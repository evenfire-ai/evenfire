import type { CronScheduler } from '../../agent/cronScheduler'
import { createGetCapabilitiesTool } from '../../capabilities/getCapabilitiesTool'
import {
  createToolCallTool,
  createToolDescribeTool,
  createToolSearchTool,
} from '../../capabilities/toolCatalogTools'
import { buildGfsReadTools, buildGfsWriteTools } from '../../internalTools/gfs'
import { createGfscClient, hasGfsRuntimeAccess } from '../../internalTools/gfsClient'
import type { McpManager } from '../../mcp/manager'
import type { IncomingMessage } from '../../server'
import { INTERNAL_TOOLS, getOutputDir, resolveInternalTools } from '../../workflow/internalTools'
import type { InternalToolDefinition } from '../../workflow/types'
import { ScopedWorkspace } from '../../workspace/scopedWorkspace'
import type { Workspace } from '../../workspace/service'
import { NativeToolConfig, Tool, ToolRegistry } from '../interfaces'
import type { SessionSearchService } from '../sessionSearch'
import type { SpilloverStorage } from '../spillover'
import { ToolDefinition, ToolOutput } from '../types'
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
  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    try {
      const result = await this.def.execute(params, this.outputDir)
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
      return {
        content,
        duration_ms: Date.now() - start,
        is_error: !result.success,
        attachments: attachment ? [attachment] : undefined,
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
    },
    spilloverStorage?: SpilloverStorage,
    sessionSearchService?: SessionSearchService,
    // F2 (dynamic-tool-loading): the MCP manager backs the read-only
    // discovery meta-tools (clerum__tool_search / clerum__tool_describe).
    // Appended as a trailing optional dep so existing positional call sites
    // stay valid; only taskExecutor passes it.
    mcpManager?: McpManager,
    // F3/F4 (dynamic-tool-loading): the STATIC feature flag
    // (config.dynamicToolsEnabled). The 3 bridge tools are only registered when
    // this is true, so a default-OFF host is byte-identical to today (no extra
    // native tools, no discovery guidance — the guidance gates on the presence
    // of clerum__tool_search). Constant per host/session, so it is cache-safe.
    // Appended as a trailing optional so existing positional call sites stay
    // valid; only taskExecutor passes it.
    dynamicToolsEnabled?: boolean
  ) {
    // file_read/file_write are scoped to the per-user root when a ScopedWorkspace
    // is wired (F1c) — they operate on a raw path string, not the Workspace
    // interface, so we read the per-user root off it explicitly. Falls back to
    // the shared root when there is no user context (e.g. the tool-name listing
    // registry in main.ts). ShellTool stays on the shared root: scoping its cwd
    // does not contain absolute-path access — shell isolation is a documented
    // residual (bundled with OS-level sandboxing).
    const fileToolsRoot =
      workspace instanceof ScopedWorkspace ? workspace.userRootPath : config.workspacePath
    this.register(new FileReadTool(fileToolsRoot))
    // NOTE (residual): FileWriteTool writes via raw fs and bypasses
    // WorkspaceService.write → scanWriteContent. So a `file_write` to
    // `daily/*` / `MEMORY.md` is NOT injection-scanned. It is scoped to the
    // per-user root (F1c), and neither MEMORY.md nor private memory feed the
    // system prompt (F5: memory is read via tools, not injected) — so the blast
    // radius is self-injection of the user's own daily snapshot (low). Closing
    // it (route memory/daily-class file_write through WorkspaceService) is future
    // hardening, independent of F5.
    this.register(new FileWriteTool(fileToolsRoot))
    this.register(
      new ShellTool(
        config.workspacePath,
        config.shellTimeout,
        config.envAllowlist,
        dynamicEnvProvider
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
      this.register(new CronManageTool(cronScheduler, sourceMessage))
    }

    const gfsEnv = {
      get: (key: string): string | undefined => process.env[key],
    }
    if (hasGfsRuntimeAccess(gfsEnv)) {
      const gfsClient = createGfscClient(gfsEnv)
      for (const tool of [...buildGfsReadTools(gfsClient), ...buildGfsWriteTools(gfsClient)]) {
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
    // execution bridge. They query the live MCP catalog (McpManager.getAllTools())
    // on demand and never put schemas into the announced tools[] array.
    // Gated on BOTH an McpManager being wired (chat path via taskExecutor; the
    // tool-name listing registry in main.ts and tests omit it) AND the static
    // feature flag (LOCKED #5: default OFF, opt-in, small hosts untouched). When
    // the flag is OFF, none of these 3 tools are registered, so tools[] is
    // byte-identical to today and the presence-gated discovery guidance is not
    // emitted by either prompt path.
    if (mcpManager && dynamicToolsEnabled) {
      const getCatalog = () => mcpManager.getAllTools()
      this.register(
        new InternalToolAdapter(
          createToolSearchTool(getCatalog),
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
        new InternalToolAdapter(createToolCallTool(), outputDir, resolvedAttachmentOptions)
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
