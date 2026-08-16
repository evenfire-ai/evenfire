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
import type { ResolvedTaskModel } from './agent'
import { agentToolEnvProvider } from './agent/agentToolEnv'
import type { PendingCronResult } from './agent/cronDispatch'
import { applySessionModelSelection as applySessionModelSelectionCore } from './agent/sessionModelSelection'
import { BudgetClient } from './budget/budgetClient'
// Structured JSON logging — must be first import
import { config } from './config'
import type { AllowlistView } from './config/allowlistCheck'
import { signalHostModelAllowlist } from './config/allowlistCheck'
import { ConfigStore } from './config/configStore'
import {
  contextWindowForModel,
  hostSubsetAllowlistView,
  isModelAllowed,
  projectModels,
  resolveSessionModel,
} from './config/modelResolution'
import {
  ContextMapperClient,
  ContextMapperRequestError,
  getContextMapperClient,
  isContextMapperInventoryAuthorityRevocation,
} from './contextMapperClient'
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
import { WorkflowBrokerRequestError } from './core/tools/workflowBrokerClient.js'
import type { Attachment } from './core/types'
import { ConversationState } from './core/types'
import { wireActivityEvents } from './eventWiring'
import { HostWatcher, getHost } from './k8sClient'
import { StatelessHeartbeat } from './lifecycle/statelessHeartbeat'
import { TaskLifecycle } from './lifecycle/taskLifecycle'
import { isTerminal } from './lifecycle/types'
import type { TransitionEvent } from './lifecycle/types'
import { SingleTurnProvider, apiKeysFromEnv, createLLMProvider } from './llm'
import { FailoverEngine } from './llm/failover/engine'
import { llmFallbackTotal } from './llm/failover/metrics'
import { parseLlmPolicy } from './llm/failover/policy'
import type { FailoverSwitchEvent, FallbackEntry, LlmPolicy } from './llm/failover/types'
import { PromptCache } from './llm/promptCache'
import { clerumPromptCacheInvalidationsTotal } from './llm/promptCacheMetrics'
import { ALL_PROVIDERS, type LlmProvider, descriptorFor, isLlmProvider } from './llm/registryCore'
import './logger'
import { McpManager } from './mcp'
import {
  AuthoritativeMcpFleetCoordinator,
  DEFAULT_MCP_FLEET_RECONCILE_MAX_CONCURRENCY,
  pollAuthoritativeMcpSnapshotIfCurrent,
  reconcileAuthoritativeMcpSnapshot,
  replaceAuthoritativeMcpFleet,
  runAuthoritativeMcpInitialization,
} from './mcp/authoritativeFleet'
import { startMcpInitializationInBackground } from './mcpBackgroundInit'
import { IncomingMessageHandler, PendingTaskEntry } from './messageHandler'
import {
  configurePluginWorkloadSdkBootstrapIdentity,
  resolvePluginWorkloadSdkBootstrapCapabilityFamily,
} from './pluginWorkloadSdk/bootstrapIdentity'
import { PluginWorkloadSdkBootstrapServer } from './pluginWorkloadSdk/bootstrapServer'
import { maybeCreatePluginWorkloadSdkServer } from './pluginWorkloadSdk/server'
import type { PluginWorkloadSdkServer } from './pluginWorkloadSdk/server/sdkServer'
import { getDisplayName, sanitizeError } from './progress/intentExtraction'
import { progressReporterRegistry } from './progress/sseProgressReporter'
import { MessageQueue, Task, TaskResponsePayload } from './queue'
import { ResultStore } from './resultStore'
import { markFileAttachmentsDelivered } from './runtime/fileAttachmentDelivery'
import { isUndeliveredResult, markResultDelivered } from './runtime/resultDelivery'
import { dispatchMcpHostRuntime } from './runtimeDispatch'
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
  SetModelResult,
  StatusResponse,
  TelegramWorkflowApprovalVerification,
  WorkflowApprovalMediumEnrollment,
  WorkflowApprovalNotificationClaim,
  WorkflowApprovalNotificationTerminal,
} from './server'
import { createSessionRouteHandlers } from './server/sessionRouteHandlers'
import { projectContextBreakdown } from './server/wireProjections'
import { SessionProcessor } from './session'
import { serializeSessionKey } from './session/types.js'
import { approxDecodedBytes } from './shared/encoding'
import {
  StatelessBootError,
  assertStatelessBootConfig,
  resolveSessionDbPathFrom,
} from './statelessBootGuard'
import { StatelessCronPolicyError, assertStatelessCronPolicyConfig } from './statelessCronPolicy'
import { ApiKeys, HostCRD, McpServerInfo, ProviderCredentials } from './types'
import { ApprovalPromptHistoryClient } from './usage/approvalPromptHistoryClient'
import {
  GovernedRunReporter,
  UsageReporter,
  createGovernedRunReporter,
} from './usage/usageReporter'
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
// R5 — provider-fallback. `currentPolicy` is the normalized `spec.llmPolicy`
// (null = no failover); `failoverEngine` holds the Host-wide sticky state
// (cooldown + served pair) and is (re)built only when the policy changes.
// `bootFallbackEntry` is set when the PRIMARY was inconstructible at boot and a
// fallback entry is serving in its place (spec §3-R5.10) — cleared once the
// primary key appears and rebuilds.
let currentPolicy: LlmPolicy | null = null
let failoverEngine: FailoverEngine | null = null
let bootFallbackEntry: FallbackEntry | null = null
let hostWatcher: HostWatcher | null = null
let contextMapperPollTimer: ReturnType<typeof setInterval> | null = null
let contextMapperPollRunner: { trigger(): void; stop(): void } | null = null
let mcpStatusHeartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastServerState: Map<string, string> = new Map()
let rpcServer: RPCServer | null = null
let mcpManager: McpManager | null = null
let contextMapperClient: ContextMapperClient | null = null
let mcpAuthorityLastSuccessAt = 0
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
let mcpInitializationGeneration = 0
// Stage 3 (stateless-agents) — heartbeat emitter + DRAINING fence holder.
let statelessHeartbeat: StatelessHeartbeat | null = null

// Shared mcp-host → control-api auth credential. Built once at startup
// from MCP_HOST_RUNTIME_* env (HCC- or WRC-injected) and passed to every
// consumer (UsageReporter, WorkflowService) so refresh-on-401 propagates.
// Null when env is absent (dev mode without HCC/WRC).
let runtimeAuth: McpHostRuntimeAuth | null = null
let pluginWorkloadSdkServer: PluginWorkloadSdkServer | null = null
let pluginWorkloadSdkBootstrapServer: PluginWorkloadSdkBootstrapServer | null = null
let usageReporter: UsageReporter | null = null
let governedRunReporter: GovernedRunReporter | null = null

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

/**
 * Cron×stateless in-flight marker set (drained-gauge race fix). Holds the ids
 * of cron tasks that have fired but whose result has not yet been written to
 * `pendingCronResults`. `wireCronDispatch` arms an id at trigger time (before
 * the task runs, hence before completeTurn flips `activeTaskId`), and the
 * TaskLifecycle terminal listener below clears it. It ORs into the heartbeat's
 * `pendingResults` condition so the gauge never reads both `activeTask` and
 * `pendingResults` false during the window between the activeTaskId flip and
 * the cron-result store — a window in which a `drained` report would let HCC
 * suspend the pod and lose the not-yet-stored one-shot result.
 */
const cronResultsInFlight = new Set<string>()

export function resolveHostRef(task?: Task, host: HostCRD | null = currentHost): string {
  return String(task?.sourceMessage?.hostRef || host?.name || config.hostName).trim() || 'unknown'
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
 * Project the ConfigStore's active-provider credential bag into the `ApiKeys`
 * shape. ConfigStore exposes the full multi-slot credential bag (keyed by slot
 * dataKey) for the configured provider; this helper routes it into the matching
 * provider field that `createLLMProvider` reads. Multi-slot (R4): Bedrock's two
 * keys travel together in the same bag.
 */
function apiKeysFromConfigStore(store: ConfigStore): ApiKeys {
  const llm = store.llmCredentials()
  if (!llm) return {}
  return { [llm.provider]: llm.credentials }
}

// ─── R5 — provider fallback ────────────────────────────────────────────────

/** Structured WARN on every failover switch (no secrets). */
function warnOnFailoverSwitch(event: FailoverSwitchEvent): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'llm_fallback_switch',
      fromProvider: event.from.provider,
      fromModel: event.from.model,
      toProvider: event.to.provider,
      toModel: event.to.model,
      reason: event.reason,
    })
  )
}

/**
 * Set `currentPolicy`/`failoverEngine` from the Host's `spec.llmPolicy`. The
 * engine is rebuilt (resetting sticky cooldown) only when the policy actually
 * changed, so an unrelated Host edit doesn't wipe an active failover state.
 */
function refreshFailoverPolicy(host: HostCRD): void {
  const next = parseLlmPolicy(host.spec.llmPolicy)
  const changed = JSON.stringify(next) !== JSON.stringify(currentPolicy)
  currentPolicy = next
  if (!next) {
    failoverEngine = null
    bootFallbackEntry = null
    return
  }
  if (!failoverEngine) {
    failoverEngine = new FailoverEngine(next, { onSwitch: warnOnFailoverSwitch })
  } else if (changed) {
    failoverEngine.setPolicy(next)
    bootFallbackEntry = null
  }
}

/**
 * The Secret dataKeys the failover policy needs loaded from the LLM Secret: each
 * fallback's explicit `credentialSlot` override PLUS every fallback provider's
 * normal slot dataKeys (for cross-provider fallbacks the active-provider load
 * never touches). Fed to the ConfigStore, exposed via `fallbackSlotValue` only.
 */
function fallbackCredentialSlotsFor(policy: LlmPolicy | null): string[] {
  if (!policy) return []
  const set = new Set<string>()
  for (const entry of policy.fallbacks) {
    if (entry.credentialSlot) set.add(entry.credentialSlot)
    if (isLlmProvider(entry.provider)) {
      for (const slot of descriptorFor(entry.provider).credentialSlots) set.add(slot.dataKey)
    }
  }
  return [...set]
}

/**
 * Build the credential bag for a fallback entry from the LIVE ConfigStore
 * fallback-slot values (same `chatllm-api-keys` Secret). The entry's optional
 * `credentialSlot` overrides the provider's PRIMARY slot source; the remaining
 * (multi-slot) slots read their normal dataKeys. Returns null when any required
 * slot is absent → the engine skips that entry.
 */
function buildFallbackCredentials(
  store: ConfigStore,
  entry: FallbackEntry
): ProviderCredentials | null {
  if (!isLlmProvider(entry.provider)) return null
  const slots = descriptorFor(entry.provider).credentialSlots
  const creds: ProviderCredentials = {}
  slots.forEach((slot, i) => {
    const dataKey = i === 0 && entry.credentialSlot ? entry.credentialSlot : slot.dataKey
    const value = store.fallbackSlotValue(dataKey)
    if (value) creds[slot.dataKey] = value
  })
  for (const slot of slots) {
    if (slot.required && !creds[slot.dataKey]) return null
  }
  return creds
}

/**
 * R5.3 — the fallback provider factory. Builds a fresh provider for `entry`
 * from the live ConfigStore keys (rotation-safe: rebuilt per attempt). Returns
 * null when unconstructible (missing slot / unknown provider). Shared by the
 * per-task/-compact wrappers (via {@link currentFailoverSupport}) and the boot
 * resolver.
 */
function buildFallbackProvider(entry: FallbackEntry): SingleTurnProvider | null {
  if (!configStore) return null
  const creds = buildFallbackCredentials(configStore, entry)
  if (!creds) return null
  return createLLMProvider(
    { [entry.provider]: creds },
    { provider: entry.provider as LlmProvider, name: entry.model }
  )
}

/**
 * The current {@link ExecutorFailoverSupport} for the agent, or null when no
 * policy. The engine and the port builder MUST share one index space, so the
 * FULL policy is always used (never sliced): the engine iterates every target
 * and `buildFallbackPort(index)` indexes the same full `fallbacks` array. When
 * serving via a boot fallback (primary inconstructible), the earlier entries are
 * still unconstructible → `buildProvider` returns null and the engine skips
 * them; the boot entry (== the effective primary) may be retried once as a
 * harmless duplicate, then iteration advances to the later entries.
 */
function currentFailoverSupport(): {
  engine: FailoverEngine
  policy: LlmPolicy
  buildProvider: (entry: FallbackEntry) => SingleTurnProvider | null
} | null {
  if (!failoverEngine || !currentPolicy) return null
  return { engine: failoverEngine, policy: currentPolicy, buildProvider: buildFallbackProvider }
}

/**
 * R2 — the allowlist view for the resolver/endpoints. In dev mode (no
 * ConfigStore) present an unavailable allowlist so only the Host default is
 * permitted (degraded-explicit), consistent with real K8s bootstrap.
 */
const UNAVAILABLE_ALLOWLIST: AllowlistView = {
  allowlistAvailable: () => false,
  allowedModels: () => new Map(),
}
function allowlistView(): AllowlistView {
  return configStore ?? UNAVAILABLE_ALLOWLIST
}

/**
 * T3a — the allowlist view the end-user-facing R2 model endpoints project/
 * validate against: the global {@link allowlistView} narrowed to this Host's
 * `spec.allowedModels` subset (live intersection; absent/empty = full global).
 * Only the user-selection surface (`GET /v1/runtime/models` + the
 * `applySessionModelSelection` write gate) uses this; the per-task resolver
 * (`resolveTaskModel`) and the R5 failover engine keep the unfiltered global
 * view BY DESIGN — `spec.allowedModels` gates only what a user may SELECT, not
 * what already-saved selections resolve to at execution time. Consequence: if an
 * operator NARROWS the subset to drop a pair a session already saved (still
 * globally enabled), `GET /v1/runtime/models` reports it `blocked`/fell-back
 * while the running task still serves it until the user re-selects. That model
 * stays globally allowed (no privilege escalation), and the write gate keeps
 * `modelSelections` from ever persisting an out-of-subset pair in the first
 * place. To make the subset an execution boundary too, switch this resolver to
 * `hostAllowlistView()` — deliberately NOT done here (out of R2 scope).
 */
function hostAllowlistView(): AllowlistView {
  return hostSubsetAllowlistView(allowlistView(), currentHost?.spec.allowedModels)
}

/**
 * R2.9(a) — build a provider instance for a specific model within the Host's
 * configured provider, reading the LIVE ConfigStore keys. Called per task by
 * {@link resolveTaskModel}, so a key rotation never reverts a session's
 * selection: the next task rebuilds with the new key. Returns null when no Host
 * model is configured or the key/provider is unavailable.
 */
function buildProviderForModel(model: string): SingleTurnProvider | null {
  const modelCfg = currentHost?.spec.model
  if (!modelCfg?.provider) return null
  const keys = configStore ? apiKeysFromConfigStore(configStore) : currentKeys
  return createLLMProvider(keys, { provider: modelCfg.provider, name: model })
}

/**
 * R2 — the per-task model resolver injected into the agent. Turns a session's
 * saved `{ provider → model }` selection into the concrete provider instance +
 * effective model + context window for the task. Falls back to the Host default
 * when the saved model is no longer allowed (blocked) or absent.
 */
function resolveTaskModel(
  selections: Record<string, string> | undefined
): ResolvedTaskModel | null {
  const modelCfg = currentHost?.spec.model
  if (!modelCfg?.provider || !modelCfg.name) return null
  const view = allowlistView()
  // R5.10 — boot fallback: the primary is inconstructible, so serve the boot
  // fallback pair (cross-provider → ignore the session selection, R5.4). The
  // runtime failover engine (currentFailoverSupport) still advances from here.
  if (bootFallbackEntry && currentProvider) {
    return {
      provider: currentProvider,
      model: bootFallbackEntry.model,
      contextWindowTokens: contextWindowForModel(
        view,
        bootFallbackEntry.provider,
        bootFallbackEntry.model
      ),
    }
  }
  const { model } = resolveSessionModel(view, modelCfg.provider, modelCfg.name, selections)
  const contextWindowTokens = contextWindowForModel(view, modelCfg.provider, model)
  // Hot-path short-circuit (review nit): when the resolution lands on the Host
  // default, reuse the process provider instead of constructing a fresh
  // instance per task. Rotation-safe: onChange rebuilds currentProvider too.
  if (model === modelCfg.name && currentProvider) {
    return { provider: currentProvider, model, contextWindowTokens }
  }
  const provider = buildProviderForModel(model)
  if (!provider) return null
  return { provider, model, contextWindowTokens }
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
    allowlistConfigMapName: config.llmAllowlistConfigMapName,
    // R5 — load the failover policy's referenced credential slots from the same
    // LLM Secret (kept out of the effective env; read via fallbackSlotValue).
    fallbackCredentialSlots: fallbackCredentialSlotsFor(currentPolicy),
  })
  await store.start()
  configStore = store

  // R3.7 — non-disruptive signal: warn (+ metric) if this Host's configured
  // model is not in the operator allowlist. No enforcement here; the hard gate
  // lives in control-api/WRC. Re-checked on every allowlist reload below.
  signalHostModelAllowlist(store, host.spec.model)

  // Hot reload: rebuild the LLM provider on key rotation. The agent receives
  // a swapped provider via setLLMProvider; in-flight requests finish on the
  // old client (already dispatched), the next task uses the new one.
  store.onChange(({ llmKeyChanged, allowlistChanged }) => {
    // R3.7 — re-evaluate the Host model against the freshly-loaded allowlist.
    if (allowlistChanged && currentHost) signalHostModelAllowlist(store, currentHost.spec.model)
    if (!llmKeyChanged || !currentHost) return
    const keys = apiKeysFromConfigStore(store)
    currentKeys = keys
    const next = createLLMProvider(keys, currentHost.spec.model)
    if (!next) {
      console.error('[Main] LLM provider rebuild failed after key rotation — Host may be degraded')
      return
    }
    currentProvider = next
    // R5.10 — the primary is now constructible again (key rotated/fixed): clear
    // any boot fallback so tasks resume on the primary, and clear the sticky
    // cooldown so the recovered primary is retried immediately instead of
    // waiting out a cooldown it never truly earned (the key was missing/invalid,
    // the provider was not "down"). Status stops reporting the boot fallback.
    bootFallbackEntry = null
    failoverEngine?.clearCooldown()
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
 *
 * `llmConfigChanged` (R5.10) — set by `onHostChange` ONLY when the primary's
 * credential surface actually changed (secretRef/provider), so a recovered
 * primary can clear a sticky runtime cooldown. It is deliberately NOT set on
 * unrelated Host edits (channels/approval/personalization…), which also reinit
 * the provider but must NOT wipe an active cooldown (would defeat the V13
 * anti-flapping invariant). Boot callers omit it — the engine has no cooldown
 * yet, so clearing there would be a no-op.
 */
async function initializeProvider(
  host: HostCRD,
  keys: ApiKeys,
  opts?: { llmConfigChanged?: boolean }
): Promise<void> {
  currentHost = host
  currentKeys = keys

  console.log(`[Main] Initializing provider for host: ${host.spec.host}`)
  console.log(`[Main] Model config:`, host.spec.model)
  console.log(`[Main] Context ref: ${host.spec.contextRef}`)

  currentProvider = createLLMProvider(keys, host.spec.model)
  bootFallbackEntry = null

  // R5.10 — boot with fallback (Q8 ratified): if the PRIMARY is inconstructible
  // at boot (key/slot absent), resolve the first constructible fallback entry
  // and serve by it (badge/metric/WARN from the first message). Degraded
  // `llm_key_missing` is reserved for when NO entry (primary nor fallbacks) is
  // constructible. A key that is present-but-invalid (401) is not detectable at
  // boot; it surfaces on the first task and the runtime failover handles it.
  let effectiveModel = host.spec.model?.name
  if (!currentProvider && currentPolicy?.fallbacks.length) {
    for (const entry of currentPolicy.fallbacks) {
      const provider = buildFallbackProvider(entry)
      if (!provider) continue
      currentProvider = provider
      bootFallbackEntry = entry
      effectiveModel = entry.model
      // servedBy status in boot-fallback mode is projected from
      // `bootFallbackEntry` directly (getStatus); the engine's runtime served
      // state is set by engine.run once tasks start.
      llmFallbackTotal.inc({
        from: `${host.spec.model?.provider ?? 'unknown'}/${host.spec.model?.name ?? 'unknown'}`,
        to: `${entry.provider}/${entry.model}`,
        reason: 'boot',
      })
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'llm_fallback_boot',
          fromProvider: host.spec.model?.provider ?? null,
          fromModel: host.spec.model?.name ?? null,
          toProvider: entry.provider,
          toModel: entry.model,
        })
      )
      break
    }
  }

  if (currentProvider) {
    console.log(
      bootFallbackEntry
        ? '[Main] LLM primary inconstructible — serving via boot fallback'
        : '[Main] LLM provider initialized successfully'
    )

    // R5.10 — the primary's credentials just changed (secretRef/provider) and it
    // is constructible again while NOT in boot-fallback mode. Clear any sticky
    // RUNTIME cooldown the engine may still hold from a prior failure so the
    // recovered primary is retried on the very next task instead of waiting it
    // out. The `store.onChange` clearCooldown path (ensureConfigStore) only fires
    // on a key rotation of an ALREADY-built ConfigStore; a `secretRefChanged`
    // rebuilds the store fresh, so its onChange never runs for the fix — this is
    // the path that covers that gap. Gated on `llmConfigChanged` so an unrelated
    // Host edit (which also reinitializes the provider) does NOT wipe a still-
    // valid cooldown of a genuinely-down primary (anti-flapping, V13).
    if (!bootFallbackEntry && opts?.llmConfigChanged) {
      failoverEngine?.clearCooldown()
    }

    // Update agent with new provider
    if (agent) {
      agent.setLLMProvider(currentProvider, effectiveModel)
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

const mcpFleetCoordinator = new AuthoritativeMcpFleetCoordinator(
  DEFAULT_MCP_FLEET_RECONCILE_MAX_CONCURRENCY,
  DEFAULT_MCP_FLEET_RECONCILE_MAX_CONCURRENCY,
  true
)

/**
 * Admit development MCP servers independently.
 *
 * McpManager.addServer propagates connection failures so production fleet
 * reconciliation can leave a failed revision retryable. Development startup
 * has no authoritative polling loop, so one unavailable optional server must
 * not prevent the remaining servers or the host itself from starting.
 */
export async function admitDevelopmentMcpServers(
  servers: McpServerInfo[],
  manager: Pick<McpManager, 'addServer'>
): Promise<void> {
  for (const server of servers) {
    try {
      await manager.addServer(server)
    } catch (error) {
      console.error(`[Main] Dev MCP server admission failed; continuing: ${server.name}`, error)
    }
  }
}

function ensureAuthenticatedContextMapperClient(): ContextMapperClient {
  if (contextMapperClient) return contextMapperClient
  if (!runtimeAuth) runtimeAuth = createMcpHostRuntimeAuth()
  if (!runtimeAuth) {
    throw new Error('MCP Host runtime authentication is required for HCC inventory')
  }
  const auth = runtimeAuth
  contextMapperClient = getContextMapperClient({
    getAccessToken: () => auth.accessToken,
    refreshOnUnauthorized: () => refreshWithRecovery(auth),
    onCallerAuthorizationFailure: status => revokeMcpAuthority(`caller_${status}`, true),
  })
  return contextMapperClient
}

export function isMcpAuthorityStale(
  lastSuccessAt: number,
  now: number,
  maxStalenessMs: number
): boolean {
  return (
    lastSuccessAt > 0 &&
    Number.isFinite(now) &&
    Number.isFinite(maxStalenessMs) &&
    maxStalenessMs > 0 &&
    now - lastSuccessAt >= maxStalenessMs
  )
}

/**
 * Arm an absolute authority deadline from the last successful HCC snapshot.
 * The independent timeout prevents a slow or failed polling cadence from
 * extending retained authority beyond the configured staleness ceiling.
 */
export function createMcpAuthorityStalenessDeadline(
  maxStalenessMs: number,
  onExpired: () => void,
  now: () => number = Date.now
): { recordSuccess(successAt?: number): void; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let deadlineAt = 0

  const clear = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    deadlineAt = 0
  }

  const schedule = (): void => {
    const remaining = deadlineAt - now()
    timer = setTimeout(
      () => {
        timer = null
        if (now() < deadlineAt) {
          schedule()
          return
        }
        deadlineAt = 0
        onExpired()
      },
      Math.max(0, remaining)
    )
  }

  return {
    recordSuccess: (successAt = now()) => {
      clear()
      if (!Number.isFinite(successAt) || !Number.isFinite(maxStalenessMs) || maxStalenessMs <= 0) {
        return
      }
      deadlineAt = successAt + maxStalenessMs
      schedule()
    },
    clear,
  }
}

const mcpAuthorityStalenessDeadline = createMcpAuthorityStalenessDeadline(
  config.hccAuthorityMaxStalenessMs,
  () => {
    if (!isShuttingDown && !config.devMode && mcpManager) {
      revokeMcpAuthority('authority_stale_deadline', true)
    }
  }
)

function recordMcpAuthoritySuccess(successAt: number = Date.now()): void {
  mcpAuthorityLastSuccessAt = successAt
  if (!config.devMode) mcpAuthorityStalenessDeadline.recordSuccess(successAt)
}

/**
 * Revoke the complete locally-published MCP authority before awaiting any
 * transport cleanup. A fresh poller may recover later with a newly verified
 * Host JWT and live Host -> Context grant snapshot.
 */
function revokeMcpAuthority(reason: string, restartPolling: boolean): void {
  mcpInitializationGeneration += 1
  stopContextMapperPolling()
  mcpAuthorityStalenessDeadline.clear()
  const closingManager = mcpManager
  mcpManager = null
  lastServerState = new Map()
  mcpAuthorityLastSuccessAt = 0

  if (closingManager) {
    mcpFleetCoordinator.closeManager(closingManager)
    void closingManager
      .close(cleanup => mcpFleetCoordinator.scheduleCleanup(cleanup))
      .catch(() => console.error(`[Main] MCP authority cleanup failed (reason=${reason})`))
  }
  console.warn(`[Main] MCP authority revoked (reason=${reason})`)

  if (restartPolling && !isShuttingDown && !config.devMode) {
    startContextMapperPolling()
  }
}

async function initializeMcpServers(): Promise<void> {
  console.log('[Main] Initializing authenticated MCP server inventory')
  const initializationGeneration = ++mcpInitializationGeneration
  const isInitializationCurrent = (): boolean =>
    !isShuttingDown && mcpInitializationGeneration === initializationGeneration

  const replaceFleet = async (servers: McpServerInfo[]): Promise<void> => {
    const previousManager = mcpManager
    await replaceAuthoritativeMcpFleet({
      servers,
      previousManager,
      createManager: () => new McpManager(config.mcpProxyEnabled ? config.mcpProxyUrl : undefined),
      getAuthToken: async (serverName, expectedRevision) => {
        return ensureAuthenticatedContextMapperClient().getAuthToken(serverName, expectedRevision)
      },
      installFleet: (nextManager, nextServerState) => {
        mcpManager = nextManager
        lastServerState = nextServerState
        recordMcpAuthoritySuccess()
        agent?.setMcpManager(nextManager)
      },
      coordinator: mcpFleetCoordinator,
      onColdStartPublished: () => ensureContextMapperPolling(),
      isPreviousManagerCurrent: () => mcpManager === previousManager,
      isFleetLifecycleCurrent: isInitializationCurrent,
    })
  }

  // In production mode, fetch an authoritative snapshot before replacing the
  // current fleet. An unavailable Context Mapper leaves the prior state intact.
  if (!config.devMode) {
    const client = ensureAuthenticatedContextMapperClient()

    await runAuthoritativeMcpInitialization({
      client,
      replaceFleet,
      isCurrent: isInitializationCurrent,
    })
  } else {
    await replaceFleet([])
  }

  // Successful discovery always installs a manager, including an
  // authoritative HTTP 200 empty snapshot.
  if (!mcpManager) {
    throw new Error('MCP manager was not installed after authoritative discovery')
  }
  const connectedServers = mcpManager.getConnectedServers()
  console.log(
    config.devMode
      ? `[Main] Connected to ${connectedServers.length} MCP server(s)`
      : `[Main] Published the initial MCP fleet manager with ${connectedServers.length} currently connected server(s); background reconciliation may still be in progress`
  )

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
async function pollContextMapper(): Promise<void> {
  if (!contextMapperClient) return

  try {
    // Cold-start discovery failures intentionally leave the manager unset.
    // Retry the authoritative initialization instead of declaring an empty
    // fleet or permanently no-oping every reconciliation tick.
    if (!mcpManager) {
      await initializeMcpServers()
      return
    }

    const manager = mcpManager
    await pollAuthoritativeMcpSnapshotIfCurrent({
      poll: () => contextMapperClient!.pollServers(),
      // A delayed fetch may resolve after shutdown or after a manager swap.
      // Never publish that stale snapshot into a closed/retired manager.
      isCurrent: () => !isShuttingDown && mcpManager === manager,
      reconcile: servers =>
        reconcileAuthoritativeMcpSnapshot({
          servers,
          manager,
          serverState: lastServerState,
          getAuthToken: (serverName, expectedRevision) =>
            contextMapperClient!.getAuthToken(serverName, expectedRevision),
          coordinator: mcpFleetCoordinator,
        }),
    })
    if (!isShuttingDown && mcpManager === manager) {
      recordMcpAuthoritySuccess()
    }
  } catch (error) {
    if (error instanceof ContextMapperRequestError && error.authorizationFailure) {
      // ContextMapperClient already revoked synchronously through its callback.
      console.warn('[Main] HCC poll rejected caller authority')
      return
    }
    if (isContextMapperInventoryAuthorityRevocation(error)) {
      revokeMcpAuthority('inventory_not_found', true)
      console.warn('[Main] HCC inventory no longer resolves live Host authority')
      return
    }
    console.error('[Main] HCC authority poll failed (reason=unavailable)')
    if (
      mcpManager &&
      isMcpAuthorityStale(mcpAuthorityLastSuccessAt, Date.now(), config.hccAuthorityMaxStalenessMs)
    ) {
      revokeMcpAuthority('authority_stale', true)
    }
  }
}

/**
 * Serialize periodic polling while coalescing any number of overlapping ticks
 * into at most one trailing run. This keeps reconciliation bounded without
 * losing the latest post-flight snapshot opportunity.
 */
export function createCoalescedPollRunner(poll: () => Promise<void>): {
  trigger(): void
  stop(): void
} {
  let inFlight = false
  let trailing = false
  let stopped = false

  const trigger = (): void => {
    if (stopped) return
    if (inFlight) {
      trailing = true
      return
    }

    inFlight = true
    void poll()
      .catch(error => {
        console.error('[Main] Context Mapper poll runner failed:', error)
      })
      .finally(() => {
        inFlight = false
        if (trailing && !stopped) {
          trailing = false
          trigger()
        }
      })
  }

  return {
    trigger,
    stop: () => {
      stopped = true
      trailing = false
    },
  }
}

/**
 * Start polling context-mapper for McpServer changes.
 */
export function startContextMapperPolling(): void {
  if (isShuttingDown) return
  // Re-entry replaces the complete producer/runner pair. Stopping only the
  // runner would leave the previous interval dispatching into the new runner.
  stopContextMapperPolling()

  console.log(
    `[Main] Starting context-mapper polling (interval: ${config.contextMapperPollInterval}ms)`
  )

  contextMapperPollRunner = createCoalescedPollRunner(() => pollContextMapper())
  contextMapperPollTimer = setInterval(() => {
    contextMapperPollRunner?.trigger()
  }, config.contextMapperPollInterval)
}

export function ensureContextMapperPolling(): void {
  if (isShuttingDown || (contextMapperPollTimer && contextMapperPollRunner)) return
  startContextMapperPolling()
}

/**
 * Stop polling context-mapper.
 */
export function stopContextMapperPolling(): void {
  if (contextMapperPollTimer) {
    console.log('[Main] Stopping context-mapper polling')
    clearInterval(contextMapperPollTimer)
    contextMapperPollTimer = null
  }
  contextMapperPollRunner?.stop()
  contextMapperPollRunner = null
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

  const contextChanged =
    currentHost !== null && currentHost.spec.contextRef !== host.spec.contextRef
  const providerChanged = currentHost?.spec.model?.provider !== host.spec.model?.provider
  const secretRefChanged = currentHost?.spec.secretRef !== host.spec.secretRef
  const modelChanged = currentHost?.spec.model?.name !== host.spec.model?.name

  if (contextChanged) {
    // The old Context's authority must disappear before any asynchronous Host
    // reconciliation. HCC derives the new Context from the authenticated Host,
    // so discovery can restart independently while provider state catches up.
    revokeMcpAuthority('context_changed', false)
    startMcpInitializationInBackground({
      initialize: () => initializeMcpServers(),
      afterInitialAttempt: () => ensureContextMapperPolling(),
    })
  }

  // R5 — refresh the failover policy BEFORE (re)building the ConfigStore so the
  // fallback credential slots are loaded. A policy change that alters which
  // Secret slots are needed forces a ConfigStore rebuild even if provider/
  // secretRef are unchanged.
  const prevFallbackSlots = fallbackCredentialSlotsFor(currentPolicy)
  refreshFailoverPolicy(host)
  const fallbackSlotsChanged =
    JSON.stringify(prevFallbackSlots) !== JSON.stringify(fallbackCredentialSlotsFor(currentPolicy))
  if (!configStore || providerChanged || secretRefChanged || fallbackSlotsChanged) {
    console.log('[Main] Rebuilding ConfigStore (provider/secretRef/failover slots changed)')
    await ensureConfigStore(host)
  }
  currentKeys = apiKeysFromConfigStore(configStore!)
  // R5.10 — only a primary credential-surface change (secretRef/provider) may
  // clear a sticky runtime cooldown; unrelated CR edits must not (see
  // initializeProvider). A `secretRefChanged` rebuilds the ConfigStore fresh, so
  // the store.onChange clearCooldown path never fires for it — this covers it.
  await initializeProvider(host, currentKeys, {
    llmConfigChanged: secretRefChanged || providerChanged,
  })

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
  revokeMcpAuthority('host_deleted', false)
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
  governedRunReporter = createGovernedRunReporter(config.governedTracingEnabled, {
    baseUrl: auth.baseUrl,
    getAccessToken: () => auth.accessToken,
    refreshOnUnauthorized: () => refreshWithRecovery(auth),
  })
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
  if (governedRunReporter) agent.setGovernedRunReporter(governedRunReporter)
  agent.setApprovalPromptHistoryClient(
    new ApprovalPromptHistoryClient({
      baseUrl: auth.baseUrl,
      getAccessToken: () => auth.accessToken,
      refreshOnUnauthorized: () => refreshWithRecovery(auth),
      enabled: config.approvalPromptHistoryEnabled,
      maxBytes: config.approvalPromptHistoryMaxBytes,
    })
  )
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
 * Resolve the absolute path where `state.db` should live. D3 §1.2 precedence:
 * `CLERUM_SESSION_DB_DIR` (dedicated PVC mount injected by HCC) → explicit
 * `CLERUM_SESSION_DB_PATH` → the workspace PVC → tmpdir fallback (dev/test
 * only; forbidden — throws — under the stateless lifecycle).
 */
function resolveSessionDbPath(): string {
  const memoryCfg = currentHost?.spec.memory || config.memory
  const wp = memoryCfg?.workspacePath ?? config.memory.workspacePath
  return resolveSessionDbPathFrom({
    statelessLifecycle: config.statelessLifecycle,
    sessionDbDir: config.sessionDbDir,
    sessionDbPath: config.sessionDbPath,
    workspaceMemoryEnabled: memoryCfg?.enabled === true,
    workspacePath: wp ?? '',
    tmpFallbackPath: path.join(require('node:os').tmpdir(), 'clerum-state.db'),
  })
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

  // D3 §1.1 — durability barrier (PRAGMA synchronous = FULL): always on under
  // the stateless lifecycle; always-on Hosts opt in via CLERUM_DB_BARRIER_MODE=full.
  const barrierMode = config.statelessLifecycle || config.dbBarrierModeFull
  const handle = createConversationStore({
    mode: config.sessionStoreMode,
    dbPath,
    cacheSize: config.conversationCacheSize,
    syncTimeoutMs: config.dbPersistSyncTimeoutMs,
    asyncTimeoutMs: config.dbPersistAsyncTimeoutMs,
    checkpointEveryWrites: config.dbCheckpointEveryWrites,
    heartbeatMs: config.dbWorkerHeartbeatMs,
    pendingApprovalTtlMs: config.pendingApprovalTtlMs,
    barrierMode,
  })

  agent.setConversationStore(handle.store)
  console.log(
    `[Main] Conversation store mode=${handle.mode} dbPath=${dbPath} ` +
      `cacheSize=${config.conversationCacheSize} barrierMode=${barrierMode ? 'full' : 'normal'}`
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

  // R2 — inject the per-task model resolver. Closes over the module globals
  // (currentHost + configStore) so it always reads the live keys/allowlist; a
  // key rotation or allowlist reload is picked up on the next task with no
  // re-wiring. Set once here (the agent is created once).
  agent.setTaskModelResolver(resolveTaskModel)

  // R5 — inject the provider-fallback support. Closes over the module globals
  // (currentPolicy/failoverEngine/bootFallbackEntry + configStore) so each task
  // reads the live policy + sticky failover state. Null when no policy.
  agent.setFailoverSupport(currentFailoverSupport)

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
  cronScheduler = new CronScheduler(messageQueue, { statelessLifecycle: config.statelessLifecycle })
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
    cronResultsInFlight,
  })

  // Cron×stateless drained-gauge race fix: clear the in-flight marker on the
  // task's terminal lifecycle transition. On success this fires AFTER the cron
  // responseCallback has stored the result in pendingCronResults (which then
  // pins the gauge on its own), closing the window without double-counting; on
  // failure/cancel it fires with no result produced, correctly unpinning. A
  // non-cron task's id is simply never in the set, so this is a cheap no-op for
  // channel/sync/async tasks.
  taskLifecycle!.on('transition', (event: TransitionEvent) => {
    if (isTerminal(event.to)) {
      cronResultsInFlight.delete(event.taskId)
    }
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
  // Fail closed: accepting traffic with durable approvals present but no
  // reconstructed executor would strand decisions and break trace continuity.
  await agent.bootstrap()

  // Start the agent
  agent.start()
  cronScheduler.start()

  console.log('[Main] Agent and cron scheduler started')
}

// R2 — thin wrapper that injects live process state (current Host model config,
// allowlist snapshot, conversation manager) into the shared, dependency-injected
// `applySessionModelSelectionCore`. Both the `POST /v1/runtime/model` route
// (`handleSetModel`) and the piggybacked `message.model` path in
// `handleIncomingMessage` go through here so they cannot diverge.
function applySessionModelSelection(
  userSub: string,
  hostRef: string,
  chatId: string | undefined,
  model: string
): Promise<SetModelResult> {
  return applySessionModelSelectionCore(
    {
      modelCfg: currentHost?.spec.model,
      // T3a — validate the requested model against the host SUBSET
      // (spec.allowedModels ∩ global), not the full global. Covers both the
      // `POST /v1/runtime/model` route and the piggybacked `message.model` write.
      allowlistView: hostAllowlistView(),
      convManager: agent!.getConversationManager(),
    },
    userSub,
    hostRef,
    chatId,
    model
  )
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

  const runHandler = (): MessageResponse | Promise<MessageResponse> => {
    const handler = new IncomingMessageHandler(normalizedMessage, {
      messageQueue: messageQueue!,
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

  // R2 — piggybacked per-session model. Because a suspended Host can't serve
  // `POST /v1/runtime/model`, the desktop rides the user's pick on the message
  // that wakes us. Apply it to THIS session and AWAIT the write BEFORE the task
  // is created, so the per-task resolver (`stateMachine` taskModelResolver over
  // `conv.modelSelections`) reads the row we just wrote. Fail-OPEN on the
  // message: a rejected/degraded selection is logged and ignored, never dropping
  // the user's turn (fail-closed only on the selection, inside the helper).
  const piggybackModel = typeof message.model === 'string' ? message.model.trim() : ''
  if (piggybackModel && normalizedMessage.channelType === 'rpc') {
    return (async () => {
      try {
        const applied = await applySessionModelSelection(
          normalizedMessage.sender,
          normalizedMessage.channelId,
          normalizedMessage.threadId,
          piggybackModel
        )
        if (!applied.ok) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'message_model_ignored',
              userId: normalizedMessage.sender,
              chatId: normalizedMessage.threadId ?? null,
              provider: applied.provider,
              model: piggybackModel,
              reason: applied.reason,
            })
          )
        }
      } catch (error) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'message_model_ignored',
            userId: normalizedMessage.sender,
            chatId: normalizedMessage.threadId ?? null,
            provider: currentHost?.spec.model?.provider ?? 'unknown',
            model: piggybackModel,
            reason: 'apply_failed',
            error: error instanceof Error ? error.message : String(error),
          })
        )
      }
      return runHandler()
    })()
  }

  return runHandler()
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
    // D8 delivered-on-read: this poll RETURNED the terminal result to its
    // verified owner — from here the entry is recoverability cache, not
    // pending work. Stamp it (idempotent, NO delete: repeat polls keep
    // replaying it for the TTL) so the stateless pendingResults gauge unpins
    // now instead of blocking suspend for the full 10-min TTL.
    markResultDelivered(result)
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

/**
 * Each code is bound to the ONE status control-api emits it with. A pair that
 * does not match exactly (403 medium_account_not_found, 404
 * communication_channel_access_denied) is 'error', so a code reused later under a
 * different status with a different meaning cannot silently widen this whitelist.
 */
const UNRESOLVED_BROKER_CODE_STATUS = new Map<string, number>([
  ['medium_account_not_found', 404],
  ['communication_channel_access_denied', 403],
])

/**
 * An unlinked or access-denied identity reaches us as a THROWN 404/403 from the
 * broker, not as a null context. Only these map to 'unresolved'; everything else
 * (5xx, timeouts, network failures, unrecognized codes) is 'error', which keeps
 * channel-reader silent so a control-api outage never tells linked users they are
 * unlinked.
 */
export function classifyAuthorizationFailure(error: unknown): 'unresolved' | 'error' {
  if (error instanceof WorkflowBrokerRequestError && error.code) {
    const expectedStatus = UNRESOLVED_BROKER_CODE_STATUS.get(error.code)
    // `expectedStatus !== undefined` first: an unrecognized code lookup and a
    // missing status would otherwise compare undefined === undefined and classify
    // 'unresolved'.
    if (expectedStatus !== undefined && expectedStatus === error.status) {
      return 'unresolved'
    }
  }
  return 'error'
}

export async function handleProviderMessageAuthorization(
  input: ProviderMessageAuthorization
): Promise<{ authorized: boolean; reason?: 'unresolved' | 'error' }> {
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
    if (context?.targetUserId) {
      return { authorized: true }
    }
    // A null context is unreachable for validated Slack traffic: channel-reader's
    // handoff validation already rejects malformed provider identities before this
    // runs. Treat it as 'error' (fail closed, stay silent) rather than invent a
    // reason we cannot substantiate.
    return { authorized: false, reason: 'error' }
  } catch (error) {
    const reason = classifyAuthorizationFailure(error)
    console.warn(
      `[Main] Provider message authorization failed closed (${reason}): ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return { authorized: false, reason }
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
    content: input.workflowRunId
      ? 'Download the completed workflow result'
      : `Download workflow result for ${input.workflowName}`,
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
  const result = input.workflowRunId
    ? await tool.executeForRun(input.workflowRunId, input.artifactName)
    : await tool.execute({ name: input.workflowName })
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
    // D8 delivered-on-read: the caller fetched this cron result. Stamp it
    // BEFORE markFileAttachmentsDelivered (which re-sets a spread copy) so
    // the stamp survives. A read is delivery — the explicit ACK delete below
    // remains the strong consumption signal; the stamp only unpins the
    // stateless pendingResults idle gauge.
    markResultDelivered(entry)
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

  // R2 — project the Host's configured (default) provider/model. Optional field;
  // the per-session selection is served separately by GET /v1/runtime/models.
  const modelCfg = currentHost?.spec.model
  const model =
    modelCfg?.provider && modelCfg.name
      ? { provider: modelCfg.provider, name: modelCfg.name }
      : undefined

  // R5 — project the pair currently serving when a failover policy is wired.
  // `fallback: true` drives the desktop "operating with fallback" badge. In
  // boot-fallback mode the engine treats the boot entry as its "primary", so its
  // servedBy would read fallback:false after the first task — project the boot
  // fallback directly to keep the badge on until the real primary recovers.
  let servedBy: StatusResponse['servedBy']
  if (currentPolicy) {
    if (bootFallbackEntry && currentProvider) {
      servedBy = {
        provider: bootFallbackEntry.provider,
        name: bootFallbackEntry.model,
        fallback: true,
      }
    } else {
      const served = failoverEngine?.servedBy()
      servedBy = served
        ? { provider: served.provider, name: served.model, fallback: served.fallback }
        : undefined
    }
  }

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
    model,
    servedBy,
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
  // R5.10 — serving via a boot fallback is NOT degraded: the primary key is
  // absent but a constructible fallback entry is answering. Degraded
  // `llm_key_missing` is reserved for when NO entry (primary nor fallbacks) is
  // constructible.
  if (bootFallbackEntry && currentProvider) return null
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
  // D.1 — the shared session-liveness projection (`sessionStateView`) and the
  // two session-read handlers now live in `createSessionRouteHandlers`
  // (src/server/sessionRouteHandlers.ts) so they can be unit-tested against a
  // real ConversationManager. `redactToolError` stays here (it closes over the
  // operator secret list) and is injected into the factory below.

  // #582: redact a persisted tool error before it reaches the `/messages` wire,
  // mirroring the live SSE path exactly: `sanitizeOutput` scrubs secret values
  // (operator-configured + built-in patterns), then `sanitizeError` strips
  // stacks/paths and truncates. The persisted `tc.error` is raw at rest
  // (reconstruct.ts), so this is the enforcement point for the P1-1 boundary.
  const toolErrorSafety = new BasicSafety(() => configStore?.listSecretEntries() ?? [])
  const redactToolError = (toolName: string, rawError: string): string =>
    sanitizeError(toolErrorSafety.sanitizeOutput(toolName, rawError).content)

  const { handleSessionsList, handleSessionMessages } = createSessionRouteHandlers({
    getConversationManager: () => agent!.getConversationManager(),
    redactToolError,
  })

  const handleContextBreakdown = async (userSub: string, agentName: string, chatId: string) => {
    const convManager = agent!.getConversationManager()
    // Same O(1) key lookup + ownership check as handleSessionMessages: userSub
    // comes from the verified edge caller and must match persisted ownership.
    const key = `${userSub}:rpc:${agentName}:${chatId}`
    const conversation = await convManager.getSessionByKeyForUserAsync(key, userSub)
    if (!conversation) return null
    // `breakdown: null` when the session exists but has no snapshot yet (cold-load
    // before the first turn) — distinct from the 404 the route returns for a
    // non-existent / cross-user session.
    return { breakdown: projectContextBreakdown(conversation) ?? null }
  }

  // R2 — GET /v1/runtime/models. Projects the in-memory allowlist for the Host's
  // provider + the per-session selection (when chatId is passed). The session
  // key is built server-side from the verified edge user + hostRef (never a
  // client param), same anti-enumeration contract as the other session reads.
  //
  // KEY-DERIVATION CONTRACT: the "agent" slot is `hostRef`. This MUST match the
  // task's session key, whose `channelId` slot the desktop app populates with the
  // same rpc `hostRef` (desktop-app appService: `channelId: targetHostRef`), so
  // `resolveTaskSessionKey` and this lookup resolve the same row. hostRef comes
  // from the edge caller (guard-pinned to this pod), never the client body — so
  // this is stricter than /messages (which trusts the client `:agent` param).
  const handleModelsList = async (userSub: string, hostRef: string, chatId: string | undefined) => {
    const modelCfg = currentHost?.spec.model
    const provider = modelCfg?.provider ?? 'unknown'
    const hostDefault = modelCfg?.name ?? 'unknown'
    // T3a — project the host's SUBSET (spec.allowedModels ∩ global), not the
    // full global, so the desktop selector only offers what this host allows.
    const view = hostAllowlistView()
    const { degraded, models } = projectModels(view, provider, hostDefault)
    let sessionModel: string | null = null
    let sessionModelBlocked: string | undefined
    if (chatId && modelCfg?.provider && modelCfg.name) {
      const key = serializeSessionKey({
        userId: userSub,
        channelType: 'rpc',
        channelId: hostRef,
        threadId: chatId,
      })
      const conversation = await agent!
        .getConversationManager()
        .getSessionByKeyForUserAsync(key, userSub)
      const saved = conversation?.modelSelections?.[provider]
      if (saved) {
        const resolution = resolveSessionModel(
          view,
          provider,
          hostDefault,
          conversation!.modelSelections
        )
        // Saved-but-no-longer-allowed → fall back to the Host default and surface
        // the stale choice as `sessionModelBlocked` so the UI can explain it.
        if (resolution.blocked) sessionModelBlocked = resolution.blocked
        else sessionModel = saved
      }
    }
    return { provider, hostDefault, sessionModel, sessionModelBlocked, degraded, models }
  }

  // R2 — POST /v1/runtime/model. Thin route adapter over the shared
  // `applySessionModelSelection` core (validate model ∈ allowlist, fail-closed;
  // degraded → only the Host default; persist the per-session selection; report
  // next-task effectivity). The same core also runs for a piggybacked
  // `message.model` in `handleIncomingMessage`, so the two paths cannot diverge.
  const handleSetModel = (userSub: string, hostRef: string, chatId: string, model: string) =>
    applySessionModelSelection(userSub, hostRef, chatId, model)

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
  rpcServer.onModelsList(handleModelsList)
  rpcServer.onSetModel(handleSetModel)
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
 * Stage 3 (stateless-agents) — start the push heartbeat emitter and wire the
 * reversible DRAINING fence into the runtime intake route. No-op unless
 * CLERUM_STATELESS_LIFECYCLE=true. Fails loud on missing prerequisites: a
 * stateless Host that cannot report activity would poison HCC's suspend
 * decisions, so degrading silently is not an option.
 */
function startStatelessHeartbeat(): void {
  if (!config.statelessLifecycle) return
  if (!rpcServer) {
    throw new Error(
      '[Main] startStatelessHeartbeat requires the RPC server to be constructed first'
    )
  }
  const handle = conversationStoreHandle
  if (!handle) {
    throw new Error(
      '[Main] CLERUM_STATELESS_LIFECYCLE=true requires CLERUM_SESSION_STORE=sqlite|dual — ' +
        'the heartbeat activity conditions come from the durable conversation store'
    )
  }
  const persistQueue = handle.persistQueue
  if (!persistQueue) {
    throw new Error(
      '[Main] stateless heartbeat requires the sqlite persist queue for the final drain checkpoint'
    )
  }
  // Guaranteed by the startup guard; re-checked here so this function fails
  // loud even if invoked outside the guarded boot path.
  const gatewayBaseUrl = config.mcpHostGatewayUrl
  if (!gatewayBaseUrl) {
    throw new Error(
      '[Main] CLERUM_STATELESS_LIFECYCLE=true requires MCP_HOST_GATEWAY_URL — the heartbeat ' +
        "targets control-api's /mcp-host facade via the workflow-approval gateway"
    )
  }
  // Share the refreshing runtime-auth holder used by every other runtime
  // consumer (approvals, usage). auth.accessToken is updated IN PLACE by the
  // refresh path (persistRotatedTokens handles rotation-on-use), so the
  // heartbeat always presents a live token — unlike a static process.env read,
  // which freezes at boot and 401s once the ~300s access token expires.
  if (!runtimeAuth) runtimeAuth = createMcpHostRuntimeAuth()
  const heartbeatAuth = runtimeAuth!
  // Arm the proactive refresher HERE — the heartbeat is a first-class runtime
  // token consumer and must not depend on setupUsageReporting()/workflow mode
  // (which early-return in a conversational stateless host) to keep the shared
  // access token live. Idempotent: safe to double-arm if another path already did.
  startRuntimeAuthProactiveRefresh(heartbeatAuth)
  const heartbeat = new StatelessHeartbeat({
    enabled: true,
    hostRef: config.hostName,
    podUid: config.podUid,
    gatewayBaseUrl,
    intervalMs: config.statelessHeartbeatIntervalMs,
    // Read the CURRENT access token from the shared runtime-auth holder each
    // tick. It is refreshed in place by the runtime auth path, so an expired
    // boot token is transparently replaced (env vars, by contrast, never
    // update in a live process).
    getAccessToken: () => {
      const token = heartbeatAuth.accessToken?.trim()
      if (!token) {
        throw new Error('runtime access token is unavailable for the stateless heartbeat')
      }
      return token
    },
    // M3 self-heal: on a 401/403 heartbeat response, refresh the shared runtime
    // token once and retry — the same recovery path UsageReporter and
    // BudgetClient use. Mutates heartbeatAuth.accessToken in place, so the
    // retry (and every later tick) presents the refreshed token.
    refreshOnUnauthorized: () => refreshWithRecovery(heartbeatAuth),
    // D8 conditions. Sessions in Processing / AwaitingApproval are pinned in
    // the store's RAM cache (reconcilePinning), so the in-RAM scan cannot
    // miss an active or awaiting session.
    getConditions: () => {
      let activeTask = false
      let awaitingApproval = false
      for (const { conversation } of handle.store.listByPrefix('')) {
        if (
          conversation.state === ConversationState.Processing ||
          conversation.activeTaskId !== undefined
        ) {
          activeTask = true
        }
        if (conversation.state === ConversationState.AwaitingApproval) {
          awaitingApproval = true
        }
      }
      return {
        activeTask,
        awaitingApproval,
        // pendingResults counts only GENUINELY-pending work — results nobody
        // has consumed yet. C3 inline-delivered sync results (deliveredInline)
        // were already returned on the caller's socket and live in
        // pendingTaskResults only for socket-death poll recovery; they must be
        // excluded here or every sync turn would pin the gauge and block
        // drain/suspend. The same principle extends to delivered-on-read
        // entries (deliveredAt): a result the owner already FETCHED via
        // GET /v1/runtime/tasks/:id/result or GET /cron/results is
        // recoverability cache, not pending work (runtime/resultDelivery.ts).
        // Genuinely UNDELIVERED async/cron results still pin the gauge until
        // TTL — the spec's hard block for results that would be LOST on
        // suspend is unchanged.
        pendingResults:
          pendingTaskResults.countWhere(isUndeliveredResult) > 0 ||
          pendingCronResults.countWhere(isUndeliveredResult) > 0 ||
          // Cron×stateless race fix: a fired-but-not-yet-stored one-shot cron
          // result pins the gauge for the window between the activeTaskId flip
          // and pendingCronResults.set (see cronResultsInFlight declaration).
          cronResultsInFlight.size > 0,
        // Cron×stateless: an ENABLED schedule pins the idle gauge — a
        // suspended pod cannot fire cron. Cheapest fresh introspection of the
        // scheduler store per tick (in-RAM jobs-map scan); no scheduler wired
        // means no schedules exist on this host.
        activeCronSchedules: cronScheduler !== null && cronScheduler.hasEnabledJobs(),
      }
    },
    flushFinalCheckpoint: () => persistQueue.drain(),
  })
  rpcServer.setLifecycleGate(heartbeat)
  heartbeat.start()
  statelessHeartbeat = heartbeat
  console.log(
    `[Main] Stateless heartbeat started (interval=${config.statelessHeartbeatIntervalMs}ms, ` +
      `target=${config.mcpHostGatewayUrl})`
  )
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
  mcpInitializationGeneration += 1

  console.log(`[Main] Received ${signal}, shutting down`)

  // Fence MCP authority and detach live tools before any awaited shutdown
  // phase. Delayed polls and in-flight connects cannot reopen a closed manager.
  const closingMcpManager = mcpManager
  if (closingMcpManager) {
    mcpFleetCoordinator.closeManager(closingMcpManager)
  }
  const mcpClosePromise = closingMcpManager?.close(cleanup =>
    mcpFleetCoordinator.scheduleCleanup(cleanup)
  )

  // Stop components in order
  stopRuntimeAuthProactiveRefresh()
  hostWatcher?.stop()
  configStore?.stop()
  stopContextMapperPolling()
  mcpAuthorityStalenessDeadline.clear()
  stopMcpStatusHeartbeat()
  statelessHeartbeat?.stop()

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
  if (governedRunReporter) {
    try {
      governedRunReporter.stop()
      await governedRunReporter.drain()
    } catch (err) {
      console.warn(
        '[Main] GovernedRunReporter drain failed during shutdown:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  cronScheduler?.stop()
  spilloverStorage?.stopGc()
  await mcpClosePromise
  await mcpFleetCoordinator.drainForShutdown()
  await pluginWorkloadSdkBootstrapServer?.stop()
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
  // provider's credential slots by env var (ALL_PROVIDERS order = dev priority).
  // Multi-slot (R4): a provider is "available" only when all its required slots
  // are present in the env (e.g. Bedrock needs both AWS keys).
  const keys = apiKeysFromEnv()

  if (ALL_PROVIDERS.every(p => !keys[p])) {
    const allSlotNames = ALL_PROVIDERS.flatMap(p =>
      descriptorFor(p).credentialSlots.map(s => s.envName)
    )
    throw new Error(
      `Dev mode requires the credential env var(s) of one provider: ${allSlotNames.join(', ')}`
    )
  }

  let hostSpec = config.devHostConfig!

  // Auto-detect provider from available API keys if not explicitly set.
  // ALL_PROVIDERS preserves the priority order
  // (openai > claude > zai > bailian > vertex > bedrock).
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

  // R5 — parse `spec.llmPolicy` (dev mode has no ConfigStore, so fallback
  // providers won't build — failover stays inert, byte-identical to today).
  refreshFailoverPolicy(host)
  await initializeProvider(host, keys)

  // Initialize MCP manager
  mcpManager = new McpManager(config.mcpProxyEnabled ? config.mcpProxyUrl : undefined)

  if (config.devMcpServers && config.devMcpServers.length > 0) {
    console.log(`[Main] Adding ${config.devMcpServers.length} dev MCP server(s)`)
    await admitDevelopmentMcpServers(config.devMcpServers, mcpManager)

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

  // Stage 3 — stateless lifecycle heartbeat + reversible DRAINING fence.
  startStatelessHeartbeat()

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

  const host = await getHost(config.hostName)

  if (!host) {
    console.error(`[Main] Host CRD not found: ${config.hostName}`)
    process.exit(1)
  }

  // R5 — parse `spec.llmPolicy` BEFORE the ConfigStore so its referenced
  // fallback credential slots are loaded from the LLM Secret at boot.
  refreshFailoverPolicy(host)
  await ensureConfigStore(host)
  const keys = apiKeysFromConfigStore(configStore!)

  await initializeProvider(host, keys)

  // §3.14 (stateless agents) — Ready never waits for MCP. The agent and the
  // RPC server (readiness route /v1/runtime/health) come up FIRST; MCP
  // discovery/connections run in the background below. initializeAgent()
  // tolerates a null mcpManager, and initializeMcpServers() wires the manager
  // into the agent when it lands (agent.setMcpManager).
  await initializeAgent()

  // Start watching for Host changes
  hostWatcher = new HostWatcher(config.hostName)
  await hostWatcher.start(onHostChange, onHostDelete)

  // Start MCP status heartbeat (keeps observedAt fresh for the desktop poll;
  // each tick no-ops until the MCP manager exists)
  startMcpStatusHeartbeat()

  // Start RPC server — readiness answers from here on
  await startRPCServer()

  // Stage 3 — stateless lifecycle heartbeat + reversible DRAINING fence.
  startStatelessHeartbeat()

  // MCP discovery/connections — in the background, AFTER readiness (§3.14).
  // A failed initial attempt is logged loudly; the context-mapper poll then
  // reconciles the catalog (the platform tolerates the 'connecting' sweep).
  startMcpInitializationInBackground({
    initialize: () => initializeMcpServers(),
    afterInitialAttempt: () => ensureContextMapperPolling(),
  })

  console.log(`[Main] Approval system: ${config.enableApproval ? 'ENABLED' : 'DISABLED'}`)
  console.log('[Main] MCP Host running. Press Ctrl+C to exit.')
  console.log('[Main] Waiting for messages from channel-reader...\n')

  // Handle graceful shutdown
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

/**
 * Start the dedicated stepless Plugin Workload SDK runtime. This is neither a
 * WorkflowService nor a standalone Host: port 8080 exposes only health and the
 * WRC-authenticated public bootstrap identity, while port 8099 serves the
 * workload SDK. Prompt credentials remain behind the per-attempt WRC broker.
 */
async function startPluginWorkloadSdkOnlyMode(): Promise<void> {
  if (!config.pluginWorkloadSdkEnabled || config.pluginWorkloadSdkRuntimeMode !== 'sdk-only') {
    throw new Error(
      'sdk-only runtime requires PLUGIN_WORKLOAD_SDK_ENABLED=true and PLUGIN_WORKLOAD_SDK_RUNTIME_MODE=sdk-only'
    )
  }

  console.log(`[Main] Starting in SDK-ONLY MODE (recipe: ${config.workflowRecipeName})`)

  if (!runtimeAuth) runtimeAuth = createMcpHostRuntimeAuth()
  if (!runtimeAuth) {
    throw new Error(
      'sdk-only runtime requires MCP_HOST_RUNTIME_ACCESS_TOKEN, MCP_HOST_RUNTIME_REFRESH_TOKEN and MCP_HOST_GATEWAY_URL'
    )
  }
  startRuntimeAuthProactiveRefresh(runtimeAuth)

  if (!usageReporter) {
    const auth = runtimeAuth
    usageReporter = new UsageReporter({
      baseUrl: auth.baseUrl,
      getAccessToken: () => auth.accessToken,
      refreshOnUnauthorized: () => refreshWithRecovery(auth),
    })
  }

  let bootstrapContext: { provider: LlmProvider; defaultModel: string } | null = null
  pluginWorkloadSdkServer = maybeCreatePluginWorkloadSdkServer(config, runtimeAuth, {
    getLlmContext: () => bootstrapContext,
    usageReporter,
  })
  if (!pluginWorkloadSdkServer) {
    throw new Error('sdk-only runtime activation gate rejected the Plugin Workload SDK server')
  }

  await pluginWorkloadSdkServer.start()
  pluginWorkloadSdkBootstrapServer = new PluginWorkloadSdkBootstrapServer({
    port: config.serverPort,
    configure: request =>
      configurePluginWorkloadSdkBootstrapIdentity(request, {
        capabilityFamily: resolvePluginWorkloadSdkBootstrapCapabilityFamily(
          config.pluginWorkloadSdkCapabilities
        ),
        onConfigured: context => {
          bootstrapContext = context
        },
        verify: async (provider, model) => {
          if (!pluginWorkloadSdkServer) return null
          try {
            return await pluginWorkloadSdkServer.verifyPromptBridgeBootstrapV2(provider, model)
          } catch {
            return null
          }
        },
        verifyClientNotifications: async () => {
          if (!pluginWorkloadSdkServer) return null
          try {
            return await pluginWorkloadSdkServer.verifyClientNotificationsBootstrap()
          } catch {
            return null
          }
        },
      }),
  })
  try {
    // Kubernetes readiness becomes reachable only after the SDK listener and
    // the bootstrap surface are both bound, preventing a Ready-but-unusable Pod.
    await pluginWorkloadSdkBootstrapServer.start()
  } catch (err) {
    await pluginWorkloadSdkServer.stop()
    pluginWorkloadSdkServer = null
    throw err
  }

  console.log('[Main] SDK-only mcp-host ready — waiting for WRC identity bootstrap')
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
  if (
    config.enableAuth &&
    (config.runtimeKind === 'workflow' || config.runtimeKind === 'sdk-only') &&
    !config.wrcPublicKey
  ) {
    console.error(
      `[Main] FATAL: enableAuth=true in ${config.runtimeKind} mode but WRC_PUBLIC_KEY_PEM is not set — refusing to start`
    )
    process.exit(1)
  }

  // D3 §1.3 — stateless lifecycle boot guard. A stateless Host whose session
  // db configuration cannot guarantee durability must not start: it would
  // silently lose every session on the next suspend.
  try {
    assertStatelessBootConfig({
      statelessLifecycle: config.statelessLifecycle,
      sessionStoreModeRaw: config.sessionStoreModeRaw,
      sessionDbDir: config.sessionDbDir,
      sessionDbPath: config.sessionDbPath,
      workspaceMemoryEnabled: config.memory.enabled,
      workspacePath: config.memory.workspacePath ?? '',
    })
  } catch (err) {
    if (err instanceof StatelessBootError) {
      console.error(`[Main] FATAL: ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  try {
    assertStatelessCronPolicyConfig({
      statelessLifecycle: config.statelessLifecycle,
      enableApproval: config.enableApproval,
    })
  } catch (err) {
    if (err instanceof StatelessCronPolicyError) {
      console.error(`[Main] FATAL: ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  // Stateless heartbeat target — same fail-loud posture as the boot guard
  // above. The emitter authenticates toward control-api's /mcp-host facade
  // through the workflow-approval gateway; without the gateway URL a
  // stateless Host could never report activity and would poison HCC's
  // suspend decisions.
  if (config.statelessLifecycle && !config.mcpHostGatewayUrl) {
    console.error(
      '[Main] FATAL: CLERUM_STATELESS_LIFECYCLE=true but MCP_HOST_GATEWAY_URL is not set — refusing to start'
    )
    process.exit(1)
  }

  // Workflow approval: if workflow mode is active, all three approval env vars must be set.
  // Without them, steps that require approval cannot request gating from control-api.
  if (config.runtimeKind === 'workflow') {
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

  // M-11: Workflow mode — dispatch keeps the existing workflow startup
  // contract isolated from the stepless SDK-only runtime.
  await dispatchMcpHostRuntime(config.runtimeKind, {
    sdkOnly: startPluginWorkloadSdkOnlyMode,
    workflow: async () => {
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
        onPluginWorkloadSdkBootstrapConfigured: context => {
          pluginSdkLlmContext = context
        },
        verifyPluginWorkloadSdkBootstrapV2: async (provider, model) => {
          if (!pluginWorkloadSdkServer) return null
          try {
            return await pluginWorkloadSdkServer.verifyPromptBridgeBootstrapV2(provider, model)
          } catch {
            return null
          }
        },
        verifyPluginWorkloadSdkClientNotifications: async () => {
          if (!pluginWorkloadSdkServer) return null
          try {
            return await pluginWorkloadSdkServer.verifyClientNotificationsBootstrap()
          } catch {
            return null
          }
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
    },
    standalone: async () => {
      if (config.devMode) {
        await startDevMode()
      } else {
        await startProductionMode()
      }
    },
  })
}

// Run main only when this module is the executable entry point. Keeping imports
// side-effect free allows the authoritative initialization contract to be
// regression-tested without starting the service.
if (require.main === module) {
  main().catch(error => {
    console.error('[Main] Fatal error:', error)
    process.exit(1)
  })
}

// Export for external access
export { messageQueue, agent, cronScheduler }
