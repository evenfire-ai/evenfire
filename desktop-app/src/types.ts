export type Role = 'admin' | 'inviter' | 'member'
export type RpcScope =
  | 'mcp:servers:list'
  | 'mcp:server:invoke'
  | 'host:health:read'
  | 'host:status:read'
  | 'host:activity:read'
  | 'host:message:invoke'
  | 'host:wake:write'
  | 'host:task:read'
  | 'host:approval:write'
  | 'host:session:read'
  | 'host:model:write'
  | 'desktop:view'
  | 'sandbox:ui:view'
export type RpcAccessScope = 'team' | 'user'

export type SessionMe = {
  id: string
  email: string
  name: string | null
  picture: string | null
  teamId: string | null
  teamName: string | null
  role: Role | null
}

export type LoginResult = {
  token: string
  me: SessionMe
}

export type InvitationFlowProfileLookup = {
  valid: true
  email: string
  appName: string
  profileUiBaseUrl: string
}

export type DesktopSetupCompletion = {
  valid: true
  email: string
  appName: string
  externalRestApiBaseUrl: string
  rpcProxyBaseUrl?: string
}

export type DesktopEnvironmentDiscovery = {
  appName: string
  externalRestApiBaseUrl: string
  rpcProxyBaseUrl: string
}

export type DesktopReleasePolicy = {
  releaseId: string
  externalRestApiVersion?: string
  rpcProxyVersion?: string
  desktopVersion: string
  minimumDesktopVersion: string
  releaseTag: string
  releaseUrl: string
}

export type DesktopAppInfo = {
  appName: string
  version: string
  isPackaged: boolean
}

export type DesktopReleaseStatus = {
  checked: boolean
  currentVersion: string
  latestVersion: string
  minimumVersion: string
  updateRequired: boolean
  releaseUrl: string
  releaseId?: string
  releaseTag?: string
  externalRestApiVersion?: string
  rpcProxyVersion?: string
  reason?: string
}

export type PendingWorkflowApproval = {
  id: string
  recipeNamespace: string
  recipeName: string
  requestedAt: string
  expiresAt: string
  payload: {
    message: string
    options?: string[]
    metadata?: unknown
  }
  correlation: {
    taskId?: string
    stepId?: string
  } | null
  target: {
    userId: string | null
    teamId: string | null
    teamName: string | null
  }
}

export type SdkNotificationSummary = {
  notificationId: string
  origin: 'plugin_workload_sdk'
  recipeNamespace: string
  recipeName: string
  callerRef: string
  eventType: string
  title: string
  body: string
  data: Record<string, unknown>
  actionRef: { type: string; id: string; urlRef?: string } | null
  deliveryPolicyRef: string | null
}

export type UserNotificationPreferences = {
  preferredMedium: 'telegram' | 'slack' | null
  channelFallbackEnabled: boolean
  verifiedMedia: Array<'telegram' | 'slack'>
}

export type ExternalChannelTarget = {
  id: string
  medium: string
  agentName: string
  channelName: string
  botLabel: string
  botUsername: string | null
  status: 'ready'
}

export type ExternalChannelAccount = {
  id: string
  medium: string
  disabledAt?: string | null
  targets?: Array<{ id: string }>
}

export type ExternalChannelsSummary = {
  targets: ExternalChannelTarget[]
  accounts: ExternalChannelAccount[]
}

export type ProfileSettingsOpenOptions = {
  section?: 'profile' | 'social'
  network?: string
  action?: 'password'
}

export type WorkflowRunCompletedNotification = {
  workflowRunId: string
  approvalRequestId: string
  recipeNamespace: string
  recipeName: string
  phase: 'Succeeded' | 'Failed' | 'Canceled'
  completedAt: string
  message?: string | null
  target: {
    userId: string | null
    teamId: string | null
    teamName: string | null
  }
}

export type WorkflowNotificationStreamEvent =
  | {
      type: 'open'
    }
  | {
      type: 'notification.snapshot'
      items: PendingWorkflowApproval[]
      cursor: string | null
      observedAt: string
    }
  | {
      type: 'approval.requested'
      id: string
      cursor: string
      approval: PendingWorkflowApproval
      observedAt: string
    }
  | {
      type: 'approval.updated'
      id: string
      cursor: string
      approvalRequestId: string
      status: 'approved' | 'denied' | 'cancelled' | 'expired' | 'consumed'
      observedAt: string
    }
  | {
      type: 'workflow.run.completed'
      id: string
      cursor: string
      workflowRun: WorkflowRunCompletedNotification
      observedAt: string
    }
  | {
      type: 'sdk.notification'
      id: string
      cursor: string
      notification: SdkNotificationSummary
      observedAt: string
    }
  | {
      type: 'heartbeat'
      observedAt: string
    }
  | {
      type: 'stream.closing'
      reason: string
      observedAt: string
    }
  | {
      type: 'error'
      message: string
    }
  | {
      type: 'closed'
    }

export type WorkflowInputContractProperty = {
  type: 'string' | 'integer' | 'number' | 'boolean'
  default?: string | number | boolean
  description?: string
  enum?: string[]
}

export type WorkflowInputContractSchema = {
  properties?: Record<string, WorkflowInputContractProperty>
  required?: string[]
}

export type WorkflowInputValues = Record<string, string | number | boolean>

export type PluginWorkloadSdkCapabilityStatus = {
  state: 'validated' | 'disabled'
  promptBridge: boolean
  clientNotifications: boolean
  message?: string
  validatedAt?: string
}

export type WorkflowRecipeResource = Record<string, unknown> & {
  metadata?: {
    namespace?: string
    name?: string
    creationTimestamp?: string
  }
  spec?: {
    inputContract?: WorkflowInputContractSchema
    [key: string]: unknown
  }
  status?: {
    phase?: string
    pluginWorkloadSdk?: PluginWorkloadSdkCapabilityStatus
  }
}

export type WorkflowRecipeListResult = {
  items: WorkflowRecipeResource[]
  count: number
}

export type WorkflowRunActor = {
  type: string
  userId?: string
  hostRef?: string
}

export type WorkflowRunExecutionRef = {
  namespace: string
  name: string
}

export type WorkflowRunArtifact = {
  name: string
  format: string
  sizeBytes: number
  createdAt: string
}

export type WorkflowRunListItem = {
  id: string
  source: 'live' | 'audit'
  phase: string
  triggeredAt: string | null
  startedAt: string | null
  completedAt: string | null
  message: string | null
  actor: WorkflowRunActor | null
  executionRef: WorkflowRunExecutionRef | null
  artifacts?: WorkflowRunArtifact[]
}

export type WorkflowRunsResult = {
  items: WorkflowRunListItem[]
  count: number
}

export type WorkflowApprovalDecisionResult = {
  ok: boolean
  run?: WorkflowRunListItem
}

export type WorkflowRunArtifactsResult = {
  artifacts: WorkflowRunArtifact[]
}

export type TeamSummary = {
  id: string
  name: string
  role: Role
}

export type TeamMember = {
  id: string
  email: string
  name: string | null
  role: Role
  status: string
}

export type TeamDirectoryEntry = {
  team: TeamSummary
  members: TeamMember[]
  contextIds: string[]
  agentNames: string[]
}

export type TeamDirectoryResult = {
  currentTeamId: string
  truncated?: boolean
  items: TeamDirectoryEntry[]
  /**
   * Populated when the best-effort attempt to restore the session to the
   * originally selected team fails. The server-side session has already
   * advanced to `currentTeamId` (which differs from `attemptedTeamId`) and
   * the in-memory session token has been updated accordingly, but callers
   * should prompt the user to re-authenticate to recover cleanly.
   */
  restoreFailed?: {
    message: string
    attemptedTeamId: string
    currentTeamId: string
  }
}

export type UserContexts = {
  userId: string
  contextIds: string[]
}

/**
 * Per-agent MCP server list as returned by the session catalog
 * (control-api → external-rest-api). Names only — no URLs or credentials
 * per spec §3.1, §4.1.
 */
export type AgentWithMcpServers = {
  name: string
  contextRef: string | null
  provider?: string | null
  mcpServers: Array<{ name: string }>
}

export type UserAgents = {
  userId: string
  agentNames: string[]
  agents?: AgentWithMcpServers[]
}

export type TeamContexts = {
  teamId: string
  contextIds: string[]
}

export type TeamAgents = {
  teamId: string
  agentNames: string[]
  agents?: AgentWithMcpServers[]
}

export type AccessCatalogMcpServerEntry =
  | string
  | {
      name?: string
      url?: string
    }

export type AccessCatalog = {
  userId: string
  teamId: string | null
  userContextIds: string[]
  userAgentNames: string[]
  teamContextIds: string[]
  teamAgentNames: string[]
  contextIds: string[]
  agentNames: string[]
  /**
   * Optional scoped MCP map keyed by agent/host ref.
   * Not currently returned by external-rest-api in all environments.
   */
  agentMcpServers?: Record<string, AccessCatalogMcpServerEntry[]>
  /**
   * Optional scoped MCP map keyed by context id.
   * Not currently returned by external-rest-api in all environments.
   */
  contextMcpServers?: Record<string, AccessCatalogMcpServerEntry[]>
  /**
   * Per-agent invocable MCP server names, merged from the user and team
   * catalogs (spec §3.1, §5). Keys are agent names from `agentNames`;
   * missing keys mean the upstream API did not return an
   * agents[] enrichment (older build or K8s listing failure).
   */
  mcpServersByAgent: Record<string, string[]>
  /**
   * Scoped map keyed by agent/host ref to the source context id.
   * Null means the agent was returned without a contextRef.
   */
  agentContextByName: Record<string, string | null>
  /**
   * Optional LLM provider keyed by agent name when the catalog includes it.
   * Older API builds omit provider details, so UI must treat missing values
   * as unknown.
   */
  agentProviderByName?: Record<string, string | null>
}

export type RpcMcpServer = {
  name: string
  url?: string | null
}

export type RpcAllowedServersResult = {
  userId: string
  contextIds: string[]
  servers: RpcMcpServer[]
}

export type RpcTokenResult = {
  token: string
  accessScope: RpcAccessScope
  teamId: string | null
  scopes: RpcScope[]
  hostRefs: string[]
  expiresInSeconds: number
}

export type HostMessageRequest = {
  content: string
  channelType?: string
  sender?: string
  hostRef?: string
  threadId?: string
  attachments?: HostMessageAttachment[]
  /**
   * Optional per-session model selection piggybacked onto the send (R2 "Option
   * A"). Present only when the user changed the model while the host was
   * suspended, so the `POST /model` write couldn't persist it — mcp-host
   * validates + persists this session selection before running the task.
   */
  model?: string
  [key: string]: unknown
}

export type HostMessageAttachment = {
  id: string
  kind: 'image'
  mimeType: 'image/jpeg' | 'image/png'
  encoding: 'base64'
  dataBase64: string
  filename?: string
}

/**
 * Structured error returned by mcp-host when an LLM call fails.
 * Mirrors the TaskError shape from mcp-host/src/queue/types.ts.
 */
export interface TaskError {
  code: string
  message: string
  retryable: boolean
  provider: string
}

export type HostMessageResponse = {
  success?: boolean
  status?: 'completed' | 'waiting_approval' | 'pending' | 'cancelled' | 'failed' | 'processing'
  response?: string
  error?: TaskError | string
  approval?: {
    taskId: string
    requestId: string
    userId?: string
    notification?: string
  }
  [key: string]: unknown
}

export type SessionState = {
  authenticated: boolean
  me: SessionMe | null
}

export type PasswordLoginResult = SessionState

export type InvitationPreview = {
  id: string
  teamId: string
  teamName: string
  email: string
  role: Role
  status: 'pending' | 'accepted' | 'revoked'
  expiresAt: string
  acceptedAt: string | null
  userId: string | null
  passwordPending: boolean
}

export type DesktopRuntimeConfig = {
  externalRestApiBaseUrl: string
  rpcProxyBaseUrl?: string
  appName?: string
}

export type DesktopRuntimeConfigOption = {
  id: string
  label: string
  source: 'file' | 'localhost'
  configPath: string | null
  externalRestApiBaseUrl: string
  rpcProxyBaseUrl: string
  appName: string
}

export type DesktopRuntimeConfigState = {
  configured: boolean
  isLocalhost: boolean
  selectorVisible: boolean
  activeOptionId: string | null
  /**
   * Stable, filesystem-safe namespacing key for the ACTIVE environment (spec
   * §5.1). Derived from `new URL(externalRestApiBaseUrl).origin`; every local
   * cache surface (chat store path, session-token keychain slot, gfs session
   * scope, sandbox partitions) is scoped by this so switching clusters never
   * shows or reconciles another environment's data.
   */
  envKey: string
  storagePath: string
  options: DesktopRuntimeConfigOption[]
}

export type TokenMetadata = {
  hasSession: boolean
  rpcTokenExpiresAtMs: number | null
  rpcScopes: RpcScope[]
  rpcHostRefs: string[]
}

/**
 * Per-MCP-server health row forwarded from mcp-host through rpc-proxy.
 * Mirror of the server-side type (spec §4.2). Keep in sync with:
 *   mcp-host/src/mcp/serverStatus.ts
 *   rpc-proxy/src/services/mcpHostRestService.ts
 */
export type McpServerState = 'connected' | 'connecting' | 'failed' | 'disabled' | 'unknown'

export type McpServerFailureReason =
  | 'auth_failed'
  | 'upstream_4xx'
  | 'upstream_5xx'
  | 'network'
  | 'handshake'
  | 'timeout'
  | 'not_ready'
  | 'unknown'

export type McpServerHealthRow = {
  name: string
  state: McpServerState
  expected: boolean
  toolCount: number
  reason: McpServerFailureReason | null
  message: string | null
  observedAt: string
}

export type HostRuntimeStatus = {
  hostRef: string
  agent: {
    state: string
    currentTaskId: string | null
    tasksProcessed: number
    tasksSucceeded: number
    tasksFailed: number
    uptime: number
  }
  queue: {
    pending: number
    processing: number
    completed: number
    failed: number
  }
  cronJobs: number
  pendingApprovalsCount: number
  /**
   * Per-MCP-server health. Undefined when the upstream mcp-host is an older
   * build that doesn't emit this field. Desktop merge treats absence as
   * "unknown for every server" (spec §5).
   */
  mcpServers?: McpServerHealthRow[]
  /**
   * When non-null, the Host is refusing new tasks. Today the only value is
   * `llm_key_missing`. UI renders a banner with the message and links the
   * operator to the LLM Secrets tab to fix the underlying Secret.
   * Recovers within ~1 s of the Secret being repaired (no pod restart).
   */
  degraded?: {
    reason: 'llm_key_missing'
    message: string
  } | null
  /**
   * R5 — the provider/model pair currently SERVING this Host. Present only when
   * a fallback policy (`spec.llmPolicy`) is configured on the Host; `fallback:
   * true` means a configured fallback entry is serving (the chat shows a
   * "Running on fallback" badge). On lazy recovery the engine flips `fallback`
   * back to false. Optional for forward/backward compat: older mcp-host builds
   * and Hosts with no policy omit it entirely, and the UI treats absence as "no
   * fallback active" (renders nothing). Mirrors mcp-host StatusResponse.servedBy.
   */
  servedBy?: {
    provider: string
    name: string
    fallback: boolean
  } | null
  observedAt: string
}

export type HostRuntimeHealth = {
  hostRef: string
  status: string
  observedAt: string
}

/**
 * Result of a client-initiated pre-warm of a (possibly suspended) stateless
 * host. `requested` is true when the wake route answered with one of its
 * terminal contract statuses (200 `active`, 202 `wake-requested`,
 * 409 `not-stateless`). `skipped: 'cooldown'` means a recent attempt for the
 * same hostRef suppressed the HTTP call entirely; `skipped: 'in-flight'`
 * means that attempt's bounded re-emission loop is still running (structural
 * single-loop-per-host guarantee). `error` carries the failure
 * message for any other outcome — the caller treats prewarm as
 * fire-and-forget, so failures surface here (and in main-process logs), never
 * as a thrown error.
 */
export type PrewarmHostResult = {
  requested: boolean
  status?: string
  skipped?: 'cooldown' | 'in-flight'
  error?: string
}

export type HostStatusStreamEvent =
  | { type: 'open'; hostRef: string; observedAt: string }
  | { type: 'status'; status: HostRuntimeStatus }
  | { type: 'error'; message: string }
  | { type: 'closed' }

export type HostActivitySeverity = 'info' | 'warn' | 'error'
export type HostActivityType =
  | 'task.queued'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'llm.requested'
  | 'llm.responded'
  | 'llm.failed'
  | 'tool.call.started'
  | 'tool.call.completed'
  | 'tool.call.failed'
  | 'approval.requested'
  | 'approval.approved'
  | 'approval.denied'
  | 'safety.input_blocked'
  | 'safety.output_sanitized'
  | 'queue.depth.changed'
  | 'agent.state.changed'
export type HostActivityEvent = {
  version: '1.0'
  eventId: string
  hostRef: string
  ts: string
  taskId?: string
  type: HostActivityType
  title: string
  severity: HostActivitySeverity
  meta: Record<string, unknown>
  redactions: string[]
}
export type HostActivitySnapshot = {
  hostRef: string
  version: '1.0'
  items: HostActivityEvent[]
  nextCursor: string | null
}
export type HostActivityStreamEvent =
  | { type: 'open'; hostRef: string; observedAt: string }
  | { type: 'activity'; activity: HostActivityEvent }
  | { type: 'error'; message: string }
  | { type: 'closed' }

export type DependencyHealth = {
  externalRestApi: { ok: boolean; detail?: string }
  rpcProxy: { ok: boolean; detail?: string }
}

export type TaskProgressStreamEvent =
  // De-collapsed from `open` (spec-v2 §4.5-1, R6): the connection is established
  // and the server acknowledged the subscription, but the reporter is NOT live
  // yet — the task may be queued behind another (FIFO per session) for up to the
  // server's reporter-wait budget. A `waiting` does NOT prove task liveness, so
  // the renderer must not reset its re-rejoin budget on it (B2b).
  | { type: 'waiting'; taskId: string; hostRef: string }
  | { type: 'open'; taskId: string; hostRef: string }
  | { type: 'tool_start'; data: unknown }
  | { type: 'tool_complete'; data: unknown }
  | { type: 'tool_progress'; data: unknown }
  | { type: 'llm_in_progress'; data: unknown }
  | {
      // Periodic keepalive emitted by mcp-host while waiting on a long
      // LLM completion or silent tool. The TaskTracker watchdog resets on
      // any event, so heartbeats prevent spurious 30s timeouts when a
      // single completion exceeds the threshold.
      type: 'heartbeat'
      data: { taskId: string; iteration: number; elapsedMs: number }
    }
  | {
      type: 'suspended'
      // P1-1: approval event carries only the server-derived displayName, never
      // the raw tool_name (mirrors the REST pendingApproval wire shape).
      data: {
        taskId: string
        requestId: string
        displayName: string
        reason: string
      }
    }
  | { type: 'cancelled'; data: { taskId: string; reason: string } }
  | { type: 'done'; data: unknown }
  | {
      // Phase D unified terminal event — replaces cancelled|error|done
      type: 'terminal'
      data: {
        taskId: string
        status: 'completed' | 'failed' | 'cancelled'
        reason?: string
        error?: { message?: string; code?: string; provider?: string }
      }
    }
  | {
      type: 'error'
      message: string // REQUIRED — every error event carries a human-readable messageP
      data?: {
        // OPTIONAL — present iff this is a structured LLM errorP
        taskId: string
        code: string
        message: string
        retryable: boolean
        provider: string
      }
    }
  // Structured transport give-up (spec-v2 §4.5-2, R6): the main-process bridge
  // exhausted its bounded reconnect (or hit `task_not_found_or_expired`). NOT a
  // task failure — the task is durable server-side; the renderer treats it as a
  // definitive stream-loss and reconciles (re-attach if non-idle, else settle),
  // never as a blind re-attach.
  | { type: 'gone'; reason: string }
  | { type: 'closed' }

// ─── Chat persistence types ───

export interface ChatMetadata {
  id: string // UUID — also used as threadId for backend routing
  title: string // auto-generated or user-edited
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
  messageCount: number
  /** D.5: a task terminated while this chat was NOT the active view. Drives the
   * sidebar "completed_unread" badge; persisted so it survives an app restart. */
  unreadTerminal?: boolean
  /** ISO 8601 timestamp of the last terminal that set unreadTerminal. */
  lastTerminalAt?: string
}

export interface ChatIndex {
  /** v2 aligns with ChatFile v2; bootstrap wipes any v1/missing-version dir (D.4 §7.1). */
  version: 1 | 2
  lastActiveChatId: string | null
  onboardingDismissed: boolean
  chats: ChatMetadata[]
}

/** Server-reported session lifecycle (D.1). `idle` once no task is in flight. */
export type SessionLifecycleState = 'idle' | 'processing' | 'awaiting_approval'

/** Pending tool-approval descriptor surfaced by the server (D.1). P1-1: the REST
 *  wire is `{requestId, displayName}` — never the raw tool_name. */
export interface PendingApprovalLite {
  requestId: string
  displayName: string
}

/**
 * Result of an approve/deny RPC (spec-v2 §4.7.4 client-contract prerequisite).
 * mcp-host answers HTTP 200 with `{success:false, error:'<string>'}` for an
 * already-decided request ("No pending approval for request …" / "Task is no
 * longer awaiting approval") — the old client discarded the body and reported a
 * FALSE success. approve/deny now parse the body and surface this structured
 * result end-to-end (rpcProxyClient → appService → ipc → preload → renderer) so
 * the renderer can distinguish `already_decided` (converge, no revert) from a
 * genuine failure. A non-ok HTTP / network error still throws.
 */
export interface ApprovalDecisionResult {
  success: boolean
  error?: string
}

/**
 * Result of `GET /api/v1/rpc/hosts/:hostRef/sessions/:agent/:chatId/messages`.
 * F5: this is the single source of truth for the loadSessionMessages wire shape,
 * shared by `rpcProxyClient` and `appService` and mirrored by `renderer.d.ts`. It
 * MUST carry the recovery fields (`state`/`activeTaskId`/`pendingApproval`) and
 * per-turn `tool_steps` the server returns — the renderer's stream-loss reconcile
 * (P1 seed + P2 rejoin) reads them, so dropping them from the declared type was a
 * latent refactor hazard.
 */
export interface SessionMessagesResult {
  agent: string
  chatId: string
  state?: SessionLifecycleState
  activeTaskId?: string
  pendingApproval?: PendingApprovalLite
  tokens?: SessionTokensLite
  turns: Array<{
    number: number
    user_input: string
    response?: string
    started_at: string
    completed_at?: string
    tokens?: SessionTokensLite
    tool_steps?: MessageToolStep[]
  }>
}

// F5 compile-time guard: `SessionMessagesResult` MUST keep carrying the recovery
// fields the renderer's stream-loss reconcile depends on (P1 seed + P2 rejoin).
// This lives in `src/**` so `build:main` (tsc -p tsconfig.json) enforces it — the
// runtime test in `test/` is NOT typechecked by any project script, so it can't.
// Removing/renaming any field below collapses `_RecoveryFields` to `never` and
// fails the build.
type _RecoveryFields = SessionMessagesResult extends {
  state?: SessionLifecycleState
  activeTaskId?: string
  pendingApproval?: PendingApprovalLite
}
  ? true
  : never
const _sessionMessagesResultCarriesRecoveryFields: _RecoveryFields = true
void _sessionMessagesResultCarriesRecoveryFields

/** Lifetime token totals for a session, surfaced by the server. `cacheRead`/
 *  `cacheWrite` are present only when the model reports cache info (Anthropic);
 *  absent for providers that don't (OpenAI / zai / bailian). Omitted entirely
 *  until the session has had its first LLM call. */
export interface SessionTokensLite {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/**
 * Snapshot of the composition of the prompt sent in the last turn — a per-bucket
 * breakdown of the CURRENT context window (not lifetime totals; that's
 * {@link SessionTokensLite}). Surfaced on-demand by
 * `GET /api/v1/rpc/hosts/:hostRef/sessions/:agent/:chatId/context-breakdown`.
 *
 * `buckets` are raw local token counts used as PROPORTIONS; absolute per-bucket
 * tokens are derived in the UI by scaling to `totalInputTokens`
 * (`round(bucket / Σbuckets × totalInputTokens)`). `cacheHitRate` is present ONLY
 * when the model reports cache info (Anthropic); absent otherwise.
 *
 * `…Lite` is the renderer-facing alias of the server `ContextBreakdownWire`,
 * mirroring `SessionTokensLite` ↔ `SessionTokensWire`. This is the single source
 * of truth shared by `rpcProxyClient`, `appService`, and `renderer.d.ts`.
 */
export interface ContextBreakdownLite {
  buckets: {
    messages: number
    systemTools: number
    metaContext: number
    systemPrompt: number
  }
  totalInputTokens: number
  maxTokens: number
  /** totalInputTokens / maxTokens (0 when maxTokens is 0). */
  fillRatio: number
  /** cache_read / (cache_read + input); only when the model reports cache (#11). */
  cacheHitRate?: number
  capturedAtTurn: number
}

/** Wire alias kept identical to the server `ContextBreakdownWire` projection. */
export type ContextBreakdownWire = ContextBreakdownLite

/**
 * Result of `GET …/sessions/:agent/:chatId/context-breakdown`. `breakdown` is
 * `null` when the session has no snapshot yet (cold-load / fresh session) — the
 * server returns the same anti-enumeration 404 when the session doesn't exist
 * for the caller, which the bridge surfaces as `{ breakdown: null }`.
 */
export interface ContextBreakdownResult {
  breakdown: ContextBreakdownLite | null
}

/**
 * One selectable model for a host's active provider (R2 model selector). The
 * allowlist is operator-declared (R3); `displayName`/`contextWindowTokens` are
 * optional operator metadata. Mirrors the rpc-proxy wire shape 1:1.
 */
export interface HostModelOption {
  name: string
  displayName?: string
  contextWindowTokens?: number
}

/**
 * Result of `GET …/hosts/:hostRef/models?chatId=…` (scope `host:session:read`).
 * `sessionModel` is the per-session selection (null → use `hostDefault`).
 * `sessionModelBlocked` names a previously-selected model that fell out of the
 * allowlist (the runtime reverted it to the default, R2.2). `degraded` means the
 * allowlist ConfigMap is unavailable, so only the default may be used (R3.5).
 *
 * The bridge returns `null` (not this shape) when the host predates the endpoint
 * (404/501) — the selector then hides entirely (compat, like `mcpServers?`).
 */
export interface HostModelsResult {
  provider: string
  hostDefault: string
  sessionModel: string | null
  sessionModelBlocked?: string
  degraded: boolean
  models: HostModelOption[]
}

/**
 * Result of `POST …/hosts/:hostRef/model` (scope `host:model:write`). The swap
 * applies to the NEXT task only — in-flight tasks finish on their captured model
 * (R2.5), which the UI surfaces as "applies to your next message". A rejected
 * model (not in the allowlist) is a 403 `{error:'model_not_allowed'}`, surfaced
 * as a thrown error the caller detects — never this shape.
 */
export interface SetHostModelResult {
  effective: 'next-task'
  provider: string
  model: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  /** mcp-host task that produced/owns this message — used to rejoin after reload (D.3, v2). */
  task_id?: string
  attachments?: ChatMessageAttachment[]
  /** True when this message represents a structured error returned by mcp-host. */
  isError?: boolean
  /** LLM error code, e.g. "LLM_AUTHENTICATION_FAILED". Present when isError is true. */
  errorCode?: string
  /** LLM provider name, e.g. "zai". Present when isError is true. */
  errorProvider?: string
  /** Per-turn token usage for the assistant message of this turn (from /messages).
   *  Absent on user messages and on turns with no recorded usage. */
  tokens?: SessionTokensLite
  /** Tools used in the turn that produced this assistant message — persisted so
   *  the progress stepper's "N tools" list survives a reload / cold-load (the live
   *  SSE steps are renderer-only). Minimal, serializable shape (no raw args/output).
   *  Absent on user messages and on turns with no tool calls. */
  toolSteps?: MessageToolStep[]
}

/**
 * The minimal, serializable subset of a tool call needed to render the desktop
 * progress stepper's collapsed "N tools" / "More details" view after a reload.
 * Mirrors the server `TurnToolStepWire` and the live `ProgressStep` (downsampled).
 * Deliberately omits raw arguments and tool output.
 */
export interface MessageToolStep {
  toolName: string
  displayName: string
  state: 'completed' | 'error'
  durationMs?: number
  errorSummary?: string
}

export interface ChatMessageAttachment {
  id: string
  type: 'plugin' | 'connector' | 'agent_file' | 'global_file' | 'uploaded_file' | 'response_file'
  label: string
  tooltip?: string
  addedOrder?: number
  filename?: string
  mimeType?: string
  encoding?: 'base64'
  dataBase64?: string
  sizeBytes?: number
}

export interface ChatFile {
  /** v1 had no per-message task_id; v2 persists it. loadMessages reads both. */
  version: 1 | 2
  chatId: string
  messages: ChatMessage[]
}
