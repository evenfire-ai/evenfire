import type { CronScheduler } from '../../agent/cronScheduler'
import { createGetCapabilitiesTool } from '../../capabilities/getCapabilitiesTool'
import {
  BRIDGE_TOOL_NAMES,
  createToolCallTool,
  createToolDescribeTool,
  createToolSearchTool,
} from '../../capabilities/toolCatalogTools'
import {
  buildGfsCopyTools,
  buildGfsReadTools,
  buildGfsWriteTools,
  referencedFilePins,
} from '../../internalTools/gfs'
import { createGfscClient, getGfsToolScopes } from '../../internalTools/gfsClient'
import type { GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import type { LlmProvider } from '../../llm/registryCore'
import type { McpManager } from '../../mcp/manager'
import type { IncomingMessage } from '../../server'
import type { McpTool } from '../../types'
import { getOutputDir, resolveInternalTools } from '../../workflow/internalTools'
import type { InternalToolDefinition } from '../../workflow/types'
import { ScopedWorkspace } from '../../workspace/scopedWorkspace'
import type { Workspace } from '../../workspace/service'
import type { AttachmentReadLedger } from '../attachments/attachmentReadBudget'
import { type ExecutionContext, NativeToolConfig, Tool, ToolRegistry } from '../interfaces'
import { BasicSafety } from '../safety/safety'
import type { SessionSearchService } from '../sessionSearch'
import type { SpilloverStorage } from '../spillover'
import { ToolDefinition, ToolOutput } from '../types'
import { AttachmentReadTool } from './attachmentRead'
import { CronManageTool } from './cronManage'
import { FileReadTool } from './fileRead'
import { FileWriteTool } from './fileWrite'
import { buildGeneratedArtifactAttachment } from './generatedArtifactAttachments'
import { HttpRequestTool } from './httpRequest'
import { JsonTransformTool } from './jsonTransform'
import {
  MemorySearchTool,
  MemoryTreeTool,
  PersistentMemoryReadTool,
  PersistentMemoryWriteTool,
} from './memory'
import { SessionSearchTool } from './sessionSearch'
import { ShellTool } from './shell'
import { SpilloverReadTool } from './spilloverRead'
import { SystemInfoTool } from './systemInfo'
import { createWorkflowTools } from './workflow'
import type { WorkflowCallerContext } from './workflowShared'

const CHAT_HIDDEN_INTERNAL_TOOL_NAMES = new Set([
  'clerum__list_workflows',
  'clerum__read_workflow',
  'clerum__trigger_workflow',
])

/** Adapter: wraps an InternalToolDefinition as a native Tool for use in chat mode. */
class InternalToolAdapter implements Tool {
  constructor(
    private readonly def: InternalToolDefinition,
    private readonly outputDir: string,
    private readonly attachmentOptions: {
      maxBytes: number
      secretEntriesProvider?: () => Array<{ name: string; value: string }>
    }
  ) {}
  name(): string {
    return this.def.name
  }
  description(): string {
    return this.def.description
  }
  parametersSchema(): Record<string, unknown> {
    return this.def.parameters
  }
  requiresSanitization(): boolean {
    return false
  }
  requiresApproval(): boolean {
    return false
  }
  traceDescriptor() {
    return { kind: 'internal_tool' as const, sourceRef: 'mcp-host' }
  }

  joinsAbortSettlement(): boolean {
    return this.def.name === 'clerum__gfs_download' || this.def.name === 'clerum__gfs_read'
  }
  async execute(params: Record<string, unknown>, context?: ExecutionContext): Promise<ToolOutput> {
    const start = Date.now()
    try {
      const result = await this.def.execute(params, this.outputDir, {
        signal: context?.signal,
        timeoutMs: context?.timeoutMs,
        visualInput: context?.visualInput,
      })
      // Query-style tools (e.g. clerum__get_capabilities) return text via
      // result.content; file-generation tools return an artifact and we
      // synthesize a message from it. Errors take precedence over both.
      const content = result.success
        ? (result.content ??
          `File generated: ${result.artifact?.name ?? 'output'} (${
            result.artifact?.format ?? 'unknown'
          })`)
        : `Error: ${result.error ?? 'Unknown error'}`
      const attachment =
        result.success && result.artifact
          ? buildGeneratedArtifactAttachment({
              sourceTool: this.def.name,
              artifact: result.artifact,
              outputDir: this.outputDir,
              maxBytes: this.attachmentOptions.maxBytes,
              sourcePayload: params,
              secretEntriesProvider: this.attachmentOptions.secretEntriesProvider,
            })
          : null
      const images = result.success
        ? (result.images?.map(image => ({
            id: `gfs-${image.source.resourceId}-${image.source.version}`,
            kind: 'image' as const,
            mimeType: image.mimeType,
            encoding: 'base64' as const,
            dataBase64: image.dataBase64,
            filename: image.source.name,
            width: image.width,
            height: image.height,
            sizeBytes: image.sizeBytes,
            sourceTool: this.def.name,
            visualSource: image.source,
          })) ?? [])
        : []
      const attachments = [...(attachment ? [attachment] : []), ...images]
      return {
        content,
        duration_ms: Date.now() - start,
        is_error: !result.success,
        attachments: attachments.length ? attachments : undefined,
      }
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}

/**
 * Registry for all native tools.
 *
 * Native tools use plain names (no serverName__ prefix).
 * This is merged with MCP tools via CompositeToolRegistry in Phase 4.
 * Resolution order: native first (Risk 3.5.6).
 */
export class NativeToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  constructor(
    config: NativeToolConfig,
    conversationId: string,
    cronScheduler?: CronScheduler,
    sourceMessage?: IncomingMessage,
    workspace?: Workspace,
    dynamicEnvProvider?: () => Record<string, string>,
    // Order note: both `workflowCallerContextOverride` and `attachmentOptions`
    // keep dev's positions (slots 7 and 8) so dev's positional call sites stay
    // valid; the session-persistence params (spillover/sessionSearch) are
    // appended after them (slots 9/10). No call site passes spillover/sessionSearch
    // positionally except taskExecutor, which is updated to match.
    workflowCallerContextOverride?: WorkflowCallerContext | null,
    attachmentOptions?: {
      maxBytes?: number
      secretEntriesProvider?: () => Array<{ name: string; value: string }>
      /**
       * C15/C16 — the turn-owned read ledger. Required (with
       * `contextWindowTokens`) whenever a file attachment registers
       * `clerum__attachment_read`: the tool refuses to run without an exact
       * measurement and a bound, so a missing ledger must fail here, at
       * registration, instead of mid-turn.
       */
      ledger?: AttachmentReadLedger
      /** C15/C16 — effective context window the ledger derives its envelope from. */
      contextWindowTokens?: number
    },
    spilloverStorage?: SpilloverStorage,
    sessionSearchService?: SessionSearchService,
    // F2 (dynamic-tool-loading): the MCP manager backs the read-only
    // discovery meta-tools (clerum__tool_search / clerum__tool_describe).
    // Appended as a trailing optional dep so existing positional call sites
    // stay valid; only taskExecutor passes it.
    mcpManager?: McpManager,
    // F3/F4 (dynamic-tool-loading) + #1003: which concerns need the 3 bridge
    // tools. `mcpDiscovery` is the MCP presentation decision (Codex/Grok mode
    // or the legacy flag) and only counts when an McpManager is wired;
    // `nativeDiscovery` is native `auto`, which needs the bridge even without
    // MCP. With both false nothing is registered, so tools[] is byte-identical
    // to a host without discovery and no discovery guidance is emitted (it
    // gates on clerum__tool_search). Constant per host/session, so it is
    // cache-safe. Trailing optional; only taskExecutor passes it.
    discovery?: { mcpDiscovery: boolean; nativeDiscovery: boolean },
    // §13 (stateless agents): the ACTIVE LLM provider steers shell_exec
    // credential-slot stripping — only the active provider's credential env
    // var survives into the child env. Appended as a trailing optional so
    // existing positional call sites stay valid; only taskExecutor passes it.
    activeLlmProvider?: LlmProvider,
    gfsDownload?: {
      /** Omitted when the durable store is recovery-required; delivery then fails closed. */
      store?: GfsDownloadStore
      /** True only for attended, policy-eligible, healthy workspace delivery. */
      deliveryAvailable: boolean
      callerIdentity: string
      callerWorkspacePath?: string
      retentionOwnerId?: string
    }
  ) {
    // A Host-owned GFS store establishes a trusted caller binding even when
    // memory is disabled. In that mode file tools never fall back to the shared
    // Host root; if the caller root cannot be verified they are omitted.
    // Without that Host store, preserve the legacy memory/shared-root behavior.
    const fileToolsRoot =
      gfsDownload !== undefined
        ? gfsDownload.callerWorkspacePath
        : workspace instanceof ScopedWorkspace
          ? workspace.userRootPath
          : config.workspacePath
    if (fileToolsRoot !== undefined) this.register(new FileReadTool(fileToolsRoot))
    // NOTE (residual): FileWriteTool writes via raw fs and bypasses
    // WorkspaceService.write → scanWriteContent. So a `file_write` to
    // `daily/*` / `MEMORY.md` is NOT injection-scanned. It is scoped to the
    // per-user root (F1c), and neither MEMORY.md nor private memory feed the
    // system prompt (F5: memory is read via tools, not injected) — so the blast
    // radius is self-injection of the user's own daily snapshot (low). Closing
    // it (route memory/daily-class file_write through WorkspaceService) is future
    // hardening, independent of F5.
    if (fileToolsRoot !== undefined) this.register(new FileWriteTool(fileToolsRoot))
    // A Host-owned GFS store binds the shell to the verified caller root. The
    // shell never calls the store itself (#1019): it only re-verifies that the
    // caller root is still canonical before each command.
    this.register(
      new ShellTool(
        gfsDownload ? gfsDownload.callerWorkspacePath : config.workspacePath,
        config.shellTimeout,
        config.envAllowlist,
        dynamicEnvProvider,
        activeLlmProvider,
        gfsDownload !== undefined
      )
    )
    this.register(new HttpRequestTool(config.httpAllowlist))
    this.register(new SystemInfoTool())
    this.register(new JsonTransformTool())

    // Memory tools: persistent (filesystem), requires workspace.
    if (workspace) {
      this.register(new MemorySearchTool(workspace))
      this.register(new PersistentMemoryWriteTool(workspace))
      this.register(new PersistentMemoryReadTool(workspace))
      this.register(new MemoryTreeTool(workspace))
    }

    if (cronScheduler) {
      this.register(
        new CronManageTool(cronScheduler, sourceMessage, config.statelessLifecycle === true)
      )
    }

    const gfsEnv = {
      get: (key: string): string | undefined => process.env[key],
    }
    const gfsScopes = getGfsToolScopes(gfsEnv)
    if (gfsScopes && gfsScopes.size > 0) {
      const gfsClient = createGfscClient(gfsEnv, { maxRetryWaitMs: config.toolTimeout })
      const gfsTools = [
        ...(gfsScopes.has('gfs.read')
          ? buildGfsReadTools(gfsClient, {
              referencedFiles: referencedFilePins(sourceMessage?.fileReferenceResolutions),
              downloadStore: gfsDownload?.deliveryAvailable ? gfsDownload.store : undefined,
              callerIdentity: gfsDownload?.callerIdentity,
              callerWorkspacePath: gfsDownload?.callerWorkspacePath,
              retentionOwnerId: gfsDownload?.retentionOwnerId,
            })
          : []),
        ...(gfsScopes.has('gfs.write') ? buildGfsWriteTools(gfsClient) : []),
        ...(gfsScopes.has('gfs.read') && gfsScopes.has('gfs.write')
          ? buildGfsCopyTools(gfsClient)
          : []),
      ]
      for (const tool of gfsTools) {
        this.register(new InternalToolAdapter(tool, getOutputDir(), { maxBytes: 52_428_800 }))
      }
    }

    // T1.5 — `clerum__spillover_read` reads back blobs persisted out-of-band
    // by `executeSingleTool`. Only registered when the host wires a real
    // `SpilloverStorage` (i.e. spillover feature is enabled).
    if (spilloverStorage) {
      this.register(new SpilloverReadTool(spilloverStorage))
    }

    // T3.1 — `clerum__session_search` lets the LLM recall past messages of
    // the same user. Requires both a `SessionSearchService` (needs SQLite
    // store + FTS5) AND a `sourceMessage` so `userId` is derivable
    // server-side. Cron-triggered turns without an origin message do not
    // get the tool — same gating as `CronManageTool`.
    if (sessionSearchService && sourceMessage) {
      this.register(new SessionSearchTool(sessionSearchService, sourceMessage))
    }

    // #666 — `clerum__attachment_read` reads the `kind:'file'` attachments of
    // the message that started this turn. Only registered when there is one.
    if (sourceMessage?.attachments?.some(a => a.kind === 'file')) {
      const maxBytes = config.attachmentTextReadMaxBytes
      if (maxBytes === undefined) {
        throw new Error(
          'NativeToolConfig.attachmentTextReadMaxBytes is required for file attachments'
        )
      }
      const ledger = attachmentOptions?.ledger
      const contextWindowTokens = attachmentOptions?.contextWindowTokens
      if (!ledger || contextWindowTokens === undefined) {
        throw new Error(
          'NativeToolConfig attachment read wiring requires a turn ledger and contextWindowTokens for file attachments'
        )
      }
      // The tool declares itself spillover-exempt: a page is bounded by
      // `maxBytes`, so the loop ships it inline whether or not this turn has
      // spillover storage (#678).
      // Pages are redacted against the whole text with the same rules and
      // ConfigStore secrets the loop's tool-output sanitizer applies.
      const redactor = new BasicSafety(attachmentOptions?.secretEntriesProvider)
      this.register(
        new AttachmentReadTool(sourceMessage, maxBytes, { contextWindowTokens, ledger, redactor })
      )
    }

    const envGetter = (key: string): string | undefined => {
      const fromStore = dynamicEnvProvider?.()[key]
      if (typeof fromStore === 'string' && fromStore.length > 0) return fromStore
      return process.env[key]
    }

    // Broker URL/token come from pod env, not mutable Host ConfigStore env.
    const workflowEnvGetter = (key: string): string | undefined => process.env[key]

    if (
      workflowEnvGetter('MCP_HOST_GATEWAY_URL') &&
      (workflowEnvGetter('MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE') ||
        workflowEnvGetter('MCP_HOST_WORKFLOW_CONTROL_TOKEN'))
    ) {
      const targetUserId = sourceMessage?.channelType === 'rpc' ? sourceMessage.sender.trim() : ''
      const targetTeamId =
        sourceMessage?.channelType === 'rpc' && typeof sourceMessage.metadata?.teamId === 'string'
          ? sourceMessage.metadata.teamId.trim()
          : ''
      const sourceConversationId =
        sourceMessage?.channelType === 'rpc' && typeof sourceMessage.threadId === 'string'
          ? sourceMessage.threadId.trim()
          : ''
      const sourceMessageContent = sourceMessage?.content || ''
      const sourceMessageId =
        sourceMessage?.channelType === 'rpc' && typeof sourceMessage.messageId === 'string'
          ? sourceMessage.messageId.trim()
          : ''
      const rpcWorkflowCallerContext =
        targetUserId || targetTeamId
          ? {
              ...(targetUserId ? { targetUserId } : {}),
              ...(targetTeamId ? { targetTeamId } : {}),
              ...(sourceConversationId ? { conversationId: sourceConversationId } : {}),
              originChannelType: 'rpc' as const,
              ...(sourceMessageId ? { sourceMessageId } : {}),
              ...(sourceMessageContent ? { sourceMessageContent } : {}),
            }
          : null
      const workflowCallerContext =
        workflowCallerContextOverride === undefined
          ? rpcWorkflowCallerContext
          : workflowCallerContextOverride
      const canExposeWorkflowTools =
        !sourceMessage || sourceMessage.channelType === 'rpc' || Boolean(workflowCallerContext)
      if (canExposeWorkflowTools) {
        for (const tool of createWorkflowTools({
          getEnv: workflowEnvGetter,
          workflowCallerContext,
        })) {
          this.register(tool)
        }
      }
    }

    // Register internal file-generation/context tools. Workflow recipe control is exposed
    // through workflow_* tools in chat mode so Desktop-owned user/team context can stay hidden.
    const outputDir = getOutputDir()
    const resolvedAttachmentOptions = {
      maxBytes: attachmentOptions?.maxBytes ?? 52_428_800,
      secretEntriesProvider: attachmentOptions?.secretEntriesProvider,
    }
    // #592: resolveInternalTools() drops the clerum__context_files_* tools when no
    // SharedFileSystem is mounted (Context references none, or this is a recipe
    // runtime that can't mount SFS at all) so the agent never sees dead tools.
    for (const tool of resolveInternalTools()) {
      if (CHAT_HIDDEN_INTERNAL_TOOL_NAMES.has(tool.name)) continue
      this.register(new InternalToolAdapter(tool, outputDir, resolvedAttachmentOptions))
    }

    // clerum__get_capabilities is a query-style internal tool that exposes
    // presence booleans + static hints to the LLM. Routes through
    // ConfigStore via dynamicEnvProvider when available; falls back to
    // process.env when no provider is supplied (e.g. dev mode).
    this.register(
      new InternalToolAdapter(
        createGetCapabilitiesTool(envGetter),
        outputDir,
        resolvedAttachmentOptions
      )
    )

    // F2/F3/F4 (dynamic-tool-loading): read-only discovery meta-tools + the
    // execution bridge. They query the live catalog on demand and never put
    // schemas into the announced tools[] array.
    // Registered when MCP discovery needs them (an McpManager is wired — the
    // tool-name listing registry in main.ts and tests omit it — AND the MCP
    // presentation enables the bridge; LOCKED #5: default OFF) or when native
    // `auto` needs them (#1003; no McpManager required). Otherwise none of
    // these 3 tools are registered, so tools[] is byte-identical to today and
    // the presence-gated discovery guidance is not emitted by either prompt path.
    const mcpDiscovery = Boolean(mcpManager && discovery?.mcpDiscovery)
    const nativeDiscovery = discovery?.nativeDiscovery === true
    if (mcpDiscovery || nativeDiscovery) {
      // Single catalog. Without native discovery it is exactly the MCP catalog.
      // With it (#1003), every non-bridge native is appended under the `native`
      // pseudo-server so a deferred native can be searched and described, and
      // MCP entries whose name collides with ANY native (bridge tools included)
      // are dropped, because the registry routes such a name to the native.
      // Read lazily: desktop tools are registered after construction and MCP
      // servers connect late.
      const getCatalog = (): McpTool[] => {
        const mcpTools = mcpManager?.getAllTools() ?? []
        if (!nativeDiscovery) return mcpTools
        const allNatives = this.listDefinitions()
        const nativeNames = new Set(allNatives.map(def => def.name))
        const natives = allNatives.filter(def => !BRIDGE_TOOL_NAMES.has(def.name))
        return [
          ...mcpTools.filter(tool => !nativeNames.has(tool.name)),
          ...natives.map(def => ({
            name: def.name,
            description: def.description,
            inputSchema: def.parameters,
            serverName: 'native',
          })),
        ]
      }
      this.register(
        new InternalToolAdapter(
          createToolSearchTool(getCatalog, { nativeTargets: nativeDiscovery }),
          outputDir,
          resolvedAttachmentOptions
        )
      )
      this.register(
        new InternalToolAdapter(
          createToolDescribeTool(getCatalog),
          outputDir,
          resolvedAttachmentOptions
        )
      )
      // F3 (dynamic-tool-loading): the execution bridge. Registered as a native
      // so it appears in tools[] and in `nativeNames`; its real handling is the
      // intercept at the top of `executeToolCalls`. The adapter's `execute` is a
      // safety net that errors if the intercept is bypassed.
      this.register(
        new InternalToolAdapter(
          createToolCallTool({ nativeTargets: nativeDiscovery }),
          outputDir,
          resolvedAttachmentOptions
        )
      )
    }
  }

  get(name: string): Tool | null {
    return this.tools.get(name) ?? null
  }

  listDefinitions(): ToolDefinition[] {
    const defs = Array.from(this.tools.values()).map(tool => ({
      name: tool.name(),
      description: tool.description(),
      parameters: tool.parametersSchema(),
    }))
    return defs
  }

  register(tool: Tool): void {
    this.tools.set(tool.name(), tool)
  }
}
