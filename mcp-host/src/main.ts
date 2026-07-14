/**
 * MCP Host - Main entry point.
 *
 * This service reads Host CRD configuration and provides LLM access
 * via OpenAI or Claude based on the configuration.
 *
 * Architecture:
 * - Messages from channel-reader are placed in a queue
 * - The agent state machine processes tasks one at a time
 * - The agent can use tools (MCP servers) and create cron jobs
 * - Responses are sent back via callbacks
 *
 * Phase 6: Added approval handler wiring and approval config propagation.
 */
import * as path from 'node:path'
import { HostActivityHub } from './activityHub'
import { AgentStateMachine, CronScheduler, wireCronDispatch } from './agent'
import { agentToolEnvProvider } from './agent/agentToolEnv'
import type { PendingCronResult } from './agent/cronDispatch'
import { BudgetClient } from './budget/budgetClient'
// Structured JSON logging — must be first import
import { config } from './config'
import { ConfigStore } from './config/configStore'
import { ContextMapperClient, getContextMapperClient } from './contextMapperClient'
import {
  type ConversationStoreHandle,
  SqliteColdStartLoader,
  createConversationStore,
} from './core/conversation/persistence'
import { validateApprovalConfig } from './core/extensions'
import type { ApprovalDecision } from './core/extensions/approvalTypes'
import { BasicSafety } from './core/safety/safety'
import { SessionSearchService } from './core/sessionSearch'
import { SpilloverStorage } from './core/spillover'
import { FsSpilloverResolver } from './core/spillover/fsResolver'
import { isInternalGeneratedArtifactAttachment } from './core/tools/generatedArtifactAttachments'
import { NativeToolRegistry } from './core/tools/nativeToolRegistry'
import { WorkflowResultTool } from './core/tools/workflow'
import type { Attachment, Conversation } from './core/types'
import { ConversationState } from './core/types'
import { wireActivityEvents } from './eventWiring'
import { HostWatcher, getHost } from './k8sClient'
import { TaskLifecycle } from './lifecycle/taskLifecycle'
import { SingleTurnProvider, createLLMProvider } from './llm'
import { PromptCache } from './llm/promptCache'
import { clerumPromptCacheInvalidationsTotal } from './llm/promptCacheMetrics'
import { ALL_PROVIDERS, type LlmProvider, descriptorFor, isLlmProvider } from './llm/registryCore'
import './logger'
import { McpManager } from './mcp'
import { IncomingMessageHandler, PendingTaskEntry } from './messageHandler'
import { maybeCreatePluginWorkloadSdkServer } from './pluginWorkloadSdk/server'
import type { PluginWorkloadSdkServer } from './pluginWorkloadSdk/server/sdkServer'
import { getDisplayName, sanitizeError } from './progress/intentExtraction'
import { progressReporterRegistry } from './progress/sseProgressReporter'
import { MessageQueue, Task, TaskResponsePayload } from './queue'
import { ResultStore } from './resultStore'
import { markFileAttachmentsDelivered } from './runtime/fileAttachmentDelivery'
import {
  HostActivityEvent,
  HostActivitySnapshotResponse,
  IncomingMessage,
  MessageResponse,
  ProviderMessageAuthorization,
  ProviderWorkflowApprovalDecision,
  ProviderWorkflowApprovalResolve,
  ProviderWorkflowResultRequest,
  RPCServer,
  RuntimeCallerContext,
  StatusResponse,
  TelegramWorkflowApprovalVerification,
  WorkflowApprovalMediumEnrollment,
  WorkflowApprovalNotificationClaim,
  WorkflowApprovalNotificationTerminal,
} from './server'
import {
  projectContextBreakdown,
  projectSessionTokens,
  projectTurnTokens,
  projectTurnToolSteps,
} from './server/wireProjections'
import { SessionProcessor } from './session'
import { approxDecodedBytes } from './shared/encoding'
import { ApiKeys, HostCRD, McpServerInfo } from './types'
import { UsageReporter } from './usage/usageReporter'
import { setOutputDirHostAccessor } from './workflow/internalTools'
import { submitProviderWorkflowApprovalDecision } from './workflow/providerWorkflowApprovalDecisionClient'
import { confirmProviderWorkflowApprovalMediumEnrollment } from './workflow/providerWorkflowApprovalMediumEnrollmentClient'
import {
  claimProviderWorkflowApprovalNotifications,
  recordProviderWorkflowApprovalNotificationTerminal,
} from './workflow/providerWorkflowApprovalNotificationClient'
import { resolvePendingProviderWorkflowApproval } from './workflow/providerWorkflowApprovalResolveClient'
import { confirmProviderWorkflowApprovalTelegramVerification } from './workflow/providerWorkflowApprovalTelegramVerificationClient'
import { resolveProviderWorkflowCallerContext } from './workflow/providerWorkflowCallerContextClient'
import { wireWorkflowApprovalRuntimeRoutes } from './workflow/runtimeApprovalRouteWiring'
import { createMcpHostRuntimeAuth } from './workflow/runtimeAuthFactory'
import {
  startRuntimeAuthProactiveRefresh,
  stopRuntimeAuthProactiveRefresh,
} from './workflow/runtimeAuthRefreshScheduler'
import { type McpHostRuntimeAuth, refreshWithRecovery } from './workflow/userApprovalRequester'
import { ScopedWorkspaceProvider } from './workspace/scopedWorkspace'

// Global state
let currentHost: HostCRD | null = null
// Chat-mode artifacts resolve to ${workspacePath}/outputs off the durable PVC
// (D.2b). The closure reads the live `currentHost`, so it picks up the CRD once
// it hydrates async after boot.
setOutputDirHostAccessor(() => currentHost)
let currentKeys: ApiKeys = {}
let currentProvider: SingleTurnProvider | null = null
let configStore: ConfigStore | null = null
let hostWatcher: HostWatcher | null = null
let contextMapperPollTimer: ReturnType<typeof setInterval> | null = null
let mcpStatusHeartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastServerState: Map<string, string> = new Map()
let rpcServer: RPCServer | null = null
let mcpManager: McpManager | null = null
let contextMapperClient: ContextMapperClient | null = null
let activityHub: HostActivityHub | null = null
let workspaceProvider: ScopedWorkspaceProvider | null = null
let spilloverStorage: SpilloverStorage | null = null
let conversationStoreHandle: ConversationStoreHandle | null = null
let promptCache: PromptCache | null = null
let sessionSearchService: SessionSearchService | null = null

// New state machine components
let messageQueue: MessageQueue | null = null
let taskLifecycle: TaskLifecycle | null = null
let agent: AgentStateMachine | null = null
let cronScheduler: CronScheduler | null = null
let sessionProcessor: SessionProcessor | null = null
let isShuttingDown = false

// Shared mcp-host → control-api auth credential. Built once at startup
// from MCP_HOST_RUNTIME_* env (HCC- or WRC-injected) and passed to every
// consumer (UsageReporter, WorkflowService) so refresh-on-401 propagates.
// Null when env is absent (dev mode without HCC/WRC).
let runtimeAuth: McpHostRuntimeAuth | null = null
let pluginWorkloadSdkServer: PluginWorkloadSdkServer | null = null
let usageReporter: UsageReporter | null = null

// Populated once at startup for approval-config validation warnings.
// Constructed without workspace/cron (optional deps) so the set covers the
// always-registered core tools (file, shell, http_request, system_info, etc.).
//
// Scope note: tools that register conditionally at TaskExecutor time (workspace,
// cron, memory when CLERUM_MEMORY_ENABLED, desktop tools) will be reported as
// "unknown" by validateApprovalConfig if an operator overrides them here. v1
// scope (http_request and the other always-on tools) is unaffected. Widen this
// snapshot if/when overrides are extended past the always-registered set.
const knownNativeToolNames: Set<string> = new Set(
  new NativeToolRegistry(config.nativeTool, '').listDefinitions().map(d => d.name)
)

/**
 * Stores final responses or intermediate approval notifications for tasks
 * that went through the approval flow. Channel-reader polls GET /task/:id/result
 * to retrieve these.
 *
 * - "completed": final response ready for delivery
 * - "waiting_approval": another tool needs approval (multi-approval flow)
 */
const pendingTaskResults = new ResultStore<PendingTaskEntry>(
  10 * 60 * 1000,
  entry => entry.storedAt
)

/**
 * Stores cron task results for channel-reader to poll via GET /cron/results.
 * Channel-reader delivers results to the originating channel and acknowledges
 * via DELETE /cron/results/:id.
 */
const pendingCronResults = new ResultStore<PendingCronResult>(30 * 60 * 1000, entry =>
  entry.timestamp.getTime()
)

function resolveHostRef(task?: Task): string {
  return (
    String(task?.sourceMessage?.hostRef || currentHost?.spec.host || config.hostName).trim() ||
    'unknown'
  )
}

function publishActivity(input: {
  task?: Task
  type: HostActivityEvent['type']
  title: string
  severity?: HostActivityEvent['severity']
  meta?: Record<string, unknown>
}): void {
  if (!activityHub) return
  activityHub.publish({
    hostRef: resolveHostRef(input.task),
    taskId: input.task?.id,
    type: input.type,
    title: input.title,
    severity: input.severity || 'info',
    meta: input.meta,
  })
}

const WORKFLOW_FILE_ATTACHMENT_MIME_BY_EXT = new Map([
  ['json', 'application/json'],
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['csv', 'text/csv'],
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
])

function attachmentExtension(filename: string | undefined): string {
  if (!filename) return ''
  const idx = filename.lastIndexOf('.')
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : ''
}

function isAllowedWorkflowFileAttachment(attachment: Attachment): boolean {
  if (attachment.kind !== 'file') return false
  if (attachment.sourceTool !== 'workflow_result') return false
  const expected = WORKFLOW_FILE_ATTACHMENT_MIME_BY_EXT.get(
    attachmentExtension(attachment.filename)
  )
  if (!expected) return false
  return attachment.mimeType.split(';', 1)[0]?.toLowerCase() === expected
}

function sanitizeAttachments(raw: Attachment[] | undefined): Attachment[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined
  }

  const sanitized: Attachment[] = []
  for (const attachment of raw) {
    if (sanitized.length >= config.attachmentMaxCount) {
      break
    }
    const supportedImage =
      config.enableResponseAttachments &&
      attachment.kind === 'image' &&
      attachment.mimeType === 'image/jpeg'
    const supportedFile =
      isAllowedWorkflowFileAttachment(attachment) ||
      (config.enableResponseAttachments && isInternalGeneratedArtifactAttachment(attachment))
    if (!supportedImage && !supportedFile) {
      console.warn(`[Main] Dropping unsupported attachment type: ${attachment.mimeType}`)
      continue
    }
    if (attachment.encoding !== 'base64' || typeof attachment.dataBase64 !== 'string') {
      console.warn('[Main] Dropping attachment with unsupported encoding')
      continue
    }

    const decodedBytes = approxDecodedBytes(attachment.dataBase64)
    if (decodedBytes > config.attachmentMaxBytes) {
      console.warn(
        `[Main] Dropping oversized attachment (${decodedBytes} bytes > ${config.attachmentMaxBytes})`
      )
      continue
    }

    sanitized.push(attachment)
  }

  return sanitized.length > 0 ? sanitized : undefined
}

function sanitizeIncomingAttachments(raw: Attachment[] | undefined): Attachment[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined
  }

  const sanitized: Attachment[] = []
  for (const attachment of raw) {
    if (sanitized.length >= config.attachmentMaxCount) {
      break
    }
    const isSupportedImageMime =
      attachment.mimeType === 'image/jpeg' || attachment.mimeType === 'image/png'
    if (
      attachment.kind !== 'image' ||
      !isSupportedImageMime ||
      attachment.encoding !== 'base64' ||
      typeof attachment.dataBase64 !== 'string' ||
      !attachment.dataBase64.trim()
    ) {
      continue
    }
    const decodedBytes = approxDecodedBytes(attachment.dataBase64)
    if (decodedBytes > config.attachmentMaxBytes) {
      continue
    }
    sanitized.push(attachment)
  }

  return sanitized.length > 0 ? sanitized : undefined
}

/**
 * Project the ConfigStore's single provider-matching LLM key into the
 * legacy `ApiKeys` shape. ConfigStore only ever exposes the key for the
 * configured provider (translated to shell-style env-name); this helper
 * routes it into the matching field that `createLLMProvider` reads.
 */
function apiKeysFromConfigStore(store: ConfigStore): ApiKeys {
  const llm = store.llmKey()
  if (!llm) return {}
  const out: ApiKeys = {}
  // Registry-driven: map the configured key's env-name back to its provider id.
  const provider = ALL_PROVIDERS.find(p => descriptorFor(p).envName === llm.name)
  if (provider) {
    out[provider] = llm.value
  }
  return out
}

/**
 * (Re)create the ConfigStore for the current Host. Used at boot and on
 * Host CRD changes that flip `spec.secretRef` (which would also have
 * triggered a Deployment rollout in HCC, but we re-create here anyway
 * so a soft secretRef change without HCC also picks up correctly).
 */
async function ensureConfigStore(host: HostCRD): Promise<ConfigStore> {
  const provider = host.spec.model?.provider ?? null
  if (configStore) {
    configStore.stop()
    configStore = null
  }
  const store = new ConfigStore({
    namespace: config.namespace,
    hostRef: host.name,
    llmSecretRef: host.spec.secretRef,
    provider,
  })
  await store.start()
  configStore = store

  // Hot reload: rebuild the LLM provider on key rotation. The agent receives
  // a swapped provider via setLLMProvider; in-flight requests finish on the
  // old client (already dispatched), the next task uses the new one.
  store.onChange(({ llmKeyChanged }) => {
    if (!llmKeyChanged || !currentHost) return
    const keys = apiKeysFromConfigStore(store)
    currentKeys = keys
    const next = createLLMProvider(keys, currentHost.spec.model)
    if (!next) {
      console.error('[Main] LLM provider rebuild failed after key rotation — Host may be degraded')
      return
    }
    currentProvider = next
    if (agent) {
      agent.setLLMProvider(next, currentHost.spec.model?.name)
      console.log('[Main] LLM provider rebuilt and re-attached to agent (key rotated)')
    } else {
      console.log('[Main] LLM provider rebuilt (agent not ready yet, will use on init)')
    }
  })

  return store
}

/**
 * Initialize or update the LLM provider based on host configuration.
 */
async function initializeProvider(host: HostCRD, keys: ApiKeys): Promise<void> {
  currentHost = host
  currentKeys = keys

  console.log(`[Main] Initializing provider for host: ${host.spec.host}`)
  console.log(`[Main] Model config:`, host.spec.model)
  console.log(`[Main] Context ref: ${host.spec.contextRef}`)

  currentProvider = createLLMProvider(keys, host.spec.model)

  if (currentProvider) {
    console.log('[Main] LLM provider initialized successfully')

    // Update agent with new provider
    if (agent) {
      agent.setLLMProvider(currentProvider, host.spec.model?.name)
    }
  } else {
    console.error('[Main] Failed to initialize LLM provider')
  }

  // Phase 6: Propagate approval config to agent
  if (agent) {
    const effectiveApprovalCfg = host.spec.approval || config.approvalConfig
    agent.setApprovalConfig(effectiveApprovalCfg)
    validateApprovalConfig(
      effectiveApprovalCfg,
      knownNativeToolNames,
      config.nativeTool.httpAllowlist
    )
  }
}

/**
 * Initialize MCP servers for the host's context using skill-mapper.
 */
async function initializeMcpServers(contextRef: string): Promise<void> {
  console.log(`[Main] Initializing MCP servers for context: ${contextRef}`)

  // Clean up existing manager
  if (mcpManager) {
    await mcpManager.disconnectAll()
  }
  mcpManager = new McpManager(config.mcpProxyEnabled ? config.mcpProxyUrl : undefined)
  lastServerState.clear()

  // In production mode, fetch from context-mapper
  if (!config.devMode) {
    if (!contextMapperClient) {
      contextMapperClient = getContextMapperClient()
    }

    // Wait for context-mapper to be available
    const maxRetries = 5
    let retries = 0
    while (retries < maxRetries) {
      const healthy = await contextMapperClient.healthCheck()
      if (healthy) {
        console.log('[Main] Context Mapper is available')
        break
      }
      retries++
      console.log(`[Main] Waiting for Context Mapper... (${retries}/${maxRetries})`)
      await new Promise(resolve => setTimeout(resolve, 2000))
    }

    const servers = await contextMapperClient.listServersByContext(contextRef)

    for (const server of servers) {
      let authToken: string | undefined

      // Get auth token if configured
      if (server.auth?.secretRef) {
        authToken = await contextMapperClient.getAuthToken(server.name)
      }

      await mcpManager.addServer(server, authToken)
      lastServerState.set(server.name, JSON.stringify(server))
    }
  }

  const connectedServers = mcpManager.getConnectedServers()
  console.log(`[Main] Connected to ${connectedServers.length} MCP server(s)`)

  if (connectedServers.length > 0) {
    const tools = mcpManager.getAllTools()
    console.log(`[Main] Total tools available: ${tools.length}`)
  }

  // Update agent with MCP manager
  if (agent) {
    agent.setMcpManager(mcpManager)
  }
}

/**
 * Poll context-mapper for McpServer changes.
 */
async function pollContextMapper(contextRef: string): Promise<void> {
  if (!contextMapperClient || !mcpManager) return

  try {
    const { servers } = await contextMapperClient.pollServers(contextRef)
    const currentNames = new Set(servers.map(s => s.name))
    const previousNames = new Set(lastServerState.keys())

    // Detect added or modified servers
    for (const server of servers) {
      const previousState = lastServerState.get(server.name)
      const currentState = JSON.stringify(server)

      if (!previousState) {
        console.log(`[Main] MCP server added: ${server.name}`)
        const authToken = server.auth?.secretRef
          ? await contextMapperClient.getAuthToken(server.name)
          : undefined
        await mcpManager.addServer(server, authToken)
        lastServerState.set(server.name, currentState)
      } else if (previousState !== currentState) {
        console.log(`[Main] MCP server modified: ${server.name}`)
        await mcpManager.removeServer(server.name)
        const authToken = server.auth?.secretRef
          ? await contextMapperClient.getAuthToken(server.name)
          : undefined
        await mcpManager.addServer(server, authToken)
        lastServerState.set(server.name, currentState)
      }
    }

    // Detect deleted servers
    for (const name of previousNames) {
      if (!currentNames.has(name)) {
        console.log(`[Main] MCP server deleted: ${name}`)
        await mcpManager.removeServer(name)
        lastServerState.delete(name)
      }
    }
  } catch (error) {
    console.error('[Main] Error polling skill-mapper:', error)
  }
}

/**
 * Start polling context-mapper for McpServer changes.
 */
function startContextMapperPolling(contextRef: string): void {
  console.log(
    `[Main] Starting context-mapper polling (interval: ${config.contextMapperPollInterval}ms)`
  )

  contextMapperPollTimer = setInterval(() => {
    pollContextMapper(contextRef)
  }, config.contextMapperPollInterval)
}

/**
 * Stop polling context-mapper.
 */
function stopContextMapperPolling(): void {
  if (contextMapperPollTimer) {
    console.log('[Main] Stopping context-mapper polling')
    clearInterval(contextMapperPollTimer)
    contextMapperPollTimer = null
  }
}

/**
 * Start periodic MCP status heartbeat. Keeps `observedAt` fresh on every
 * connected server and classifies tools/list failures without interrupting
 * the connection (spec §4.5, §7.1).
 */
function startMcpStatusHeartbeat(): void {
  if (mcpStatusHeartbeatTimer) return
  const interval = config.mcpStatusHeartbeatInterval
  console.log(`[Main] Starting MCP status heartbeat (interval: ${interval}ms)`)
  mcpStatusHeartbeatTimer = setInterval(() => {
    if (!mcpManager) return
    mcpManager.refreshAllServerStatus().catch((err: unknown) => {
      console.error('[Main] MCP status heartbeat failed:', err)
    })
  }, interval)
}

function stopMcpStatusHeartbeat(): void {
  if (mcpStatusHeartbeatTimer) {
    console.log('[Main] Stopping MCP status heartbeat')
    clearInterval(mcpStatusHeartbeatTimer)
    mcpStatusHeartbeatTimer = null
  }
}

/**
 * Handle host configuration change.
 */
async function onHostChange(host: HostCRD): Promise<void> {
  console.log(`[Main] Host configuration changed: ${host.name}`)

  const providerChanged = currentHost?.spec.model?.provider !== host.spec.model?.provider
  const secretRefChanged = currentHost?.spec.secretRef !== host.spec.secretRef
  const modelChanged = currentHost?.spec.model?.name !== host.spec.model?.name
  if (!configStore || providerChanged || secretRefChanged) {
    console.log('[Main] Rebuilding ConfigStore (provider or secretRef changed)')
    await ensureConfigStore(host)
  }
  currentKeys = apiKeysFromConfigStore(configStore!)
  await initializeProvider(host, currentKeys)

  // PMC-2 — the cached `stable` tier embeds the model+provider runtime line
  // (see DefaultPromptBuilder). A model/provider/secretRef swap must invalidate
  // the prompt cache REGARDLESS of personalization, otherwise the next turn
  // keeps serving the OLD model:/provider: line until eviction (generation is
  // correct — it uses the live provider — but the system prompt mislabels the
  // model). This is deliberately OUTSIDE the personalization branch below.
  if (providerChanged || secretRefChanged || modelChanged) {
    promptCache?.invalidateAll('model_change')
  }

  // Reconcile admin-managed identity files. This is intentionally keyed off the
  // Host watch so CRD edits propagate without a pod restart.
  if (workspaceProvider && host.spec.personalization?.enabled) {
    try {
      await workspaceProvider.collectiveWorkspace.applyAdminIdentityFiles(host.spec.personalization)
      // T2.2 §5.7 — identity files just got rewritten; drop every cached
      // `parts` so the next turn rebuilds the `stable` tier from the new
      // identity content. The cache is constructed during initializeAgent()
      // so by the time onHostChange runs at runtime it is non-null; the `?.`
      // is defensive for early-boot reconcile paths.
      promptCache?.invalidateAll('identity_reconciled')
      console.log('[Main] Identity files reconciled from CRD')
    } catch (err) {
      console.error('[Main] Failed to apply identity files:', err)
    }
  }
}

/**
 * Handle host deletion.
 */
function onHostDelete(): void {
  console.log('[Main] Host CRD deleted, shutting down')
  currentHost = null
  currentProvider = null
  process.exit(1)
}

/**
 * Build the shared McpHostRuntimeAuth and the UsageReporter once. Skips
 * silently when the runtime-token env vars aren't set (dev mode without
 * HCC/WRC) — features that need auth degrade to "disabled" individually.
 */
function setupUsageReporting(): void {
  if (!agent || !currentHost) return
  if (usageReporter) return // already wired

  if (!runtimeAuth) runtimeAuth = createMcpHostRuntimeAuth()
  if (!runtimeAuth) {
    console.log('[Main] LLM usage reporting disabled — MCP_HOST_RUNTIME_* env not set')
    return
  }

  const auth = runtimeAuth
  // Keep the runtime-auth chain alive even when this host is idle, so an
  // unconsumed refresh token never expires beyond grace into an unrecoverable
  // pod that HCC cannot detect as NotReady.
  startRuntimeAuthProactiveRefresh(auth)
  usageReporter = new UsageReporter({
    baseUrl: auth.baseUrl,
    getAccessToken: () => auth.accessToken,
    refreshOnUnauthorized: () => refreshWithRecovery(auth),
  })

  // host_ref must match the runtime JWT's hostRefs[0]. HCC stamps the
  // actual Host CRD name there; control-api rejects usage batches that
  // drift from that claim.
  agent.setUsageReporter(usageReporter, {
    host_ref: auth.hostRef,
    context_ref: currentHost.spec.contextRef ?? null,
    llm_secret_name: currentHost.spec.secretRef ?? null,
  })
  console.log(
    `[Main] LLM usage reporting wired (host=${currentHost.name}, gateway=${auth.baseUrl})`
  )

  // P1 token budgets (§5.1) — reuse the SAME shared McpHostRuntimeAuth (bearer +
  // auto-refresh) and base URL the UsageReporter posts through. Gated on the
  // flag; the per-task wiring in SessionProcessor is gated too, so flag-off is a
  // true no-op with no network.
  if (config.budgetsEnabled) {
    const budgetClient = new BudgetClient({
      baseUrl: auth.baseUrl,
      getAccessToken: () => auth.accessToken,
      refreshOnUnauthorized: () => refreshWithRecovery(auth),
    })
    // host_ref MUST be auth.hostRef (the Host CRD name in the runtime JWT),
    // the same value usage is recorded under (see setUsageReporter above). Using
    // currentHost.spec.host instead would not match usage_events.host_ref, so a
    // host-scoped budget would silently never match — a block-budget bypass.
    agent.setBudgetCheck(budgetClient, () =>
      currentHost
        ? {
            host_ref: auth.hostRef,
            context_ref: currentHost.spec.contextRef ?? null,
            llm_secret_name: currentHost.spec.secretRef ?? null,
          }
        : null
    )
    console.log('[Main] Token budget enforcement wired (CLERUM_BUDGETS_ENABLED=true)')
  }
}

/**
 * Resolve the absolute path where `state.db` should live. Production uses
 * the workspace PVC; dev/test fall back to a tmpdir copy so the file lives
 * outside the repo.
 */
function resolveSessionDbPath(): string {
  if (config.sessionDbPath) return config.sessionDbPath
  const memoryCfg = currentHost?.spec.memory || config.memory
  const wp = memoryCfg?.workspacePath ?? config.memory.workspacePath
  if (memoryCfg?.enabled && wp) {
    return path.join(wp, 'state.db')
  }
  // No PVC available — dev / ephemeral fallback. State is lost across
  // restarts; expected for unit-level smoke tests.
  return path.join(require('node:os').tmpdir(), 'clerum-state.db')
}

/**
 * Build the conversation store handle (and wire the cold-start loader when
 * SQLite is enabled). Returns null when the operator is still on the legacy
 * `memory` mode — main.ts keeps the default in-memory store inside the
 * agent's ConversationManager.
 */
async function initializeConversationStore(): Promise<ConversationStoreHandle | null> {
  if (!agent) return null
  if (config.sessionStoreMode === 'memory') {
    console.log('[Main] Conversation store: memory (legacy fallback)')
    return null
  }

  const dbPath = resolveSessionDbPath()
  const memoryCfg = currentHost?.spec.memory || config.memory
  if (!memoryCfg?.enabled) {
    console.warn(
      `[Main] SQLite state will be ephemeral — workspace memory is disabled. dbPath=${dbPath}`
    )
  }

  const handle = createConversationStore({
    mode: config.sessionStoreMode,
    dbPath,
    cacheSize: config.conversationCacheSize,
    syncTimeoutMs: config.dbPersistSyncTimeoutMs,
    asyncTimeoutMs: config.dbPersistAsyncTimeoutMs,
    checkpointEveryWrites: config.dbCheckpointEveryWrites,
    heartbeatMs: config.dbWorkerHeartbeatMs,
    pendingApprovalTtlMs: config.pendingApprovalTtlMs,
  })

  agent.setConversationStore(handle.store)
  console.log(
    `[Main] Conversation store mode=${handle.mode} dbPath=${dbPath} cacheSize=${config.conversationCacheSize}`
  )

  // Wire the cold-start loader so `agent.bootstrap()` (called below) can
  // pull pending_approvals from durable storage before SessionProcessor
  // accepts new traffic (boot order P1-010 §16.3).
  const spilloverResolver =
    spilloverStorage !== null ? new FsSpilloverResolver({ storage: spilloverStorage }) : undefined
  const loader = new SqliteColdStartLoader(handle.store, {
    spilloverResolver,
    onExpired: entry => {
      console.warn(
        `[Main] Cold-start: dropping approval ${entry.request_id} — spillover ref expired`
      )
    },
  })
  agent.setColdStartLoader(loader)

  return handle
}

/**
 * Initialize the message queue and agent.
 */
async function initializeAgent(): Promise<void> {
  console.log('[Main] Initializing message queue and agent')

  // Create message queue
  messageQueue = new MessageQueue(config.agentMaxQueueSize)
  activityHub = new HostActivityHub(config.activityBufferSize, config.activityMaxEventBytes)

  // Create TaskLifecycle and inject into message queue (Phase A.6 dual-write)
  taskLifecycle = new TaskLifecycle()
  messageQueue.setLifecycle(taskLifecycle)

  // Create agent state machine
  agent = new AgentStateMachine(messageQueue, taskLifecycle, {
    maxTaskDuration: config.agentMaxTaskDuration,
    maxToolCallsPerTask: config.agentMaxToolCallsPerTask,
    autoStart: true,
    taskDelay: config.agentTaskDelay,
    approvalTimeout: config.agentApprovalTimeout,
  })

  console.log(
    `[Main] Agent config: taskDelay=${config.agentTaskDelay}ms, maxTaskDuration=${config.agentMaxTaskDuration}ms, maxToolCalls=${config.agentMaxToolCallsPerTask}, maxQueueSize=${config.agentMaxQueueSize}, approvalTimeout=${config.agentApprovalTimeout}ms`
  )

  // Phase 6: Set approval config
  const approvalCfg = currentHost?.spec.approval || config.approvalConfig
  agent.setApprovalConfig(approvalCfg)
  validateApprovalConfig(approvalCfg, knownNativeToolNames, config.nativeTool.httpAllowlist)
  console.log(
    `[Main] Approval system: ${config.enableApproval ? 'ENABLED' : 'DISABLED'} (policy: ${approvalCfg?.defaultPolicy || 'none/cli_only'})`
  )

  // Shell-tool subprocesses see the ConfigStore user-env snapshot at spawn
  // time. `userEnvSnapshot()` deliberately omits the LLM provider key —
  // that key is read in-process by the LLM client and has no business in a
  // child shell. The output sanitizer (configured via secretEntriesProvider
  // below) still includes it as defense-in-depth, so any path that does
  // print the value gets it redacted before it leaves mcp-host.
  agent.setDynamicEnvProvider(() => agentToolEnvProvider(configStore))
  agent.setSecretEntriesProvider(() => configStore?.listSecretEntries() ?? [])

  // Phase 7–8: Create WorkspaceService when memory is enabled
  const memoryCfg = currentHost?.spec.memory || config.memory
  if (memoryCfg?.enabled) {
    const workspacePath = memoryCfg.workspacePath ?? config.memory.workspacePath ?? './workspace'
    workspaceProvider = new ScopedWorkspaceProvider(workspacePath)
    agent.setWorkspaceProvider(workspaceProvider)
    console.log(`[Main] Workspace memory enabled at: ${workspacePath}`)

    // Dev mode has no Host CRD watch, so apply env-sourced personalization here.
    // In production, the Host watch also applies this path on every CRD update.
    const personalizationCfg = currentHost?.spec.personalization || config.personalization
    if (personalizationCfg?.enabled) {
      workspaceProvider.collectiveWorkspace
        .applyAdminIdentityFiles(personalizationCfg)
        .then(() => {
          // T2.2 §5.7 — boot-time apply runs BEFORE the PromptCache is
          // constructed (further down in initializeAgent), so this `?.` is
          // intentionally a no-op today. The runtime reconcile path lives
          // in `onHostChange` and fires the actual invalidation there.
          promptCache?.invalidateAll('identity_reconciled')
        })
        .catch(err => {
          console.error('[Main] Failed to apply identity files at startup:', err)
        })
    }

    // T1.5 — Tool-result spillover. Persists oversized tool outputs under
    // `${workspacePath}/spillover/<task_id>/<tool_call_id>.json`. The
    // workspace PVC is also the natural lifetime boundary for the blobs
    // (same Pod lifetime + same TTL semantics). When memory is disabled we
    // simply skip the feature; the loop ships content inline.
    if (config.toolSpilloverEnabled) {
      spilloverStorage = new SpilloverStorage({
        workspacePath,
        thresholdBytes: config.toolSpilloverThresholdBytes,
        ttlMs: config.spilloverTtlMs,
        gcIntervalMs: config.spilloverGcIntervalMs,
      })
      // Lazy boot sweep (best-effort; failures are logged inside).
      spilloverStorage.sweep().catch(err => {
        console.error('[Main] Spillover boot sweep failed (non-fatal):', err)
      })
      spilloverStorage.startGc()
      agent.setSpilloverStorage(spilloverStorage)
      console.log(
        `[Main] Spillover storage enabled (threshold=${config.toolSpilloverThresholdBytes}B, ttl=${config.spilloverTtlMs}ms)`
      )
    }
  }

  // Create cron scheduler and inject into agent
  cronScheduler = new CronScheduler(messageQueue)
  agent.setCronScheduler(cronScheduler)

  // Wire activity events (agent, queue, core events -> activity hub)
  wireActivityEvents(agent, messageQueue, publishActivity)

  // Set providers if already initialized
  if (currentProvider) {
    agent.setLLMProvider(currentProvider, currentHost?.spec.model?.name)
  }
  if (mcpManager) {
    agent.setMcpManager(mcpManager)
  }

  // LLM usage reporting — wires the bounded ring buffer + 60s flusher to
  // POST /api/v1/internal/usage/llm/events through the workflow-approval
  // gateway. Disabled silently when the runtime token env vars aren't
  // injected (dev mode without HCC/WRC).
  setupUsageReporting()

  // Create SessionProcessor for session-based dispatch.
  // AgentStateMachine now delegates to per-task TaskExecutors, making concurrent
  // execution safe. Default maxConcurrent=3, configurable via CLERUM_MAX_CONCURRENT_SESSIONS.
  const maxConcurrent = parseInt(process.env.CLERUM_MAX_CONCURRENT_SESSIONS || '3', 10)
  sessionProcessor = new SessionProcessor({
    maxConcurrent,
    executor: async (task: Task) => {
      return agent!.executeTask(task)
    },
    lifecycle: taskLifecycle!,
    // P1 token budgets (§5.1, §5.3): wire the pre-task check + denial delivery
    // ONLY when the flag is on so flag-off dispatch keeps its synchronous,
    // network-free path.
    ...(config.budgetsEnabled
      ? {
          checkTaskBudget: (task: Task) => agent!.checkTaskBudget(task),
          onBudgetDenied: (task: Task, reason?: string) => agent!.handleBudgetDenied(task, reason),
        }
      : {}),
  })
  agent.setSessionProcessor(sessionProcessor)

  wireCronDispatch(cronScheduler, {
    sessionProcessor,
    pendingCronResults,
    sanitizeAttachments,
  })

  // T2.1 — Construct the durable conversation store (no-op in `memory`
  // mode) and wire the SqliteColdStartLoader before bootstrap. This MUST
  // happen before agent.bootstrap() so pending_approvals can rehydrate.
  conversationStoreHandle = await initializeConversationStore()

  // T3.1 — Session search. Requires SQLite persistence (the FTS5 index lives
  // there) AND the feature flag. In `memory` mode there is no `persistQueue`
  // so the tool/endpoint simply stay unregistered.
  const persistQueue = conversationStoreHandle?.persistQueue
  if (config.sessionSearchEnabled && persistQueue) {
    sessionSearchService = new SessionSearchService({ persistQueue })
    agent.setSessionSearchService(sessionSearchService)

    // Boot-only retention sweep (T3.1 §8). Failures are non-fatal so a
    // corrupt DB does not block traffic — the metric / log surfaces the issue.
    sessionSearchService.sweepRetention(config.searchRetentionDays).then(
      deleted => {
        console.log(
          JSON.stringify({
            event: 'search_retention_sweep',
            deleted_sessions: deleted,
            retention_days: config.searchRetentionDays,
          })
        )
      },
      err => {
        console.error('[Main] Session search retention sweep failed (non-fatal):', err)
      }
    )
    console.log(`[Main] Session search enabled (retentionDays=${config.searchRetentionDays})`)
  }

  // T2.2 — Process-wide system-prompt cache. Built unconditionally so the
  // observer counters surface invalidation reasons even when the cache flag
  // is OFF (still RAM-cheap: empty map when nobody calls set). Hooks
  // `onEvict` on the conversation store so dropping a session from the LRU
  // also drops its prompt cache entry.
  if (workspaceProvider) {
    const cache = new PromptCache({
      onInvalidate: (key, reason) => {
        clerumPromptCacheInvalidationsTotal.inc({ reason })
        console.log(`[PromptCache] invalidate sessionKey=${key} reason=${reason}`)
      },
    })
    promptCache = cache
    conversationStoreHandle?.store?.onEvict?.(sessionKey => cache.drop(sessionKey))
    agent.setPromptCache(cache)
    console.log(`[Main] Prompt cache wired (flag=${config.promptCacheEnabled ? 'on' : 'off'})`)
  }

  // P.3 invariant #3: rehydrate pending_approvals from durable storage
  // BEFORE SessionProcessor accepts new traffic. No-op when the cold-start
  // loader is still the NoOp default (memory mode).
  //
  // Guarded: under sqlite/dual a worker boot/load failure must NOT crashloop
  // the pod. Degrade to an empty approval set (waiting users re-trigger) —
  // matching the retention-sweep degrade policy — instead of taking the host
  // down on every restart.
  try {
    await agent.bootstrap()
  } catch (err) {
    console.error(
      '[Main] agent.bootstrap() failed — starting with an empty pending-approval set. ' +
        'Durable approvals (if any) will not be rehydrated this boot.',
      err
    )
  }

  // Start the agent
  agent.start()
  cronScheduler.start()

  console.log('[Main] Agent and cron scheduler started')
}

/**
 * Handle incoming message from channel-reader.
 *
 * Two-phase response for approval flow:
 * - Phase 1: If a tool needs approval, resolve immediately with status "waiting_approval"
 *   and the notification text. Channel-reader sends the notification to the user.
 * - Phase 2: After approval/denial, the final response is stored in pendingTaskResults
 *   for channel-reader to poll via GET /task/:id/result.
 */
function handleIncomingMessage(
  message: IncomingMessage,
  options?: { async?: boolean }
): MessageResponse | Promise<MessageResponse> {
  const sanitizedIncomingAttachments = sanitizeIncomingAttachments(message.attachments)
  const normalizedMessage: IncomingMessage = {
    ...message,
    attachments: sanitizedIncomingAttachments,
  }

  console.log('\n' + '='.repeat(50))
  console.log('[Main] Received message')
  console.log(`[Main]   Channel: ${normalizedMessage.channelType}`)
  console.log(`[Main]   Channel ID: ${normalizedMessage.channelId}`)
  console.log(`[Main]   Sender: ${normalizedMessage.sender}`)
  console.log(`[Main]   Time: ${normalizedMessage.timestamp}`)
  console.log(`[Main]   Message ID: ${normalizedMessage.messageId}`)
  console.log(
    `[Main]   Content: ${normalizedMessage.content.substring(0, 100)}${normalizedMessage.content.length > 100 ? '...' : ''}`
  )
  if (normalizedMessage.attachments?.length) {
    console.log(`[Main]   Attachments: ${normalizedMessage.attachments.length}`)
  }
  console.log('='.repeat(50))

  if (!messageQueue) {
    return {
      success: false,
      error: {
        code: 'LLM_API_CALL_FAILED',
        message: 'Message queue not initialized',
        retryable: false,
        provider: 'unknown',
      },
    }
  }

  // Refuse new tasks while the Host is degraded. Operator fixes the LLM
  // Secret and the Host returns to ready within ~1 s — no restart.
  const degraded = computeDegradedReason()
  if (degraded) {
    console.warn(`[Main] Refusing message — Host is degraded: ${degraded.reason}`)
    return {
      success: false,
      error: {
        code: 'LLM_KEY_MISSING',
        message: degraded.message,
        retryable: true,
        provider: currentHost?.spec.model?.provider ?? 'unknown',
      },
    }
  }

  const handler = new IncomingMessageHandler(normalizedMessage, {
    messageQueue,
    agent,
    pendingTaskResults,
    getModel: () => currentHost?.spec.model?.name || 'unknown',
    sanitizeAttachments,
    sessionProcessor: sessionProcessor ?? undefined,
    taskLifecycle: taskLifecycle!,
  })

  if (options?.async) {
    return handler.executeAsync()
  }

  return handler.execute()
}

function sourceMatchesRuntimeCaller(
  source: { channelType?: string | null; channelId?: string | null; sender?: string | null },
  caller?: RuntimeCallerContext
): boolean {
  if (!caller) return false

  if (caller.caller === 'rpc-proxy') {
    return source.channelType === 'rpc' && !!caller.userId && source.sender === caller.userId
  }

  return (
    source.channelType === caller.channelType &&
    source.channelId === caller.channelId &&
    source.sender === caller.sender
  )
}

function logRuntimeOwnershipMismatch(
  route: string,
  taskId: string,
  caller: RuntimeCallerContext,
  source: { channelType?: string | null; channelId?: string | null; sender?: string | null }
): void {
  console.warn(
    JSON.stringify({
      event: 'runtime_task_ownership_mismatch',
      route,
      taskId,
      caller: caller.caller,
      callerUserId: caller.userId ?? null,
      callerChannelType: caller.channelType ?? null,
      callerChannelId: caller.channelId ?? null,
      callerSender: caller.sender ?? null,
      taskChannelType: source.channelType ?? null,
      taskChannelId: source.channelId ?? null,
      taskSender: source.sender ?? null,
    })
  )
}

function runtimeCallerCanReadTask(
  taskId: string,
  caller: RuntimeCallerContext | undefined,
  route: string
): boolean {
  if (!caller) return false

  const pending = pendingTaskResults.get(taskId)
  if (pending) {
    const matches = sourceMatchesRuntimeCaller(pending.source, caller)
    if (!matches) logRuntimeOwnershipMismatch(route, taskId, caller, pending.source)
    return matches
  }

  const record = taskLifecycle?.get(taskId)
  if (!record) return false

  const source = {
    channelType: record.submittedChannelType,
    channelId: record.submittedChannelId,
    sender: record.submittedBy,
  }
  const matches = sourceMatchesRuntimeCaller(source, caller)
  if (!matches) logRuntimeOwnershipMismatch(route, taskId, caller, source)
  return matches
}

/**
 * Handle task result polling from channel-reader (after approval flow).
 */
async function handleTaskResult(
  taskId: string,
  caller?: RuntimeCallerContext
): Promise<MessageResponse | null> {
  if (!runtimeCallerCanReadTask(taskId, caller, 'task_result')) return null

  const result = pendingTaskResults.get(taskId)
  if (result) {
    if (result.status === 'waiting_approval' && result.approval) {
      // Another tool needs approval — return notification for channel-reader
      return {
        success: true,
        status: 'waiting_approval',
        approval: {
          taskId,
          requestId: result.approval.requestId,
          userId: result.approval.userId,
          notification: result.approval.notification,
        },
        model: result.model,
      }
    }

    // Return the stored result with structured error when present.
    // Phase 2 (LLM error handling) writes `error: TaskError` for LLM
    // failures; previously this handler hardcoded success:true and
    // never returned the error field.
    const response: MessageResponse = {
      success: !result.error,
      status: 'completed',
      response: result.response,
      attachments: result.attachments,
      error: result.error,
      model: result.model,
    }
    // Desktop can have multiple task-result readers for the same turn: the
    // tracker, stream recovery, and the chat renderer can all reconcile the
    // durable task result. Keep task file attachments idempotent for the
    // ResultStore TTL so the first poll cannot consume the downloadable file
    // before the visible chat bubble renders it.
    return response
  }

  // Task still processing or not found
  return {
    success: true,
    status: 'pending',
  }
}

/**
 * Phase 6: Handle approval/denial decisions from /approve and /deny endpoints.
 */
async function handleApprovalDecision(
  decision: ApprovalDecision
): Promise<{ success: boolean; error?: string }> {
  if (!agent) {
    return { success: false, error: 'Agent not initialized' }
  }

  const action = decision.approved ? 'approve' : 'deny'
  console.log(
    `[Main] Processing ${action} from userId=${decision.userId} requestId=${decision.requestId}`
  )

  const result = decision.approved
    ? await agent.handleApproval(
        decision.userId,
        decision.requestId,
        decision.alwaysApprove,
        decision.channelType,
        decision.channelId
      )
    : await agent.handleDenial(
        decision.userId,
        decision.requestId,
        decision.channelType,
        decision.channelId
      )

  if (!result.success) {
    console.error(`[Main] ${action} failed: ${result.error}`)
  } else {
    console.log(`[Main] ${action} succeeded for requestId=${decision.requestId}`)
  }
  return result
}

async function handleProviderWorkflowApprovalDecision(
  decision: ProviderWorkflowApprovalDecision
): Promise<{
  success: boolean
  duplicate?: boolean
  status?: string
  run?: Record<string, unknown> | null
  error?: string
}> {
  console.log(
    `[Main] Processing provider workflow approval decision ${decision.decision} ` +
      `requestId=${decision.approvalRequestId} medium=${decision.providerIdentity.medium}`
  )
  return submitProviderWorkflowApprovalDecision(decision, runtimeAuth)
}

async function handleProviderMessageAuthorization(
  input: ProviderMessageAuthorization
): Promise<{ authorized: boolean }> {
  const identity = input.providerIdentity
  try {
    const context = await resolveProviderWorkflowCallerContext(
      {
        content: '',
        channelType: identity.medium,
        channelId: identity.providerChannelId,
        sender: identity.providerUserId,
        timestamp: new Date().toISOString(),
        messageId: identity.providerEventId || 'provider-authorization',
        hostRef: identity.providerTarget?.hostRef || '',
        providerIdentity: identity,
      },
      key => process.env[key]
    )
    return { authorized: Boolean(context?.targetUserId) }
  } catch (error) {
    console.warn(
      `[Main] Provider message authorization failed closed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return { authorized: false }
  }
}

async function handleProviderWorkflowApprovalResolve(
  input: ProviderWorkflowApprovalResolve
): Promise<
  | { status: 'found'; approvalRequestId: string }
  | { status: 'not_found' }
  | { status: 'ambiguous' }
  | { status: 'error'; error: string }
> {
  console.log(
    `[Main] Resolving provider workflow approval recipe=${input.recipeName} ` +
      `medium=${input.providerIdentity.medium}`
  )
  return resolvePendingProviderWorkflowApproval(input, runtimeAuth)
}

async function handleProviderWorkflowResultRequest(
  input: ProviderWorkflowResultRequest
): Promise<MessageResponse> {
  const message: IncomingMessage = {
    content: `Download workflow result for ${input.workflowName}`,
    channelType: input.source.channelType,
    channelId: input.source.channelId,
    sender: input.source.sender,
    timestamp: input.source.timestamp,
    messageId: input.source.messageId,
    hostRef: input.providerIdentity.providerTarget?.hostRef ?? currentHost?.name ?? config.hostName,
    threadId: input.source.threadId,
    providerIdentity: input.providerIdentity,
  }
  let context: Awaited<ReturnType<typeof resolveProviderWorkflowCallerContext>>
  try {
    context = await resolveProviderWorkflowCallerContext(message, key => process.env[key])
  } catch (error) {
    console.warn(
      `[Main] Provider workflow result access failed closed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    context = null
  }
  if (!context?.targetUserId && !context?.targetTeamId) {
    return {
      success: false,
      status: 'completed',
      response:
        'Could not verify this provider conversation for workflow result access. Use the verified conversation connected to your Clerum account.',
      error: {
        code: 'WORKFLOW_RESULT_UNAUTHORIZED',
        message: 'Provider workflow result access is not authorized',
        retryable: false,
        provider: currentHost?.spec.model?.provider ?? 'unknown',
      },
      model: currentHost?.spec.model?.name ?? 'unknown',
    }
  }

  const env = agentToolEnvProvider(configStore)
  const tool = new WorkflowResultTool({
    getEnv: key => env[key] ?? process.env[key],
    workflowCallerContext: context,
  })
  const result = await tool.execute({ name: input.workflowName })
  return {
    success: !result.is_error,
    status: 'completed',
    response: result.content,
    attachments: result.attachments,
    ...(result.is_error
      ? {
          error: {
            code: 'WORKFLOW_RESULT_UNAVAILABLE',
            message: result.content,
            retryable: true,
            provider: currentHost?.spec.model?.provider ?? 'unknown',
          },
        }
      : {}),
    model: currentHost?.spec.model?.name ?? 'workflow_result',
  }
}

async function handleWorkflowApprovalNotificationClaim(input: WorkflowApprovalNotificationClaim) {
  return claimProviderWorkflowApprovalNotifications(input, runtimeAuth)
}

async function handleWorkflowApprovalNotificationTerminal(
  id: string,
  action: 'ack' | 'fail',
  input: WorkflowApprovalNotificationTerminal
) {
  return recordProviderWorkflowApprovalNotificationTerminal(id, action, input, runtimeAuth)
}

async function handleWorkflowApprovalMediumEnrollment(input: WorkflowApprovalMediumEnrollment) {
  return confirmProviderWorkflowApprovalMediumEnrollment(input, runtimeAuth)
}

async function handleTelegramWorkflowApprovalVerification(
  input: TelegramWorkflowApprovalVerification
) {
  return confirmProviderWorkflowApprovalTelegramVerification(input, runtimeAuth)
}

/**
 * Get pending cron results for channel-reader to deliver.
 */
function getCronResults(caller?: RuntimeCallerContext): Array<PendingCronResult & { id: string }> {
  const entries = pendingCronResults.entries()
  const filteredEntries =
    caller?.caller === 'channel-reader' && caller.channelType && caller.channelId && caller.sender
      ? entries.filter(([, entry]) => sourceMatchesRuntimeCaller(entry.origin, caller))
      : entries

  const results = filteredEntries.map(([id, entry]) => ({
    id,
    ...entry,
  }))
  for (const [id, entry] of filteredEntries) {
    markFileAttachmentsDelivered(pendingCronResults, id, entry)
  }

  return results
}

/**
 * Acknowledge delivery of a cron result (called by channel-reader after sending).
 */
function acknowledgeCronResult(taskId: string, caller?: RuntimeCallerContext): boolean {
  const entry = pendingCronResults.get(taskId)
  if (!entry) return false

  if (!sourceMatchesRuntimeCaller(entry.origin, caller)) {
    if (caller) logRuntimeOwnershipMismatch('cron_result_ack', taskId, caller, entry.origin)
    return false
  }

  return pendingCronResults.delete(taskId)
}

/**
 * Get current system status.
 */
async function getStatus(): Promise<StatusResponse> {
  const agentStats = agent?.getStats() || {
    state: 'uninitialized',
    currentTaskId: null,
    tasksProcessed: 0,
    tasksSucceeded: 0,
    tasksFailed: 0,
    totalToolCalls: 0,
    uptime: 0,
    lastTaskCompletedAt: null,
  }

  const queueStats = messageQueue?.getStats() || {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    total: 0,
  }

  const cronJobs = cronScheduler?.getAllJobs().length || 0

  // Phase 6: Include pending approvals
  const pendingApprovals = agent?.getPendingApprovals() || []

  const mcpServers = mcpManager ? mcpManager.status.snapshot() : []
  const degraded = computeDegradedReason()

  return {
    agent: {
      state: agentStats.state,
      currentTaskId: agentStats.currentTaskId,
      tasksProcessed: agentStats.tasksProcessed,
      tasksSucceeded: agentStats.tasksSucceeded,
      tasksFailed: agentStats.tasksFailed,
      uptime: agentStats.uptime,
    },
    queue: {
      pending: queueStats.pending,
      processing: queueStats.processing,
      completed: queueStats.completed,
      failed: queueStats.failed,
    },
    cronJobs,
    pendingApprovals,
    mcpServers,
    degraded,
  }
}

/**
 * Returns the current degraded reason or null when the Host is healthy.
 *
 * Today the only condition is `llm_key_missing`: ConfigStore exists (we are
 * running in a real K8s context, not dev mode) but cannot resolve the
 * provider key. ConfigStore keeps watching, so the host flips back to
 * healthy automatically once the operator fixes the Secret.
 */
function computeDegradedReason(): StatusResponse['degraded'] {
  if (!configStore) return null // dev mode or pre-init
  if (configStore.isLlmKeyConfigured()) return null
  return {
    reason: 'llm_key_missing',
    message:
      'LLM API key is missing or the referenced Secret does not contain a key for the configured provider.',
  }
}

async function getActivitySnapshot(
  limit: number,
  sinceEventId?: string
): Promise<HostActivitySnapshotResponse> {
  const hostRef = resolveHostRef()
  if (!activityHub) {
    return { hostRef, version: '1.0', items: [], nextCursor: null }
  }
  return activityHub.snapshot(hostRef, limit, sinceEventId)
}

function subscribeActivity(onEvent: (event: HostActivityEvent) => void): {
  hostRef: string
  unsubscribe: () => void
} {
  const hostRef = resolveHostRef()
  if (!activityHub) {
    return { hostRef, unsubscribe: () => undefined }
  }
  return { hostRef, unsubscribe: activityHub.subscribe(onEvent) }
}

/**
 * Start the RPC server.
 */
async function startRPCServer(): Promise<void> {
  const port = config.serverPort
  rpcServer = new RPCServer(port)
  // agent is guaranteed non-null here: initializeAgent() runs before startRPCServer()
  // in both startDevMode and startProductionMode.
  // Use the durable (async) variants so sessions evicted from the in-memory
  // LRU — or, under sqlite/dual, any session after a pod restart — still
  // surface from SQLite. The sync RAM-only accessors would 404 persisted
  // sessions, defeating the persistence feature. The route already awaits.
  // D.1 — view of session liveness shared by /sessions and /messages.
  // `state` lets the desktop paint sidebar badges; `activeTaskId` tells it
  // which task to re-subscribe to; `pendingApproval` lets it render the
  // approve button without waiting for the SSE. `displayName` is derived
  // server-side (the `tool_name` itself is NOT leaked over the wire — security
  // patch P1-1).
  const sessionStateView = (conversation: Conversation) => {
    const state =
      conversation.state === ConversationState.Processing
        ? ('processing' as const)
        : conversation.state === ConversationState.AwaitingApproval
          ? ('awaiting_approval' as const)
          : ('idle' as const)
    const activeTaskId = state === 'idle' ? undefined : conversation.activeTaskId
    const pendingApproval =
      conversation.state === ConversationState.AwaitingApproval && conversation.pending_approval
        ? {
            requestId: conversation.pending_approval.request_id,
            displayName: getDisplayName(conversation.pending_approval.tool_name),
          }
        : undefined
    // Lifetime token totals — projected to the wire shape (omitted until the
    // session has had an LLM call; cache breakdown included only when the model
    // reports it). See `projectSessionTokens`.
    const tokens = projectSessionTokens(conversation)
    return { state, activeTaskId, pendingApproval, tokens }
  }

  // #582: redact a persisted tool error before it reaches the `/messages` wire,
  // mirroring the live SSE path exactly: `sanitizeOutput` scrubs secret values
  // (operator-configured + built-in patterns), then `sanitizeError` strips
  // stacks/paths and truncates. The persisted `tc.error` is raw at rest
  // (reconstruct.ts), so this is the enforcement point for the P1-1 boundary.
  const toolErrorSafety = new BasicSafety(() => configStore?.listSecretEntries() ?? [])
  const redactToolError = (toolName: string, rawError: string): string =>
    sanitizeError(toolErrorSafety.sanitizeOutput(toolName, rawError).content)

  const handleSessionsList = async (userSub: string) => {
    const convManager = agent!.getConversationManager()
    const entries = await convManager.listSessionsForUserAsync(`${userSub}:rpc:`)
    return {
      items: entries.map(({ conversation, agent: agentName, chatId }) => ({
        agent: agentName,
        chatId,
        turnCount: conversation.turns.length,
        lastActivityAt: conversation.updated_at.toISOString(),
        ...sessionStateView(conversation),
      })),
    }
  }

  const handleSessionMessages = async (userSub: string, agentName: string, chatId: string) => {
    const convManager = agent!.getConversationManager()
    // Direct O(1) key lookup — spec §2: `conversations.get(`${auth.sub}:rpc:${agent}:${chatId}`)`.
    const key = `${userSub}:rpc:${agentName}:${chatId}`
    const conversation = await convManager.getSessionByKeyAsync(key)
    if (!conversation) return null
    return {
      agent: agentName,
      chatId,
      ...sessionStateView(conversation),
      turns: conversation.turns.map(t => ({
        number: t.number,
        user_input: t.user_input,
        response: t.response,
        started_at: t.started_at.toISOString(),
        completed_at: t.completed_at ? t.completed_at.toISOString() : undefined,
        tokens: projectTurnTokens(t),
        tool_steps: projectTurnToolSteps(t, redactToolError),
      })),
    }
  }

  const handleContextBreakdown = async (userSub: string, agentName: string, chatId: string) => {
    const convManager = agent!.getConversationManager()
    // Same O(1) key lookup + anti-enumeration semantics as handleSessionMessages:
    // the userSub comes from the verified rpc edge caller (routes.ts), never a
    // client param, so a caller cannot read another user's session.
    const key = `${userSub}:rpc:${agentName}:${chatId}`
    const conversation = await convManager.getSessionByKeyAsync(key)
    if (!conversation) return null
    // `breakdown: null` when the session exists but has no snapshot yet (cold-load
    // before the first turn) — distinct from the 404 the route returns for a
    // non-existent / cross-user session.
    return { breakdown: projectContextBreakdown(conversation) ?? null }
  }

  rpcServer.onMessage(handleIncomingMessage)
  rpcServer.setArtifactSecretEntriesProvider(() => configStore?.listSecretEntries() ?? [])
  rpcServer.onStatus(getStatus)
  rpcServer.onActivitySnapshot(getActivitySnapshot)
  rpcServer.onActivityStream(subscribeActivity)
  rpcServer.onApproval(handleApprovalDecision)
  wireWorkflowApprovalRuntimeRoutes(rpcServer, {
    providerMessageAuthorization: handleProviderMessageAuthorization,
    providerWorkflowApprovalDecision: handleProviderWorkflowApprovalDecision,
    providerWorkflowApprovalResolve: handleProviderWorkflowApprovalResolve,
    workflowApprovalNotificationClaim: handleWorkflowApprovalNotificationClaim,
    workflowApprovalNotificationTerminal: handleWorkflowApprovalNotificationTerminal,
    workflowApprovalMediumEnrollment: handleWorkflowApprovalMediumEnrollment,
    telegramWorkflowApprovalVerification: handleTelegramWorkflowApprovalVerification,
  })
  rpcServer.onProviderWorkflowResultRequest(handleProviderWorkflowResultRequest)
  rpcServer.onTaskResult(handleTaskResult)
  rpcServer.onCronResults(getCronResults)
  rpcServer.onCronResultAck(acknowledgeCronResult)
  rpcServer.onSessionsList(handleSessionsList)
  rpcServer.onSessionMessages(handleSessionMessages)
  rpcServer.onContextBreakdown(handleContextBreakdown)
  // T3.1 — session search REST endpoint. Only wired when the feature is
  // enabled and the SQLite backend is live; otherwise the route returns 501
  // through `handleSessionSearchRoute`.
  if (sessionSearchService) {
    const service = sessionSearchService
    rpcServer.onSessionSearch(async req => {
      const result = await service.search(
        {
          query: req.query,
          userId: req.userSub,
          channelType: req.scope === 'this_channel' ? req.channelType : undefined,
          since: req.since,
          limit: req.limit,
        },
        'rest'
      )
      return result
    })
  }
  // T1.1 — operator-triggered compaction. Delegates to the agent so the same
  // PressureContextManager wiring (workspace, llmPort, tokenCounter) used by
  // the in-loop path drives the manual one. Result kinds map to HTTP codes
  // inside `handleCompactionRoute`.
  rpcServer.onCompaction(async req => agent!.compactSession(req))
  rpcServer.onProgressStream(async (taskId, onEvent, caller) => {
    if (!runtimeCallerCanReadTask(taskId, caller, 'task_progress_stream')) return null

    // Wait up to 3 minutes for the reporter to appear. Channel-origin tasks can
    // sit behind an LLM-bound queue item; ending early leaves the provider UI
    // stuck without the terminal event.
    // where the Desktop App opens the progress stream before the agent dequeues
    // the task and creates the SseProgressReporter.
    const reporter = await progressReporterRegistry.waitFor(taskId, 180_000)
    if (!reporter) return null
    const unsubscribe = reporter.subscribe(onEvent)
    return { unsubscribe }
  })
  rpcServer.onCancel((taskId, requesterUserId) => {
    console.log(
      JSON.stringify({
        event: 'cancel_requested',
        taskId,
        requesterUserId: requesterUserId ?? null,
        origin: 'user', // HTTP-initiated cancels are always user-originated. Shutdown drain logs 'system' from stateMachine.stop().
      })
    )

    // Ownership check: if the record carries a submittedBy identity AND the
    // requester identity is provided, they must match.
    // Fail-open when either side is absent for back-compat — internal tasks have no
    // submitter, and older rpc-proxy versions didn't pass userId. New rpc-proxy always
    // passes userId so this narrows over time.
    const existing = taskLifecycle!.get(taskId)
    if (
      existing &&
      existing.submittedBy &&
      requesterUserId &&
      existing.submittedBy !== requesterUserId
    ) {
      console.warn(
        JSON.stringify({
          event: 'cancel_ownership_mismatch',
          taskId,
          submittedBy: existing.submittedBy,
          requester: requesterUserId,
        })
      )
      // Do NOT leak task existence to unauthorized requesters
      return 'not_found'
    }

    const outcome = taskLifecycle!.transition(taskId, 'cancelled', 'user_requested')

    if (outcome.kind === 'applied') {
      console.log(
        JSON.stringify({
          event: 'cancel_applied',
          taskId,
          from_state: outcome.from,
          reason: outcome.reason,
        })
      )
      return 'cancelled'
    }
    if (outcome.kind === 'already_terminal') {
      console.log(
        JSON.stringify({
          event: 'already_terminal',
          taskId,
          current_state: outcome.state,
          requested_transition: 'cancelled',
        })
      )
      return 'already_terminal'
    }
    if (outcome.kind === 'not_found') {
      return 'not_found'
    }
    // kind === 'illegal' — should never happen for cancel
    console.error('[cancel] illegal transition', outcome)
    return 'not_found'
  })
  await rpcServer.start()
}

/**
 * Graceful shutdown handler.
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log('[Main] Shutdown already in progress...')
    return
  }
  isShuttingDown = true

  console.log(`[Main] Received ${signal}, shutting down`)

  // Stop components in order
  stopRuntimeAuthProactiveRefresh()
  hostWatcher?.stop()
  configStore?.stop()
  stopContextMapperPolling()
  stopMcpStatusHeartbeat()

  if (agent) {
    await agent.stop()
  }

  // Best-effort drain of the LLM usage buffer before the process exits.
  // Without this a routine rolling deploy loses up to a minute of buffered
  // events per pod.
  if (usageReporter) {
    try {
      usageReporter.stop()
      await usageReporter.drain()
    } catch (err) {
      console.warn(
        '[Main] UsageReporter drain failed during shutdown:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  cronScheduler?.stop()
  spilloverStorage?.stopGc()
  await mcpManager?.disconnectAll()
  await pluginWorkloadSdkServer?.stop()
  await rpcServer?.stop()

  // T2.1 — drain pending DB writes, then terminate the SQLite worker.
  if (conversationStoreHandle) {
    try {
      await conversationStoreHandle.shutdown()
    } catch (err) {
      console.warn('[Main] ConversationStore shutdown raised:', err)
    }
  }

  process.exit(0)
}

/**
 * Start the MCP Host service in dev mode.
 */
async function startDevMode(): Promise<void> {
  console.log('[Main] Starting in DEV MODE')

  // Use API keys from environment variables. Registry-driven: read each
  // provider's env var by its descriptor (ALL_PROVIDERS order = dev priority).
  const keys: ApiKeys = {}
  for (const p of ALL_PROVIDERS) {
    const value = process.env[descriptorFor(p).envName]
    if (value) keys[p] = value
  }

  if (ALL_PROVIDERS.every(p => !keys[p])) {
    throw new Error(
      `Dev mode requires one of these environment variables: ${ALL_PROVIDERS.map(p => descriptorFor(p).envName).join(', ')}`
    )
  }

  let hostSpec = config.devHostConfig!

  // Auto-detect provider from available API keys if not explicitly set.
  // ALL_PROVIDERS preserves the priority order (openai > claude > zai > bailian).
  if (!hostSpec.model) {
    // Safe `!`: the `ALL_PROVIDERS.every(p => !keys[p])` throw-guard above
    // already proved at least one key is present.
    const provider = ALL_PROVIDERS.find(p => keys[p])!
    hostSpec = {
      ...hostSpec,
      model: { provider, name: descriptorFor(provider).defaultModel },
    }
    console.log(`[Main] Auto-detected provider: ${provider} (based on available API key)`)
  }

  // Phase 6: Attach approval config to host spec if provided via env var
  if (config.approvalConfig && !hostSpec.approval) {
    hostSpec = {
      ...hostSpec,
      approval: config.approvalConfig,
    }
  }

  const host: HostCRD = {
    name: config.hostName,
    namespace: config.namespace,
    spec: hostSpec,
  }

  await initializeProvider(host, keys)

  // Initialize MCP manager
  mcpManager = new McpManager(config.mcpProxyEnabled ? config.mcpProxyUrl : undefined)

  if (config.devMcpServers && config.devMcpServers.length > 0) {
    console.log(`[Main] Adding ${config.devMcpServers.length} dev MCP server(s)`)
    for (const server of config.devMcpServers) {
      await mcpManager.addServer(server)
    }

    const tools = mcpManager.getAllTools()
    console.log(`[Main] Total tools available: ${tools.length}`)
  } else {
    console.log('[Main] No MCP servers configured in dev mode')
  }

  // Initialize agent (after provider and MCP manager are ready)
  await initializeAgent()

  // Start MCP status heartbeat (dev parity with production — spec §9.5)
  startMcpStatusHeartbeat()

  // Start RPC server
  await startRPCServer()

  console.log(`[Main] Approval system: ${config.enableApproval ? 'ENABLED' : 'DISABLED'}`)
  console.log('\n[Main] MCP Host running in dev mode. Press Ctrl+C to exit.')
  console.log('[Main] Waiting for messages from channel-reader...\n')

  // Handle graceful shutdown
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

/**
 * Start the MCP Host service in production mode.
 */
async function startProductionMode(): Promise<void> {
  console.log('[Main] Starting in PRODUCTION MODE')
  console.log(`[Main] Host name: ${config.hostName}`)
  console.log(`[Main] Namespace: ${config.namespace}`)
  console.log(`[Main] Context Mapper URL: ${config.contextMapperUrl}`)

  contextMapperClient = getContextMapperClient()

  const host = await getHost(config.hostName)

  if (!host) {
    console.error(`[Main] Host CRD not found: ${config.hostName}`)
    process.exit(1)
  }

  await ensureConfigStore(host)
  const keys = apiKeysFromConfigStore(configStore!)

  await initializeProvider(host, keys)
  await initializeMcpServers(host.spec.contextRef)

  // Initialize agent (after provider and MCP manager are ready)
  await initializeAgent()

  // Start watching for Host changes
  hostWatcher = new HostWatcher(config.hostName)
  await hostWatcher.start(onHostChange, onHostDelete)

  // Start polling context-mapper for McpServer changes
  startContextMapperPolling(host.spec.contextRef)

  // Start MCP status heartbeat (keeps observedAt fresh for the desktop poll)
  startMcpStatusHeartbeat()

  // Start RPC server
  await startRPCServer()

  console.log(`[Main] Approval system: ${config.enableApproval ? 'ENABLED' : 'DISABLED'}`)
  console.log('[Main] MCP Host running. Press Ctrl+C to exit.')
  console.log('[Main] Waiting for messages from channel-reader...\n')

  // Handle graceful shutdown
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  console.log('='.repeat(50))
  console.log('MCP Host - Starting')
  console.log('='.repeat(50))

  // M-18: Startup validation — crash-fail if auth is enabled but keys are missing.
  // Silently disabling auth leaves workflow endpoints unauthenticated with no indication
  // in metrics or logs that auth is off. In workflow mode this is always a misconfiguration.
  if (config.enableAuth && !config.authJwtPublicKey) {
    console.error(
      '[Main] FATAL: enableAuth=true but CLERUM_AUTH_JWT_PUBLIC_KEY is not set — refusing to start'
    )
    process.exit(1)
  }
  if (config.enableAuth && config.workflowEnabled && !config.wrcPublicKey) {
    console.error(
      '[Main] FATAL: enableAuth=true in workflow mode but WRC_PUBLIC_KEY_PEM is not set — refusing to start'
    )
    process.exit(1)
  }

  // Workflow approval: if workflow mode is active, all three approval env vars must be set.
  // Without them, steps that require approval cannot request gating from control-api.
  if (config.workflowEnabled) {
    const missingApprovalVars: string[] = []
    if (!config.mcpHostRuntimeAccessToken) missingApprovalVars.push('MCP_HOST_RUNTIME_ACCESS_TOKEN')
    if (!config.mcpHostRuntimeRefreshToken)
      missingApprovalVars.push('MCP_HOST_RUNTIME_REFRESH_TOKEN')
    if (!config.mcpHostGatewayUrl) missingApprovalVars.push('MCP_HOST_GATEWAY_URL')
    if (!config.mcpHostWorkflowControlTokenFile && !config.mcpHostWorkflowControlToken) {
      missingApprovalVars.push('MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE')
    }
    if (missingApprovalVars.length > 0) {
      console.error(
        `[Main] FATAL: Workflow mode enabled but runtime token vars missing: ${missingApprovalVars.join(', ')} — refusing to start`
      )
      process.exit(1)
    }
  }

  // M-11: Workflow mode — skip standalone initialization entirely.
  // The WRC will configure this Pod via POST /configure (apiKey, soul, model).
  if (config.workflowEnabled) {
    console.log(`[Main] Starting in WORKFLOW MODE (recipe: ${config.workflowRecipeName})`)

    const { WorkflowService } = await import('./workflow/workflowService')
    const { McpClient } = await import('./mcp/client')

    rpcServer = new RPCServer(config.serverPort)

    // Inject a real HTTP MCP client factory so steps that declare mcpServers can
    // actually connect to them. Without this, WorkflowService uses a default factory
    // that always throws "No MCP client factory configured" (bug fix).
    const mcpClientFactory = (server: { name: string; url: string; authToken?: string }) => {
      const info = {
        name: server.name,
        contextRef: '',
        transport: { type: 'streamableHttp' as const, url: server.url },
        enabled: true,
        status: { deployed: true, ready: true },
      } as McpServerInfo
      const client = new McpClient(info, server.authToken)
      return {
        connect: (options?: { timeoutMs?: number; signal?: AbortSignal }) =>
          client.connect(options),
        listTools: async (options?: { timeoutMs?: number; signal?: AbortSignal }) =>
          (await client.listTools(options)).map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        callTool: async (
          toolName: string,
          args: Record<string, unknown>,
          options?: { timeoutMs?: number; signal?: AbortSignal }
        ) => {
          const raw = await client.callTool(toolName, args, options)
          return raw as { content: unknown; isError?: boolean }
        },
        disconnect: () => client.disconnect(),
      }
    }

    // Build the shared runtime auth once so WorkflowService and any
    // subsequent UsageReporter wiring share the refreshed access token.
    if (!runtimeAuth) runtimeAuth = createMcpHostRuntimeAuth()
    if (runtimeAuth) startRuntimeAuthProactiveRefresh(runtimeAuth)

    // Wire a UsageReporter for workflow mode so each LLM round-trip in
    // executeStep ships an LlmUsageEvent (source_kind='workflow') to
    // control-api. Without this the recipe's spend stays local to the
    // step response and never lands in usage_events / the dashboard.
    if (runtimeAuth && !usageReporter) {
      const auth = runtimeAuth
      usageReporter = new UsageReporter({
        baseUrl: auth.baseUrl,
        getAccessToken: () => auth.accessToken,
        refreshOnUnauthorized: () => refreshWithRecovery(auth),
      })
    }

    // Plugin Workload SDK LLM binding: a push-style holder updated by
    // WorkflowService.configure() — never a public getter, so the apiKey
    // stays unreachable through the service's public API surface.
    let pluginSdkLlmContext: {
      keys: ApiKeys
      provider: LlmProvider
      defaultModel: string
    } | null = null

    const workflowService = new WorkflowService(config.workflowRecipeName, {
      mcpClientFactory,
      runtimeAuth,
      usageReporter,
      onLlmConfigured: context => {
        pluginSdkLlmContext = context
      },
    })
    rpcServer.setWorkflowService(workflowService)
    wireWorkflowApprovalRuntimeRoutes(rpcServer, {
      providerMessageAuthorization: handleProviderMessageAuthorization,
      providerWorkflowApprovalDecision: handleProviderWorkflowApprovalDecision,
      providerWorkflowApprovalResolve: handleProviderWorkflowApprovalResolve,
      workflowApprovalNotificationClaim: handleWorkflowApprovalNotificationClaim,
      workflowApprovalNotificationTerminal: handleWorkflowApprovalNotificationTerminal,
      workflowApprovalMediumEnrollment: handleWorkflowApprovalMediumEnrollment,
      telegramWorkflowApprovalVerification: handleTelegramWorkflowApprovalVerification,
    })
    await rpcServer.start()

    // Plugin Workload SDK: only recipe-bound mcp-hosts inside
    // sandbox-recipes pass the triple activation gate; everyone else logs
    // the structured reason and continues without the SDK. The LLM binding
    // comes from WorkflowService (POST /configure delivers the API key).
    pluginWorkloadSdkServer = maybeCreatePluginWorkloadSdkServer(config, runtimeAuth, {
      getLlmContext: () => pluginSdkLlmContext,
      usageReporter,
    })
    if (pluginWorkloadSdkServer) {
      await pluginWorkloadSdkServer.start()
    }

    console.log('[Main] Workflow mcp-host ready — waiting for /configure from WRC')
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    process.once('SIGINT', () => shutdown('SIGINT'))
    return
  }

  if (config.devMode) {
    await startDevMode()
  } else {
    await startProductionMode()
  }
}

// Run main
main().catch(error => {
  console.error('[Main] Fatal error:', error)
  process.exit(1)
})

// Export for external access
export { messageQueue, agent, cronScheduler }
