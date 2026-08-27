import type {
  ChatMessageAttachment,
  HostActivityEvent,
  MessageToolStep,
  SessionTokensLite,
} from '../../src/types'
import type {
  AgentWorkspaceRoute as AgentWorkspaceRouteValue,
  DesktopRoute,
} from './constants/navigation'

export type NavItem = DesktopRoute
export type ActiveSandboxUiApp = {
  appRef: string
  label: string
  icon?: string
  defaultPath: string
  routePath?: string
}
export type Tone = 'info' | 'success' | 'error' | 'warn'
export type ThemeMode = 'dark' | 'light'
export type AgentWorkspaceRoute = AgentWorkspaceRouteValue
export type AgentChatRole = 'user' | 'assistant' | 'system'
export type ChatNotificationPreference =
  | 'always'
  | 'when_app_focused_away_from_chat'
  | 'when_app_unfocused'
export type DesktopNotificationPermission = NotificationPermission | 'unsupported'

export type NotificationSettings = {
  inApp: ChatNotificationPreference
  desktop: ChatNotificationPreference
  soundVolume: number
}

export type DesktopNotificationPayload = {
  title: string
  body: string
  tag?: string
  silent?: boolean
  actions?: Array<{
    action: string
    title: string
  }>
  onClick?: () => void | Promise<void>
  onAction?: (action: string) => void | Promise<void>
}

export type AgentConversationNotificationTarget = {
  agentName: string
  chatId?: string
  teamId?: string
}

export type AgentApprovalNotificationTarget = AgentConversationNotificationTarget & {
  taskId: string
  requestId: string
  decision: 'approve' | 'deny'
}

export type AgentChatMessage = {
  id: string
  role: AgentChatRole
  content: string
  timestamp: number
  /** Authoritative server turn ordinal used for delta reconciliation and paging. */
  serverTurnNumber?: number
  /** mcp-host task that produced/owns this message — used to rejoin after reload (D.3, v2). */
  task_id?: string
  attachments?: ChatMessageAttachment[]
  /** True when this message represents a structured error returned by mcp-host. */
  isError?: boolean
  /** Local-only durable message that must not be evicted by server window reconciliation. */
  preserveLocal?: boolean
  /** LLM error code, e.g. "LLM_AUTHENTICATION_FAILED". Present when isError is true. */
  errorCode?: string
  /** LLM provider name, e.g. "zai". Present when isError is true. */
  errorProvider?: string
  /** Per-turn token usage for this assistant message (from /messages). Absent on
   *  user messages and on turns with no recorded usage. */
  tokens?: SessionTokensLite
  /** Tools used in the turn — persisted so the progress stepper survives a reload
   *  (the live SSE steps are renderer-only). Absent on user messages / no-tool turns. */
  toolSteps?: MessageToolStep[]
}

export type AgentActivityStateTone =
  | 'waiting'
  | 'streaming'
  | 'reconnecting'
  | 'completed'
  | 'error'
  | 'no_activity'

export type AgentMessageActivity = {
  status: AgentActivityStateTone
  events: HostActivityEvent[]
  taskId?: string
  redactionCount: number
  errorMessage?: string
}

export type ToastMessage = {
  id: number
  tone: Tone
  text: string
  durationMs?: number
}

export type AppNotificationKind =
  | 'assistant_reply'
  | 'approval_required'
  | 'workflow_completed'
  | 'sdk_notification'

export type SdkNotificationTarget = {
  deliveryId: string
  notificationId: string
  recipeNamespace: string
  recipeName: string
  callerRef: string
  eventType: string
  title: string
  body: string
}

export type WorkflowCompletionNotificationTarget = {
  namespace: string
  name: string
  runId: string
  approvalRequestId: string
  phase: 'Succeeded' | 'Failed' | 'Canceled'
  completedAt: string
}

export type AppNotification = {
  id: string
  kind: AppNotificationKind
  agentName: string
  chatId?: string
  teamId?: string
  teamName?: string
  text: string
  timestamp: number
  read: boolean
  approval?: {
    taskId: string
    requestId: string
    displayName?: string
  }
  approvalState?: 'approved' | 'denied'
  workflow?: WorkflowCompletionNotificationTarget
  sdk?: SdkNotificationTarget
  dedupeKey?: string
}

export type AppErrorKind = 'network' | 'auth' | 'validation' | 'upstream' | 'waking' | 'unknown'

export type FailedAgentSend = {
  content: string
  attachments: ComposerImageAttachment[]
  references: ComposerReferenceAttachment[]
  message: string
  kind: AppErrorKind
  timestamp: number
}

export type HostConnectionTone = 'healthy' | 'degraded' | 'offline'

export interface SuspendedInfo {
  requestId: string
  displayName: string
  /** Raw tool name (e.g. `clerum__plot_pnl`) — lets the approval label surface
   *  the function when the display name is generic. */
  toolName?: string
  /** U5 (mcp-oauth reactive consent): `'connect_required'` makes the stepper
   *  render a "Connect <server>" prompt instead of Approve/Deny. `mcpServerName`
   *  is the server to connect. Absent on ordinary approval suspensions. */
  reason?: string
  mcpServerName?: string
}

export interface TaskProgress {
  taskId?: string
  status: 'connecting' | 'active' | 'suspended' | 'completed' | 'error' | 'cancelled'
  steps: ProgressStep[]
  currentIteration: number
  llmElapsedMs?: number
  suspendedInfo?: SuspendedInfo
  cancelReason?: string
}

export interface ProgressStep {
  toolCallId: string
  toolName: string
  displayName: string
  intentSummary: string
  iteration: number
  stepIndex: number
  totalSteps: number
  state: 'running' | 'completed' | 'error'
  metadata?: Record<string, unknown>
  durationMs?: number
  /** Tokens of the LLM call that requested this tool. Only the first emitted
   *  step of each iteration carries it (the batch shares one call).
   *  cacheRead/cacheWrite are absent when the provider doesn't report cache.
   *  Live-only: the stepper is not rehydrated after a reload. */
  tokens?: SessionTokensLite
  errorSummary?: string
  inputPreview?: string
  outputPreview?: {
    headLines: string[]
    tailLines: string[]
    totalLines: number
    truncated: boolean
  }
  /** ms since tool_start, updated by tool_progress events. */
  elapsedMs?: number
  /** Most recent output snapshot during execution, updated by tool_progress events.
   *  Superseded by `outputPreview` once the step completes. */
  liveOutputPreview?: {
    headLines: string[]
    tailLines: string[]
    totalLines: number
    truncated: boolean
  }
}

export type ScopedMcpServer = {
  name: string
  url?: string
}

export type ContextMcpServerDetail = {
  name: string
  url?: string
  mappedAgentCount: number
  mappedAgents: string[]
  mappingSource: 'context-map' | 'agent-derived' | 'workspace-preview'
}

export type ComposerImageAttachment = {
  id: string
  addedOrder?: number
  name: string
  mimeType: 'image/jpeg' | 'image/png'
  dataBase64: string
  sizeBytes: number
  previewDataUrl: string
}

export type ComposerPluginReference = {
  id: string
  addedOrder?: number
  type: 'plugin'
  namespace: string
  name: string
  label: string
}

export type ComposerConnectorReference = {
  id: string
  addedOrder?: number
  type: 'connector'
  name: string
  label: string
}

export type ComposerAgentFileReference = {
  id: string
  addedOrder?: number
  type: 'agent_file'
  contextId: string
  filesystemName: string
  path: string
  kind: 'file' | 'directory'
  label: string
}

export type ComposerGlobalFileReference = {
  id: string
  addedOrder?: number
  type: 'global_file'
  resourceId: string
  drive: string
  gfsUri: string
  label: string
}

export type ComposerReferenceAttachment =
  | ComposerPluginReference
  | ComposerConnectorReference
  | ComposerAgentFileReference
  | ComposerGlobalFileReference
