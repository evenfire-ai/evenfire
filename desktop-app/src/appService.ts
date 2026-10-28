import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AuthClient } from './authClient.js'
import {
  bindChatStoreForUser,
  getChatStoreBindingGeneration,
  prepareChatStoreBindingForUser,
  requireChatStore,
  reserveBoundChatStoreTeamScope,
  unbindChatStore,
  updateBoundChatStoreTeamScope,
} from './chatStoreBinding.js'
import {
  clearDesktopRuntimeConfigSelection,
  config,
  deleteDesktopRuntimeConfigOption,
  getActiveEnvKey,
  getActiveLegacyEnvKeyInventory,
  getActiveLegacyEnvKeys,
  getActiveLegacyRestOnlyEnvKey,
  getActiveRuntimeConfigOptionId,
  getDesktopRuntimeConfigState,
  hydrateDesktopRuntimeConfig,
  isDesktopRuntimeConfigured,
  resolveEnvKey,
  saveDesktopRuntimeConfig,
  selectDesktopRuntimeConfigOption,
  validateRpcProxyBaseUrl,
} from './config.js'
import {
  canonicalizeDesktopRestEndpoint,
  sameDesktopRestEndpoint,
} from './desktopEnvironmentUrl.js'
import { desktopRuntimeLog } from './desktopRuntimeLog.js'
import { fetchBoundedBytes, streamBoundedBytes } from './gfs/boundedDownload.js'
import { type DelegationAffordances, delegationAffordances } from './gfs/delegation.js'
import {
  DesktopGfsUploadJob,
  DesktopUploadCapabilityError,
  type DesktopUploadInput,
  type DesktopUploadSession,
  type DesktopUploadTransport,
  formatGfsUploadLimit,
} from './gfs/upload.js'
import { GfsClient, type GfsResourceView, parseSubjectKey } from './gfs/uriHandler.js'
import {
  ApiError,
  assertSessionRequestAllowed,
  enterSessionRequestContext,
  getSessionRequestContext,
  reportSessionUnauthorized,
  requestJson,
  runWithSessionRequestContext,
  setSessionInvalidationHandler,
  withTimeout,
} from './httpClient.js'
import { MemberRegistrationServiceClient } from './memberRegistrationServiceClient.js'
import {
  type PendingExternalLogoutIntent,
  type PendingExternalLogoutMarker,
  acceptancePendingExternalMarker,
  applyPendingExternalLogoutCas,
  clearPendingExternalLogoutIfUnchanged,
  pendingExternalLogoutMarkersMatch,
  readPendingExternalLogoutContentsRevision,
  recordMemoryOnlySessionIfMissing,
  recordPendingExternalLogout,
  recordPendingExternalLogoutIfContentsUnchanged,
  recordPendingExternalLogoutIfUnchanged,
  recordPendingKeytarCleanupIfMissing,
  recordPendingKeytarCleanupIfUnchanged,
} from './pendingExternalLogout.js'
import { tryGetPluginSdkRuntime } from './pluginSdkRuntime.js'
import { RpcProxyClient } from './rpcProxyClient.js'
import { RpcTokenManager } from './rpcTokenManager.js'
import {
  SessionAuthorityAcceptanceTransaction,
  type SessionAuthorityAcceptedRecord,
  SessionAuthorityLogoutPreflightError,
  SessionAuthorityLogoutTransaction,
  readSessionAuthoritySourceSelection,
} from './sessionAuthorityAcceptance.js'
import {
  type AcceptedSessionTokenSource,
  type MemoryOnlySessionLease,
  type PendingLogoutFailureDisposition,
  type PendingLogoutLoginPlan,
  type PersistenceFailureContext,
  type SavedSessionRestorePlan,
  SessionAuthorityCoordinator,
  SessionRequestOwnershipError,
  type SessionSourceCleanupOutcome,
  TemporarySessionAuthorityUnavailableError,
  TemporarySessionEnvironmentChangedError,
  TemporarySessionExpiredError,
  type VerifiedSessionTokenSource,
  isMemoryOnlySessionMarker,
  sessionTokenPublicationSource,
} from './sessionAuthorityCoordinator.js'
import {
  type SessionAuthorityCredentialSource,
  SessionAuthorityProjectionIntegrityError,
  SessionAuthorityRecordConflictError,
  SessionAuthorityRecordRepository,
} from './sessionAuthorityRecord.js'
import {
  retireSessionPersistenceJournalAfterVerifiedLogout,
  snapshotSessionPersistenceJournal,
} from './sessionPersistenceJournal.js'
import {
  ContextSharedFilesystemSummary,
  SharedFileListResult,
  SharedFilesClient,
} from './sharedFilesClient.js'
import {
  type SessionTokenFallbackSnapshot,
  type SessionTokenReadSource,
  SessionTokenStorageClearError,
  SessionTokenStorageSupersededBeforeWriteError,
  SessionTokenStorageUnavailableBeforeWriteError,
  TokenStore,
  isKeytarCleanupEstablished,
  isSessionTokenMutationCallbackFailure,
} from './tokenStore.js'
import {
  AccessCatalog,
  AgentWithMcpServers,
  ApprovalDecisionResult,
  ChatAuthorityScope,
  ContextBreakdownResult,
  DependencyHealth,
  DesktopAppInfo,
  DesktopLogoutOutcome,
  DesktopReleaseStatus,
  DesktopRuntimeConfig,
  DesktopRuntimeConfigHandoffSelection,
  EntityChangeStreamEvent,
  ExternalChannelsSummary,
  HostActivitySnapshot,
  HostActivityStreamEvent,
  HostMessageRequest,
  HostMessageResponse,
  HostModelsResult,
  HostRuntimeStatus,
  HostStatusStreamEvent,
  LoginBackendHint,
  PasswordLoginResult,
  PendingWorkflowApproval,
  PrewarmHostResult,
  ProfileSettingsOpenOptions,
  RpcAllowedServersResult,
  RpcConnectorsResult,
  RpcScope,
  SessionMe,
  SessionMessagesQuery,
  SessionMessagesResult,
  SessionState,
  SessionsListQuery,
  SessionsListResult,
  SetHostModelResult,
  TaskProgressStreamEvent,
  TeamDirectoryResult,
  TeamMember,
  TeamSummary,
  TokenMetadata,
  UserNotificationPreferences,
  WorkflowApprovalDecisionResult,
  WorkflowNotificationStreamEvent,
  WorkflowRecipeListResult,
  WorkflowRunArtifactsResult,
} from './types.js'

// The single wake scope. A finite (non-streaming) Host operation carries this
// IN ADDITION to its functional scope so a suspended stateless Host wakes
// bounded-and-once for that operation (issue #791). control-api intersects the
// requested scopes against the caller's grants before issuance, so requesting
// the wake scope never widens a caller who was not granted it.
// Upper bound for a single backend-reachability probe used by
// `diagnoseLoginBackend`. Kept short so a post-login-failure diagnosis never
// makes the failure feel slower than it already did.
const BACKEND_PROBE_TIMEOUT_MS = 1500
const ENTITY_CHANGE_RETRY_AFTER_CAP_MS = 5 * 60 * 1000
// Two maximum server heartbeat intervals plus its maximum poll delay. This
// matches the operator-stream liveness watchdog and bounds half-open sockets.
const ENTITY_CHANGE_STREAM_IDLE_TIMEOUT_MS = 2 * (60_000 + 5_000)

const HOST_WAKE_SCOPE: RpcScope = 'host:wake:write'
const PROFILE_UI_BASE_URL_ORIGIN_ERROR =
  'PROFILE_UI_BASE_URL must be an origin URL with a root pathname and no search parameters'

type RuntimeConfigDiscovery = {
  profileId: string | null
  externalRestApiBaseUrl: string
  rpcProxyBaseUrl: string
  appName: string
}

function parseEntityChangeRetryAfterMs(
  value: string | undefined,
  nowMs = Date.now()
): number | undefined {
  const retryAfter = value?.trim()
  if (!retryAfter) return undefined

  const seconds = Number(retryAfter)
  const retryAtMs =
    Number.isFinite(seconds) && seconds >= 0 ? nowMs + seconds * 1_000 : Date.parse(retryAfter)
  if (!Number.isFinite(retryAtMs)) return undefined

  return Math.min(ENTITY_CHANGE_RETRY_AFTER_CAP_MS, Math.max(0, retryAtMs - nowMs))
}

function normalizeExplicitProfileUiBaseUrl(rawValue: string): string | null {
  const value = rawValue.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return null
  }
  if (url.pathname !== '/' || url.search) return null
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function requireProfileUiBaseUrlForBrowserAction(): string {
  if (!config.desktopProfileUiBaseUrlExplicit) {
    return config.desktopProfileUiBaseUrl
  }
  const explicitBaseUrl = normalizeExplicitProfileUiBaseUrl(config.desktopProfileUiBaseUrl)
  if (!explicitBaseUrl) {
    throw new Error(PROFILE_UI_BASE_URL_ORIGIN_ERROR)
  }
  return explicitBaseUrl
}

/**
 * Guarded wrapper around `shell.openExternal` for URLs that originate in data
 * (server responses, config, deep-links) rather than fixed constants. Electron
 * hands a non-web scheme (`file:`, `javascript:`, `data:`, a custom protocol
 * such as `clerum://`) straight to the OS protocol handler, so every
 * data-derived URL is scheme-checked before it can reach the browser.
 *
 * `requireHttps` pins OAuth authorize URLs to `https:` — real providers never
 * issue a plaintext authorize endpoint. The default also permits `http:` for
 * profile-ui links, which legitimately run on `http://localhost` in local dev
 * (see `normalizeExplicitProfileUiBaseUrl`, which accepts both schemes).
 *
 * On rejection only the offending scheme is surfaced — never the full URL,
 * whose query string may carry tokens or other secrets.
 */
async function openExternalDataUrl(
  rawUrl: string,
  options: { requireHttps?: boolean } = {}
): Promise<void> {
  const value = String(rawUrl ?? '')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Refusing to open a malformed external URL')
  }
  const allowedProtocols = options.requireHttps ? ['https:'] : ['https:', 'http:']
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error(`Refusing to open external URL with unsupported scheme "${parsed.protocol}"`)
  }
  const { shell } = await import('electron')
  await shell.openExternal(value)
}

/**
 * Finite-operation scope matrix — the single source of truth for the exact
 * scope array each finite (single request/response) Host RPC operation requests,
 * keyed by operation family (plan §11.4). EVERY entry carries HOST_WAKE_SCOPE:
 * these are the on-demand, user-driven operations that may legitimately wake a
 * suspended stateless Host. rpc-proxy still enforces each route's own functional
 * `requireScope`; the wake scope here only lets that same operation pull a
 * suspended Host back up.
 *
 * Streams and observability reads are DELIBERATELY absent (see
 * HOST_OBSERVABILITY_SCOPES): they keep narrow read scopes with NO wake scope so
 * background polling and SSE streams can never defeat scale-to-zero. Adding a
 * family here is the ONLY place the wake grant is requested — never append
 * HOST_WAKE_SCOPE at a call site.
 *   - `model`: writing the per-session selection (POST /model) is gated by the
 *     dedicated write scope (the swap's blast radius is the caller's own
 *     session); wake is added so selecting a model on a suspended Host brings it
 *     up. Reading the model list (GET /models) rides the `session` family.
 *   - `approval`: the tool-call surface only (approveToolCall/denyToolCall).
 *     `decideWorkflowApproval` (`host:workflow-approval:decide`) is a separate
 *     surface and is intentionally NOT in this matrix.
 */
const HOST_FINITE_OPERATION_SCOPES: Record<
  'message' | 'session' | 'model' | 'artifact' | 'approval',
  RpcScope[]
> = {
  message: ['host:message:invoke', 'host:task:read', HOST_WAKE_SCOPE],
  session: ['host:session:read', HOST_WAKE_SCOPE],
  model: ['host:model:write', HOST_WAKE_SCOPE],
  artifact: ['host:activity:read', 'host:task:read', HOST_WAKE_SCOPE],
  approval: ['host:approval:write', HOST_WAKE_SCOPE],
}

/**
 * Observability scope matrix — status/activity reads plus every SSE stream.
 * DELIBERATELY never contains HOST_WAKE_SCOPE: a suspended stateless Host must
 * stay suspended under polling/streaming, or observability would defeat
 * scale-to-zero. The negative scope tests assert no entry here carries wake.
 */
const HOST_OBSERVABILITY_SCOPES: Record<'status' | 'activity', RpcScope[]> = {
  status: ['host:status:read'],
  activity: ['host:activity:read'],
}

// Named views onto the matrices so existing call sites stay byte-identical.
const HOST_WAKEABLE_OPERATION_SCOPES: RpcScope[] = HOST_FINITE_OPERATION_SCOPES.message
const HOST_STATUS_SCOPES: RpcScope[] = HOST_OBSERVABILITY_SCOPES.status
const HOST_ACTIVITY_SCOPES: RpcScope[] = HOST_OBSERVABILITY_SCOPES.activity
const HOST_SESSION_SCOPES: RpcScope[] = HOST_FINITE_OPERATION_SCOPES.session
const HOST_MODEL_SCOPES: RpcScope[] = HOST_FINITE_OPERATION_SCOPES.model
// Spec 15 Fase B — explicit user rename. A dedicated WRITE scope, distinct from
// `host:session:read` (so a read/navigation token can never rename), and
// DELIBERATELY NOT wake-eligible: it carries no HOST_WAKE_SCOPE. Rename is
// optimistic local-first and reconciles on the next listSessions poll, and
// rpc-proxy's PATCH route is non-wake too — granting wake here would turn a
// rename into a cheap "wake my pod" primitive. Kept OUT of
// HOST_FINITE_OPERATION_SCOPES (whose every entry carries wake, asserted by
// appService.wakeScopeMatrix.issue791.test.ts) for exactly that reason.
const HOST_SESSION_TITLE_SCOPES: RpcScope[] = ['host:session:write']
const HOST_ARTIFACT_SCOPES: RpcScope[] = HOST_FINITE_OPERATION_SCOPES.artifact
const HOST_APPROVAL_SCOPES: RpcScope[] = HOST_FINITE_OPERATION_SCOPES.approval
const MCP_SERVERS_LIST_SCOPES: RpcScope[] = ['mcp:servers:list']
// U5 (mcp-oauth reactive consent): "Connect <server>" reuses the SAME capability
// the desktop already holds to invoke mcp tools — connecting is a precondition of
// invoking, so rpc-proxy gates the authorize-url route on this scope (no new
// scope is minted). The token is host-bound to the suspended conversation's
// hostRef, which the user demonstrably has access to.
const MCP_SERVER_INVOKE_SCOPES: RpcScope[] = ['mcp:server:invoke']
const DESKTOP_VIEW_SCOPES: RpcScope[] = ['desktop:view']
const SANDBOX_UI_VIEW_SCOPES: RpcScope[] = ['sandbox:ui:view']
// hostRefs is required by control-api's RPC token issuance (see
// `issueRpcAccessToken` — it returns null for empty hostRefs). The
// `sandbox:ui:view` scope is recipe-bound, not host-bound, so we pass a
// sentinel that doesn't collide with any real host. rpc-proxy's view/*
// path doesn't read hostRefs; the cookie + path pair is the per-recipe gate.
const SANDBOX_UI_HOST_REF_SENTINEL = 'sandbox-ui'

// Pre-warm cooldown: client-side hygiene so catalog refreshes or rapid app
// reloads don't spam the wake route (control-api rate-limits anyway). Attempts —
// including failed ones — are recorded up front so a failing wake is never
// silently retried by the next catalog refresh inside the window.
const PREWARM_COOLDOWN_MS = 60_000
// Bounded map: evict the oldest attempt entry past this many distinct hosts.
const PREWARM_COOLDOWN_MAX_HOSTS = 256
// Bounded wake re-emission: HCC's raw watch is known to lose events, and a
// single projected wake annotation then goes unseen until the ~300s resync.
// The reactive message path compensates by re-triggering every 15s while
// holding (rpc-proxy wakeAndHold); prewarm mirrors that backstop with a
// BOUNDED loop tied to one catalog-driven invocation: while the wake route
// answers 202 wake-requested (HCC has not acted — the CR is still suspended),
// re-POST up to this many more times at this interval. The interval exceeds
// control-api's 2s coalesce window, so each re-POST bumps the Postgres
// generation and re-projects a fresh watch event. 200 active is the
// acknowledgment that HCC acted — stop immediately, as on any other status
// or error. Never a persistent loop, never coupled to the status stream.
const PREWARM_REEMIT_MAX_ATTEMPTS = 2
const PREWARM_REEMIT_INTERVAL_MS = 10_000

function compareSemverLike(left: string, right: string): number {
  const parse = (value: string) =>
    value
      .split(/[.-]/)
      .slice(0, 3)
      .map(part => Number.parseInt(part.replace(/\D.*/, ''), 10))
      .map(part => (Number.isFinite(part) ? part : 0))
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  return 0
}

function normalizeVersion(value: unknown): string | null {
  const version = String(value || '').trim()
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null
}

function readDesktopPackageVersion(): string | null {
  const envVersion = normalizeVersion(process.env.npm_package_version)
  if (envVersion) return envVersion

  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ]
  for (const candidate of candidates) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown }
      const packageVersion = normalizeVersion(packageJson.version)
      if (packageVersion) return packageVersion
    } catch {
      // Keep the release check best-effort in dev mode.
    }
  }
  return null
}

function resolveDesktopAppVersion(desktopApp: { isPackaged: boolean; getVersion: () => string }) {
  return desktopApp.isPackaged
    ? desktopApp.getVersion()
    : readDesktopPackageVersion() || desktopApp.getVersion()
}

/** Known progress event types forwarded from host SSE to desktop consumers. */
const KNOWN_PROGRESS_EVENTS = new Set([
  'tool_start',
  'tool_complete',
  'tool_progress',
  'llm_in_progress',
  'suspended',
  // Keepalive surfaced by the SSE parser — forwarded so the renderer's task
  // watchdog resets on it (the tracker bumps lastEventAt on every event).
  'heartbeat',
])

// stream-recovery (A): bounded reconnect of a dropped progress stream before
// surfacing an error. Total worst-case (~3 attempts + backoff + per-attempt
// timeout) stays under the renderer's 30s watchdog so B backstops either way.
const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 2000
// F3: the 8s bound guards CONNECTION ESTABLISHMENT only — the window between
// opening the HTTP request and receiving the first server bytes. mcp-host emits
// `waiting` immediately on flushing the SSE headers (`routes.ts` handleProgress
// StreamRoute), so a `waiting` proves the connection is established and clears
// this timer.
const RECONNECT_ATTEMPT_TIMEOUT_MS = 8000
// F3: after `waiting`, mcp-host blocks in `progressReporterRegistry.waitFor(taskId,
// 180_000)` (main.ts) before it can send `open` — and sends NO keepalive until
// after `open` (routes.ts:1043). So the legitimate pre-`open` wait can be up to
// 180s; the 8s establishment bound must NOT police it (that synthesized a false
// stream-loss terminal while the task was alive → false reconcile → P1/P2). This
// longer bound matches the server's reporter-wait budget plus margin: the server
// itself ends the stream with `task_not_found_or_expired` at 180s if no reporter
// appears, so this is a backstop for a connection that received `waiting` but
// then went silent without the server's own error. A genuinely dead/hung
// post-`waiting` connection is still caught here (and by the renderer's 30s
// watchdog).
const RECONNECT_WAITING_FOR_OPEN_TIMEOUT_MS = 195_000
const SAVED_SESSION_RESTORE_RETRY_DELAY_MS = 5_000

const gfsUploadTransport: DesktopUploadTransport = {
  requestJson,
  requestPart: async (url, token, headers, body, timeoutMs, signal) => {
    const requestOwner = assertSessionRequestAllowed(token)
    const response = await fetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, ...headers },
      body: body as unknown as BodyInit,
      // Node's fetch requires this opt-in for a streaming request body.
      duplex: 'half',
      signal: withTimeout(signal, timeoutMs),
    } as RequestInit & { duplex: 'half' })
    reportSessionUnauthorized(token, response.status, requestOwner)
    const text = await response.text()
    return {
      status: response.status,
      text,
      retryAfter: response.headers.get('retry-after') ?? undefined,
    }
  },
}

const LEGACY_GFS_MAX_FILE_BYTES = 16 * 1024 * 1024
const LEGACY_GFS_READ_BUFFER_BYTES = 1024 * 1024

async function readBoundedLegacyFile(handle: fs.promises.FileHandle): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for (;;) {
    const remaining = LEGACY_GFS_MAX_FILE_BYTES + 1 - totalBytes
    const chunk = Buffer.allocUnsafe(Math.min(LEGACY_GFS_READ_BUFFER_BYTES, remaining))
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null)
    if (bytesRead === 0) break
    totalBytes += bytesRead
    if (totalBytes > LEGACY_GFS_MAX_FILE_BYTES) {
      throw new Error(
        `This writer does not advertise resumable uploads; legacy GFS is limited to ${formatGfsUploadLimit(LEGACY_GFS_MAX_FILE_BYTES)}.`
      )
    }
    chunks.push(chunk.subarray(0, bytesRead))
  }
  return Buffer.concat(chunks, totalBytes)
}

export async function legacyEncodedFile(filePath: string): Promise<string> {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ELOOP') {
      throw new Error('selected upload path must not be a symbolic link')
    }
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('selected upload path is not a regular file')
    if (info.size > LEGACY_GFS_MAX_FILE_BYTES) {
      throw new Error(
        `This writer does not advertise resumable uploads; legacy GFS is limited to ${formatGfsUploadLimit(LEGACY_GFS_MAX_FILE_BYTES)}.`
      )
    }

    // O_NOFOLLOW is not available on every Electron target. The post-open
    // lstat/object-identity check is the portable equivalent: a symlink is
    // rejected and a pathname swap cannot make the already-open descriptor
    // point at different bytes.
    const pathInfo = await fs.promises.lstat(filePath)
    if (pathInfo.isSymbolicLink())
      throw new Error('selected upload path must not be a symbolic link')
    if (
      typeof info.dev === 'number' &&
      typeof info.ino === 'number' &&
      typeof pathInfo.dev === 'number' &&
      typeof pathInfo.ino === 'number' &&
      (info.dev !== pathInfo.dev || info.ino !== pathInfo.ino)
    ) {
      throw new Error('selected upload path changed while it was being opened')
    }
    const bytes = await readBoundedLegacyFile(handle)
    const finalInfo = await handle.stat()
    if (
      finalInfo.size !== info.size ||
      finalInfo.mtimeMs !== info.mtimeMs ||
      finalInfo.ctimeMs !== info.ctimeMs ||
      bytes.byteLength !== info.size
    ) {
      throw new Error('selected upload file changed while it was being read')
    }
    return bytes.toString('base64')
  } finally {
    await handle.close()
  }
}

function legacyReceipt(
  resource: GfsResourceView,
  operation: 'create' | 'replace'
): DesktopUploadSession {
  return {
    uploadId: resource.resourceId,
    drive: resource.drive,
    operation,
    expectedBytes: resource.bytes,
    partBytes: resource.bytes || 1,
    partCount: resource.bytes === 0 ? 0 : 1,
    state: 'completed',
    contiguousBytes: resource.bytes,
    committedBytes: resource.bytes,
    committedPartCount: resource.bytes === 0 ? 0 : 1,
    activePartCount: 0,
    expiresAt: new Date(Date.now()).toISOString(),
    resultResourceId: resource.resourceId,
    resultVersion: resource.version,
  }
}

const DESKTOP_GFS_UPLOAD_STATE_VERSION = 2 as const

type DesktopGfsUploadPersistenceStatus = 'active' | 'paused' | 'failed' | 'suspended_auth'

interface DesktopGfsUploadScope {
  ownerId: string
  teamId: string | null
  environmentKey: string
  baseUrl: string
  drive: string
  authEpoch: number
}

type DesktopGfsUploadIdentity = Omit<DesktopGfsUploadScope, 'drive' | 'authEpoch'>

interface PersistedDesktopGfsUpload {
  version: typeof DESKTOP_GFS_UPLOAD_STATE_VERSION
  uploadId: string
  filePath: string
  fileName: string
  fileSize: number
  target: {
    operation: 'create' | 'replace'
    parentRid?: string
    resourceRid?: string
    ifMatch?: number
  }
  name: string
  session: DesktopUploadSession
  scope: DesktopGfsUploadScope
  status: DesktopGfsUploadPersistenceStatus
  updatedAt: string
}

interface LegacyPersistedDesktopGfsUpload {
  uploadId: string
  filePath: string
  fileName: string
  fileSize: number
  target: PersistedDesktopGfsUpload['target']
  name: string
  session: DesktopUploadSession
}

interface QuarantinedDesktopGfsUpload {
  uploadId: string
  reason: 'legacy_unscoped' | 'invalid_scope' | 'unsupported_version'
  quarantinedAt: string
}

interface DesktopGfsUploadStateFile {
  version: typeof DESKTOP_GFS_UPLOAD_STATE_VERSION
  records: PersistedDesktopGfsUpload[]
  quarantined: QuarantinedDesktopGfsUpload[]
}

interface DesktopGfsUploadSummary {
  uploadId: string
  fileName: string
  fileSize: number
  target: PersistedDesktopGfsUpload['target']
  name: string
  drive: string
  status: DesktopGfsUploadPersistenceStatus
}

const DESKTOP_GFS_UPLOAD_STATE_FILE = 'gfs-upload-sessions.json'

function normalizeDesktopUploadBaseUrl(value: string): string {
  const url = new URL(String(value || '').trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('GFS upload base URL must use http(s)')
  }
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function desktopGfsUploadIdentity(me: SessionMe): DesktopGfsUploadIdentity {
  return {
    ownerId: me.id,
    teamId: String(me.teamId ?? '').trim() || null,
    environmentKey: getActiveEnvKey(),
    baseUrl: normalizeDesktopUploadBaseUrl(config.externalRestApiBaseUrl),
  }
}

function normalizeDesktopUploadDrive(value: string | undefined): string {
  const drive = String(value ?? 'main').trim()
  if (!drive) throw new Error('drive_required: GFS uploads require a canonical drive')
  return drive
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isDesktopGfsUploadTarget(value: unknown): value is PersistedDesktopGfsUpload['target'] {
  if (!value || typeof value !== 'object') return false
  const target = value as Partial<PersistedDesktopGfsUpload['target']>
  if (target.operation !== 'create' && target.operation !== 'replace') return false
  if (
    target.parentRid !== undefined &&
    (typeof target.parentRid !== 'string' || !target.parentRid.trim())
  )
    return false
  if (
    target.resourceRid !== undefined &&
    (typeof target.resourceRid !== 'string' || !target.resourceRid.trim())
  )
    return false
  if (target.ifMatch !== undefined && !isNonNegativeSafeInteger(target.ifMatch)) return false
  return target.operation === 'create' ? Boolean(target.parentRid) : Boolean(target.resourceRid)
}

function isDesktopUploadSession(value: unknown): value is DesktopUploadSession {
  if (!value || typeof value !== 'object') return false
  const session = value as Partial<DesktopUploadSession>
  return (
    typeof session.uploadId === 'string' &&
    Boolean(session.uploadId.trim()) &&
    typeof session.drive === 'string' &&
    session.drive === session.drive.trim() &&
    Boolean(session.drive) &&
    (session.operation === 'create' || session.operation === 'replace') &&
    isNonNegativeSafeInteger(session.expectedBytes) &&
    isNonNegativeSafeInteger(session.partBytes) &&
    session.partBytes > 0 &&
    isNonNegativeSafeInteger(session.partCount) &&
    typeof session.state === 'string' &&
    Boolean(session.state) &&
    isNonNegativeSafeInteger(session.contiguousBytes) &&
    isNonNegativeSafeInteger(session.committedBytes) &&
    isNonNegativeSafeInteger(session.committedPartCount) &&
    isNonNegativeSafeInteger(session.activePartCount) &&
    typeof session.expiresAt === 'string' &&
    Boolean(session.expiresAt) &&
    (session.resultResourceId === undefined || typeof session.resultResourceId === 'string') &&
    (session.resultVersion === undefined || isNonNegativeSafeInteger(session.resultVersion)) &&
    (session.resultSha256 === undefined || typeof session.resultSha256 === 'string')
  )
}

function canonicalDesktopUploadSession(session: DesktopUploadSession): DesktopUploadSession {
  return {
    uploadId: session.uploadId,
    drive: session.drive,
    operation: session.operation,
    expectedBytes: session.expectedBytes,
    partBytes: session.partBytes,
    partCount: session.partCount,
    state: session.state,
    contiguousBytes: session.contiguousBytes,
    committedBytes: session.committedBytes,
    committedPartCount: session.committedPartCount,
    activePartCount: session.activePartCount,
    expiresAt: session.expiresAt,
    ...(session.resultResourceId === undefined
      ? {}
      : { resultResourceId: session.resultResourceId }),
    ...(session.resultVersion === undefined ? {} : { resultVersion: session.resultVersion }),
    ...(session.resultSha256 === undefined ? {} : { resultSha256: session.resultSha256 }),
  }
}

function isLegacyPersistedDesktopGfsUpload(
  value: unknown
): value is LegacyPersistedDesktopGfsUpload {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<LegacyPersistedDesktopGfsUpload>
  return (
    typeof item.uploadId === 'string' &&
    typeof item.filePath === 'string' &&
    typeof item.fileName === 'string' &&
    isNonNegativeSafeInteger(item.fileSize) &&
    typeof item.name === 'string' &&
    isDesktopGfsUploadTarget(item.target) &&
    isDesktopUploadSession(item.session)
  )
}

function isDesktopGfsUploadScope(value: unknown): value is DesktopGfsUploadScope {
  if (!value || typeof value !== 'object') return false
  const scope = value as Partial<DesktopGfsUploadScope>
  if (
    typeof scope.ownerId !== 'string' ||
    scope.ownerId !== scope.ownerId.trim() ||
    !scope.ownerId ||
    (scope.teamId !== null &&
      (typeof scope.teamId !== 'string' ||
        scope.teamId !== scope.teamId.trim() ||
        !scope.teamId)) ||
    typeof scope.environmentKey !== 'string' ||
    scope.environmentKey !== scope.environmentKey.trim() ||
    !scope.environmentKey ||
    typeof scope.baseUrl !== 'string' ||
    typeof scope.drive !== 'string' ||
    scope.drive !== scope.drive.trim() ||
    !scope.drive ||
    !Number.isSafeInteger(scope.authEpoch) ||
    Number(scope.authEpoch) < 0
  ) {
    return false
  }
  try {
    return normalizeDesktopUploadBaseUrl(scope.baseUrl) === scope.baseUrl
  } catch {
    return false
  }
}

function isPersistedDesktopGfsUpload(value: unknown): value is PersistedDesktopGfsUpload {
  if (!isLegacyPersistedDesktopGfsUpload(value)) return false
  const item = value as Partial<PersistedDesktopGfsUpload>
  return (
    item.version === DESKTOP_GFS_UPLOAD_STATE_VERSION &&
    isDesktopGfsUploadScope(item.scope) &&
    item.uploadId === item.session?.uploadId &&
    item.fileSize === item.session?.expectedBytes &&
    item.target?.operation === item.session?.operation &&
    item.session?.drive === item.scope.drive &&
    ['active', 'paused', 'failed', 'suspended_auth'].includes(String(item.status)) &&
    typeof item.updatedAt === 'string'
  )
}

function canonicalPersistedDesktopGfsUpload(
  record: PersistedDesktopGfsUpload
): PersistedDesktopGfsUpload {
  return {
    version: DESKTOP_GFS_UPLOAD_STATE_VERSION,
    uploadId: record.uploadId,
    filePath: record.filePath,
    fileName: record.fileName,
    fileSize: record.fileSize,
    target: {
      operation: record.target.operation,
      ...(record.target.parentRid === undefined ? {} : { parentRid: record.target.parentRid }),
      ...(record.target.resourceRid === undefined
        ? {}
        : { resourceRid: record.target.resourceRid }),
      ...(record.target.ifMatch === undefined ? {} : { ifMatch: record.target.ifMatch }),
    },
    name: record.name,
    session: canonicalDesktopUploadSession(record.session),
    scope: {
      ownerId: record.scope.ownerId,
      teamId: record.scope.teamId,
      environmentKey: record.scope.environmentKey,
      baseUrl: record.scope.baseUrl,
      drive: record.scope.drive,
      authEpoch: record.scope.authEpoch,
    },
    status: record.status,
    updatedAt: record.updatedAt,
  }
}

function canonicalQuarantinedDesktopGfsUpload(value: unknown): QuarantinedDesktopGfsUpload | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<QuarantinedDesktopGfsUpload>
  if (
    typeof record.uploadId !== 'string' ||
    !record.uploadId ||
    !['legacy_unscoped', 'invalid_scope', 'unsupported_version'].includes(String(record.reason)) ||
    typeof record.quarantinedAt !== 'string' ||
    !record.quarantinedAt
  )
    return null
  return {
    uploadId: record.uploadId,
    reason: record.reason as QuarantinedDesktopGfsUpload['reason'],
    quarantinedAt: record.quarantinedAt,
  }
}

function serializedStateValueChanged(raw: unknown, canonical: unknown): boolean {
  try {
    return JSON.stringify(raw) !== JSON.stringify(canonical)
  } catch {
    return true
  }
}

function sameDesktopGfsUploadScope(
  left: DesktopGfsUploadScope,
  right: DesktopGfsUploadScope,
  options: { includeAuthEpoch?: boolean } = {}
): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.teamId === right.teamId &&
    left.environmentKey === right.environmentKey &&
    left.baseUrl === right.baseUrl &&
    left.drive === right.drive &&
    (options.includeAuthEpoch === false || left.authEpoch === right.authEpoch)
  )
}

function currentChatAuthorityScopeOrNull(): ChatAuthorityScope | null {
  try {
    return requireChatStore().getAuthorityScope()
  } catch (error) {
    if (error instanceof Error && error.message === 'Not authenticated') return null
    throw error
  }
}

function sameChatAuthorityScope(
  left: ChatAuthorityScope | null,
  right: ChatAuthorityScope | null
): boolean {
  return Boolean(
    left &&
    right &&
    left.environmentKey === right.environmentKey &&
    left.userId === right.userId &&
    left.teamId === right.teamId
  )
}

export function migrateDesktopGfsUploadState(value: unknown): {
  state: DesktopGfsUploadStateFile
  migrated: boolean
} {
  const now = new Date().toISOString()
  if (Array.isArray(value)) {
    const quarantined = value
      .filter(isLegacyPersistedDesktopGfsUpload)
      .slice(-100)
      .map(record => ({
        uploadId: record.uploadId,
        reason: 'legacy_unscoped' as const,
        quarantinedAt: now,
      }))
    return {
      state: { version: DESKTOP_GFS_UPLOAD_STATE_VERSION, records: [], quarantined },
      migrated: true,
    }
  }
  if (!value || typeof value !== 'object') {
    return {
      state: { version: DESKTOP_GFS_UPLOAD_STATE_VERSION, records: [], quarantined: [] },
      migrated: value !== undefined && value !== null,
    }
  }
  const candidate = value as {
    version?: unknown
    records?: unknown
    quarantined?: unknown
  }
  if (candidate.version !== DESKTOP_GFS_UPLOAD_STATE_VERSION) {
    return {
      state: {
        version: DESKTOP_GFS_UPLOAD_STATE_VERSION,
        records: [],
        quarantined: [
          {
            uploadId: 'unknown',
            reason: 'unsupported_version',
            quarantinedAt: now,
          },
        ],
      },
      migrated: true,
    }
  }
  const rawRecords = Array.isArray(candidate.records) ? candidate.records : []
  const records = rawRecords
    .filter(isPersistedDesktopGfsUpload)
    .map(canonicalPersistedDesktopGfsUpload)
    .slice(-100)
  const invalid = rawRecords
    .filter(record => !isPersistedDesktopGfsUpload(record))
    .slice(-100)
    .map(record => ({
      uploadId:
        record &&
        typeof record === 'object' &&
        typeof (record as { uploadId?: unknown }).uploadId === 'string'
          ? String((record as { uploadId: string }).uploadId)
          : 'unknown',
      reason: 'invalid_scope' as const,
      quarantinedAt: now,
    }))
  const rawQuarantined = Array.isArray(candidate.quarantined) ? candidate.quarantined : []
  const quarantined = rawQuarantined
    .map(canonicalQuarantinedDesktopGfsUpload)
    .filter((record): record is QuarantinedDesktopGfsUpload => record !== null)
    .slice(-100)
  const recordsChanged =
    records.length !== rawRecords.length ||
    records.some((record, index) => serializedStateValueChanged(rawRecords[index], record))
  const quarantineChanged =
    !Array.isArray(candidate.quarantined) ||
    quarantined.length !== rawQuarantined.length ||
    quarantined.some((record, index) => serializedStateValueChanged(rawQuarantined[index], record))
  return {
    state: {
      version: DESKTOP_GFS_UPLOAD_STATE_VERSION,
      records,
      quarantined: [...quarantined, ...invalid].slice(-100),
    },
    migrated: recordsChanged || quarantineChanged,
  }
}

export interface AppServiceOptions {
  tokenStore?: TokenStore
  getUserDataDirectory?: () => string
  reportDeferredLogoutFailure?: (error: unknown) => void
  notifySessionExpired?: (sessionGeneration: number) => void
}

type ActiveTeamContextHop = {
  homeTeamId: string
  homeRequestContext: unknown
  restoredToken: string | null
  restorationError: unknown
  homeTeamOperations: Array<() => Promise<void>>
}

type AcceptedTeamSwitchRequestTransition = {
  previousRequestContext: unknown
  nextRequestContext: unknown
  nextToken: string
  nextGeneration: number
  envKey: string
  userId: string
}

export class QuitAdmissionClosedError extends Error {
  readonly code = 'QUIT_ADMISSION_CLOSED'

  constructor() {
    super('Application is shutting down')
    this.name = 'QuitAdmissionClosedError'
  }
}

export class AppService {
  private readonly authClient = new AuthClient()
  private readonly memberRegistrationServiceClient = new MemberRegistrationServiceClient()
  private readonly rpcClient = new RpcProxyClient(() => this.getEffectiveRpcProxyBaseUrl())
  private readonly sharedFilesClient = new SharedFilesClient()
  private readonly gfsClient = new GfsClient({
    get baseUrl() {
      return config.externalRestApiBaseUrl
    },
    requestJson,
    fetchBytes: (url, token, opts) => fetchBoundedBytes(url, token, opts),
    fetchByteStream: (url, token, opts, onChunk) => streamBoundedBytes(url, token, opts, onChunk),
  })
  private readonly tokenStore: TokenStore
  private readonly sessionAuthority: SessionAuthorityCoordinator
  private readonly getUserDataDirectory: () => string
  private readonly reportDeferredLogoutFailure: (error: unknown) => void
  private readonly notifySessionExpired: (sessionGeneration: number) => void
  private readonly pendingCredentialProducers = new Set<Promise<unknown>>()
  private quitPreparationStarted = false
  private readonly rpcTokenManager = new RpcTokenManager(this.authClient)
  private memoryOnlySessionExpiryTimer: ReturnType<typeof setTimeout> | null = null
  private memoryOnlySessionTermination: Promise<void> | null = null
  private profileUiBaseUrlCache: { key: string; value: string } | null = null
  private accessCatalog: AccessCatalog | null = null
  private teamDirectoryCache: TeamDirectoryResult | null = null
  private teamContextQueue: Promise<void> = Promise.resolve()
  private activeTeamContextHop: ActiveTeamContextHop | null = null
  private acceptedTeamSwitchRequestTransition: AcceptedTeamSwitchRequestTransition | null = null
  private closeDesktopWindowsForSession?: () => Promise<void>
  private restoreSavedSessionInFlight: Promise<SessionState> | null = null
  private restoreSavedSessionReservationStarted = false
  private runtimeConfigResolutionInFlight = new Map<string, { promise: Promise<void> }>()
  private effectiveRuntimeRpcEndpoint: RuntimeConfigDiscovery | null = null
  private pendingRuntimeConfigDiscovery: RuntimeConfigDiscovery | null = null
  private savedSessionRestoreAttemptedEnvKey: string | null = null
  private savedSessionRestoreAttemptedAtMs = 0
  private logoutFenceCount = 0
  private pendingLogoutAuthoritySource: {
    envKey: string
    source: SessionAuthorityCredentialSource
  } | null = null
  private volatileLogoutInFlight: {
    sessionId: string
    promise: Promise<DesktopLogoutOutcome>
  } | null = null
  private memoryOnlyExpiryDeferredDuringLogout = false
  private sessionAuthorityCleanupInFlight: Promise<void> | null = null
  private interactiveLoginAttempts = 0
  private nativeAuthEnvironmentCommitQueue: Promise<void> = Promise.resolve()
  private gfsAuthEpoch = 0
  private gfsDispatchBlocked = true
  // A transient runWithTeamContext hop temporarily installs another team's
  // token in sessionToken. Existing GFS jobs keep their captured token and
  // scope, but new GFS operations must not capture that temporary token.
  private gfsTransientTeamHopDepth = 0
  // While a `runWithTeamContext` hop that will restore the original team is in
  // flight, `me.teamId` holds the borrowed team. The chat store (and the delete
  // fence derived from it) stays on the original team: rebinding it for the hop
  // and back would expose the deliberate team's chats to the borrowed scope for
  // the length of an RPC.
  private chatStoreHomeTeamId: string | null = null
  // A finite RPC may temporarily borrow another team session. Keep the
  // deliberate user-owned GFS scope stable across that hop so in-flight jobs
  // are not invalidated by the transient `me` value.
  private gfsScopeIdentity: DesktopGfsUploadIdentity | null = null
  private gfsUploadStateQueue: Promise<void> = Promise.resolve()
  private readonly gfsUploadJobs = new Map<
    string,
    {
      job: DesktopGfsUploadJob
      promise: Promise<DesktopUploadSession>
      scope: DesktopGfsUploadScope
    }
  >()
  private readonly gfsPendingUploadJobs = new Set<{
    job: DesktopGfsUploadJob
    promise: Promise<DesktopUploadSession>
    scope: DesktopGfsUploadScope
  }>()
  private readonly gfsPendingLegacyUploads = new Set<{
    controller: AbortController
    promise: Promise<unknown>
    scope: DesktopGfsUploadScope
  }>()
  private sandboxUiLifecycleQueue: Promise<void> = Promise.resolve()
  private workflowApprovalTeamById = new Map<string, string>()
  private workflowTeamByKey = new Map<string, string>()
  private readonly prewarmAttemptAtByHostRef = new Map<string, number>()
  private readonly prewarmReemitLoopHostRefs = new Set<string>()
  private readonly prewarmReemitAbortControllers = new Map<string, AbortController>()
  private prewarmAuthEpoch = 0
  private prewarmAuthTransitionCount = 0
  private hostStatusStreams = new Map<
    string,
    {
      ownerId: number
      stop: (opts?: { silent?: boolean }) => void
    }
  >()
  private hostActivityStreams = new Map<
    string,
    {
      ownerId: number
      stop: (opts?: { silent?: boolean }) => void
    }
  >()
  private notificationStreams = new Map<
    string,
    {
      ownerId: number
      state: 'connecting' | 'open' | 'error'
      approvalRequested: number
      snapshot: number
      updated: number
      completed: number
      stop: (opts?: { silent?: boolean }) => void
    }
  >()
  private readonly entityChangeSubscribers = new Map<
    string,
    { ownerId: number; onEvent: (event: EntityChangeStreamEvent) => void }
  >()
  private entityChangeConnectionStop: ((opts?: { silent?: boolean }) => void) | null = null
  private entityChangeSessionToken: string | null = null
  private entityChangeSessionRequestContext: unknown = null
  private entityChangeSessionGeneration = 0
  private entityChangeEnvironmentSwitching = false
  private entityChangeSessionExpiryDeferred = false
  private entityChangeCursor: string | null = null
  private progressStreams = new Map<
    string,
    { ownerId: number; stop: (opts?: { silent?: boolean }) => void }
  >()

  private get logoutInProgress(): boolean {
    return this.logoutFenceCount > 0
  }

  private set logoutInProgress(active: boolean) {
    this.logoutFenceCount = active
      ? this.logoutFenceCount + 1
      : Math.max(0, this.logoutFenceCount - 1)
  }

  constructor(options: AppServiceOptions = {}) {
    this.tokenStore = options.tokenStore ?? new TokenStore()
    this.getUserDataDirectory = options.getUserDataDirectory ?? (() => app.getPath('userData'))
    this.reportDeferredLogoutFailure = options.reportDeferredLogoutFailure ?? (() => {})
    this.notifySessionExpired = options.notifySessionExpired ?? (() => {})
    this.sessionAuthority = new SessionAuthorityCoordinator({
      getTokenStore: () => this.tokenStore,
      getUserDataDirectory: this.getUserDataDirectory,
      reportDeferredLogoutFailure: this.reportDeferredLogoutFailure,
      failClosedForPendingLogout: error => this.failClosedForPendingLogout(error),
    })
    setSessionInvalidationHandler(
      (token, requestOwner) => {
        // A derived RPC token can expire independently while its owning session
        // lease remains valid. RPC callers own their one-refresh retry; only a
        // 401 from the primary session credential invalidates the lease here.
        if (this.sessionAuthority.isPrimarySessionRequestOwner(requestOwner))
          this.endInvalidatedMemoryOnlySession(token, requestOwner)
      },
      (token, requestContext) => this.assertTemporarySessionRequestAllowed(token, requestContext)
    )
  }

  private get sessionToken(): string | null {
    return this.sessionAuthority.sessionToken
  }

  private set sessionToken(value: string | null) {
    this.sessionAuthority.sessionToken = value
  }

  private get me(): SessionMe | null {
    return this.sessionAuthority.me
  }

  private set me(value: SessionMe | null) {
    this.sessionAuthority.me = value
  }

  private get sessionGeneration(): number {
    return this.sessionAuthority.sessionGeneration
  }

  private get acceptedSessionSource(): AcceptedSessionTokenSource | undefined {
    return this.sessionAuthority.acceptedSessionSource
  }

  private set acceptedSessionSource(value: AcceptedSessionTokenSource | undefined) {
    this.sessionAuthority.acceptedSessionSource = value
  }

  private get memoryOnlySession(): MemoryOnlySessionLease | undefined {
    return this.sessionAuthority.memoryOnlySession
  }

  private set memoryOnlySession(value: MemoryOnlySessionLease | undefined) {
    this.sessionAuthority.memoryOnlySession = value
  }

  private static dedupe(values: string[]): string[] {
    return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)))
  }

  private static shouldRefreshRpcToken(error: unknown): boolean {
    if (!(error instanceof ApiError)) return false
    if (error.status === 401) return true
    if (error.status !== 403) return false
    const body = String(error.bodyText || '').toLowerCase()
    const message = String(error.message || '').toLowerCase()
    return body.includes('missing scope') || message.includes('missing scope')
  }

  private static isForbiddenSharedFilesListError(error: unknown): boolean {
    if (!(error instanceof ApiError)) return false
    if (error.status === 403) return true
    if (error.status !== 500) return false
    const details = `${error.message || ''} ${error.bodyText || ''}`.toLowerCase()
    return (
      details.includes('shared-filesystems') &&
      details.includes('(403)') &&
      details.includes('forbidden')
    )
  }

  private admitCredentialProducer(): (() => void) | null {
    if (this.quitPreparationStarted) {
      return null
    }

    let settleProducer!: () => void
    const producer = new Promise<void>(resolve => {
      settleProducer = resolve
    })
    this.pendingCredentialProducers.add(producer)
    let released = false
    return () => {
      if (released) return
      released = true
      this.pendingCredentialProducers.delete(producer)
      settleProducer()
    }
  }

  private runCredentialProducer<T>(
    operation: () => Promise<T>,
    onAdmissionRejected?: (error: QuitAdmissionClosedError) => T | void | Promise<T | void>
  ): Promise<T> {
    if (this.quitPreparationStarted) {
      const error = new QuitAdmissionClosedError()
      try {
        const fallback = onAdmissionRejected?.(error)
        if (fallback instanceof Promise) {
          return fallback.then(value => {
            if (value !== undefined) return value
            throw error
          })
        }
        if (fallback !== undefined) return Promise.resolve(fallback)
      } catch (recordError) {
        return Promise.reject(recordError)
      }
      return Promise.reject(error)
    }

    let resolveProducer!: (value: T | PromiseLike<T>) => void
    let rejectProducer!: (error: unknown) => void
    const producer = new Promise<T>((resolve, reject) => {
      resolveProducer = resolve
      rejectProducer = reject
    })
    this.pendingCredentialProducers.add(producer)
    void producer.then(
      () => this.pendingCredentialProducers.delete(producer),
      () => this.pendingCredentialProducers.delete(producer)
    )
    try {
      Promise.resolve(operation()).then(resolveProducer, rejectProducer)
    } catch (error) {
      rejectProducer(error)
    }
    return producer
  }

  /**
   * Maps rpc-proxy's structured host-availability 503s ({code:'host_waking'}
   * from the wake-and-hold subsystem, {code:'host_draining'} from the mcp-host
   * DRAINING fence) to a stable Error. Electron IPC serializes errors down to
   * their message string, so the renderer keys its "waking" presentation off
   * the code token carried in this message.
   */
  private static toHostAvailabilityError(hostRef: string, error: unknown): Error | null {
    if (!(error instanceof ApiError) || error.status !== 503) return null
    const body = String(error.bodyText || '')
    if (body.includes('"host_waking"')) {
      return new Error(`host_waking: agent host "${hostRef}" is waking up — retry shortly`)
    }
    if (body.includes('"host_draining"')) {
      return new Error(`host_draining: agent host "${hostRef}" is draining — retry shortly`)
    }
    return null
  }

  private rememberWorkflowApprovalTeam(approval: PendingWorkflowApproval): void {
    const teamId = String(approval.target?.teamId || '').trim()
    if (!approval.id || !teamId) return
    this.workflowApprovalTeamById.set(approval.id, teamId)
  }

  private rememberWorkflowApprovalTeams(approvals: PendingWorkflowApproval[]): void {
    for (const approval of approvals) {
      this.rememberWorkflowApprovalTeam(approval)
    }
  }

  private workflowKey(ns: string, name: string): string {
    return `${String(ns || '').trim()}/${String(name || '').trim()}`
  }

  private updateCachedCurrentTeam(teamId: string | null | undefined): void {
    if (!this.teamDirectoryCache) return
    this.teamDirectoryCache = {
      ...this.teamDirectoryCache,
      currentTeamId: String(teamId || ''),
    }
  }

  /** The team the chat store and the delete fence are scoped to (see chatStoreHomeTeamId). */
  private chatStoreTeamId(): string | null {
    if (this.chatStoreHomeTeamId !== null) return this.chatStoreHomeTeamId
    return this.me?.teamId ?? null
  }

  private async bindCurrentChatStore(userId: string): Promise<void> {
    await bindChatStoreForUser(userId, getActiveEnvKey(), {
      legacyEnvKeys: getActiveLegacyEnvKeys(),
      teamId: this.me?.id === userId ? this.chatStoreTeamId() : null,
    })
  }

  /**
   * Serialize native operations that publish runtime configuration, session,
   * token-store, or GFS authorization state. The queue recovers after either
   * success or failure so one rejected transition cannot strand later work.
   */
  private withNativeAuthEnvironmentCommit<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.nativeAuthEnvironmentCommitQueue.then(operation, operation)
    this.nativeAuthEnvironmentCommitQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private captureAuthEnvironmentBinding(): {
    environmentKey: string
    profileId: string | null
    restBaseUrl: string
  } {
    return {
      environmentKey: getActiveEnvKey(),
      profileId: getActiveRuntimeConfigOptionId(),
      restBaseUrl: canonicalizeDesktopRestEndpoint(config.externalRestApiBaseUrl),
    }
  }

  private assertAuthEnvironmentBinding(binding: {
    environmentKey: string
    profileId: string | null
    restBaseUrl: string
  }): void {
    const current = this.captureAuthEnvironmentBinding()
    if (
      current.profileId !== binding.profileId ||
      !sameDesktopRestEndpoint(current.restBaseUrl, binding.restBaseUrl)
    ) {
      throw new Error('stale_runtime_environment')
    }
  }

  private runtimeConfigDiscoveryMatchesCurrentBinding(discovery: RuntimeConfigDiscovery): boolean {
    const currentBinding = this.captureAuthEnvironmentBinding()
    return (
      currentBinding.profileId === discovery.profileId &&
      sameDesktopRestEndpoint(currentBinding.restBaseUrl, discovery.externalRestApiBaseUrl)
    )
  }

  private getEffectiveRpcProxyBaseUrl(): string {
    const effectiveEndpoint = this.effectiveRuntimeRpcEndpoint
    if (effectiveEndpoint && this.runtimeConfigDiscoveryMatchesCurrentBinding(effectiveEndpoint)) {
      return effectiveEndpoint.rpcProxyBaseUrl
    }
    return config.rpcProxyBaseUrl
  }

  /** Caller must hold the native auth/environment commit owner. */
  private setEffectiveRuntimeRpcEndpoint(discovery: RuntimeConfigDiscovery): void {
    const previousEndpoint = this.getEffectiveRpcProxyBaseUrl()
    this.effectiveRuntimeRpcEndpoint = discovery
    if (previousEndpoint !== discovery.rpcProxyBaseUrl) this.rpcTokenManager.clear()
  }

  /** Caller must hold the native auth/environment commit owner. */
  private clearEffectiveRuntimeRpcEndpoint(): void {
    const effectiveEndpoint = this.effectiveRuntimeRpcEndpoint
    if (!effectiveEndpoint) return
    this.effectiveRuntimeRpcEndpoint = null
    if (effectiveEndpoint.rpcProxyBaseUrl !== config.rpcProxyBaseUrl) this.rpcTokenManager.clear()
  }

  /** Caller must hold the native auth/environment commit owner. */
  private discardRuntimeConfigDiscoveryOutsideCurrentBinding(): void {
    if (
      this.pendingRuntimeConfigDiscovery &&
      !this.runtimeConfigDiscoveryMatchesCurrentBinding(this.pendingRuntimeConfigDiscovery)
    ) {
      this.pendingRuntimeConfigDiscovery = null
    }
    if (
      this.effectiveRuntimeRpcEndpoint &&
      !this.runtimeConfigDiscoveryMatchesCurrentBinding(this.effectiveRuntimeRpcEndpoint)
    ) {
      this.clearEffectiveRuntimeRpcEndpoint()
    }
    if (config.rpcProxyBaseUrl?.trim()) {
      this.pendingRuntimeConfigDiscovery = null
      this.clearEffectiveRuntimeRpcEndpoint()
    }
  }

  getChatDeletionFenceAuthority(): {
    authorityScope: ChatAuthorityScope
    sessionGeneration: number
  } {
    this.requireSessionToken()
    if (!this.me) throw new Error('Not authenticated')
    return {
      authorityScope: {
        environmentKey: getActiveEnvKey(),
        userId: this.me.id,
        teamId: String(this.chatStoreTeamId() || '').trim() || null,
      },
      sessionGeneration: this.sessionGeneration,
    }
  }

  private async inspectPendingLogoutBeforeTeamPersistence(
    envKey: string
  ): Promise<PendingExternalLogoutMarker | null> {
    try {
      return this.inspectPendingLogoutMarker(envKey)
    } catch (error) {
      await this.handlePendingLogoutInspectionFailure(error)
      throw error
    }
  }

  private async inspectTeamTransitionMarker(
    envKey: string
  ): Promise<PendingExternalLogoutMarker | null> {
    const legacyNamespace = getActiveLegacyEnvKeyInventory()
    try {
      await SessionAuthorityAcceptanceTransaction.reconcilePendingAcceptanceProjection(
        this.tokenStore,
        this.getUserDataDirectory(),
        envKey,
        legacyNamespace.keys,
        legacyNamespace.complete
      )
    } catch (error) {
      // A confirmed projection mismatch is an authoritative denial, not a benign team-hop
      // conflict. Route it through the same fail-closed runtime transition used by restore/login.
      await this.handlePendingLogoutInspectionFailure(error, 'marker-inspection')
      throw error
    }
    const marker = await this.inspectPendingLogoutBeforeTeamPersistence(envKey)
    if (
      this.sessionAuthority.planTeamTransitionMarkerAdmission(marker, envKey).kind === 'fail-closed'
    ) {
      await this.failClosedForPendingLogout(
        new Error('Durable session authority does not admit a team transition')
      )
      throw new SessionTokenStorageSupersededBeforeWriteError()
    }
    return marker
  }

  private async assertTeamTransitionMarkerCurrent(
    envKey: string,
    expected: PendingExternalLogoutMarker | null
  ): Promise<void> {
    const current = await this.inspectTeamTransitionMarker(envKey)
    if (
      expected === null ? current !== null : !pendingExternalLogoutMarkersMatch(current, expected)
    )
      throw new SessionTokenStorageSupersededBeforeWriteError()
  }

  private inspectPendingLogoutMarker(envKey: string): PendingExternalLogoutMarker | null {
    return this.sessionAuthority.inspectPendingLogoutMarker(envKey)
  }

  private async handlePendingLogoutInspectionFailure(
    error: unknown,
    context: PersistenceFailureContext = 'marker-inspection'
  ): Promise<PendingLogoutFailureDisposition> {
    return this.sessionAuthority.handlePendingLogoutInspectionFailure(error, context)
  }

  private unwrapPersistenceAuthorityError(error: unknown): unknown {
    return this.sessionAuthority.unwrapPersistenceAuthorityError(error)
  }

  private async clearKeytarForObservedMarker(
    envKey: string,
    marker: PendingExternalLogoutMarker,
    preserveActiveEnvKey: boolean,
    generation = this.sessionGeneration
  ) {
    return this.sessionAuthority.clearKeytarForObservedMarker(
      envKey,
      marker,
      preserveActiveEnvKey,
      generation
    )
  }

  private runSessionPersistence<T>(operation: () => Promise<T>): Promise<T> {
    return this.sessionAuthority.runSessionPersistence(operation)
  }

  private requireSessionTokenSourceCurrent(
    selected: VerifiedSessionTokenSource | undefined,
    envKey: string,
    mayContinue: () => boolean
  ): asserts selected is VerifiedSessionTokenSource {
    this.sessionAuthority.requireSessionTokenSourceCurrent(selected, envKey, mayContinue)
  }

  private captureAcceptedSessionSource(envKey: string): VerifiedSessionTokenSource | undefined {
    return this.sessionAuthority.captureAcceptedSessionSource(envKey)
  }

  /** Derive prior ownership only from original publications or accepted scope. */
  private priorSessionSource(
    token: string,
    envKey: string,
    source: SessionTokenReadSource | 'default',
    priorPublications: Map<SessionTokenReadSource, VerifiedSessionTokenSource>,
    publications: Map<SessionTokenReadSource, VerifiedSessionTokenSource>,
    accepted: VerifiedSessionTokenSource | undefined
  ): VerifiedSessionTokenSource {
    return this.sessionAuthority.priorSessionSource(
      token,
      envKey,
      source,
      priorPublications,
      publications,
      accepted
    )
  }

  /** Keep the original in-lane source observation through every awaited boundary. */
  private async verifySessionTokenSource(
    selected: VerifiedSessionTokenSource | undefined,
    envKey: string,
    mayContinue: () => boolean
  ): Promise<void> {
    return this.sessionAuthority.verifySessionTokenSource(selected, envKey, mayContinue)
  }

  private async readVerifiedSessionTokenSource(
    token: string,
    envKey: string,
    source: SessionTokenReadSource | 'default',
    mayContinue: () => boolean,
    original?: VerifiedSessionTokenSource
  ): Promise<VerifiedSessionTokenSource> {
    return this.sessionAuthority.readVerifiedSessionTokenSource(
      token,
      envKey,
      source,
      mayContinue,
      original
    )
  }

  private async switchSessionToTeam(
    teamId: string,
    token = this.requireSessionToken(),
    options: {
      advanceSessionGeneration?: boolean
      activateGfsScope?: boolean
      beforeAcceptance?: () => Promise<void>
    } = {}
  ) {
    const releaseTransientHop = this.enterGfsTransientTeamHop()
    const targetTeamId = String(teamId || '').trim()
    try {
      if (!targetTeamId) throw new Error('teamId is required')
      const switchGeneration = this.sessionGeneration
      if (this.sessionToken !== token || !this.me) {
        throw new Error('stale_auth_epoch: authenticated team scope changed before switch dispatch')
      }
      const expectedMarker = await this.inspectTeamTransitionMarker(getActiveEnvKey())
      const previousIdentity =
        this.gfsScopeIdentity ?? (this.me ? desktopGfsUploadIdentity(this.me) : undefined)
      if (this.memoryOnlySession) {
        const switched = await this.authClient.switchTeam(token, targetTeamId)
        await this.assertTeamTransitionMarkerCurrent(getActiveEnvKey(), expectedMarker)
        if (this.sessionGeneration !== switchGeneration || this.sessionToken !== token) {
          throw new SessionTokenStorageSupersededBeforeWriteError()
        }
        await this.switchMemoryOnlySessionToTeamCandidate(
          targetTeamId,
          token,
          switched.token,
          switchGeneration,
          expectedMarker,
          previousIdentity,
          options
        )
        return switched.token
      }

      const switched = await this.authClient.switchTeam(token, targetTeamId)
      await this.assertTeamTransitionMarkerCurrent(getActiveEnvKey(), expectedMarker)
      if (this.sessionGeneration !== switchGeneration || this.sessionToken !== token) {
        throw new SessionTokenStorageSupersededBeforeWriteError()
      }
      await this.switchPersistentSessionToTeamCandidate(
        targetTeamId,
        token,
        switched.token,
        switchGeneration,
        previousIdentity,
        expectedMarker,
        options
      )
      return switched.token
    } finally {
      releaseTransientHop()
    }
  }

  private async switchMemoryOnlySessionToTeamCandidate(
    targetTeamId: string,
    priorToken: string,
    candidateToken: string,
    generation: number,
    expectedMarker: PendingExternalLogoutMarker | null,
    priorGfsIdentity: DesktopGfsUploadIdentity | undefined,
    options: {
      advanceSessionGeneration?: boolean
      activateGfsScope?: boolean
      beforeAcceptance?: () => Promise<void>
    }
  ): Promise<void> {
    const priorUser = this.me
    const priorLease = this.memoryOnlySession
    const envKey = getActiveEnvKey()
    if (
      !priorUser ||
      !priorLease ||
      priorLease.envKey !== envKey ||
      !expectedMarker ||
      !pendingExternalLogoutMarkersMatch(priorLease.marker, expectedMarker)
    )
      throw new SessionTokenStorageSupersededBeforeWriteError()

    const ownerIsCurrent = () =>
      this.sessionGeneration === generation &&
      this.sessionToken === priorToken &&
      this.me === priorUser &&
      this.memoryOnlySession === priorLease &&
      !this.logoutInProgress &&
      getActiveEnvKey() === envKey
    const producerIsCurrent = () =>
      ownerIsCurrent() && !this.sessionAuthority.isMemoryOnlySessionExpired(priorLease.expiresAt)
    const assertOwnerCurrent = async () => {
      if (!ownerIsCurrent()) throw new SessionTokenStorageSupersededBeforeWriteError()
      this.assertMemoryOnlySessionCurrent(priorLease)
      await this.assertTeamTransitionMarkerCurrent(envKey, expectedMarker)
      if (!ownerIsCurrent()) throw new SessionTokenStorageSupersededBeforeWriteError()
      this.assertMemoryOnlySessionCurrent(priorLease)
    }

    const initialChatBindingGeneration = getChatStoreBindingGeneration()
    const initialChatScope = requireChatStore().getAuthorityScope()
    if (
      !initialChatScope ||
      initialChatScope.environmentKey !== envKey ||
      initialChatScope.userId !== priorUser.id
    )
      throw new Error('Temporary team candidate cannot prepare the current chat-store owner')

    const candidate = await SessionAuthorityAcceptanceTransaction.begin({
      tokenStore: this.tokenStore,
      userDataDirectory: this.getUserDataDirectory(),
      envKey,
      legacyEnvKeys: getActiveLegacyEnvKeys(),
      legacyNamespaceComplete: getActiveLegacyEnvKeyInventory().complete,
      token: candidateToken,
      accountId: priorUser.id,
      source: 'memory-only',
      priorToken,
      priorVolatileSessionId: priorLease.volatileSessionId,
      volatileSessionId: priorLease.volatileSessionId,
      ownerEpoch: generation,
    })
    let gfsPrepared = false
    let acceptedMemoryLease: MemoryOnlySessionLease | undefined
    try {
      const expiresAt = this.sessionAuthority.memoryOnlySessionReplacementDeadline(
        priorLease.expiresAt,
        candidateToken
      )
      await this.runSessionPersistence(async () => {
        await candidate.execute({
          assertOwned: assertOwnerCurrent,
          isProducerStillCurrent: producerIsCurrent,
          isPriorConsumerOwnerCurrent: () =>
            sameChatAuthorityScope(requireChatStore().getAuthorityScope(), initialChatScope),
          onAcceptanceIndeterminate: () => {
            if (ownerIsCurrent()) this.clearAuthenticatedSessionState()
          },
          onAcceptancePublicationFailure: () => {
            // The durable frame may already select this candidate. Do not restore the old
            // in-process owner after a partial synchronous publication; deny runtime access
            // and let startup reconcile the accepted receipt.
            this.clearAuthenticatedSessionState()
          },
          verifyIdentity: async () => {
            const user = await this.sessionAuthority.withTemporarySessionCandidateValidation(
              priorToken,
              candidateToken,
              () =>
                runWithSessionRequestContext(
                  this.sessionAuthority.captureSessionRequestContext(priorToken),
                  () => this.authClient.getMe(candidateToken)
                )
            )
            await assertOwnerCurrent()
            if (user.id !== priorUser.id || String(user.teamId || '').trim() !== targetTeamId)
              throw new SessionTokenStorageSupersededBeforeWriteError()
            return user
          },
          prepareConsumers: async user => {
            if (options.beforeAcceptance) {
              // The GFS fence may partly apply before failing. Preserve and restore its owner.
              gfsPrepared = true
              await options.beforeAcceptance()
            }
            await assertOwnerCurrent()
            if (this.sessionAuthority.isMemoryOnlySessionExpired(expiresAt))
              throw new TemporarySessionExpiredError()
            return {
              chatBindingGeneration: initialChatBindingGeneration,
              chatScope: initialChatScope,
              acceptedChatTeamId:
                this.chatStoreHomeTeamId ?? (String(user.teamId || '').trim() || null),
            }
          },
          consumersReady: consumers => {
            const currentScope = requireChatStore().getAuthorityScope()
            return Boolean(
              getChatStoreBindingGeneration() === consumers.chatBindingGeneration &&
              currentScope &&
              currentScope.environmentKey === consumers.chatScope.environmentKey &&
              currentScope.userId === consumers.chatScope.userId &&
              currentScope.teamId === consumers.chatScope.teamId &&
              !this.sessionAuthority.isMemoryOnlySessionExpired(expiresAt)
            )
          },
          isStillOwned: (_user, consumers) => {
            if (
              !ownerIsCurrent() ||
              getChatStoreBindingGeneration() !== consumers.chatBindingGeneration
            )
              return false
            // The acceptance transaction has replaced the observed before-image with its own
            // deny-only projection marker. It validates that exact marker under the serialized
            // authority lane immediately before CAS; comparing with the pre-transaction marker
            // here would falsely reject every valid staged acceptance.
            return (
              getActiveEnvKey() === envKey &&
              !this.sessionAuthority.isMemoryOnlySessionExpired(priorLease.expiresAt)
            )
          },
          preparePublication: (user, consumers) => {
            const publishChatScope = reserveBoundChatStoreTeamScope(
              consumers.chatBindingGeneration,
              user.id,
              envKey,
              consumers.acceptedChatTeamId
            )
            const acceptedMarker = candidate.stagedAcceptanceMarker
            if (!publishChatScope || !acceptedMarker)
              throw new SessionTokenStorageSupersededBeforeWriteError()
            const nextLease: MemoryOnlySessionLease = {
              ...priorLease,
              marker: acceptedMarker,
              expiresAt,
            }
            const nextGeneration =
              options.advanceSessionGeneration === false ? generation : generation + 1
            const activateGfs = options.activateGfsScope || this.chatStoreHomeTeamId === null
            const nextGfsIdentity = activateGfs ? desktopGfsUploadIdentity(user) : undefined
            const runtimeOwnerPublication = this.sessionAuthority.prepareRuntimeOwnerPublication({
              expectedGeneration: generation,
              generation: nextGeneration,
              token: candidateToken,
              user,
              acceptedSource: undefined,
              acceptedAuthoritySource: undefined,
              acceptedProjectionMarker: nextLease.marker,
              memoryLease: nextLease,
            })
            if (!runtimeOwnerPublication) throw new SessionTokenStorageSupersededBeforeWriteError()
            const nextTeamDirectoryCache = this.teamDirectoryCache
              ? { ...this.teamDirectoryCache, currentTeamId: String(user.teamId || '') }
              : this.teamDirectoryCache
            return {
              isCurrent: () => runtimeOwnerPublication.isCurrent(),
              publish: () => {
                publishChatScope()
                runtimeOwnerPublication.publish()
                acceptedMemoryLease = nextLease
                this.rpcTokenManager.clear()
                this.profileUiBaseUrlCache = null
                this.accessCatalog = null
                this.teamDirectoryCache = nextTeamDirectoryCache
                this.workflowApprovalTeamById.clear()
                this.workflowTeamByKey.clear()
                if (activateGfs) {
                  this.gfsAuthEpoch += 1
                  this.gfsDispatchBlocked = false
                  this.gfsScopeIdentity = nextGfsIdentity ?? null
                }
                if (this.gfsTransientTeamHopDepth === 0)
                  this.updateEntityChangeSessionToken(candidateToken)
                return undefined
              },
            }
          },
          afterAcceptance: async () => {
            if (acceptedMemoryLease) this.scheduleMemoryOnlySessionExpiry(acceptedMemoryLease)
            if (this.gfsTransientTeamHopDepth === 0) {
              try {
                this.restartEntityChangeStreamForSessionReplacement()
              } catch (error) {
                this.reportDeferredLogoutFailureSafely(error)
              }
            }
          },
          discardConsumers: () => {},
          rollbackBeforeAcceptance: authorization => {
            if (!authorization.canRestorePriorConsumers) {
              if (ownerIsCurrent()) this.clearAuthenticatedSessionState()
              return
            }
            if (gfsPrepared && ownerIsCurrent()) this.activateGfsAuthScope(priorGfsIdentity)
          },
        })
      })

      const expectedGeneration =
        options.advanceSessionGeneration === false ? generation : generation + 1
      if (
        !acceptedMemoryLease ||
        this.sessionGeneration !== expectedGeneration ||
        this.sessionToken !== candidateToken ||
        this.memoryOnlySession !== acceptedMemoryLease ||
        this.me?.teamId !== targetTeamId
      )
        throw new SessionTokenStorageSupersededBeforeWriteError()
    } catch (error) {
      if (
        !acceptedMemoryLease &&
        ownerIsCurrent() &&
        !(error instanceof SessionTokenStorageSupersededBeforeWriteError)
      ) {
        // A candidate failure may race a newer logout or marker revision. Re-observe the
        // volatile lease before retaining Home; a transient read is retried, never interpreted
        // as absence, while a confirmed newer denial ends the old lease.
        for (let attempt = 0; attempt < 3 && ownerIsCurrent(); attempt += 1) {
          try {
            this.assertMemoryOnlySessionCurrent(priorLease)
            break
          } catch (ownershipError) {
            const failure = this.sessionAuthority.planPersistenceAuthorityFailure(
              ownershipError,
              'producer-rollback'
            )
            if (failure.kind !== 'transient-read') break
            this.reportDeferredLogoutFailureSafely(ownershipError)
          }
        }
      }
      throw error
    }
  }

  /**
   * Stage a persistent team replacement in an immutable source slot. The prior source remains
   * selected until server identity and the producer owner are verified and the authority CAS wins.
   */
  private async switchPersistentSessionToTeamCandidate(
    targetTeamId: string,
    priorToken: string,
    candidateToken: string,
    generation: number,
    priorGfsIdentity: DesktopGfsUploadIdentity | undefined,
    expectedMarker: PendingExternalLogoutMarker | null,
    options: {
      advanceSessionGeneration?: boolean
      activateGfsScope?: boolean
      beforeAcceptance?: () => Promise<void>
    }
  ): Promise<void> {
    const priorUser = this.me
    const envKey = getActiveEnvKey()
    if (!priorUser || !candidateToken || !this.tokenStore)
      throw new SessionTokenStorageSupersededBeforeWriteError()

    await this.runSessionPersistence(async () => {
      const ownerIsCurrent = () =>
        this.sessionGeneration === generation &&
        this.sessionToken === priorToken &&
        this.me === priorUser &&
        !this.logoutInProgress &&
        getActiveEnvKey() === envKey
      const producerIsCurrent = () => ownerIsCurrent()
      const assertOwnerCurrent = async () => {
        if (!ownerIsCurrent()) throw new SessionTokenStorageSupersededBeforeWriteError()
        await this.assertTeamTransitionMarkerCurrent(envKey, expectedMarker)
        if (!ownerIsCurrent()) throw new SessionTokenStorageSupersededBeforeWriteError()
      }

      let source: 'keytar' | 'safe-storage'
      const selected = await readSessionAuthoritySourceSelection({
        tokenStore: this.tokenStore,
        envKey,
        coordinator: this.sessionAuthority,
      })
      if (selected.status === 'accepted') {
        if (selected.session.token !== priorToken)
          throw new SessionTokenStorageSupersededBeforeWriteError()
        const selectedSource = selected.session.accepted.record.frame.source
        if (
          !selectedSource ||
          (selectedSource.kind !== 'keytar' && selectedSource.kind !== 'safe-storage')
        )
          throw new SessionTokenStorageSupersededBeforeWriteError()
        source = selectedSource.kind
      } else if (selected.status === 'absent') {
        const legacyAccepted = this.sessionAuthority.captureAcceptedSessionSource(envKey)
        if (!legacyAccepted || legacyAccepted.token !== priorToken)
          throw new SessionTokenStorageSupersededBeforeWriteError()
        if (legacyAccepted.source === 'keytar') source = 'keytar'
        else if (legacyAccepted.source === 'safe-storage') source = 'safe-storage'
        else throw new SessionTokenStorageSupersededBeforeWriteError()
      } else {
        throw new SessionTokenStorageSupersededBeforeWriteError()
      }
      await assertOwnerCurrent()

      const candidate = await SessionAuthorityAcceptanceTransaction.begin({
        tokenStore: this.tokenStore,
        userDataDirectory: this.getUserDataDirectory(),
        envKey,
        legacyEnvKeys: getActiveLegacyEnvKeys(),
        legacyNamespaceComplete: getActiveLegacyEnvKeyInventory().complete,
        token: candidateToken,
        accountId: priorUser.id,
        source,
        priorToken,
        priorSourceKind: source,
        ownerEpoch: generation,
      })
      let gfsPrepared = false
      const chatBindingGeneration = getChatStoreBindingGeneration()
      const chatScope = requireChatStore().getAuthorityScope()
      if (!chatScope || chatScope.environmentKey !== envKey || chatScope.userId !== priorUser.id)
        throw new Error('Team candidate cannot prepare the current chat-store owner')

      await candidate.execute({
        assertOwned: assertOwnerCurrent,
        isProducerStillCurrent: producerIsCurrent,
        isPriorConsumerOwnerCurrent: () =>
          sameChatAuthorityScope(requireChatStore().getAuthorityScope(), chatScope),
        onAcceptanceIndeterminate: () => {
          if (ownerIsCurrent()) this.clearAuthenticatedSessionState()
        },
        onAcceptancePublicationFailure: () => {
          this.clearAuthenticatedSessionState()
        },
        verifyIdentity: async () => {
          const user = await this.withCandidateSessionRequest(
            candidateToken,
            envKey,
            generation,
            ownerIsCurrent,
            () => this.authClient.getMe(candidateToken)
          )
          await assertOwnerCurrent()
          if (user.id !== priorUser.id || String(user.teamId || '').trim() !== targetTeamId)
            throw new SessionTokenStorageSupersededBeforeWriteError()
          return user
        },
        prepareConsumers: async user => {
          if (options.beforeAcceptance) {
            // Preparation may partially fence a fallible consumer; rollback restores its scope.
            gfsPrepared = true
            await options.beforeAcceptance()
          }
          await assertOwnerCurrent()
          return {
            chatBindingGeneration,
            chatScope,
            acceptedChatTeamId:
              this.chatStoreHomeTeamId ?? (String(user.teamId || '').trim() || null),
          }
        },
        consumersReady: consumers => {
          const currentScope = requireChatStore().getAuthorityScope()
          return Boolean(
            getChatStoreBindingGeneration() === consumers.chatBindingGeneration &&
            currentScope &&
            currentScope.environmentKey === consumers.chatScope.environmentKey &&
            currentScope.userId === consumers.chatScope.userId &&
            currentScope.teamId === consumers.chatScope.teamId
          )
        },
        isStillOwned: (_user, consumers) => {
          // The transaction verifies the staged acceptance marker against its durable projection
          // intent inside the final authority lane. This callback only verifies runtime and
          // consumer ownership; the original marker is an obsolete before-image by this point.
          return (
            ownerIsCurrent() && getChatStoreBindingGeneration() === consumers.chatBindingGeneration
          )
        },
        preparePublication: (user, consumers) => {
          const publishChatScope = reserveBoundChatStoreTeamScope(
            consumers.chatBindingGeneration,
            user.id,
            envKey,
            consumers.acceptedChatTeamId
          )
          const acceptedMarker = candidate.stagedAcceptanceMarker
          const nextGeneration =
            options.advanceSessionGeneration === false ? generation : generation + 1
          const runtimeOwnerPublication = this.sessionAuthority.prepareRuntimeOwnerPublication({
            expectedGeneration: generation,
            generation: nextGeneration,
            token: candidateToken,
            user,
            acceptedSource: undefined,
            acceptedAuthoritySource: candidate.candidateAuthoritySource ?? undefined,
            acceptedProjectionMarker: acceptedMarker ?? undefined,
            memoryLease: undefined,
          })
          if (!publishChatScope || !acceptedMarker || !runtimeOwnerPublication)
            throw new SessionTokenStorageSupersededBeforeWriteError()
          const activateGfs = options.activateGfsScope || this.chatStoreHomeTeamId === null
          const nextGfsIdentity = activateGfs ? desktopGfsUploadIdentity(user) : undefined
          return {
            isCurrent: () => runtimeOwnerPublication.isCurrent(),
            publish: () => {
              publishChatScope()
              runtimeOwnerPublication.publish()
              this.rpcTokenManager.clear()
              this.profileUiBaseUrlCache = null
              this.accessCatalog = null
              this.teamDirectoryCache = null
              this.workflowApprovalTeamById.clear()
              this.workflowTeamByKey.clear()
              if (activateGfs) {
                this.gfsAuthEpoch += 1
                this.gfsDispatchBlocked = false
                this.gfsScopeIdentity = nextGfsIdentity ?? null
              }
              if (this.gfsTransientTeamHopDepth === 0)
                this.updateEntityChangeSessionToken(candidateToken)
              return undefined
            },
          }
        },
        afterAcceptance: async () => {
          if (this.gfsTransientTeamHopDepth === 0) {
            this.restartEntityChangeStreamForSessionReplacement()
          }
          try {
            await candidate.cleanSupersededSources()
          } catch (error) {
            this.reportDeferredLogoutFailureSafely(error)
          }
        },
        discardConsumers: () => {},
        rollbackBeforeAcceptance: authorization => {
          if (!authorization.canRestorePriorConsumers) {
            if (ownerIsCurrent()) this.clearAuthenticatedSessionState()
            return
          }
          if (gfsPrepared && ownerIsCurrent()) this.activateGfsAuthScope(priorGfsIdentity)
        },
      })
    })
  }

  private enterGfsTransientTeamHop(): () => void {
    this.gfsTransientTeamHopDepth += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.gfsTransientTeamHopDepth = Math.max(0, this.gfsTransientTeamHopDepth - 1)
      if (this.gfsTransientTeamHopDepth === 0 && this.entityChangeSessionExpiryDeferred) {
        this.entityChangeSessionExpiryDeferred = false
        this.emitEntityChangeSessionExpired()
      }
    }
  }

  private assertGfsDispatchAllowed(): void {
    if (this.gfsTransientTeamHopDepth > 0) {
      throw new Error('GFS upload dispatch is unavailable during a transient team hop')
    }
  }

  /**
   * A failed return hop can leave the already-accepted borrowed team as the runtime owner.
   * Re-enable its GFS scope only after the exact source/lease and projection marker still
   * authorize that runtime owner. If any observation is transient or divergent, revoke this
   * owner's consumers rather than reviving a pre-hop scope.
   */
  private async settleFailedTeamRestoreGfsOwner(expected: {
    envKey: string
    generation: number
    token: string
    user: SessionMe
    authoritySource: SessionAuthorityCoordinator['acceptedSessionAuthoritySource']
    projectionMarker: PendingExternalLogoutMarker | undefined
    memoryLease: MemoryOnlySessionLease | undefined
  }): Promise<boolean> {
    const stillOwnsRuntime = () =>
      !this.logoutInProgress &&
      !this.quitPreparationStarted &&
      getActiveEnvKey() === expected.envKey &&
      this.sessionGeneration === expected.generation &&
      this.sessionToken === expected.token &&
      this.me === expected.user &&
      this.sessionAuthority.acceptedSessionAuthoritySource === expected.authoritySource &&
      this.sessionAuthority.memoryOnlySession === expected.memoryLease

    if (!stillOwnsRuntime()) return false
    try {
      if (expected.memoryLease) {
        this.sessionAuthority.assertMemoryOnlySessionCurrent(expected.memoryLease)
      } else {
        const selection = await readSessionAuthoritySourceSelection({
          tokenStore: this.tokenStore,
          envKey: expected.envKey,
          coordinator: this.sessionAuthority,
        })
        const selectedSource =
          selection.status === 'accepted' ? selection.session.accepted.record.frame.source : null
        if (
          selection.status !== 'accepted' ||
          selection.session.token !== expected.token ||
          !selectedSource ||
          !expected.authoritySource ||
          JSON.stringify(selectedSource) !== JSON.stringify(expected.authoritySource) ||
          selectedSource.accountId !== expected.user.id
        )
          throw new SessionTokenStorageSupersededBeforeWriteError()
      }

      // The source read above awaits. Recheck the runtime owner and exact sidecar synchronously
      // after it; there is no yield between this final check and the consumer publication.
      if (!stillOwnsRuntime()) return false
      if (
        !pendingExternalLogoutMarkersMatch(
          this.inspectPendingLogoutMarker(expected.envKey),
          expected.projectionMarker ?? null
        )
      )
        throw new SessionTokenStorageSupersededBeforeWriteError()
      if (!stillOwnsRuntime()) return false

      this.sessionAuthority.advanceSessionGeneration(expected.generation)
      this.updateEntityChangeSessionToken(expected.token)
      this.restartEntityChangeStreamForSessionReplacement()
      this.activateGfsAuthScope(desktopGfsUploadIdentity(expected.user))
      return true
    } catch (error) {
      // An independent newer owner is never cleared. If this operation still owns runtime but
      // its durable receipt cannot be verified, fail closed across every authenticated consumer.
      if (stillOwnsRuntime()) this.clearAuthenticatedSessionState()
      this.reportDeferredLogoutFailureSafely(error)
      return false
    }
  }

  /**
   * After a failed Home restore, the accepted hop owner may need its chat team scope rebound.
   * The operation queue can yield while draining Home work, so publish this same-user scope
   * synchronously only when the exact runtime owner and deny-only marker still match.
   */
  private rebindFailedTeamRestoreChatOwner(expected: {
    envKey: string
    generation: number
    token: string
    user: SessionMe
    authoritySource: SessionAuthorityCoordinator['acceptedSessionAuthoritySource']
    projectionMarker: PendingExternalLogoutMarker | undefined
    memoryLease: MemoryOnlySessionLease | undefined
  }): void {
    const ownerIsCurrent = () =>
      !this.logoutInProgress &&
      !this.quitPreparationStarted &&
      getActiveEnvKey() === expected.envKey &&
      this.sessionGeneration === expected.generation &&
      this.sessionToken === expected.token &&
      this.me === expected.user &&
      this.sessionAuthority.acceptedSessionAuthoritySource === expected.authoritySource &&
      this.memoryOnlySession === expected.memoryLease
    if (!ownerIsCurrent()) return

    let marker: PendingExternalLogoutMarker | null
    try {
      marker = this.inspectPendingLogoutMarker(expected.envKey)
    } catch (error) {
      if (ownerIsCurrent()) this.clearAuthenticatedSessionState()
      this.reportDeferredLogoutFailureSafely(error)
      return
    }
    if (
      !ownerIsCurrent() ||
      !pendingExternalLogoutMarkersMatch(marker, expected.projectionMarker ?? null)
    ) {
      if (ownerIsCurrent()) this.clearAuthenticatedSessionState()
      return
    }

    try {
      if (expected.memoryLease)
        this.sessionAuthority.assertMemoryOnlySessionCurrent(expected.memoryLease)
      const chatStore = requireChatStore()
      const bindingGeneration = getChatStoreBindingGeneration()
      const scope = chatStore.getAuthorityScope()
      if (!scope || scope.environmentKey !== expected.envKey || scope.userId !== expected.user.id)
        throw new SessionTokenStorageSupersededBeforeWriteError()
      const publish = reserveBoundChatStoreTeamScope(
        bindingGeneration,
        expected.user.id,
        expected.envKey,
        String(expected.user.teamId || '').trim() || null
      )
      if (
        !publish ||
        !ownerIsCurrent() ||
        !pendingExternalLogoutMarkersMatch(
          this.inspectPendingLogoutMarker(expected.envKey),
          expected.projectionMarker ?? null
        )
      ) {
        if (ownerIsCurrent()) this.clearAuthenticatedSessionState()
        return
      }
      publish()
    } catch (error) {
      if (ownerIsCurrent()) this.clearAuthenticatedSessionState()
      this.reportDeferredLogoutFailureSafely(error)
    }
  }

  private runWithTeamContext<T>(
    teamId: string | null | undefined,
    operation: (sessionToken: string) => Promise<T>,
    options: {
      mutation?: boolean
      preserveRequestContext?: boolean
      onRequestContextTransition?: (context: unknown) => void
    } = {}
  ): Promise<T> {
    const targetTeamId = String(teamId || '').trim()
    if (options.preserveRequestContext) {
      this.preserveSessionRequestContextForOperation()
    } else {
      this.captureSessionRequestContextForOperation()
    }
    const requestContext = getSessionRequestContext()
    if (requestContext === undefined) throw new SessionRequestOwnershipError()
    const queueOptions = {
      mutation: options.mutation,
      onRequestContextTransition: options.onRequestContextTransition,
      allowApprovedTeamSwitchRebind: !options.preserveRequestContext && options.mutation !== true,
    }
    return runWithSessionRequestContext(requestContext, () =>
      this.runWithTeamContextInTeamQueue(targetTeamId, operation, queueOptions)
    )
  }

  private async runWithTeamContextInTeamQueue<T>(
    targetTeamId: string,
    operation: (sessionToken: string) => Promise<T>,
    options: {
      mutation?: boolean
      onRequestContextTransition?: (context: unknown) => void
      allowApprovedTeamSwitchRebind?: boolean
    } = {}
  ): Promise<T> {
    let requestContext = getSessionRequestContext()
    const activeHop = this.activeTeamContextHop
    const currentToken = this.sessionToken
    const activeHopOwnsRequest = Boolean(
      activeHop &&
      currentToken &&
      this.sessionAuthority.isSessionRequestContextInCurrentLineage(
        activeHop.homeRequestContext,
        currentToken
      )
    )
    if (activeHop && targetTeamId === activeHop.homeTeamId && activeHopOwnsRequest) {
      if (!this.quitPreparationStarted)
        return this.enqueueHomeTeamOperation(
          activeHop,
          operation,
          requestContext,
          options.onRequestContextTransition
        )
    }
    if (requestContext === undefined) {
      throw new SessionRequestOwnershipError()
    }
    if (!activeHopOwnsRequest) {
      const contextIsInCurrentLineage = Boolean(
        currentToken &&
        this.sessionAuthority.isSessionRequestContextInCurrentLineage(requestContext, currentToken)
      )
      if (!contextIsInCurrentLineage) this.assertCurrentSessionRequestContext()
    }
    const rebindRequestContextWithinCurrentLineage = () => {
      if (requestContext === undefined) return
      const token = this.sessionToken
      if (
        !token ||
        !this.sessionAuthority.isSessionRequestContextInCurrentLineage(requestContext, token)
      ) {
        return
      }
      const nextContext = this.sessionAuthority.captureSessionRequestContext(token)
      if (this.sessionAuthority.sessionRequestContextsMatchOwner(requestContext, nextContext))
        return
      requestContext = nextContext
      enterSessionRequestContext(nextContext)
      options.onRequestContextTransition?.(nextContext)
    }
    if (!targetTeamId) {
      await this.teamContextQueue.catch(() => undefined)
      rebindRequestContextWithinCurrentLineage()
      this.assertCurrentSessionRequestContext()
      const context = await this.withNativeAuthEnvironmentCommit(async () => {
        rebindRequestContextWithinCurrentLineage()
        this.assertCurrentSessionRequestContext()
        return {
          sessionToken: this.requireSessionToken(),
          sessionGeneration: this.sessionGeneration,
          environmentBinding: this.captureAuthEnvironmentBinding(),
        }
      })
      const assertContextIsCurrent = () => {
        this.assertSessionGeneration(context.sessionGeneration)
        if (this.sessionToken !== context.sessionToken) {
          throw new Error('stale_auth_epoch: authenticated session changed during operation')
        }
        this.assertAuthEnvironmentBinding(context.environmentBinding)
      }
      if (options.mutation) {
        return this.withNativeAuthEnvironmentCommit(async () => {
          assertContextIsCurrent()
          return runWithSessionRequestContext(
            this.sessionAuthority.captureSessionRequestContext(context.sessionToken),
            () => operation(context.sessionToken)
          )
        })
      }
      const { request } = await this.withNativeAuthEnvironmentCommit(async () => {
        assertContextIsCurrent()
        return {
          request: runWithSessionRequestContext(
            this.sessionAuthority.captureSessionRequestContext(context.sessionToken),
            () => operation(context.sessionToken)
          ),
        }
      })
      const result = await request
      await this.withNativeAuthEnvironmentCommit(async () => assertContextIsCurrent())
      return result
    }

    // A request that already targets another team reserves admission at call
    // time. Queued same-team work remains a nonproducer until it proves it
    // needs a credential switch after reaching the head of the queue. A late
    // home request queues behind the hop after quit closes; it does not join
    // or extend that hop, and may reuse its restored home token at dispatch.
    const activeTeamId = String(this.me?.teamId || '').trim()
    const admissionTeamId = activeHop?.homeTeamId ?? activeTeamId
    const earlyProducer = targetTeamId !== admissionTeamId ? this.admitCredentialProducer() : null
    if (targetTeamId !== admissionTeamId && !earlyProducer) {
      return Promise.reject(new QuitAdmissionClosedError())
    }

    const previousQueue = this.teamContextQueue
    let releaseQueue!: () => void
    this.teamContextQueue = previousQueue
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>(resolve => {
            releaseQueue = resolve
          })
      )

    await previousQueue.catch(() => undefined)

    try {
      const applyApprovedTeamSwitchRebind = () => {
        if (!options.allowApprovedTeamSwitchRebind) return
        const nextContext = this.applyApprovedTeamSwitchRequestTransition(
          requestContext,
          earlyProducer !== null
        )
        if (nextContext !== requestContext) {
          requestContext = nextContext
          options.onRequestContextTransition?.(nextContext)
        }
      }
      rebindRequestContextWithinCurrentLineage()
      applyApprovedTeamSwitchRebind()
      const session = await this.withNativeAuthEnvironmentCommit(async () => {
        // Explicit switchTeam owns this lock through GFS activation and publication. Rebind a
        // request admitted under its exact previous owner only after that accepted transition
        // has settled, then check the current owner at the dispatch boundary. A quit that began
        // while a nonproducer waited still closes admission here.
        rebindRequestContextWithinCurrentLineage()
        applyApprovedTeamSwitchRebind()
        try {
          this.assertCurrentSessionRequestContext()
        } catch (error) {
          if (this.quitPreparationStarted && !earlyProducer) throw new QuitAdmissionClosedError()
          throw error
        }
        const sessionToken = this.requireSessionToken()
        return {
          sessionToken,
          teamId: String(this.me?.teamId || '').trim(),
          sessionGeneration: this.sessionGeneration,
          environmentBinding: this.captureAuthEnvironmentBinding(),
        }
      })

      let context = session
      if (!context.teamId) {
        const me = await runWithSessionRequestContext(
          this.sessionAuthority.captureSessionRequestContext(session.sessionToken),
          () => this.authClient.getMe(session.sessionToken)
        )
        context = await this.withNativeAuthEnvironmentCommit(async () => {
          this.assertSessionGeneration(session.sessionGeneration)
          if (this.sessionToken !== session.sessionToken) {
            throw new Error('stale_auth_epoch: authenticated team scope changed during discovery')
          }
          this.assertAuthEnvironmentBinding(session.environmentBinding)
          this.me = me
          await this.bindCurrentChatStore(me.id)
          this.updateCachedCurrentTeam(me.teamId)
          return { ...session, teamId: String(me.teamId || '').trim() }
        })
      }

      const assertContextIsCurrent = () => {
        this.assertSessionGeneration(context.sessionGeneration)
        const currentTeamId = String(this.me?.teamId || '').trim()
        if (this.sessionToken !== context.sessionToken || currentTeamId !== context.teamId) {
          throw new Error('stale_auth_epoch: authenticated team scope changed during operation')
        }
        this.assertAuthEnvironmentBinding(context.environmentBinding)
      }

      const originalToken = context.sessionToken
      const originalTeamId = context.teamId
      const shouldSwitch = originalTeamId !== targetTeamId
      const shouldRestore = Boolean(originalTeamId && shouldSwitch)
      const activeHop: ActiveTeamContextHop | null = shouldRestore
        ? {
            homeTeamId: originalTeamId,
            homeRequestContext: this.sessionAuthority.captureSessionRequestContext(originalToken),
            restoredToken: null,
            restorationError: null,
            homeTeamOperations: [],
          }
        : null

      if (context.teamId === targetTeamId) {
        // The request was admitted as a potential hop, but an earlier queued
        // switch already moved the session to this team. It no longer owns
        // credential work and must not hold quit draining while its read runs.
        earlyProducer?.()
        if (options.mutation) {
          return this.withNativeAuthEnvironmentCommit(async () => {
            assertContextIsCurrent()
            const result = await runWithSessionRequestContext(
              this.sessionAuthority.captureSessionRequestContext(context.sessionToken),
              () => operation(context.sessionToken)
            )
            return result
          })
        }
        const { request } = await this.withNativeAuthEnvironmentCommit(async () => {
          assertContextIsCurrent()
          return {
            request: runWithSessionRequestContext(
              this.sessionAuthority.captureSessionRequestContext(context.sessionToken),
              () => operation(context.sessionToken)
            ),
          }
        })
        const result = await request
        return this.withNativeAuthEnvironmentCommit(async () => {
          assertContextIsCurrent()
          return result
        })
      }

      const runOperation = () =>
        this.withNativeAuthEnvironmentCommit(async () => {
          assertContextIsCurrent()
          const shouldRestore = Boolean(originalTeamId)
          let restoredOriginalTeam = false
          let operationFailed = false
          let restoreFailed = false
          let restoreFailure: unknown
          let hopSessionToken: string | null = null
          let chatRebindOwner: {
            envKey: string
            generation: number
            token: string
            user: SessionMe
            authoritySource: SessionAuthorityCoordinator['acceptedSessionAuthoritySource']
            projectionMarker: PendingExternalLogoutMarker | undefined
            memoryLease: MemoryOnlySessionLease | undefined
          } | null = null
          let hopOwner: {
            envKey: string
            generation: number
            token: string
            user: SessionMe
            authoritySource: SessionAuthorityCoordinator['acceptedSessionAuthoritySource']
            projectionMarker: PendingExternalLogoutMarker | undefined
            memoryLease: MemoryOnlySessionLease | undefined
          } | null = null
          const releaseTransientHop = this.enterGfsTransientTeamHop()
          if (activeHop) this.activeTeamContextHop = activeHop
          if (shouldRestore) this.chatStoreHomeTeamId = originalTeamId

          try {
            const activeToken = await this.switchSessionToTeam(targetTeamId, originalToken, {
              advanceSessionGeneration: !shouldRestore,
            })
            hopSessionToken = activeToken
            if (!originalTeamId) {
              options.onRequestContextTransition?.(
                this.sessionAuthority.captureSessionRequestContext(activeToken)
              )
            }
            if (shouldRestore && this.me && this.sessionToken === activeToken) {
              hopOwner = {
                envKey: getActiveEnvKey(),
                generation: this.sessionGeneration,
                token: activeToken,
                user: this.me,
                authoritySource: this.sessionAuthority.acceptedSessionAuthoritySource,
                projectionMarker: this.sessionAuthority.acceptedSessionProjectionMarker,
                memoryLease: this.memoryOnlySession,
              }
            }
            try {
              return await runWithSessionRequestContext(
                this.sessionAuthority.captureSessionRequestContext(activeToken),
                () => operation(activeToken)
              )
            } catch (error) {
              operationFailed = true
              throw error
            } finally {
              if (shouldRestore) {
                try {
                  await this.switchSessionToTeam(originalTeamId, this.requireSessionToken(), {
                    advanceSessionGeneration: false,
                  })
                  restoredOriginalTeam = true
                } catch (restoreError) {
                  if (activeHop) activeHop.restorationError = restoreError
                  restoreFailed = true
                  restoreFailure = restoreError
                  if (operationFailed) {
                    desktopRuntimeLog.warn(
                      '[AppService] Failed to restore team context after operation:',
                      restoreError
                    )
                  }
                }
              }
              if (restoredOriginalTeam && this.sessionToken) {
                this.updateEntityChangeSessionToken(this.sessionToken)
                this.restartEntityChangeStreamForSessionReplacement()
              } else if (
                shouldRestore &&
                hopSessionToken &&
                hopOwner &&
                this.sessionToken === hopOwner.token &&
                this.sessionGeneration === hopOwner.generation &&
                this.me === hopOwner.user &&
                this.me &&
                String(this.me.teamId || '').trim() !== originalTeamId
              ) {
                // A failed restore leaves the hop team as the actual committed
                // session. Re-observe its exact accepted source/lease and projection marker
                // before publishing any session-scoped consumer after the awaited restore.
                const settled = await this.settleFailedTeamRestoreGfsOwner(hopOwner)
                const user = this.me
                const token = this.sessionToken
                if (settled && user && token) {
                  if (
                    activeHop &&
                    this.sessionGeneration === hopOwner.generation + 1 &&
                    getActiveEnvKey() === hopOwner.envKey &&
                    this.me === hopOwner.user &&
                    token === hopOwner.token
                  ) {
                    // Durable recovery advances the accepted generation after proving that the
                    // same session still owns the hop. Carry that verified owner into queued
                    // Home restoration; the pre-hop request context is intentionally stale now.
                    activeHop.homeRequestContext =
                      this.sessionAuthority.captureSessionRequestContext(token)
                  }
                  chatRebindOwner = {
                    envKey: getActiveEnvKey(),
                    generation: this.sessionGeneration,
                    token,
                    user,
                    authoritySource: this.sessionAuthority.acceptedSessionAuthoritySource,
                    projectionMarker: this.sessionAuthority.acceptedSessionProjectionMarker,
                    memoryLease: this.memoryOnlySession,
                  }
                }
              }
              if (restoreFailed && !operationFailed) throw restoreFailure
            }
          } finally {
            if (activeHop) {
              const restoredToken =
                this.me?.teamId === activeHop.homeTeamId ? this.sessionToken : null
              if (
                restoredToken &&
                this.sessionAuthority.isSessionRequestContextInCurrentLineage(
                  activeHop.homeRequestContext,
                  restoredToken
                )
              ) {
                const previousHomeRequestContext = activeHop.homeRequestContext
                const restoredHomeRequestContext =
                  this.sessionAuthority.captureSessionRequestContext(restoredToken)
                activeHop.homeRequestContext = restoredHomeRequestContext
                if (
                  !this.sessionAuthority.sessionRequestContextsMatchOwner(
                    previousHomeRequestContext,
                    restoredHomeRequestContext
                  )
                ) {
                  options.onRequestContextTransition?.(restoredHomeRequestContext)
                }
              }
              activeHop.restoredToken = restoredToken
              await this.drainHomeTeamOperations(activeHop)
            }
            if (shouldRestore) {
              this.chatStoreHomeTeamId = null
              // A failed switch back leaves the session on the hop team while the
              // store is still bound to the pinned home team. Rebind so the store
              // scope and the delete-fence authority agree again. The queue drain above may
              // have yielded to logout or another owner, so publish only through the exact
              // synchronous owner/marker fence captured after source verification.
              if (chatRebindOwner && chatRebindOwner.user.teamId !== originalTeamId) {
                try {
                  this.rebindFailedTeamRestoreChatOwner(chatRebindOwner)
                } catch (rebindError) {
                  desktopRuntimeLog.error(
                    '[AppService] Failed to rebind the chat store after a failed team restore:',
                    rebindError
                  )
                }
              }
            }
            releaseTransientHop()
          }
        })

      if (shouldSwitch && !earlyProducer) return await this.runCredentialProducer(runOperation)
      return await runOperation()
    } finally {
      earlyProducer?.()
      releaseQueue()
    }
  }

  private enqueueHomeTeamOperation<T>(
    activeHop: ActiveTeamContextHop,
    operation: (sessionToken: string) => Promise<T>,
    requestContext: unknown,
    onRequestContextTransition?: (context: unknown) => void
  ): Promise<T> {
    const admittedHomeContext = activeHop.homeRequestContext
    return new Promise<T>((resolve, reject) => {
      activeHop.homeTeamOperations.push(async () => {
        if (!activeHop.restoredToken) {
          reject(
            activeHop.restorationError instanceof Error
              ? activeHop.restorationError
              : new Error('Home-team context could not be restored after the team hop')
          )
          return
        }
        try {
          if (requestContext === undefined || requestContext !== admittedHomeContext)
            throw new SessionRequestOwnershipError()
          const dispatchContext = activeHop.homeRequestContext
          // The admitted context is the hop's original Home owner. A failed restore may
          // advance the generation only after durable recovery proves that same owner; the
          // hop replaces homeRequestContext with that verified receipt before draining.
          this.sessionAuthority.assertTemporaryRequestAllowed(
            activeHop.restoredToken,
            dispatchContext
          )
          if (requestContext !== dispatchContext) onRequestContextTransition?.(dispatchContext)
          resolve(
            await runWithSessionRequestContext(dispatchContext, () =>
              operation(activeHop.restoredToken!)
            )
          )
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  private async drainHomeTeamOperations(activeHop: ActiveTeamContextHop): Promise<void> {
    while (activeHop.homeTeamOperations.length > 0) {
      const currentToken = this.sessionToken
      if (
        !activeHop.restoredToken &&
        this.me &&
        this.me.teamId === activeHop.homeTeamId &&
        currentToken &&
        this.sessionAuthority.isSessionRequestContextInCurrentLineage(
          activeHop.homeRequestContext,
          currentToken
        )
      ) {
        activeHop.restoredToken = currentToken
        activeHop.restorationError = null
      }
      if (
        !activeHop.restoredToken &&
        this.me &&
        this.me.teamId !== activeHop.homeTeamId &&
        currentToken
      ) {
        if (
          !this.sessionAuthority.isSessionRequestContextInCurrentLineage(
            activeHop.homeRequestContext,
            currentToken
          )
        ) {
          activeHop.restorationError = new SessionRequestOwnershipError()
        } else {
          const priorGeneration = this.sessionGeneration
          const priorUserId = this.me.id
          const priorEnvKey = getActiveEnvKey()
          const priorMemoryLeaseId = this.memoryOnlySession?.volatileSessionId ?? null
          try {
            const restoredToken = await this.switchSessionToTeam(
              activeHop.homeTeamId,
              currentToken,
              { activateGfsScope: true }
            )
            if (
              this.sessionToken !== restoredToken ||
              this.sessionGeneration !== priorGeneration + 1 ||
              this.me?.id !== priorUserId ||
              this.me?.teamId !== activeHop.homeTeamId ||
              getActiveEnvKey() !== priorEnvKey ||
              (this.memoryOnlySession?.volatileSessionId ?? null) !== priorMemoryLeaseId
            ) {
              throw new SessionRequestOwnershipError()
            }
            activeHop.restoredToken = restoredToken
            activeHop.homeRequestContext =
              this.sessionAuthority.captureSessionRequestContext(restoredToken)
            activeHop.restorationError = null
            this.updateEntityChangeSessionToken(restoredToken)
            this.restartEntityChangeStreamForSessionReplacement()
          } catch (error) {
            activeHop.restorationError = error
          }
        }
      }
      const operations = activeHop.homeTeamOperations.splice(0)
      for (const operation of operations) await operation()
    }
    if (this.activeTeamContextHop === activeHop) this.activeTeamContextHop = null
  }

  private async resolveTeamForHostRefs(hostRefs: string[]): Promise<string | null> {
    const refs = AppService.dedupe(hostRefs)
    if (!refs.length) return null

    const currentSessionTeamId = String(this.me?.teamId || '').trim()
    const cachedCatalogTeamId = String(this.accessCatalog?.teamId || '').trim()
    const directory = this.teamDirectoryCache
    const currentTeamId = directory?.currentTeamId || currentSessionTeamId || cachedCatalogTeamId

    if (
      this.accessCatalog?.userAgentNames.length &&
      refs.every(ref => this.accessCatalog?.userAgentNames.includes(ref))
    ) {
      if (currentSessionTeamId || cachedCatalogTeamId) return null
      if (currentTeamId) return currentTeamId
    }

    if (!directory) return this.accessCatalog?.teamId ?? null

    const teamHasRefs = (entry: TeamDirectoryResult['items'][number]) =>
      refs.every(ref => entry.agentNames.includes(ref))

    if (currentTeamId) {
      const currentEntry = directory.items.find(entry => entry.team.id === currentTeamId)
      if (currentEntry && teamHasRefs(currentEntry)) return currentTeamId
    }

    const matchingEntry = directory.items.find(teamHasRefs)
    return matchingEntry?.team.id ?? this.accessCatalog?.teamId ?? null
  }

  /**
   * Monotonic per sandbox-ui mount. Carried into the SDK surface pin so a
   * request from a superseded embed can be told apart from the live one
   *, mirroring the driver's own `mountGeneration` guard.
   */
  private sandboxUiGeneration = 0

  /**
   * Advanced only when the signed-in user goes away: the session is cleared, or
   * a login replaces it without a logout. Sandbox-ui work
   * that awaits the network (open mint, OAuth authorize-url fetch) captures it
   * first and drops its effects if it moved. `sessionGeneration` cannot serve:
   * every token commit bumps it, including the two of each transient team hop
   * that unrelated concurrent work performs while a mint is in flight.
   */
  private sandboxUiSessionEpoch = 0

  private assertSandboxUiSessionEpoch(epoch: number): void {
    if (this.sandboxUiSessionEpoch !== epoch) {
      throw new Error('The session changed while this app request was in flight')
    }
  }

  private enqueueSandboxUiLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sandboxUiLifecycleQueue.then(operation)
    this.sandboxUiLifecycleQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private captureSessionRequestContextForOperation(): void {
    const token = this.sessionToken
    if (!token) throw new SessionRequestOwnershipError()
    if (this.memoryOnlySession) this.assertMemoryOnlySessionCurrent()
    const activeHop = this.activeTeamContextHop
    if (
      activeHop &&
      this.sessionAuthority.isSessionRequestContextInCurrentLineage(
        activeHop.homeRequestContext,
        token
      )
    ) {
      enterSessionRequestContext(activeHop.homeRequestContext)
      return
    }
    enterSessionRequestContext(this.sessionAuthority.captureSessionRequestContext(token))
  }

  private applyApprovedTeamSwitchRequestTransition(
    requestContext: unknown,
    allowDuringQuit: boolean
  ): unknown {
    if (!requestContext || (this.quitPreparationStarted && !allowDuringQuit)) return requestContext
    const transition = this.acceptedTeamSwitchRequestTransition
    if (
      !transition ||
      getSessionRequestContext() !== requestContext ||
      !this.sessionAuthority.sessionRequestContextsMatchOwner(
        requestContext,
        transition.previousRequestContext
      ) ||
      this.sessionToken !== transition.nextToken ||
      this.sessionGeneration !== transition.nextGeneration ||
      getActiveEnvKey() !== transition.envKey ||
      this.me?.id !== transition.userId
    )
      return requestContext

    this.sessionAuthority.assertTemporaryRequestAllowed(
      transition.nextToken,
      transition.nextRequestContext
    )
    enterSessionRequestContext(transition.nextRequestContext)
    return transition.nextRequestContext
  }

  private preserveSessionRequestContextForOperation(): void {
    const inheritedContext = getSessionRequestContext()
    if (inheritedContext === undefined) {
      this.captureSessionRequestContextForOperation()
      return
    }
    const token = this.sessionToken
    if (!token) throw new SessionRequestOwnershipError()
    if (this.memoryOnlySession) this.assertMemoryOnlySessionCurrent()
    const activeHop = this.activeTeamContextHop
    if (
      activeHop &&
      this.sessionAuthority.isSessionRequestContextInCurrentLineage(inheritedContext, token)
    ) {
      // Host-to-team resolution may finish after a transient hop has captured its
      // pinned Home owner. Adopt that exact owner only when the request still belongs
      // to the same accepted session lineage; queued dispatch revalidates the restored
      // Home token against the current owner before it can reach the RPC transport.
      enterSessionRequestContext(activeHop.homeRequestContext)
      return
    }
    this.sessionAuthority.assertTemporaryRequestAllowed(token, inheritedContext)
  }

  private assertCurrentSessionRequestContext(): void {
    const requestContext = getSessionRequestContext()
    if (requestContext === undefined) return
    const token = this.sessionToken
    if (!token) throw new SessionRequestOwnershipError()
    this.sessionAuthority.assertTemporaryRequestAllowed(token, requestContext)
  }

  private assertTeamScopedRpcQueueAdmissionContext(): void {
    const requestContext = getSessionRequestContext()
    const token = this.sessionToken
    if (requestContext === undefined || !token) throw new SessionRequestOwnershipError()
    if (this.sessionAuthority.isSessionRequestContextInCurrentLineage(requestContext, token)) return
    this.sessionAuthority.assertTemporaryRequestAllowed(token, requestContext)
  }

  private clearRpcTokenCacheForCurrentRequest(): void {
    this.assertCurrentSessionRequestContext()
    this.rpcTokenManager.clear()
  }

  private clearRpcTokenCacheForRequestContext(requestContext: unknown): boolean {
    const token = this.sessionToken
    if (!token || requestContext === undefined) return false
    try {
      this.sessionAuthority.assertTemporaryRequestAllowed(token, requestContext)
    } catch {
      return false
    }
    this.rpcTokenManager.clear()
    return true
  }

  private async issueRpcTokenForHostRefs(
    scopes: RpcScope[],
    hostRefs: string[],
    options: { teamId?: string | null } = {}
  ) {
    this.preserveSessionRequestContextForOperation()
    this.assertTeamScopedRpcQueueAdmissionContext()
    let finalRequestContext = getSessionRequestContext()
    const targetTeamId =
      String(options.teamId || '').trim() || (await this.resolveTeamForHostRefs(hostRefs))
    this.assertTeamScopedRpcQueueAdmissionContext()
    const result = await this.runWithTeamContext(
      targetTeamId,
      token => this.getRpcTokenForCurrentSession(token, scopes, hostRefs),
      {
        preserveRequestContext: true,
        onRequestContextTransition: context => {
          finalRequestContext = context
        },
      }
    )
    if (finalRequestContext !== getSessionRequestContext()) {
      const currentToken = this.sessionToken
      if (!currentToken) throw new SessionRequestOwnershipError()
      this.sessionAuthority.assertTemporaryRequestAllowed(currentToken, finalRequestContext)
      enterSessionRequestContext(finalRequestContext)
    }
    this.assertCurrentSessionRequestContext()
    this.sessionAuthority.bindRpcCredentialToRequestOwner(result.token, getSessionRequestContext())
    return result
  }

  private async getRpcTokenForCurrentSession(
    sessionToken: string,
    scopes: RpcScope[],
    hostRefs: string[]
  ) {
    try {
      return await this.sessionAuthority.issueRpcCredential(
        sessionToken,
        bindingKey => this.rpcTokenManager.getOrIssue(sessionToken, scopes, hostRefs, bindingKey),
        bindingKey => this.rpcTokenManager.peekCached(scopes, hostRefs, bindingKey)
      )
    } catch (error) {
      // The coordinator detects a lease expiry/authority loss after an awaited mint, but
      // AppService owns the observable session teardown and consumer unbinding effects.
      this.handleMemoryOnlySessionAssertionFailure(error)
      throw error
    }
  }

  private clearAuthenticatedSessionState(
    options: { notifySessionChanged?: boolean; advanceGeneration?: boolean } = {}
  ): void {
    this.acceptedSessionSource = undefined
    this.memoryOnlySession = undefined
    this.sessionAuthority.clearRpcCredentialOwners()
    this.scheduleDesktopWindowTeardown()
    if (this.memoryOnlySessionExpiryTimer) clearTimeout(this.memoryOnlySessionExpiryTimer)
    this.memoryOnlySessionExpiryTimer = null
    if (options.advanceGeneration !== false)
      this.sessionAuthority.advanceSessionGeneration(this.sessionGeneration)
    this.updateEntityChangeSessionToken(null)
    this.gfsAuthEpoch += 1
    this.gfsDispatchBlocked = true
    this.gfsScopeIdentity = null
    this.cancelPrewarmReemissions()
    this.stopAllStreams()
    this.sessionToken = null
    this.me = null
    this.clearEffectiveRuntimeRpcEndpoint()
    this.profileUiBaseUrlCache = null
    this.accessCatalog = null
    this.teamDirectoryCache = null
    this.workflowApprovalTeamById.clear()
    this.workflowTeamByKey.clear()
    this.rpcTokenManager.clear()
    unbindChatStore()
    this.invalidateSandboxUiSession()
    if (options.notifySessionChanged === false) return
    this.notifySessionChangedSafely(false)
  }

  private scheduleDesktopWindowTeardown(): void {
    const closeWindows = this.closeDesktopWindowsForSession
    if (!closeWindows) return
    try {
      void Promise.resolve(closeWindows()).catch(error => {
        desktopRuntimeLog.warn('[Desktop] Could not close host windows on session change:', error)
      })
    } catch (error) {
      desktopRuntimeLog.warn('[Desktop] Could not close host windows on session change:', error)
    }
  }

  private notifySessionChangedSafely(isAuthenticated: boolean): void {
    try {
      tryGetPluginSdkRuntime()?.notifySessionChanged(isAuthenticated)
    } catch (error) {
      this.reportDeferredLogoutFailureSafely(error)
    }
  }

  /** Retires the sandbox-ui work of a session that is being cleared or replaced. */
  private invalidateSandboxUiSession(): void {
    this.sandboxUiSessionEpoch += 1
    this.scheduleSandboxUiTeardown()
  }

  /**
   * Queue physical teardown without waiting for an in-flight sandbox mint.
   * Session replacement has already revoked the outgoing epoch synchronously;
   * awaiting the lifecycle queue here would deadlock a replacement whose caller
   * is responsible for settling that mint.
   */
  private scheduleSandboxUiTeardown(): void {
    // The embed and its refresh loop run on the outgoing session. Queued rather
    // than awaited: callers must not wait on a pending open's mint; the serial
    // queue still tears down whatever that open mounts.
    try {
      void this.closeSandboxUi({ reason: 'session' }).catch(error => {
        desktopRuntimeLog.error('[SandboxUI] Could not close the embed on session change:', error)
      })
    } catch (error) {
      // Owner retirement is the synchronous security boundary; physical UI teardown is best effort.
      desktopRuntimeLog.error('[SandboxUI] Could not close the embed on session change:', error)
    }
  }

  private activateGfsAuthScope(identityOverride?: DesktopGfsUploadIdentity): void {
    this.gfsAuthEpoch += 1
    this.gfsDispatchBlocked = false
    this.gfsScopeIdentity = identityOverride ?? (this.me ? desktopGfsUploadIdentity(this.me) : null)
  }

  private cancelPrewarmReemissions(): void {
    this.prewarmAuthEpoch += 1
    this.prewarmAttemptAtByHostRef.clear()
    this.prewarmReemitLoopHostRefs.clear()
    for (const controller of this.prewarmReemitAbortControllers.values()) controller.abort()
    this.prewarmReemitAbortControllers.clear()
  }

  private beginPrewarmAuthTransition(): () => void {
    this.prewarmAuthTransitionCount += 1
    this.cancelPrewarmReemissions()
    let released = false
    return () => {
      if (released) return
      released = true
      this.cancelPrewarmReemissions()
      this.prewarmAuthTransitionCount -= 1
    }
  }

  private currentDesktopGfsUploadScope(
    driveValue: string | undefined,
    options: { allowTransientTeamHop?: boolean } = {}
  ): DesktopGfsUploadScope {
    if (this.gfsDispatchBlocked || !this.sessionToken || !this.me) {
      throw new Error('GFS upload dispatch is unavailable without an active authenticated scope')
    }
    const marker = this.inspectPendingLogoutMarker(getActiveEnvKey())
    if (marker?.intent.intent === 'logout-pending') {
      throw new Error('GFS upload dispatch is unavailable while logout authority is pending')
    }
    if (this.memoryOnlySession) this.assertMemoryOnlySessionCurrent()
    if (!options.allowTransientTeamHop) this.assertGfsDispatchAllowed()
    const identity = this.gfsScopeIdentity
    if (!identity) {
      throw new Error('GFS upload dispatch is unavailable before scope activation')
    }
    return {
      ...identity,
      drive: normalizeDesktopUploadDrive(driveValue),
      authEpoch: this.gfsAuthEpoch,
    }
  }

  private assertCurrentDesktopGfsUploadScope(scope: DesktopGfsUploadScope): void {
    // Existing jobs retain their original token and scope while a finite RPC
    // borrows another team session. Only new user-facing dispatches are gated.
    const current = this.currentDesktopGfsUploadScope(scope.drive, { allowTransientTeamHop: true })
    if (!sameDesktopGfsUploadScope(scope, current)) {
      throw new Error('stale_auth_epoch: GFS upload no longer belongs to the active scope')
    }
  }

  private async suspendDesktopGfsUploadsForAuthBoundary(identityOverride?: {
    ownerId: string
    teamId: string | null
    environmentKey: string
    baseUrl: string
  }): Promise<void> {
    const oldIdentity =
      identityOverride ??
      (this.me
        ? {
            ownerId: this.me.id,
            teamId: this.me.teamId ? String(this.me.teamId).trim() : null,
            environmentKey: getActiveEnvKey(),
            baseUrl: normalizeDesktopUploadBaseUrl(config.externalRestApiBaseUrl),
          }
        : null)
    this.gfsDispatchBlocked = true
    this.gfsAuthEpoch += 1
    const matchesIdentity = (scope: DesktopGfsUploadScope) =>
      !oldIdentity ||
      (scope.ownerId === oldIdentity.ownerId &&
        scope.teamId === oldIdentity.teamId &&
        scope.environmentKey === oldIdentity.environmentKey &&
        scope.baseUrl === oldIdentity.baseUrl)
    const activeEntries = [...this.gfsUploadJobs.entries()].filter(([, entry]) =>
      matchesIdentity(entry.scope)
    )
    const pendingEntries = [...this.gfsPendingUploadJobs].filter(entry =>
      matchesIdentity(entry.scope)
    )
    const legacyUploads = [...this.gfsPendingLegacyUploads].filter(upload =>
      matchesIdentity(upload.scope)
    )
    const jobs = new Set([
      ...activeEntries.map(([, entry]) => entry.job),
      ...pendingEntries.map(entry => entry.job),
    ])
    const jobSuspensions = [...jobs].map(job => job.suspendForAuth())
    for (const upload of legacyUploads) {
      upload.controller.abort(new Error('GFS legacy upload suspended by authentication fence'))
    }
    await Promise.all([
      ...jobSuspensions,
      ...legacyUploads.map(upload => upload.promise.catch(() => undefined)),
    ])
    for (const [uploadId, entry] of activeEntries) {
      if (this.gfsUploadJobs.get(uploadId) === entry) this.gfsUploadJobs.delete(uploadId)
    }
    for (const entry of pendingEntries) this.gfsPendingUploadJobs.delete(entry)
    for (const upload of legacyUploads) this.gfsPendingLegacyUploads.delete(upload)
    if (!oldIdentity) return
    await this.updateDesktopGfsUploadState(state => {
      const updatedAt = new Date().toISOString()
      return {
        ...state,
        records: state.records.map(record =>
          record.scope.ownerId === oldIdentity.ownerId &&
          record.scope.teamId === oldIdentity.teamId &&
          record.scope.environmentKey === oldIdentity.environmentKey &&
          record.scope.baseUrl === oldIdentity.baseUrl
            ? { ...record, status: 'suspended_auth' as const, updatedAt }
            : record
        ),
      }
    })
  }

  private async restoreSavedSession(options: { runLaunchMaintenance?: boolean } = {}) {
    if (this.restoreSavedSessionInFlight) {
      return await this.restoreSavedSessionInFlight
    }
    if (this.quitPreparationStarted) throw new QuitAdmissionClosedError()
    const restore = (async () => {
      this.restoreSavedSessionReservationStarted = false
      await this.resolveRuntimeConfigIfNeeded().catch(() => undefined)
      const restoreGeneration = await this.withNativeAuthEnvironmentCommit(async () => {
        this.restoreSavedSessionReservationStarted = true
        return this.sessionGeneration
      })
      const restorePlan = await this.clearPendingExternalLogoutBeforeRestore(restoreGeneration)
      if (!restorePlan) {
        return { authenticated: Boolean(this.sessionToken && this.me), me: this.me }
      }
      if (restorePlan.policy === 'deny-all') {
        this.savedSessionRestoreAttemptedEnvKey = getActiveEnvKey()
        this.savedSessionRestoreAttemptedAtMs = Date.now()
        return { authenticated: false, me: null }
      }
      return this.runCredentialProducer(() =>
        this.restoreSavedSessionOnce(options, restorePlan, restoreGeneration)
      )
    })()
    this.restoreSavedSessionInFlight = restore
    try {
      return await restore
    } finally {
      // No newer restore can start while this promise is installed, so the
      // single-flight slot can be cleared unconditionally after it settles.
      this.restoreSavedSessionInFlight = null
      this.restoreSavedSessionReservationStarted = false
      if (this.interactiveLoginAttempts === 0) {
        await this.withNativeAuthEnvironmentCommit(async () => {
          await this.commitPendingRuntimeConfigDiscoveryIfSafe().catch(() => undefined)
        })
      }
    }
  }

  private async clearPendingExternalLogoutBeforeRestore(
    restoreGeneration: number
  ): Promise<SavedSessionRestorePlan | null> {
    const userDataDirectory = this.getUserDataDirectory()
    const envKey = getActiveEnvKey()
    const legacyNamespace = getActiveLegacyEnvKeyInventory()
    let marker: PendingExternalLogoutMarker | null
    try {
      await SessionAuthorityAcceptanceTransaction.reconcilePendingAcceptanceProjection(
        this.tokenStore,
        userDataDirectory,
        envKey,
        legacyNamespace.keys,
        legacyNamespace.complete
      )
      marker = this.inspectPendingLogoutMarker(envKey)
    } catch (error) {
      const failure = this.sessionAuthority.planPersistenceAuthorityFailure(
        error,
        'restore-source-observation',
        { priorRuntimeAvailable: Boolean(this.sessionToken && this.me) }
      )
      if (failure.kind === 'transient-read') {
        // Unknown marker/journal I/O cannot authorize a cold restore, but it is not a
        // new denial against an already accepted in-memory owner. Preserve that owner
        // and let a later restore attempt retry the exact durable observation.
        this.reportDeferredLogoutFailureSafely(error)
      } else if (failure.kind !== 'ignore') {
        await this.failClosedForPendingLogout(error)
      }
      return null
    }

    let selectedAuthority: Awaited<
      ReturnType<SessionAuthorityCoordinator['inspectAcceptedSessionRestore']>
    >
    try {
      selectedAuthority = await this.sessionAuthority.inspectAcceptedSessionRestore(envKey)
    } catch (error) {
      // Source observation uncertainty is not absence and never permits sibling-provider
      // fallback. Preserve an already-owned runtime, leave a cold process signed out, and retry
      // on the next restore attempt. Confirmed authority/projection corruption still follows
      // the coordinator's fail-closed path.
      const failure = this.sessionAuthority.planPersistenceAuthorityFailure(
        error,
        'restore-source-observation',
        { priorRuntimeAvailable: Boolean(this.sessionToken && this.me) }
      )
      if (failure.kind === 'fail-closed') await this.failClosedForPendingLogout(error)
      else this.reportDeferredLogoutFailureSafely(error)
      return null
    }
    if (
      selectedAuthority.status === 'denied' &&
      selectedAuthority.frameMode === 'logged-out' &&
      marker?.intent.intent === 'logout-pending'
    ) {
      // V2 logout recovery is exact-debt-only. Do not re-enter the legacy clear-first path after
      // a marker/authority crash window; retain the LP fence and retry only recorded sources.
      return {
        policy: 'deny-all',
        pendingCleanupMarker: marker,
        retireMarkerAfterRestore: false,
      }
    }
    const action = this.sessionAuthority.restoreActionForMarker(marker)
    if (action.kind === 'restore' || action.kind === 'deny') return action.plan

    if (action.kind === 'cleanup-source') {
      return this.runCredentialProducer(() =>
        this.runSessionPersistence(async () => {
          if (
            this.sessionGeneration !== restoreGeneration ||
            !pendingExternalLogoutMarkersMatch(
              this.inspectPendingLogoutMarker(envKey),
              action.plan.pendingCleanupMarker!
            )
          ) {
            return null
          }
          const preserveActiveEnvKey = action.source === 'active-keytar'
          try {
            const result = await this.clearKeytarForObservedMarker(
              envKey,
              action.plan.pendingCleanupMarker!,
              preserveActiveEnvKey,
              restoreGeneration
            )
            const cleanupVerified = isKeytarCleanupEstablished(result.keytarDisposition)
            if (!cleanupVerified) {
              this.reportDeferredLogoutFailureSafely(
                new Error('Keytar cleanup is unavailable while the cleanup marker remains')
              )
            }
            return this.sessionAuthority.restorePlanAfterCleanup(action, cleanupVerified)
          } catch (error) {
            if (error instanceof SessionTokenStorageSupersededBeforeWriteError) return null
            // Keytar-only cleanup did not unlink this witness. Keep its revision
            // and any newer producer's marker instead of manufacturing new intent.
            if (error instanceof SessionTokenStorageClearError) {
              this.reportDeferredLogoutFailureSafely(error)
              return this.sessionAuthority.restorePlanAfterCleanup(action, false)
            }
            await this.handlePendingLogoutInspectionFailure(error)
            return null
          }
        })
      ).catch(async error => {
        await this.handlePendingLogoutInspectionFailure(error)
        return null
      })
    }

    const logoutMarker = action.marker
    if (
      this.sessionGeneration !== restoreGeneration ||
      !pendingExternalLogoutMarkersMatch(this.inspectPendingLogoutMarker(envKey), logoutMarker)
    )
      return null
    try {
      const recovered = await this.recoverObservedLogoutProjection(
        envKey,
        () => getActiveEnvKey() === envKey && this.sessionGeneration === restoreGeneration
      )
      if (recovered?.kind === 'committed') {
        return {
          policy: 'deny-all',
          pendingCleanupMarker: logoutMarker,
          retireMarkerAfterRestore: false,
        }
      }
    } catch (error) {
      this.reportDeferredLogoutFailureSafely(error)
    }
    return null
  }

  private reportDeferredLogoutFailureSafely(error: unknown): void {
    try {
      this.reportDeferredLogoutFailure(error)
    } catch {
      // Failure reporting must not permit a pending logout to restore a session.
    }
  }

  private scheduleSessionAuthorityLogoutCleanup(
    transaction: SessionAuthorityLogoutTransaction
  ): void {
    const cleanup = transaction
      .cleanExactSourceDebts()
      .catch(error => this.reportDeferredLogoutFailureSafely(error))
      .finally(() => transaction.close())
    this.sessionAuthorityCleanupInFlight = cleanup
    void cleanup.finally(() => {
      if (this.sessionAuthorityCleanupInFlight === cleanup)
        this.sessionAuthorityCleanupInFlight = null
    })
  }

  private async failClosedForPendingLogout(error: unknown): Promise<void> {
    const generation = this.sessionGeneration
    const token = this.sessionToken
    const gfsIdentity = this.gfsScopeIdentity ?? undefined
    const ownsRuntime = this.sessionGeneration === generation && this.sessionToken === token
    const hasAuthenticatedRuntime = this.sessionToken !== null || this.me !== null

    // Revoke the in-memory authorization synchronously. Draining GFS work is cleanup, not the
    // boundary: if durable logout intent already exists (or authority is unverifiable), no
    // protected consumer may continue using the old session while a suspension promise waits.
    if (ownsRuntime) {
      if (hasAuthenticatedRuntime) this.clearAuthenticatedSessionState()
      else this.notifySessionChangedSafely(false)
    }

    try {
      await this.suspendDesktopGfsUploadsForAuthBoundary(gfsIdentity)
    } catch (suspendError) {
      this.reportDeferredLogoutFailureSafely(suspendError)
    }
    this.reportDeferredLogoutFailureSafely(error)
  }

  /**
   * A failed logout preflight is not itself logout success. However, an observed durable LP (or
   * a confirmed authority/marker projection mismatch) is an independent denial that must revoke
   * this process's stale runtime before returning the failure to its caller.
   */
  private async failClosedForObservedLogoutDenial(envKey: string, error: unknown): Promise<void> {
    let marker: PendingExternalLogoutMarker | null
    try {
      marker = this.inspectPendingLogoutMarker(envKey)
    } catch (markerError) {
      // An unreadable sidecar cannot prove that a durable LP is absent.
      await this.failClosedForPendingLogout(markerError)
      return
    }
    const authorityDenial =
      error instanceof SessionAuthorityProjectionIntegrityError ||
      error instanceof SessionAuthorityLogoutPreflightError
    if (marker?.intent.intent === 'logout-pending' || authorityDenial) {
      if (authorityDenial && marker?.intent.intent !== 'logout-pending') {
        try {
          // A confirmed invalid/recovery-fenced authority is not a transient read failure. Keep
          // restart restore denied with a legacy-visible LP even though this logout call fails.
          this.persistLogoutIntentFallback(envKey)
        } catch (fenceError) {
          await this.failClosedForPendingLogout(fenceError)
          return
        }
      }
      await this.failClosedForPendingLogout(error)
    }
  }

  /**
   * Finish a durable sidecar LP that was published before this process could create its logout
   * transaction. The marker denies the old runtime immediately; only the reconciled V2 LP plus
   * exact-source debt is reported as logout success.
   */
  private async recoverObservedLogoutProjection(
    envKey: string,
    isOwnerCurrent: () => boolean
  ): Promise<DesktopLogoutOutcome | null> {
    let marker: PendingExternalLogoutMarker | null
    try {
      marker = this.inspectPendingLogoutMarker(envKey)
    } catch (error) {
      // An unreadable/corrupt marker cannot prove that an LP is absent. Revoke the
      // in-process runtime before the caller propagates the failed logout preflight.
      await this.failClosedForPendingLogout(error)
      throw error
    }
    if (marker?.intent.intent !== 'logout-pending') return null
    if (!isOwnerCurrent()) throw new SessionTokenStorageSupersededBeforeWriteError()

    const previousGfsIdentity = this.gfsScopeIdentity ?? undefined
    const previousMemorySessionId = this.memoryOnlySession?.volatileSessionId
    const initialScope = await this.tokenStore.createSessionAuthorityStorageScope()
    const initialAuthority = new SessionAuthorityRecordRepository(
      initialScope,
      envKey,
      this.tokenStore
    ).observe()
    if (
      initialAuthority.status === 'absent' ||
      (initialAuthority.status === 'observed' &&
        (initialAuthority.record.frame.mode === 'uninitialized' ||
          initialAuthority.record.frame.source?.format === 'v0'))
    ) {
      // A historical marker without a supported accepted source cannot authorize deletion of
      // old-protocol credentials or be reported as a committed current-session logout.
      return this.logoutNotCommitted(new SessionAuthorityRecordConflictError())
    }
    if (initialAuthority.status === 'transient' || initialAuthority.status === 'invalid')
      throw initialAuthority.error
    if (initialAuthority.status === 'recovery-fenced')
      throw new SessionAuthorityRecordConflictError()
    const recoveryAuthoritySource =
      initialAuthority.status === 'observed' && initialAuthority.record.frame.mode === 'persistent'
        ? (initialAuthority.record.frame.source ?? undefined)
        : undefined
    // The external LP is already durable, so make the old lease and every synchronous consumer
    // unusable before reconciliation performs any await or further filesystem work.
    if (this.sessionToken !== null || this.me !== null || this.memoryOnlySession !== undefined)
      this.clearAuthenticatedSessionState()
    const fencedGeneration = this.sessionGeneration
    try {
      await this.suspendDesktopGfsUploadsForAuthBoundary(previousGfsIdentity)
    } catch (error) {
      this.reportDeferredLogoutFailureSafely(error)
    }

    let cleanupTransaction: SessionAuthorityLogoutTransaction | null = null
    try {
      const legacyNamespace = getActiveLegacyEnvKeyInventory()
      await SessionAuthorityAcceptanceTransaction.reconcilePendingAcceptanceProjection(
        this.tokenStore,
        this.getUserDataDirectory(),
        envKey,
        legacyNamespace.keys,
        legacyNamespace.complete
      )
      cleanupTransaction = await SessionAuthorityLogoutTransaction.begin({
        tokenStore: this.tokenStore,
        userDataDirectory: this.getUserDataDirectory(),
        envKey,
        expectedToken: null,
        cleanupOnly: true,
      })
      if (!cleanupTransaction) {
        // The selected V1 or memory lease is already denied by the observed LP. Reconcile only
        // that exact authority; never inventory or delete historical credential namespaces.
        cleanupTransaction = await SessionAuthorityLogoutTransaction.begin({
          tokenStore: this.tokenStore,
          userDataDirectory: this.getUserDataDirectory(),
          envKey,
          expectedToken: null,
          expectedAuthoritySource: recoveryAuthoritySource,
          expectedVolatileSessionId: previousMemorySessionId,
        })
      }
      if (!cleanupTransaction) throw new SessionAuthorityRecordConflictError()
      if (
        this.sessionGeneration !== fencedGeneration ||
        this.sessionToken !== null ||
        this.me !== null ||
        this.memoryOnlySession !== undefined
      )
        throw new SessionTokenStorageSupersededBeforeWriteError()

      // The marker may have reached durable storage before its producer observed the write.
      // Convert that LP into the V2 logged-out frame and exact cleanup debt before scheduling
      // source deletion. This is a recovery acceptance boundary, not a second marker write.
      const committedRecord = await cleanupTransaction.commit(
        () =>
          this.sessionGeneration === fencedGeneration &&
          this.sessionToken === null &&
          this.me === null &&
          this.memoryOnlySession === undefined
      )
      this.scheduleSessionAuthorityLogoutCleanup(cleanupTransaction)
      return {
        kind: 'committed',
        sessionGeneration: this.sessionGeneration,
        cleanup: committedRecord.cleanupDebts.length > 0 ? 'pending' : 'not-required',
      }
    } catch (error) {
      cleanupTransaction?.close()
      await this.failClosedForPendingLogout(error)
      throw error
    }
  }

  /** Persist a deny-only fallback against the exact marker image it observed. */
  private persistLogoutIntentFallback(envKey: string): void {
    const userDataDirectory = this.getUserDataDirectory()
    const observed = this.inspectPendingLogoutMarker(envKey)
    if (observed) {
      // A repeated logout is a newer producer, even when the current intent is already LP.
      // Advance its exact revision so an in-flight candidate planned against the old receipt
      // cannot consume the earlier denial and publish after this request.
      if (!recordPendingExternalLogoutIfUnchanged(userDataDirectory, envKey, observed))
        throw new SessionTokenStorageSupersededBeforeWriteError()
      return
    }
    recordPendingExternalLogout(userDataDirectory, envKey)
  }

  /** Persisted LP has already denied restore; synchronously revoke its live runtime as well. */
  private recordLogoutIntentFallback(envKey: string): void {
    this.persistLogoutIntentFallback(envKey)
    if (getActiveEnvKey() !== envKey) return
    const gfsIdentity = this.gfsScopeIdentity ?? undefined
    if (this.sessionToken !== null || this.me !== null || this.memoryOnlySession !== undefined)
      this.clearAuthenticatedSessionState()
    void this.suspendDesktopGfsUploadsForAuthBoundary(gfsIdentity).catch(error =>
      this.reportDeferredLogoutFailureSafely(error)
    )
  }

  private async applyPendingExternalLogoutBeforeLogin(
    userDataDirectory: string,
    envKey: string
  ): Promise<PendingLogoutLoginPlan> {
    let marker: PendingExternalLogoutMarker | null
    const legacyNamespace = getActiveLegacyEnvKeyInventory()
    try {
      await SessionAuthorityAcceptanceTransaction.reconcilePendingAcceptanceProjection(
        this.tokenStore,
        userDataDirectory,
        envKey,
        legacyNamespace.keys,
        legacyNamespace.complete
      )
      marker = this.inspectPendingLogoutMarker(envKey)
    } catch (markerError) {
      const initialRecovery = this.sessionAuthority.planMalformedMarkerLoginReadFailure({
        error: markerError,
      })
      if (initialRecovery.kind === 'reject-transient-read') {
        this.reportDeferredLogoutFailureSafely(markerError)
        throw markerError
      }
      if (initialRecovery.kind !== 'read-observed-revision') {
        await this.failClosedForPendingLogout(markerError)
        throw markerError
      }
      let malformedMarkerContentsRevision: string | null
      try {
        malformedMarkerContentsRevision = readPendingExternalLogoutContentsRevision(
          userDataDirectory,
          envKey
        )
      } catch {
        await this.failClosedForPendingLogout(markerError)
        throw markerError
      }
      const recoveryPlan = this.sessionAuthority.planMalformedMarkerLoginReadFailure({
        error: markerError,
        contentsRevision: malformedMarkerContentsRevision,
      })
      if (recoveryPlan.kind === 'deny-unverifiable-marker') {
        await this.failClosedForPendingLogout(markerError)
        throw markerError
      }
      if (recoveryPlan.kind !== 'normalize-observed-bytes') {
        await this.failClosedForPendingLogout(markerError)
        throw markerError
      }

      // Normalize only the bytes observed above, before awaiting any cleanup.
      // Explicit repair then uses the same revision-bound recovery plan as a
      // valid logout marker, including secure fallback and isolated storage.
      try {
        if (
          !recordPendingExternalLogoutIfContentsUnchanged(
            userDataDirectory,
            envKey,
            recoveryPlan.contentsRevision
          )
        ) {
          throw new Error('Pending logout intent changed before login recovery')
        }
        marker = this.inspectPendingLogoutMarker(envKey)
        if (!marker) throw new Error('Pending logout intent disappeared before login recovery')
      } catch (clearError) {
        await this.handlePendingLogoutInspectionFailure(clearError)
        throw clearError
      }
    }
    const loginAction = this.sessionAuthority.planFreshLogin(marker)
    if (loginAction.kind === 'ready') return loginAction.plan

    if (loginAction.kind === 'cleanup-source') {
      const cleanupMarker = loginAction.marker
      const preserveActiveEnvKey = loginAction.source === 'active-keytar'
      try {
        const result = await this.clearKeytarForObservedMarker(
          envKey,
          cleanupMarker,
          preserveActiveEnvKey
        )
        return this.sessionAuthority.loginPlanAfterKeytarCleanup(cleanupMarker, result)
      } catch (error) {
        if (error instanceof SessionTokenStorageSupersededBeforeWriteError) throw error
        const recovered = this.sessionAuthority.loginPlanAfterCleanupFailure(
          'keytar-cleanup',
          cleanupMarker,
          envKey,
          error
        )
        if (recovered) return recovered
        await this.handlePendingLogoutInspectionFailure(error)
        throw error
      }
    }

    if (loginAction.kind !== 'finalize-logout')
      throw new Error('Session authority returned an unsupported fresh-login plan')
    // Every supported marker state has an explicit plan above. An unknown future marker is
    // not permission to clear credentials before authentication; preserve the durable fence
    // and fail closed until its authority contract is implemented.
    const error = new SessionAuthorityProjectionIntegrityError('marker')
    await this.failClosedForPendingLogout(error)
    throw error
  }

  private async restoreSelectedSessionAuthoritySource(
    restorePlan: import('./sessionAuthorityAcceptance.js').SessionAuthorityRestoreExistingPlan,
    environmentBinding: ReturnType<AppService['captureAuthEnvironmentBinding']>,
    legacyEnvKeys: readonly string[],
    restoreGeneration: number,
    runLaunchMaintenance: boolean
  ): Promise<SessionState> {
    const envKey = environmentBinding.environmentKey
    const previousRuntimeToken = this.sessionToken
    const previousRuntimeUser = this.me
    const transaction =
      await SessionAuthorityAcceptanceTransaction.beginRestoreExisting(restorePlan)
    const token = transaction.sessionToken
    const ownerIsCurrent = () =>
      this.sessionGeneration === restoreGeneration &&
      this.sessionToken === previousRuntimeToken &&
      this.me === previousRuntimeUser &&
      (previousRuntimeToken === null || previousRuntimeToken === token) &&
      this.interactiveLoginAttempts === 0 &&
      !this.logoutInProgress &&
      getActiveEnvKey() === envKey
    const environmentIsCurrent = () => {
      try {
        this.assertAuthEnvironmentBinding(environmentBinding)
        return true
      } catch {
        return false
      }
    }

    try {
      const { identity: user } = await transaction.executeRestoreExisting({
        assertOwned: () => {
          if (!ownerIsCurrent()) throw new SessionTokenStorageSupersededBeforeWriteError()
          this.assertAuthEnvironmentBinding(environmentBinding)
        },
        verifyIdentity: async () => {
          const identity = await this.withCandidateSessionRequest(
            token,
            envKey,
            restoreGeneration,
            () => {
              try {
                restorePlan.assertSourceCurrent()
                return ownerIsCurrent() && environmentIsCurrent()
              } catch {
                return false
              }
            },
            () => this.authClient.getMe(token)
          )
          if (!ownerIsCurrent()) throw new SessionTokenStorageSupersededBeforeWriteError()
          this.assertAuthEnvironmentBinding(environmentBinding)
          return identity
        },
        onRestoreRejected: async error => {
          if (
            (restorePlan.source.format === 'v0' || restorePlan.source.format === 'v1') &&
            error instanceof ApiError &&
            (error.status === 401 || error.status === 403 || error.status === 410)
          ) {
            try {
              await this.fenceRejectedAcceptedRestoreSource({
                plan: restorePlan,
                token,
                envKey,
                restoreGeneration,
                previousRuntimeToken,
                previousRuntimeUser,
                environmentBinding,
              })
            } catch (cleanupError) {
              if (
                this.sessionGeneration === restoreGeneration &&
                this.sessionToken === previousRuntimeToken &&
                this.me === previousRuntimeUser
              )
                await this.failClosedForPendingLogout(cleanupError)
              this.reportDeferredLogoutFailureSafely(cleanupError)
            }
          }
        },
        prepareConsumers: async identity => {
          const preparedChat = await prepareChatStoreBindingForUser(identity.id, envKey, {
            legacyEnvKeys,
            teamId: identity.teamId,
          })
          if (!ownerIsCurrent() || !environmentIsCurrent() || !preparedChat.canPublish()) {
            preparedChat.discard()
            throw new SessionTokenStorageSupersededBeforeWriteError()
          }
          return preparedChat
        },
        consumersReady: preparedChat => preparedChat.canPublish(),
        isStillOwned: (_identity, preparedChat) =>
          ownerIsCurrent() && environmentIsCurrent() && preparedChat.canPublish(),
        preparePublication: (_accepted, identity, preparedChat) => {
          const publishChat = preparedChat.reservePublication()
          const generation = restoreGeneration + 1
          const acceptedSource = restorePlan.runtimeSource
            ? { selected: restorePlan.runtimeSource, envKey, generation }
            : undefined
          const acceptedMarker = restorePlan.accepted.record.projectionReceipt
            ? acceptancePendingExternalMarker(restorePlan.accepted.record.projectionReceipt.marker)
            : undefined
          const runtimeOwnerPublication = this.sessionAuthority.prepareRuntimeOwnerPublication({
            expectedGeneration: restoreGeneration,
            generation,
            token,
            user: identity,
            acceptedSource,
            acceptedAuthoritySource: restorePlan.source,
            acceptedProjectionMarker: acceptedMarker,
            memoryLease: undefined,
          })
          if (!publishChat || !runtimeOwnerPublication)
            throw new SessionTokenStorageSupersededBeforeWriteError()
          const nextGfsIdentity = desktopGfsUploadIdentity(identity)
          return {
            isCurrent: () => runtimeOwnerPublication.isCurrent(),
            publish: () => {
              publishChat()
              runtimeOwnerPublication.publish()
              this.updateEntityChangeSessionToken(token)
              this.accessCatalog = null
              this.teamDirectoryCache = null
              this.workflowApprovalTeamById.clear()
              this.workflowTeamByKey.clear()
              this.gfsAuthEpoch += 1
              this.gfsDispatchBlocked = false
              this.gfsScopeIdentity = nextGfsIdentity
              return undefined
            },
          }
        },
        afterPublication: (_identity, preparedChat) => {
          preparedChat.afterPublication()
          this.restartEntityChangeStreamForSessionReplacement()
        },
        discardConsumers: preparedChat => preparedChat.discard(),
        onPublicationFailure: () => this.clearAuthenticatedSessionState(),
        rollbackBeforeAcceptance: () => {
          // A rejected cold restore must leave no staged chat authorization behind. A repeated
          // restore attempt over the same already authenticated owner must preserve its existing
          // runtime/consumer binding while discarding only the newly staged resources.
          if (ownerIsCurrent() && previousRuntimeToken === null && previousRuntimeUser === null) {
            unbindChatStore()
            this.gfsAuthEpoch += 1
            this.gfsDispatchBlocked = true
            this.gfsScopeIdentity = null
          }
        },
      })
      if (runLaunchMaintenance) void this.runSandboxUiPartitionGcSafely()
      return { authenticated: true, me: user }
    } catch (error) {
      desktopRuntimeLog.warn(
        '[AppService] Selected session authority could not be restored:',
        error
      )
      throw error
    }
  }

  /**
   * A definitively server-rejected accepted source must be durably denied before exact cleanup.
   * Otherwise the authority frame retries the rejected credential on every subsequent startup.
   */
  private async fenceRejectedAcceptedRestoreSource(input: {
    plan: import('./sessionAuthorityAcceptance.js').SessionAuthorityRestoreExistingPlan
    token: string
    envKey: string
    restoreGeneration: number
    previousRuntimeToken: string | null
    previousRuntimeUser: SessionMe | null
    environmentBinding: ReturnType<AppService['captureAuthEnvironmentBinding']>
  }): Promise<void> {
    input.plan.assertSourceCurrent()
    const runtimeOwnerIsCurrent = () =>
      this.sessionGeneration === input.restoreGeneration &&
      this.sessionToken === input.previousRuntimeToken &&
      this.me === input.previousRuntimeUser &&
      getActiveEnvKey() === input.envKey
    const previousGfsIdentity = this.gfsScopeIdentity ?? undefined
    let cleanupOwnsLease = false
    this.logoutInProgress = true
    // Revoke new GFS dispatch synchronously before any repository or marker observation can
    // await. GFS draining/persistence is fallible cleanup and must not delay the durable deny.
    this.gfsDispatchBlocked = true
    this.gfsAuthEpoch += 1
    let logout: SessionAuthorityLogoutTransaction | null = null
    try {
      const legacyNamespace = getActiveLegacyEnvKeyInventory()
      logout = await SessionAuthorityLogoutTransaction.begin({
        tokenStore: this.tokenStore,
        userDataDirectory: this.getUserDataDirectory(),
        envKey: input.envKey,
        expectedToken: input.token,
        expectedAuthoritySource: input.plan.source,
        legacyEnvKeys: legacyNamespace.keys,
        legacyNamespaceComplete: legacyNamespace.complete,
        isStillOwned: runtimeOwnerIsCurrent,
      })
      if (!logout) throw new SessionAuthorityRecordConflictError()

      await logout.commit(() => {
        if (!runtimeOwnerIsCurrent()) return false
        try {
          this.assertAuthEnvironmentBinding(input.environmentBinding)
          return true
        } catch {
          return false
        }
      })
      // LP plus exact-source debt is now durable. Kick off GFS drain only after that boundary;
      // its state-file write can fail or wait, but cannot undo denial or make restore retry.
      void this.suspendDesktopGfsUploadsForAuthBoundary(previousGfsIdentity).catch(error =>
        this.reportDeferredLogoutFailureSafely(error)
      )
      this.clearAuthenticatedSessionState()
      this.scheduleSessionAuthorityLogoutCleanup(logout)
      cleanupOwnsLease = true
    } finally {
      this.logoutInProgress = false
      if (!cleanupOwnsLease) logout?.close()
    }
  }

  private async restoreSavedSessionOnce(
    options: { runLaunchMaintenance?: boolean } = {},
    restorePlan: SavedSessionRestorePlan = {
      policy: 'normal',
      pendingCleanupMarker: null,
      retireMarkerAfterRestore: false,
    },
    restoreGeneration = this.sessionGeneration
  ) {
    if (this.logoutInProgress) return { authenticated: false, me: null }
    if (this.interactiveLoginAttempts > 0)
      return { authenticated: Boolean(this.sessionToken && this.me), me: this.me }
    if (restorePlan.policy === 'deny-all') return { authenticated: false, me: null }

    const previousRuntimeToken = this.sessionToken
    const previousRuntimeMe = this.me
    hydrateDesktopRuntimeConfig()
    const environmentBinding = this.captureAuthEnvironmentBinding()
    const envKey = environmentBinding.environmentKey
    const legacyNamespace = getActiveLegacyEnvKeyInventory()
    const legacyEnvKeys = legacyNamespace.keys
    const currentRestoreState = () => ({
      authenticated: Boolean(this.sessionToken && this.me),
      me: this.me,
    })
    const isRestoreAdmitted = () => {
      if (
        this.sessionGeneration !== restoreGeneration ||
        this.interactiveLoginAttempts > 0 ||
        this.logoutInProgress ||
        getActiveEnvKey() !== envKey
      )
        return false
      try {
        this.assertAuthEnvironmentBinding(environmentBinding)
        return true
      } catch {
        return false
      }
    }
    const leaveColdRestoreUnauthenticated = () => {
      if (!previousRuntimeToken && !previousRuntimeMe) {
        unbindChatStore()
        this.gfsAuthEpoch += 1
        this.gfsDispatchBlocked = true
        this.gfsScopeIdentity = null
      }
      return currentRestoreState()
    }

    if (!isRestoreAdmitted()) return currentRestoreState()
    this.savedSessionRestoreAttemptedEnvKey = envKey
    this.savedSessionRestoreAttemptedAtMs = Date.now()

    let selectedPlan:
      | import('./sessionAuthorityAcceptance.js').SessionAuthorityRestoreExistingPlan
      | null = null
    try {
      // The current storage protocol restores only a source explicitly selected by the
      // authoritative V2 frame. Historical Keytar/safeStorage selectors belong to older Desktop
      // protocols and are never imported or used as a fallback by this client.
      const selection = await this.sessionAuthority.beginAcceptedSessionRestore(
        envKey,
        restorePlan.policy
      )

      if (selection.status !== 'accepted') return leaveColdRestoreUnauthenticated()
      selectedPlan = selection.plan

      const restored = await this.restoreSelectedSessionAuthoritySource(
        selection.plan,
        environmentBinding,
        legacyEnvKeys,
        restoreGeneration,
        Boolean(options.runLaunchMaintenance)
      )
      if (!restored.authenticated) return currentRestoreState()
      await this.retirePendingKeytarCleanupAfterRestore(restorePlan, envKey)
      return currentRestoreState()
    } catch (error) {
      const normalized = this.unwrapPersistenceAuthorityError(error)
      if (!isRestoreAdmitted()) return currentRestoreState()

      const observationFailure = this.sessionAuthority.planPersistenceAuthorityFailure(
        normalized,
        'restore-source-observation',
        { priorRuntimeAvailable: Boolean(previousRuntimeToken && previousRuntimeMe) }
      )
      if (observationFailure.kind === 'transient-read')
        this.reportDeferredLogoutFailureSafely(normalized)

      // A confirmed server rejection invalidates only the exact legacy V0 value selected by this
      // restore receipt. It never scans or clears another provider or a newer source revision.
      desktopRuntimeLog.warn(
        '[AppService] Selected session authority could not be restored:',
        error
      )
      return leaveColdRestoreUnauthenticated()
    }
  }

  private async canRetireSourceCleanup(
    envKey: string,
    expectedToken: string | null,
    source: 'active-keytar' | 'safe-storage',
    options: {
      marker?: PendingExternalLogoutMarker
      mayContinue?: () => boolean
      fallbackSnapshot?: SessionTokenFallbackSnapshot
      selectedSource?: VerifiedSessionTokenSource
    } = {}
  ): Promise<SessionSourceCleanupOutcome> {
    const cleanupToken = expectedToken
    const plan = this.sessionAuthority.planSourceCleanup(source, cleanupToken)
    if (!cleanupToken || !plan) return { source, kind: 'incomplete' }
    const generation = this.sessionGeneration
    let selected = options.selectedSource
    const ownsCleanup = () =>
      this.sessionAuthority.isSourceCleanupOwnerCurrent({
        envKey,
        generation,
        selectedSource: selected,
        marker: options.marker,
        mayContinue: options.mayContinue,
      })
    try {
      selected ??= await this.readVerifiedSessionTokenSource(
        cleanupToken,
        envKey,
        source === 'active-keytar' ? 'keytar' : 'safe-storage',
        ownsCleanup
      )
      await this.verifySessionTokenSource(selected, envKey, ownsCleanup)
      const snapshot =
        options.fallbackSnapshot ??
        (await this.tokenStore.snapshotSessionTokenFallbackFiles(envKey, {
          legacyEnvKeys: getActiveLegacyEnvKeys(),
          mayWrite: ownsCleanup,
        }))
      const cleared = await this.tokenStore.clearKeytarSessionTokensStrictly(envKey, {
        legacyEnvKeys: getActiveLegacyEnvKeys(),
        preserveActiveEnvKey: plan.preserveActiveEnvKey,
        mayWrite: ownsCleanup,
      })
      const keytarCleanupSettled = isKeytarCleanupEstablished(cleared.keytarDisposition)
      const keytarOwnerCurrent = ownsCleanup()
      if (!keytarCleanupSettled || !keytarOwnerCurrent)
        return this.sessionAuthority.planSourceCleanupOutcome(plan, {
          sourceVerified: false,
          keytarCleanupSettled,
          fallbackRetirementVerified: false,
          ownerCurrent: keytarOwnerCurrent,
        })
      const retired = await this.tokenStore.retireSessionTokenFallbackFilesIfUnchanged(snapshot, {
        mayWrite: ownsCleanup,
        ...(plan.preserveActiveEncryptedToken
          ? { preserveActiveEncryptedToken: plan.preserveActiveEncryptedToken }
          : {}),
      })
      const fallbackRetirementVerified = Boolean(retired)
      const fallbackOwnerCurrent = ownsCleanup()
      if (!fallbackRetirementVerified || !fallbackOwnerCurrent)
        return this.sessionAuthority.planSourceCleanupOutcome(plan, {
          sourceVerified: false,
          keytarCleanupSettled: true,
          fallbackRetirementVerified,
          ownerCurrent: fallbackOwnerCurrent,
        })
      await this.verifySessionTokenSource(selected, envKey, ownsCleanup)
      return this.sessionAuthority.planSourceCleanupOutcome(plan, {
        sourceVerified: true,
        keytarCleanupSettled: true,
        fallbackRetirementVerified: true,
        ownerCurrent: ownsCleanup(),
      })
    } catch (error) {
      this.reportDeferredLogoutFailureSafely(error)
      const failure = this.sessionAuthority.planPersistenceAuthorityFailure(error, 'source-cleanup')
      if (failure.kind === 'fail-closed') await this.failClosedForPendingLogout(error)
      let ownerCurrent = true
      try {
        ownerCurrent = ownsCleanup()
      } catch {
        // An unclassifiable/transient ownership read is incomplete, not proof of supersession.
      }
      return this.sessionAuthority.planSourceCleanupOutcome(plan, {
        sourceVerified: false,
        keytarCleanupSettled: false,
        fallbackRetirementVerified: false,
        ownerCurrent,
      })
    }
  }

  private async bindVerifiedNativeCredentialAfterFallbackCleanup(
    token: string,
    envKey: string,
    marker: PendingExternalLogoutMarker | null,
    fallbackSnapshot: SessionTokenFallbackSnapshot,
    mayContinue: () => boolean,
    markerAttempted: (marker: PendingExternalLogoutMarker) => void,
    selected?: VerifiedSessionTokenSource
  ): Promise<PendingExternalLogoutMarker | null> {
    if (!mayContinue()) throw new SessionTokenStorageSupersededBeforeWriteError()
    selected ??= await this.readVerifiedSessionTokenSource(token, envKey, 'keytar', mayContinue)
    await this.verifySessionTokenSource(selected, envKey, mayContinue)
    const cleanup = await this.canRetireSourceCleanup(envKey, token, 'active-keytar', {
      marker: marker ?? undefined,
      mayContinue,
      fallbackSnapshot,
      selectedSource: selected,
    })
    await this.verifySessionTokenSource(selected, envKey, mayContinue)
    const bindingPlan = this.sessionAuthority.planSourceBindingAfterFallbackCleanup(cleanup, marker)
    if (bindingPlan.kind === 'retain') return bindingPlan.marker
    if (bindingPlan.kind === 'conflict') throw new SessionTokenStorageSupersededBeforeWriteError()
    const quarantine = bindingPlan.next
    markerAttempted(quarantine)
    const written = applyPendingExternalLogoutCas(this.getUserDataDirectory(), envKey, {
      expected: bindingPlan.kind === 'replace-if-unchanged' ? bindingPlan.expected : null,
      next: quarantine,
    })
    if (!written) throw new SessionTokenStorageSupersededBeforeWriteError()
    return quarantine
  }

  private async retirePendingKeytarCleanupAfterRestore(
    restorePlan: SavedSessionRestorePlan,
    envKey: string
  ): Promise<void> {
    const marker = restorePlan.pendingCleanupMarker
    if (!marker || !restorePlan.retireMarkerAfterRestore) return
    await this.retirePendingKeytarCleanupMarker(marker, envKey)
  }

  private async retirePendingKeytarCleanupMarker(
    marker: PendingExternalLogoutMarker,
    envKey: string
  ): Promise<void> {
    await this.runSessionPersistence(() =>
      this.retirePendingKeytarCleanupWithinPersistence(marker, envKey)
    )
  }

  private async retirePendingKeytarCleanupWithinPersistence(
    marker: PendingExternalLogoutMarker,
    envKey: string
  ): Promise<void> {
    const intent = marker.intent
    if (intent.intent !== 'keytar-cleanup-pending') return

    const userDataDirectory = this.getUserDataDirectory()
    const cleanup = await this.canRetireSourceCleanup(
      envKey,
      this.sessionToken,
      intent.credentialSource,
      {
        marker,
      }
    )
    if (cleanup.kind !== 'verified') return
    try {
      const retirement = this.sessionAuthority.planMarkerRetirement(
        marker,
        this.inspectPendingLogoutMarker(envKey),
        true
      )
      if (
        retirement.kind === 'retire' &&
        !applyPendingExternalLogoutCas(userDataDirectory, envKey, retirement.cas)
      )
        throw new SessionTokenStorageSupersededBeforeWriteError()
    } catch (error) {
      this.reportDeferredLogoutFailureSafely(error)
      const failure = this.sessionAuthority.planPersistenceAuthorityFailure(
        error,
        'marker-retirement'
      )
      if (failure.kind === 'transient-read' && failure.source === 'marker') return
      try {
        const current = this.inspectPendingLogoutMarker(envKey)
        const recovery = this.sessionAuthority.planMarkerRetirementFailure(marker, current)
        if (recovery.kind === 'restore-cleanup-if-missing') {
          applyPendingExternalLogoutCas(userDataDirectory, envKey, {
            expected: null,
            next: recovery.next,
          })
        }
      } catch (markerError) {
        this.reportDeferredLogoutFailureSafely(markerError)
      }
    }
  }

  async initialize(): Promise<SessionState> {
    await this.alignRuntimeEnvironmentWithAcceptedSession()
    return this.restoreSavedSession({ runLaunchMaintenance: true })
  }

  /** The durable profile selector, not the last UI selection, chooses startup restore. */
  private async alignRuntimeEnvironmentWithAcceptedSession(): Promise<void> {
    const acceptedEnvKey = await this.sessionAuthority.getProfileSelectedEnvironmentKey()
    if (!acceptedEnvKey || acceptedEnvKey === getActiveEnvKey()) return

    const state = getDesktopRuntimeConfigState()
    const selected = state.options.find(
      option =>
        resolveEnvKey(option.externalRestApiBaseUrl, option.rpcProxyBaseUrl) === acceptedEnvKey
    )
    if (!selected) throw new SessionAuthorityRecordConflictError()

    await this.withNativeAuthEnvironmentCommit(async () => {
      if ((await this.sessionAuthority.getProfileSelectedEnvironmentKey()) !== acceptedEnvKey)
        throw new SessionTokenStorageSupersededBeforeWriteError()
      await selectDesktopRuntimeConfigOption(selected.id)
      this.discardRuntimeConfigDiscoveryOutsideCurrentBinding()
    })
  }

  async applyPendingExternalLogoutIntent(): Promise<boolean> {
    // Quit has already closed credential-producer admission. Pending marker work is left for
    // the next process; do not enter authority reconciliation or native storage during drain.
    if (this.quitPreparationStarted) return false
    const userDataDirectory = this.getUserDataDirectory()
    const envKey = getActiveEnvKey()
    const legacyNamespace = getActiveLegacyEnvKeyInventory()
    let marker: PendingExternalLogoutMarker | null

    // LP is a deny-only runtime boundary too. Inspect it synchronously and revoke every
    // authenticated in-memory consumer before projection reconciliation or any other await.
    // The durable GFS record update may wait for existing uploads, but authorization does not.
    let pendingLogoutDrain: Promise<void> | null = null
    const revokeForPendingLogout = (observed: PendingExternalLogoutMarker | null): void => {
      if (
        observed?.intent.intent !== 'logout-pending' ||
        (this.sessionToken === null && this.me === null && this.memoryOnlySession === undefined)
      )
        return
      const previousGfsIdentity =
        this.gfsScopeIdentity ?? (this.me ? desktopGfsUploadIdentity(this.me) : undefined)
      this.clearAuthenticatedSessionState()
      pendingLogoutDrain = this.suspendDesktopGfsUploadsForAuthBoundary(previousGfsIdentity).catch(
        error => this.reportDeferredLogoutFailureSafely(error)
      )
    }

    try {
      marker = this.inspectPendingLogoutMarker(envKey)
      revokeForPendingLogout(marker)
    } catch {
      // Do not treat an unreadable/invalid marker as absence. The full projection reconciliation
      // immediately below repeats the authoritative read and preserves its more specific
      // projection/corruption error. A valid LP is handled synchronously by the successful read.
      marker = null
    }

    try {
      await SessionAuthorityAcceptanceTransaction.reconcilePendingAcceptanceProjection(
        this.tokenStore,
        userDataDirectory,
        envKey,
        legacyNamespace.keys,
        legacyNamespace.complete
      )
      marker = this.inspectPendingLogoutMarker(envKey)
      // A writer may have installed LP while projection reconciliation was awaiting I/O.
      // Fence it immediately after observing it, before inspecting authority or entering IPC work.
      revokeForPendingLogout(marker)
    } catch (error) {
      if (pendingLogoutDrain) await pendingLogoutDrain
      const disposition = await this.handlePendingLogoutInspectionFailure(
        error,
        'marker-inspection'
      )
      if (disposition === 'transient') return false
      throw error
    }
    if (pendingLogoutDrain) await pendingLogoutDrain

    // V2 LP is already the durable local-logout boundary. Never route it through the legacy
    // clear-first marker policy below: the authority frame and exact cleanup receipts are the
    // source of truth, and physical deletion may safely finish after sign-out.
    type AuthorityInspection =
      | {
          status: 'observed'
          selection: Awaited<
            ReturnType<SessionAuthorityCoordinator['inspectAcceptedSessionRestore']>
          >
        }
      | { status: 'failed'; error: unknown }
    let authorityInspection: AuthorityInspection
    try {
      authorityInspection = {
        status: 'observed',
        selection: await this.sessionAuthority.inspectAcceptedSessionRestore(envKey),
      }
    } catch (error) {
      authorityInspection = { status: 'failed', error }
    }
    let markerAfterAuthorityInspection: PendingExternalLogoutMarker | null
    try {
      markerAfterAuthorityInspection = this.inspectPendingLogoutMarker(envKey)
    } catch (error) {
      // Authority inspection is asynchronous. If the marker cannot be observed again after it
      // settles, the earlier marker image cannot authorize a no-op or cleanup decision.
      await this.failClosedForPendingLogout(error)
      throw error
    }
    if (!pendingExternalLogoutMarkersMatch(markerAfterAuthorityInspection, marker)) {
      marker = markerAfterAuthorityInspection
      revokeForPendingLogout(marker)
      if (marker?.intent.intent === 'logout-pending') {
        const fencedGeneration = this.sessionGeneration
        if (pendingLogoutDrain) await pendingLogoutDrain
        const recovered = await this.recoverObservedLogoutProjection(
          envKey,
          () =>
            getActiveEnvKey() === envKey &&
            this.sessionGeneration === fencedGeneration &&
            this.sessionToken === null &&
            this.me === null &&
            this.memoryOnlySession === undefined
        )
        if (recovered !== null) return true
      }
      // A marker transition during authority inspection invalidates that inspection's result.
      // Re-entry may make a new decision from the current receipt; never apply a stale `null`
      // marker to the legacy logout planner.
      throw new SessionTokenStorageSupersededBeforeWriteError()
    }
    if (authorityInspection.status === 'failed') throw authorityInspection.error
    const authoritySelection = authorityInspection.selection
    const hasLoggedOutAuthority =
      authoritySelection.status === 'denied' && authoritySelection.frameMode === 'logged-out'
    // An absent frame is not a V2 logout receipt; it follows the coordinator-owned legacy marker
    // plan below rather than being synthesized into a logged-out authority selection.
    if (marker?.intent.intent === 'logout-pending' && hasLoggedOutAuthority) {
      const logoutMarker = marker
      const owner = {
        generation: this.sessionGeneration,
        token: this.sessionToken,
        user: this.me,
      }
      const applied = await this.runCredentialProducer(() =>
        this.runSessionPersistence(async () => {
          if (
            this.sessionGeneration !== owner.generation ||
            this.sessionToken !== owner.token ||
            this.me !== owner.user ||
            !pendingExternalLogoutMarkersMatch(
              this.inspectPendingLogoutMarker(envKey),
              logoutMarker
            )
          )
            return false

          const currentAuthority = await this.sessionAuthority.inspectAcceptedSessionRestore(envKey)
          if (
            currentAuthority.status !== 'denied' ||
            currentAuthority.frameMode !== 'logged-out' ||
            !pendingExternalLogoutMarkersMatch(
              this.inspectPendingLogoutMarker(envKey),
              logoutMarker
            )
          )
            return false

          if (owner.token || owner.user) {
            try {
              await this.suspendDesktopGfsUploadsForAuthBoundary()
            } catch (error) {
              // The durable LP already denies restore and consumers are synchronously fenced by
              // clearAuthenticatedSessionState below; suspension is best-effort cleanup now.
              this.reportDeferredLogoutFailureSafely(error)
            }
          }
          if (
            this.sessionGeneration !== owner.generation ||
            this.sessionToken !== owner.token ||
            this.me !== owner.user ||
            !pendingExternalLogoutMarkersMatch(
              this.inspectPendingLogoutMarker(envKey),
              logoutMarker
            )
          )
            return false
          if (owner.token || owner.user) this.clearAuthenticatedSessionState()
          return true
        })
      )
      return applied
    }

    const logoutPlan = this.sessionAuthority.planPendingLogoutApplication(marker)
    if (logoutPlan.kind === 'none') return false

    if (logoutPlan.kind === 'cleanup-source') {
      const cleanupMarker = logoutPlan.marker
      const preserveActiveEnvKey = logoutPlan.source === 'active-keytar'
      const cleanupGeneration = this.sessionGeneration
      return this.runCredentialProducer(() =>
        this.runSessionPersistence(async () => {
          if (
            this.sessionGeneration !== cleanupGeneration ||
            !pendingExternalLogoutMarkersMatch(
              this.inspectPendingLogoutMarker(envKey),
              cleanupMarker
            )
          ) {
            return false
          }
          try {
            const result = await this.clearKeytarForObservedMarker(
              envKey,
              cleanupMarker,
              preserveActiveEnvKey,
              cleanupGeneration
            )
            if (isKeytarCleanupEstablished(result.keytarDisposition)) {
              await this.retirePendingKeytarCleanupWithinPersistence(cleanupMarker, envKey)
            }
          } catch (error) {
            const failure = this.sessionAuthority.planPersistenceAuthorityFailure(
              error,
              'marker-cleanup'
            )
            if (
              failure.kind === 'fail-closed' ||
              (failure.kind === 'transient-read' && failure.source === 'marker')
            )
              await this.handlePendingLogoutInspectionFailure(error, 'marker-cleanup')
            else this.reportDeferredLogoutFailureSafely(error)
          }
          return false
        })
      ).catch(error => {
        this.reportDeferredLogoutFailureSafely(error)
        return false
      })
    }

    marker = logoutPlan.marker
    const cleanupGeneration = this.sessionGeneration
    if (!pendingExternalLogoutMarkersMatch(this.inspectPendingLogoutMarker(envKey), marker))
      return false
    const recovered = await this.recoverObservedLogoutProjection(
      envKey,
      () =>
        getActiveEnvKey() === envKey &&
        this.sessionGeneration === cleanupGeneration &&
        this.sessionToken === null &&
        this.me === null &&
        this.memoryOnlySession === undefined
    )
    return recovered?.kind === 'committed'
  }

  async prepareForQuit(): Promise<void> {
    this.quitPreparationStarted = true
    if (this.pendingCredentialProducers.size > 0) {
      await Promise.allSettled([...this.pendingCredentialProducers])
    }
    await this.tokenStore.prepareForQuit()
  }

  cancelQuitPreparation(): void {
    this.tokenStore.reopenAdmission()
    this.quitPreparationStarted = false
  }

  private async runSandboxUiPartitionGcSafely(): Promise<void> {
    try {
      const { app } = await import('electron')
      const { runSandboxUiPartitionGc } = await import('./sandboxUiPartitionGc.js')
      const result = await runSandboxUiPartitionGc({
        userDataDir: app.getPath('userData'),
        envKey: getActiveEnvKey(),
        listAccessibleApps: () => this.listSandboxUiApps(),
      })
      if (result.wiped.length || result.evicted.length) {
        desktopRuntimeLog.info(
          `[SandboxUI] partition GC complete: wiped=${result.wiped.length}, ` +
            `evicted=${result.evicted.length}`
        )
      }
    } catch (err) {
      desktopRuntimeLog.warn('[SandboxUI] partition GC failed:', err)
    }
  }

  private installAuthenticatedLogin(
    result: { token: string; me: SessionMe },
    expectedSessionGeneration?: number
  ): Promise<SessionState> {
    if (expectedSessionGeneration !== undefined) {
      this.assertSessionGeneration(expectedSessionGeneration)
    }
    const authenticatedAt = Date.now()
    return this.runCredentialProducer(() =>
      this.installAuthenticatedLoginOnce(result, authenticatedAt, expectedSessionGeneration)
    )
  }

  private async installAuthenticatedLoginOnce(
    result: {
      token: string
      me: SessionMe
    },
    authenticatedAt = Date.now(),
    expectedSessionGeneration?: number
  ): Promise<SessionState> {
    return this.runSessionPersistence(() =>
      this.installAuthenticatedLoginWithinPersistence(
        result,
        authenticatedAt,
        expectedSessionGeneration
      )
    )
  }

  private async installAuthenticatedLoginWithAcceptanceTransaction(
    result: { token: string; me: SessionMe },
    envKey: string,
    pendingLogout: PendingLogoutLoginPlan,
    authenticatedAt: number
  ): Promise<SessionState> {
    const legacyNamespace = getActiveLegacyEnvKeyInventory()
    const legacyEnvKeys = legacyNamespace.keys
    // Login preflight can establish a revisioned LP after first reconciling the old
    // marker/source view (for example, while recovering malformed marker bytes). Reconcile
    // that newly established deny state before the coordinator snapshots the authority
    // revision for this candidate; otherwise begin() can legitimately recover LP into a
    // logged-out V2 frame and make the plan's earlier revision stale.
    await SessionAuthorityAcceptanceTransaction.reconcilePendingAcceptanceProjection(
      this.tokenStore,
      this.getUserDataDirectory(),
      envKey,
      legacyEnvKeys,
      legacyNamespace.complete
    )
    const plan = await this.sessionAuthority.planFreshSessionAcceptance({
      envKey,
      token: result.token,
      authenticatedAt,
      pendingLogout,
      legacyEnvKeys,
      legacyNamespaceComplete: legacyNamespace.complete,
    })
    if (plan.generation !== this.sessionGeneration)
      throw new SessionTokenStorageSupersededBeforeWriteError()
    if (plan.source === 'memory-only' && (!plan.volatileSessionId || plan.expiresAt === undefined))
      throw new Error('Temporary session acceptance plan is incomplete')

    const assertOwned = () =>
      this.sessionAuthority.assertFreshSessionAcceptancePlanCurrent(plan, this.logoutInProgress)
    const runtimeOwnerIsCurrent = () =>
      this.sessionAuthority.isFreshSessionAcceptanceRuntimeOwnerCurrent(plan, this.logoutInProgress)
    const runtimeOwnerIsUnchanged = () =>
      this.sessionAuthority.isFreshSessionAcceptanceRuntimeOwnerUnchanged(
        plan,
        this.logoutInProgress
      )
    assertOwned()
    const transaction = await SessionAuthorityAcceptanceTransaction.begin({
      tokenStore: this.tokenStore,
      userDataDirectory: this.getUserDataDirectory(),
      envKey,
      legacyEnvKeys: plan.legacyEnvKeys,
      legacyNamespaceComplete: plan.legacyNamespaceComplete,
      token: result.token,
      accountId: result.me.id,
      source: plan.source,
      purpose: plan.purpose,
      priorToken: plan.priorToken,
      ...(plan.priorVolatileSessionId
        ? { priorVolatileSessionId: plan.priorVolatileSessionId }
        : {}),
      ...(plan.volatileSessionId ? { volatileSessionId: plan.volatileSessionId } : {}),
      expectedAuthorityRevision: plan.authorityRevision,
      ownerEpoch: plan.generation,
    })
    let gfsPrepared = false
    let acceptanceOutcomeIndeterminate = false
    let retireSandboxOwner = false
    let previousPrewarmControllers: AbortController[] = []
    const priorGfsIdentity = plan.ownerUser
      ? (this.gfsScopeIdentity ?? desktopGfsUploadIdentity(plan.ownerUser))
      : undefined
    const priorChatScope = plan.ownerUser ? currentChatAuthorityScopeOrNull() : null

    try {
      const { identity: verifiedUser } = await transaction.execute({
        assertOwned,
        isProducerStillCurrent: runtimeOwnerIsCurrent,
        isPriorConsumerOwnerCurrent: () =>
          sameChatAuthorityScope(currentChatAuthorityScopeOrNull(), priorChatScope),
        onRollbackFailure: error => this.reportDeferredLogoutFailureSafely(error),
        verifyIdentity: async () => {
          const validateIdentity = () => this.authClient.getMe(result.token)
          const user =
            plan.ownerMemoryLease && plan.ownerToken && result.token !== plan.ownerToken
              ? await this.sessionAuthority.withTemporarySessionCandidateValidation(
                  plan.ownerToken,
                  result.token,
                  () =>
                    runWithSessionRequestContext(
                      this.sessionAuthority.captureSessionRequestContext(plan.ownerToken!),
                      validateIdentity
                    )
                )
              : await this.withCandidateSessionRequest(
                  result.token,
                  envKey,
                  plan.generation,
                  runtimeOwnerIsCurrent,
                  validateIdentity
                )
          assertOwned()
          if (!user.id || user.id !== result.me.id)
            throw new Error('Authenticated candidate identity does not match the login result')
          return user
        },
        prepareConsumers: async user => {
          const preparedChat = await prepareChatStoreBindingForUser(user.id, envKey, {
            legacyEnvKeys: getActiveLegacyEnvKeys(),
            teamId: user.teamId,
          })
          assertOwned()
          if (!preparedChat.canPublish()) throw new SessionTokenStorageSupersededBeforeWriteError()

          gfsPrepared = true
          await this.suspendDesktopGfsUploadsForAuthBoundary(priorGfsIdentity)
          assertOwned()
          return preparedChat
        },
        consumersReady: preparedChat => preparedChat.canPublish(),
        isStillOwned: (_user, preparedChat) => preparedChat.canPublish() && runtimeOwnerIsCurrent(),
        // AppService must not perform a second marker/journal CAS after the authority record
        // accepts the candidate. The transaction stages the exact deny-only compatibility
        // marker and binds it into the V2 acceptance receipt before this reservation is made.
        preparePublication: (user, preparedChat) => {
          const publishChat = preparedChat.reservePublication()
          const acceptedMarker = transaction.stagedAcceptanceMarker
          if (!publishChat || !acceptedMarker || !runtimeOwnerIsCurrent())
            throw new SessionTokenStorageSupersededBeforeWriteError()

          const nextMemoryLease: MemoryOnlySessionLease | undefined =
            plan.source === 'memory-only'
              ? {
                  envKey,
                  volatileSessionId: plan.volatileSessionId!,
                  marker: acceptedMarker,
                  expiresAt: plan.expiresAt!,
                }
              : undefined
          const nextGeneration = plan.generation + 1
          const runtimeOwnerPublication = this.sessionAuthority.prepareRuntimeOwnerPublication({
            expectedGeneration: plan.generation,
            generation: nextGeneration,
            token: result.token,
            user,
            acceptedSource: undefined,
            acceptedAuthoritySource: transaction.candidateAuthoritySource ?? undefined,
            acceptedProjectionMarker: acceptedMarker,
            memoryLease: nextMemoryLease,
          })
          if (!runtimeOwnerPublication) throw new SessionTokenStorageSupersededBeforeWriteError()
          const nextGfsIdentity = desktopGfsUploadIdentity(user)
          const nextTeamDirectoryCache = this.teamDirectoryCache
            ? { ...this.teamDirectoryCache, currentTeamId: String(user.teamId || '') }
            : this.teamDirectoryCache
          const retireDesktopWindowOwner = Boolean(plan.ownerToken)
          const previousSessionEnvironment =
            plan.ownerMemoryLease?.envKey ??
            this.sessionAuthority.acceptedSessionSource?.envKey ??
            this.sessionAuthority.acceptedSessionAuthoritySource?.envKey
          retireSandboxOwner = Boolean(
            plan.ownerToken &&
            (plan.ownerUser?.id !== user.id ||
              (previousSessionEnvironment && previousSessionEnvironment !== envKey))
          )
          previousPrewarmControllers = [...this.prewarmReemitAbortControllers.values()]
          const nextPrewarmAuthEpoch = this.prewarmAuthEpoch + 1

          const publish = () => {
            if (retireDesktopWindowOwner) this.scheduleDesktopWindowTeardown()
            publishChat()
            if (retireSandboxOwner) this.sandboxUiSessionEpoch += 1
            runtimeOwnerPublication.publish()
            this.sessionAuthority.clearRpcCredentialOwnerRecords()
            this.rpcTokenManager.clear()
            this.profileUiBaseUrlCache = null
            this.accessCatalog = null
            this.teamDirectoryCache = nextTeamDirectoryCache
            this.workflowApprovalTeamById.clear()
            this.workflowTeamByKey.clear()
            this.updateEntityChangeSessionToken(result.token)
            this.prewarmAuthEpoch = nextPrewarmAuthEpoch
            this.prewarmAttemptAtByHostRef.clear()
            this.prewarmReemitLoopHostRefs.clear()
            this.prewarmReemitAbortControllers.clear()
            this.gfsAuthEpoch += 1
            this.gfsDispatchBlocked = false
            this.gfsScopeIdentity = nextGfsIdentity
            return undefined
          }
          return {
            isCurrent: () => runtimeOwnerPublication.isCurrent() && runtimeOwnerIsCurrent(),
            publish,
          }
        },
        onAcceptanceIndeterminate: () => {
          acceptanceOutcomeIndeterminate = true
          if (runtimeOwnerIsCurrent()) this.clearAuthenticatedSessionState()
        },
        onAcceptancePublicationFailure: () => {
          acceptanceOutcomeIndeterminate = true
          this.clearAuthenticatedSessionState()
        },
        afterAcceptance: async (_accepted, _user, preparedChat) => {
          preparedChat.afterPublication()
          if (retireSandboxOwner) this.scheduleSandboxUiTeardown()
          for (const controller of previousPrewarmControllers) {
            try {
              controller.abort()
            } catch {
              // Epoch checks already deny stale re-emission; abort is best effort.
            }
          }
          if (plan.source === 'memory-only' && this.memoryOnlySession)
            this.scheduleMemoryOnlySessionExpiry(this.memoryOnlySession)
          else {
            if (this.memoryOnlySessionExpiryTimer) clearTimeout(this.memoryOnlySessionExpiryTimer)
            this.memoryOnlySessionExpiryTimer = null
          }
          this.notifySessionChangedSafely(true)
          try {
            this.restartEntityChangeStreamForSessionReplacement()
          } catch (error) {
            this.reportDeferredLogoutFailureSafely(error)
          }
          try {
            await transaction.cleanSupersededSources()
          } catch (error) {
            this.reportDeferredLogoutFailureSafely(error)
          }
          if (this.gfsScopeIdentity) {
            await this.migrateLegacyDesktopGfsUploadScopes(
              this.gfsScopeIdentity,
              getActiveLegacyEnvKeys()
            ).catch(() => undefined)
          }
        },
        discardConsumers: preparedChat => preparedChat.discard(),
        rollbackBeforeAcceptance: authorization => {
          if (!authorization.canRestorePriorConsumers) {
            if (
              runtimeOwnerIsUnchanged() &&
              (this.sessionToken !== null ||
                this.me !== null ||
                this.memoryOnlySession !== undefined)
            )
              this.clearAuthenticatedSessionState()
            return
          }
          if (
            !acceptanceOutcomeIndeterminate &&
            gfsPrepared &&
            plan.ownerUser &&
            runtimeOwnerIsCurrent()
          )
            this.activateGfsAuthScope(priorGfsIdentity)
        },
      })
      return {
        authenticated: true,
        me: verifiedUser,
        ...this.temporarySessionState(),
      }
    } finally {
      // execute() normally closes its transaction. This idempotent close also covers failures
      // thrown while constructing producer effects or before execute() starts.
      await transaction.close()
    }
  }

  private async installAuthenticatedLoginWithinPersistence(
    result: { token: string; me: SessionMe },
    authenticatedAt = Date.now(),
    expectedSessionGeneration?: number
  ): Promise<SessionState> {
    if (expectedSessionGeneration !== undefined)
      this.assertSessionGeneration(expectedSessionGeneration)
    if (this.memoryOnlySessionTermination) await this.memoryOnlySessionTermination
    const releasePrewarm = this.beginPrewarmAuthTransition()
    try {
      const envKey = getActiveEnvKey()
      const legacyNamespace = getActiveLegacyEnvKeyInventory()
      if (this.sessionToken === null && this.me === null && this.memoryOnlySession === undefined) {
        await SessionAuthorityAcceptanceTransaction.recoverCorruptLegacyJournalAfterFreshAuthentication(
          {
            tokenStore: this.tokenStore,
            userDataDirectory: this.getUserDataDirectory(),
            envKey,
            legacyEnvKeys: legacyNamespace.keys,
            legacyNamespaceComplete: legacyNamespace.complete,
          }
        )
      }
      const pendingLogout = await this.applyPendingExternalLogoutBeforeLogin(
        this.getUserDataDirectory(),
        envKey
      )
      return await this.installAuthenticatedLoginWithAcceptanceTransaction(
        result,
        envKey,
        pendingLogout,
        authenticatedAt
      )
    } finally {
      releasePrewarm()
    }
  }

  private async completePasswordLogin(
    email: string,
    password: string,
    expectedSessionGeneration: number
  ): Promise<SessionState> {
    let loginRequest: ReturnType<AuthClient['passwordLogin']> | undefined
    const binding = await this.withNativeAuthEnvironmentCommit(async () => {
      this.assertSessionGeneration(expectedSessionGeneration)
      const currentBinding = this.captureAuthEnvironmentBinding()
      loginRequest = this.authClient.passwordLogin(email, password)
      return currentBinding
    })
    if (!loginRequest) throw new Error('password login request was not dispatched')
    const result = await loginRequest
    return this.withNativeAuthEnvironmentCommit(async () => {
      this.assertSessionGeneration(expectedSessionGeneration)
      this.assertAuthEnvironmentBinding(binding)
      return this.installAuthenticatedLogin(result, expectedSessionGeneration)
    })
  }

  async getDependenciesHealth(): Promise<DependencyHealth> {
    await this.resolveRuntimeConfigIfNeeded().catch(() => undefined)
    const [externalHealth, rpcHealth] = await Promise.allSettled([
      this.authClient.health(),
      this.rpcClient.health(),
    ])
    return {
      externalRestApi:
        externalHealth.status === 'fulfilled'
          ? { ok: externalHealth.value.status === 'ok' }
          : {
              ok: false,
              detail:
                externalHealth.reason instanceof Error
                  ? externalHealth.reason.message
                  : String(externalHealth.reason),
            },
      rpcProxy:
        rpcHealth.status === 'fulfilled'
          ? { ok: rpcHealth.value.status === 'ok' }
          : {
              ok: false,
              detail:
                rpcHealth.reason instanceof Error
                  ? rpcHealth.reason.message
                  : String(rpcHealth.reason),
            },
    }
  }

  getRuntimeConfigState() {
    return getDesktopRuntimeConfigState()
  }

  getSessionGeneration(): number {
    return this.sessionGeneration
  }

  private assertSessionGeneration(expectedSessionGeneration: number): void {
    if (this.sessionGeneration !== expectedSessionGeneration) {
      throw new Error('stale_session_generation')
    }
  }

  private assertProfileHandoffSessionIsSignedOut(): void {
    if (this.interactiveLoginAttempts > 0) {
      throw new Error('auth_transition_in_progress')
    }
    if (this.sessionToken || this.me) {
      throw new Error('desktop_setup_requires_signout')
    }
  }

  private async assertProfileSelectionAllowsEnvironment(
    targetEnvKey: string | null,
    expectedSessionGeneration: number
  ): Promise<void> {
    if (this.quitPreparationStarted) throw new QuitAdmissionClosedError()
    let selectedEnvKey: string | null
    try {
      selectedEnvKey = await this.sessionAuthority.getProfileSelectedEnvironmentKey()
    } catch {
      // An unreadable or recovery-fenced selector is unknown, never permission to switch.
      throw new Error('session_authority_unavailable')
    }
    this.assertSessionGeneration(expectedSessionGeneration)
    if (selectedEnvKey !== null && selectedEnvKey !== targetEnvKey) {
      throw new Error('desktop_setup_requires_signout')
    }
  }

  private applyRuntimeEnvironmentChange(
    operation: () => Promise<void>,
    expectedSessionGeneration?: number
  ): Promise<number> {
    return this.runCredentialProducer(() =>
      this.applyRuntimeEnvironmentChangeOnce(operation, expectedSessionGeneration)
    )
  }

  private async applyRuntimeEnvironmentChangeOnce(
    operation: () => Promise<void>,
    expectedSessionGeneration?: number
  ): Promise<number> {
    if (expectedSessionGeneration !== undefined) {
      this.assertSessionGeneration(expectedSessionGeneration)
    }
    // Every caller of this method changes the authentication environment. A
    // runtime reset is not a substitute for durable LP plus exact-source debt.
    this.assertProfileHandoffSessionIsSignedOut()
    const oldEnvKey = getActiveEnvKey()
    const oldBaseUrl = normalizeDesktopUploadBaseUrl(config.externalRestApiBaseUrl)
    const oldSessionToken = this.sessionToken
    const oldMe = this.me
    const releasePrewarm = this.beginPrewarmAuthTransition()
    try {
      const hadAuthenticatedScope = Boolean(this.sessionToken && this.me)
      this.entityChangeEnvironmentSwitching = true
      this.entityChangeConnectionStop?.({ silent: true })
      // Invalidate a restore that may still be awaiting keychain/getMe before it
      // can bind an old-environment token to the newly selected runtime.
      const transitionGeneration = this.sessionAuthority.advanceSessionGeneration(
        this.sessionGeneration
      )
      if (hadAuthenticatedScope) await this.suspendDesktopGfsUploadsForAuthBoundary()
      this.assertSessionGeneration(transitionGeneration)
      try {
        await operation()
        this.assertSessionGeneration(transitionGeneration)
        this.discardRuntimeConfigDiscoveryOutsideCurrentBinding()
      } catch (error) {
        const environmentUnchanged =
          getActiveEnvKey() === oldEnvKey &&
          normalizeDesktopUploadBaseUrl(config.externalRestApiBaseUrl) === oldBaseUrl
        if (!environmentUnchanged) {
          this.discardRuntimeConfigDiscoveryOutsideCurrentBinding()
          this.clearAuthenticatedSessionState()
        } else if (
          hadAuthenticatedScope &&
          this.sessionToken === oldSessionToken &&
          this.me === oldMe &&
          this.sessionToken &&
          this.me
        ) {
          this.activateGfsAuthScope()
        }
        throw error
      }
      const boundaryChanged =
        getActiveEnvKey() !== oldEnvKey ||
        normalizeDesktopUploadBaseUrl(config.externalRestApiBaseUrl) !== oldBaseUrl
      if (boundaryChanged) {
        this.clearAuthenticatedSessionState()
      } else if (hadAuthenticatedScope && this.sessionToken && this.me) {
        this.activateGfsAuthScope()
        this.sessionAuthority.advanceSessionGeneration(this.sessionGeneration)
      } else {
        this.sessionAuthority.advanceSessionGeneration(this.sessionGeneration)
      }
      return this.sessionGeneration
    } finally {
      this.entityChangeEnvironmentSwitching = false
      if (
        getActiveEnvKey() === oldEnvKey &&
        normalizeDesktopUploadBaseUrl(config.externalRestApiBaseUrl) === oldBaseUrl
      ) {
        this.ensureEntityChangeConnection()
      }
      releasePrewarm()
    }
  }

  async selectRuntimeConfig(optionId: string) {
    return (await this.selectRuntimeConfigWithGeneration(optionId)).runtimeConfigState
  }

  async selectRuntimeConfigForHandoff(
    optionId: string,
    expectedSessionGeneration: number
  ): Promise<DesktopRuntimeConfigHandoffSelection> {
    if (!Number.isSafeInteger(expectedSessionGeneration) || expectedSessionGeneration < 0) {
      throw new Error('invalid_session_generation')
    }
    return this.selectRuntimeConfigWithGeneration(optionId, expectedSessionGeneration)
  }

  private async selectRuntimeConfigWithGeneration(
    optionId: string,
    expectedSessionGeneration?: number
  ): Promise<DesktopRuntimeConfigHandoffSelection> {
    return this.withNativeAuthEnvironmentCommit(async () => {
      if (expectedSessionGeneration !== undefined) {
        this.assertSessionGeneration(expectedSessionGeneration)
      }
      this.assertProfileHandoffSessionIsSignedOut()
      const state = getDesktopRuntimeConfigState()
      const selected = state.options.find(option => option.id === String(optionId || '').trim())
      if (!selected) throw new Error('runtime configuration not found')
      const nextEnvKey = resolveEnvKey(selected.externalRestApiBaseUrl, selected.rpcProxyBaseUrl)
      await this.assertProfileSelectionAllowsEnvironment(
        nextEnvKey,
        expectedSessionGeneration ?? this.sessionGeneration
      )
      const sameUploadBoundary =
        nextEnvKey === state.envKey &&
        normalizeDesktopUploadBaseUrl(selected.externalRestApiBaseUrl) ===
          normalizeDesktopUploadBaseUrl(config.externalRestApiBaseUrl)
      if (sameUploadBoundary) {
        const transitionGeneration = this.sessionAuthority.advanceSessionGeneration(
          this.sessionGeneration
        )
        await selectDesktopRuntimeConfigOption(optionId)
        this.assertSessionGeneration(transitionGeneration)
        this.discardRuntimeConfigDiscoveryOutsideCurrentBinding()
        this.sessionAuthority.advanceSessionGeneration(transitionGeneration)
      } else {
        // A same-boundary selection is not an environment handoff and must not log out an
        // authenticated session. Boundary-changing operations enforce the durable-LP policy
        // inside applyRuntimeEnvironmentChangeOnce before mutating runtime state.
        await this.applyRuntimeEnvironmentChange(
          () => selectDesktopRuntimeConfigOption(optionId),
          expectedSessionGeneration
        )
      }
      return {
        runtimeConfigState: getDesktopRuntimeConfigState(),
        sessionGeneration: this.sessionGeneration,
      }
    })
  }

  async clearRuntimeConfigSelection() {
    return this.withNativeAuthEnvironmentCommit(async () => {
      this.assertProfileHandoffSessionIsSignedOut()
      await this.assertProfileSelectionAllowsEnvironment(null, this.sessionGeneration)
      await this.applyRuntimeEnvironmentChange(clearDesktopRuntimeConfigSelection)
      return getDesktopRuntimeConfigState()
    })
  }

  async saveRuntimeConfig(next: DesktopRuntimeConfig, expectedSessionGeneration?: number) {
    await this.withNativeAuthEnvironmentCommit(async () => {
      if (expectedSessionGeneration !== undefined) {
        if (!Number.isSafeInteger(expectedSessionGeneration) || expectedSessionGeneration < 0) {
          throw new Error('invalid_session_generation')
        }
        this.assertSessionGeneration(expectedSessionGeneration)
      }
      this.assertProfileHandoffSessionIsSignedOut()
      const nextEnvKey = resolveEnvKey(next.externalRestApiBaseUrl, next.rpcProxyBaseUrl || '')
      await this.assertProfileSelectionAllowsEnvironment(
        nextEnvKey,
        expectedSessionGeneration ?? this.sessionGeneration
      )
      const sameUploadBoundary =
        nextEnvKey === getActiveEnvKey() &&
        normalizeDesktopUploadBaseUrl(next.externalRestApiBaseUrl) ===
          normalizeDesktopUploadBaseUrl(config.externalRestApiBaseUrl)
      if (sameUploadBoundary) {
        await saveDesktopRuntimeConfig(next)
        this.discardRuntimeConfigDiscoveryOutsideCurrentBinding()
      } else
        await this.applyRuntimeEnvironmentChange(
          () => saveDesktopRuntimeConfig(next),
          expectedSessionGeneration
        )
    })
    await this.resolveRuntimeConfigIfNeeded().catch(() => undefined)
    return getDesktopRuntimeConfigState()
  }

  async deleteRuntimeConfig(optionId: string) {
    return this.withNativeAuthEnvironmentCommit(async () => {
      this.assertProfileHandoffSessionIsSignedOut()
      const state = getDesktopRuntimeConfigState()
      const normalizedOptionId = String(optionId || '').trim()
      const selected = state.options.find(option => option.id === normalizedOptionId)
      if (!selected) throw new Error('runtime configuration not found')
      await this.assertProfileSelectionAllowsEnvironment(
        state.activeOptionId === normalizedOptionId ? null : state.envKey,
        this.sessionGeneration
      )
      if (state.activeOptionId === normalizedOptionId)
        await this.applyRuntimeEnvironmentChange(() => deleteDesktopRuntimeConfigOption(optionId))
      else await deleteDesktopRuntimeConfigOption(optionId)
      return getDesktopRuntimeConfigState()
    })
  }

  async googleLogin(idToken: string): Promise<SessionState> {
    let loginRequest: ReturnType<AuthClient['googleLogin']> | undefined
    let registered = false
    try {
      const sessionGeneration = await this.withNativeAuthEnvironmentCommit(async () => {
        const sessionGeneration = this.sessionAuthority.advanceSessionGeneration(
          this.sessionGeneration
        )
        this.interactiveLoginAttempts += 1
        registered = true
        return sessionGeneration
      })

      await this.resolveRuntimeConfigIfNeeded().catch(() => undefined)
      const binding = await this.withNativeAuthEnvironmentCommit(async () => {
        this.assertSessionGeneration(sessionGeneration)
        return this.captureAuthEnvironmentBinding()
      })
      const dispatch = await this.withNativeAuthEnvironmentCommit(async () => {
        this.assertSessionGeneration(sessionGeneration)
        this.assertAuthEnvironmentBinding(binding)
        return { request: this.authClient.googleLogin(idToken) }
      })
      loginRequest = dispatch.request
      if (!loginRequest) throw new Error('Google login request was not dispatched')
      const result = await loginRequest
      return await this.withNativeAuthEnvironmentCommit(async () => {
        this.assertSessionGeneration(sessionGeneration)
        this.assertAuthEnvironmentBinding(binding)
        return this.installAuthenticatedLogin(result, sessionGeneration)
      })
    } finally {
      if (registered) {
        await this.withNativeAuthEnvironmentCommit(async () => {
          this.interactiveLoginAttempts = Math.max(0, this.interactiveLoginAttempts - 1)
          if (this.interactiveLoginAttempts === 0 && !this.sessionToken && !this.me) {
            await this.commitPendingRuntimeConfigDiscoveryIfSafe().catch(() => undefined)
          }
        })
      }
    }
  }

  private async openProfileDesktopSetup(email: string): Promise<{
    profileUiUrl: string
    appName: string
  }> {
    try {
      const activation = await this.memberRegistrationServiceClient.getInvitationProfile(email)
      if (activation.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
        throw new Error('invitation configuration mismatch')
      }

      const profileUiUrl = new URL(
        '/desktop-setup',
        `${activation.profileUiBaseUrl.replace(/\/+$/, '')}/`
      )
      profileUiUrl.searchParams.set('email', activation.email)
      await openExternalDataUrl(profileUiUrl.toString())
      return {
        profileUiUrl: profileUiUrl.toString(),
        appName: activation.appName,
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 404) {
          throw new Error('invitation_config_not_found')
        }
      }
      throw error
    }
  }

  async startDesktopSetup(email: string): Promise<{
    profileUiUrl: string
    appName: string
  }> {
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail) throw new Error('email is required')
    return this.openProfileDesktopSetup(normalizedEmail)
  }

  async openForgotPassword(email: string): Promise<{ profileUiUrl: string }> {
    const normalizedEmail = email.trim().toLowerCase()
    const profileUiBaseUrl = requireProfileUiBaseUrlForBrowserAction()
    const profileUiUrl = new URL('/forgot-password', `${profileUiBaseUrl.replace(/\/+$/, '')}/`)
    if (normalizedEmail) profileUiUrl.searchParams.set('email', normalizedEmail)
    await openExternalDataUrl(profileUiUrl.toString())
    return { profileUiUrl: profileUiUrl.toString() }
  }

  async openProfileSettings(
    email: string,
    options: ProfileSettingsOpenOptions = {}
  ): Promise<{ profileUiUrl: string }> {
    const normalizedEmail = email.trim().toLowerCase()
    const profileUiBaseUrl = await this.resolveProfileUiBaseUrl(normalizedEmail)

    const network = String(options.network || '')
      .trim()
      .toLowerCase()
    const socialPath =
      options.section === 'social' && /^[a-z0-9-]+$/.test(network)
        ? `/settings/social/${network}`
        : '/settings/profile'
    const profileUiUrl = new URL(socialPath, `${profileUiBaseUrl.replace(/\/+$/, '')}/`)
    if (options.action === 'password') profileUiUrl.searchParams.set('action', 'password')
    await openExternalDataUrl(profileUiUrl.toString())
    return { profileUiUrl: profileUiUrl.toString() }
  }

  private async resolveProfileUiBaseUrl(
    email?: string,
    options: { fallbackOnLookupError?: boolean } = {}
  ): Promise<string> {
    const { fallbackOnLookupError = true } = options
    if (config.desktopProfileUiBaseUrlExplicit) {
      const explicitBaseUrl = normalizeExplicitProfileUiBaseUrl(config.desktopProfileUiBaseUrl)
      if (!explicitBaseUrl) {
        throw new Error(PROFILE_UI_BASE_URL_ORIGIN_ERROR)
      }
      return explicitBaseUrl
    }
    const normalizedEmail = String(email || this.me?.email || '')
      .trim()
      .toLowerCase()
    if (!normalizedEmail) {
      if (fallbackOnLookupError) return config.desktopProfileUiBaseUrl
      throw new Error('Cannot resolve the Profile UI for this desktop session')
    }
    const cacheKey = `${getActiveEnvKey()}:${this.me?.id || ''}:${normalizedEmail}`
    if (this.profileUiBaseUrlCache?.key === cacheKey) {
      return this.profileUiBaseUrlCache.value
    }
    try {
      const activation =
        await this.memberRegistrationServiceClient.getInvitationProfile(normalizedEmail)
      const profileUiBaseUrl = String(activation.profileUiBaseUrl || '').trim()
      if (!profileUiBaseUrl) {
        if (!fallbackOnLookupError) {
          throw new Error('the invitation profile did not provide a Profile UI URL')
        }
        return config.desktopProfileUiBaseUrl
      }
      this.profileUiBaseUrlCache = { key: cacheKey, value: profileUiBaseUrl }
      return profileUiBaseUrl
    } catch (error) {
      if (fallbackOnLookupError) return config.desktopProfileUiBaseUrl
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Cannot resolve a shareable Profile UI link: ${message}`)
    }
  }

  async completeDesktopSetup(email: string, authorizationToken: string) {
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail || !authorizationToken.trim()) {
      throw new Error('email and authorization token are required')
    }
    const setupGeneration = await this.withNativeAuthEnvironmentCommit(async () => {
      this.assertProfileHandoffSessionIsSignedOut()
      await this.assertProfileSelectionAllowsEnvironment(null, this.sessionGeneration)
      return this.sessionAuthority.advanceSessionGeneration(this.sessionGeneration)
    })
    let setupRequest:
      | ReturnType<MemberRegistrationServiceClient['completeDesktopSetup']>
      | undefined
    await this.withNativeAuthEnvironmentCommit(async () => {
      this.assertSessionGeneration(setupGeneration)
      setupRequest = this.memberRegistrationServiceClient.completeDesktopSetup(
        normalizedEmail,
        authorizationToken
      )
    })
    if (!setupRequest) throw new Error('desktop setup request was not dispatched')

    try {
      const activation = await setupRequest
      if (activation.email.trim().toLowerCase() !== normalizedEmail) {
        throw new Error('desktop setup configuration mismatch')
      }

      const committedGeneration = await this.withNativeAuthEnvironmentCommit(async () => {
        this.assertSessionGeneration(setupGeneration)
        await this.assertProfileSelectionAllowsEnvironment(null, setupGeneration)
        await saveDesktopRuntimeConfig({
          externalRestApiBaseUrl: activation.externalRestApiBaseUrl,
          rpcProxyBaseUrl: '',
          appName: activation.appName,
        })
        this.discardRuntimeConfigDiscoveryOutsideCurrentBinding()
        this.assertSessionGeneration(setupGeneration)
        return this.sessionAuthority.advanceSessionGeneration(setupGeneration)
      })
      const shouldResolve = await this.withNativeAuthEnvironmentCommit(
        async () => this.sessionGeneration === committedGeneration
      )
      if (shouldResolve) await this.resolveRuntimeConfigIfNeeded().catch(() => undefined)
      return getDesktopRuntimeConfigState()
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new Error('desktop_setup_not_found')
      }
      throw error
    }
  }

  async passwordLogin(email: string, password: string): Promise<PasswordLoginResult> {
    let registered = false
    try {
      const currentLoginGeneration = await this.withNativeAuthEnvironmentCommit(async () => {
        const generation = this.sessionAuthority.advanceSessionGeneration(this.sessionGeneration)
        hydrateDesktopRuntimeConfig()
        if (!isDesktopRuntimeConfigured()) {
          throw new Error('desktop_setup_required')
        }
        this.interactiveLoginAttempts += 1
        registered = true
        return generation
      })
      await this.withNativeAuthEnvironmentCommit(async () => {
        this.assertSessionGeneration(currentLoginGeneration)
      })
      await this.resolveRuntimeConfigIfNeeded().catch(() => undefined)
      this.assertSessionGeneration(currentLoginGeneration)
      const normalizedEmail = email.trim().toLowerCase()
      const accepted = await this.completePasswordLogin(
        normalizedEmail,
        password,
        currentLoginGeneration
      )
      return accepted
    } finally {
      if (registered) {
        await this.withNativeAuthEnvironmentCommit(async () => {
          this.interactiveLoginAttempts = Math.max(0, this.interactiveLoginAttempts - 1)
          if (this.interactiveLoginAttempts === 0 && !this.sessionToken && !this.me) {
            await this.commitPendingRuntimeConfigDiscoveryIfSafe().catch(() => undefined)
          }
        })
      }
    }
  }

  /**
   * After a login failure, decide whether to offer a one-click "switch to
   * Localhost and retry". Returns a hint ONLY when all hold:
   *   - the active runtime profile is NOT already localhost,
   *   - a local Evenfire external-rest-api answers `/health`, and
   *   - the active backend does NOT answer `/health` (i.e. the failure looks
   *     like "pointed at the wrong/dead backend", not a bad password against a
   *     healthy one).
   * Self-contained (reads current runtime state + probes reachability), so it
   * never second-guesses a reachable backend and needs no detail from the
   * thrown login error. Best-effort and time-bounded — a slow network yields
   * `null`, never a slower login.
   */
  async diagnoseLoginBackend(): Promise<LoginBackendHint | null> {
    hydrateDesktopRuntimeConfig()
    const state = getDesktopRuntimeConfigState()
    if (state.isLocalhost) return null

    const localhostOption = state.options.find(option => option.source === 'localhost')
    if (!localhostOption?.externalRestApiBaseUrl) return null

    const activeOption = state.options.find(option => option.id === state.activeOptionId) ?? null
    const activeBaseUrl = activeOption?.externalRestApiBaseUrl || config.externalRestApiBaseUrl
    // Nothing to switch to if we're already pointed at the localhost origin.
    if (activeBaseUrl === localhostOption.externalRestApiBaseUrl) return null

    const [localhostReachable, activeReachable] = await Promise.all([
      this.probeBackendHealthy(localhostOption.externalRestApiBaseUrl),
      this.probeBackendHealthy(activeBaseUrl),
    ])
    if (!localhostReachable || activeReachable) return null

    return {
      targetOptionId: localhostOption.id,
      targetLabel: localhostOption.label,
      activeLabel: activeOption?.label || config.appName || activeBaseUrl,
    }
  }

  /**
   * Onboarding's local-cluster hint: is a local Evenfire answering?
   *
   * Takes **no argument** on purpose. The renderer cannot name a URL for the
   * main process to fetch — it can only ask about the built-in Localhost
   * option, whose address is a constant in config. Best-effort and
   * time-bounded, like every other use of `probeBackendHealthy`; a negative
   * result means "show no hint", never an error.
   */
  async probeLocalhostReachable(): Promise<boolean> {
    hydrateDesktopRuntimeConfig()
    const state = getDesktopRuntimeConfigState()
    const localhostOption = state.options.find(option => option.source === 'localhost')
    if (!localhostOption?.externalRestApiBaseUrl) return false
    return this.probeBackendHealthy(localhostOption.externalRestApiBaseUrl)
  }

  /**
   * Open the deployment documentation for onboarding's self-hosted answer
   *. The URL is a build-time constant, not a renderer argument.
   */
  async openDeploymentDocs(): Promise<{ opened: true }> {
    const { shell } = await import('electron')
    await shell.openExternal(config.deploymentDocsUrl)
    return { opened: true }
  }

  /**
   * Open the hosted Evenfire site for onboarding's hosted answer.
   * Also a build-time constant. No credentials, no tenant name and no nonce
   * cross this boundary — the app only opens a page.
   */
  async openHostedSignup(): Promise<{ opened: true }> {
    const { shell } = await import('electron')
    await shell.openExternal(config.hostedSignupUrl)
    return { opened: true }
  }

  /** True iff `<baseUrl>/health` returns `{ status: 'ok' }` within the probe bound. */
  private async probeBackendHealthy(baseUrl: string): Promise<boolean> {
    if (!baseUrl?.trim()) return false
    try {
      const result = await this.authClient.healthAt(
        baseUrl,
        AbortSignal.timeout(BACKEND_PROBE_TIMEOUT_MS)
      )
      return result?.status === 'ok'
    } catch {
      return false
    }
  }

  private async resolveRuntimeConfigIfNeeded(): Promise<void> {
    const request = await this.withNativeAuthEnvironmentCommit(async () => {
      hydrateDesktopRuntimeConfig()
      if (!isDesktopRuntimeConfigured() || config.rpcProxyBaseUrl?.trim()) return null
      if (
        this.pendingRuntimeConfigDiscovery &&
        this.interactiveLoginAttempts > 0 &&
        !this.sessionToken &&
        !this.me
      ) {
        await this.applyRuntimeConfigDiscovery(this.pendingRuntimeConfigDiscovery)
      }
      if (config.rpcProxyBaseUrl?.trim()) return null
      if (
        this.effectiveRuntimeRpcEndpoint &&
        this.runtimeConfigDiscoveryMatchesCurrentBinding(this.effectiveRuntimeRpcEndpoint)
      ) {
        return null
      }
      return {
        externalRestApiBaseUrl: canonicalizeDesktopRestEndpoint(config.externalRestApiBaseUrl),
        appName: config.appName,
        environmentBinding: this.captureAuthEnvironmentBinding(),
      }
    })
    if (!request) return

    const resolutionKey = JSON.stringify([
      request.environmentBinding.profileId,
      request.externalRestApiBaseUrl,
    ])
    const inFlight = this.runtimeConfigResolutionInFlight.get(resolutionKey)
    if (inFlight) {
      await inFlight.promise
      return
    }

    const resolution = { promise: this.resolveRuntimeConfigRequest(request) }
    this.runtimeConfigResolutionInFlight.set(resolutionKey, resolution)
    try {
      await resolution.promise
    } finally {
      if (this.runtimeConfigResolutionInFlight.get(resolutionKey) === resolution) {
        this.runtimeConfigResolutionInFlight.delete(resolutionKey)
      }
    }
  }

  private async resolveRuntimeConfigRequest(request: {
    externalRestApiBaseUrl: string
    appName: string
    environmentBinding: {
      environmentKey: string
      profileId: string | null
      restBaseUrl: string
    }
  }): Promise<void> {
    const discovered = await this.authClient.getDesktopEnvironment()
    const rpcProxyBaseUrl = validateRpcProxyBaseUrl(discovered.rpcProxyBaseUrl)
    if (
      !sameDesktopRestEndpoint(discovered.externalRestApiBaseUrl, request.externalRestApiBaseUrl)
    ) {
      throw new Error('Desktop environment discovery returned a different REST endpoint')
    }
    await this.withNativeAuthEnvironmentCommit(async () => {
      this.assertAuthEnvironmentBinding(request.environmentBinding)
      await this.applyRuntimeConfigDiscovery({
        profileId: request.environmentBinding.profileId,
        externalRestApiBaseUrl: request.externalRestApiBaseUrl,
        rpcProxyBaseUrl,
        appName: discovered.appName || request.appName,
      })
    })
  }

  /** Caller must hold the native auth/environment commit owner. */
  private async applyRuntimeConfigDiscovery(discovery: RuntimeConfigDiscovery): Promise<void> {
    this.pendingRuntimeConfigDiscovery = discovery
    hydrateDesktopRuntimeConfig()
    if (!this.runtimeConfigDiscoveryMatchesCurrentBinding(discovery)) {
      if (this.pendingRuntimeConfigDiscovery === discovery) {
        this.pendingRuntimeConfigDiscovery = null
      }
      return
    }
    if (!isDesktopRuntimeConfigured() || config.rpcProxyBaseUrl?.trim()) {
      if (this.pendingRuntimeConfigDiscovery === discovery) {
        this.pendingRuntimeConfigDiscovery = null
      }
      this.clearEffectiveRuntimeRpcEndpoint()
      return
    }

    const restoreHasReservedEnvironment =
      this.restoreSavedSessionInFlight !== null && this.restoreSavedSessionReservationStarted
    if (this.sessionToken || this.me) {
      this.setEffectiveRuntimeRpcEndpoint(discovery)
      return
    }
    if (restoreHasReservedEnvironment && this.interactiveLoginAttempts === 0) {
      return
    }

    const discoveredEnvKey = resolveEnvKey(
      discovery.externalRestApiBaseUrl,
      discovery.rpcProxyBaseUrl
    )
    await this.assertProfileSelectionAllowsEnvironment(discoveredEnvKey, this.sessionGeneration)
    const previousEnvKey = getActiveEnvKey()
    await saveDesktopRuntimeConfig({
      // Discovery only enriches the selected profile. Commit it while signed
      // out so the next auth boundary owns token and chat migration.
      externalRestApiBaseUrl: discovery.externalRestApiBaseUrl,
      rpcProxyBaseUrl: discovery.rpcProxyBaseUrl,
      appName: discovery.appName,
    })
    if (getActiveEnvKey() !== previousEnvKey) this.rpcTokenManager.clear()
    if (this.pendingRuntimeConfigDiscovery === discovery) {
      this.pendingRuntimeConfigDiscovery = null
    }
    this.clearEffectiveRuntimeRpcEndpoint()
  }

  /** Caller must hold the native auth/environment commit owner. */
  private async commitPendingRuntimeConfigDiscoveryIfSafe(): Promise<void> {
    const pending = this.pendingRuntimeConfigDiscovery
    if (pending) await this.applyRuntimeConfigDiscovery(pending)
  }

  async getDesktopReleaseStatus(): Promise<DesktopReleaseStatus> {
    const token = this.requireSessionToken()
    const { app } = await import('electron')
    const currentVersion = resolveDesktopAppVersion(app)
    const policy = await this.authClient.getDesktopReleasePolicy(token)
    const updateRequired = compareSemverLike(currentVersion, policy.minimumDesktopVersion) < 0
    return {
      checked: true,
      currentVersion,
      latestVersion: policy.desktopVersion,
      minimumVersion: policy.minimumDesktopVersion,
      updateRequired,
      releaseUrl: policy.releaseUrl,
      releaseId: policy.releaseId,
      releaseTag: policy.releaseTag,
      externalRestApiVersion: policy.externalRestApiVersion,
      rpcProxyVersion: policy.rpcProxyVersion,
    }
  }

  async getDesktopAppInfo(): Promise<DesktopAppInfo> {
    const { app } = await import('electron')
    return {
      appName: config.appName || 'Evenfire',
      version: resolveDesktopAppVersion(app),
      isPackaged: Boolean(app.isPackaged),
    }
  }

  async openDesktopRelease(releaseUrl: string): Promise<{ opened: true }> {
    const target = String(releaseUrl || '').trim()
    if (!/^https?:\/\//i.test(target)) throw new Error('releaseUrl must be http(s)')
    const { shell } = await import('electron')
    await shell.openExternal(target)
    return { opened: true }
  }

  logout(): Promise<DesktopLogoutOutcome> {
    const requestedEnvKey = getActiveEnvKey()
    const authoritySource =
      this.sessionAuthority.acceptedSessionAuthoritySource ??
      (this.pendingLogoutAuthoritySource?.envKey === requestedEnvKey
        ? this.pendingLogoutAuthoritySource.source
        : undefined)
    const volatileOwner = this.memoryOnlySession
    if (volatileOwner && this.volatileLogoutInFlight?.sessionId === volatileOwner.volatileSessionId)
      return this.volatileLogoutInFlight.promise
    if (volatileOwner && this.sessionToken && this.me) {
      const owner = {
        envKey: volatileOwner.envKey,
        generation: this.sessionGeneration,
        token: this.sessionToken,
        user: this.me,
        authoritySource,
        volatileSessionId: volatileOwner.volatileSessionId,
        gfsIdentity: this.gfsScopeIdentity,
      }
      this.logoutInProgress = true
      this.clearAuthenticatedSessionState()
      const runtimeRevokedGeneration = this.sessionGeneration
      void this.suspendDesktopGfsUploadsForAuthBoundary(owner.gfsIdentity ?? undefined).catch(
        error => this.reportDeferredLogoutFailureSafely(error)
      )
      const operation = this.runCredentialProducer(
        () =>
          this.withNativeAuthEnvironmentCommit(async () => {
            let runtimeRevokedByUnframedProjection: number | null = runtimeRevokedGeneration
            const stillOwnsVolatileRuntime = () =>
              getActiveEnvKey() === owner.envKey &&
              runtimeRevokedByUnframedProjection !== null &&
              this.sessionGeneration === runtimeRevokedByUnframedProjection &&
              this.sessionToken === null &&
              this.me === null &&
              this.memoryOnlySession === undefined
            const recoveredLogout = await this.recoverObservedLogoutProjection(
              owner.envKey,
              stillOwnsVolatileRuntime
            )
            if (recoveredLogout !== null) return recoveredLogout

            let authorityLogout: SessionAuthorityLogoutTransaction | null
            try {
              authorityLogout = await SessionAuthorityLogoutTransaction.begin({
                tokenStore: this.tokenStore,
                userDataDirectory: this.getUserDataDirectory(),
                envKey: owner.envKey,
                expectedToken: null,
                expectedVolatileSessionId: owner.volatileSessionId,
                onLogoutIntentStaged: () => {
                  runtimeRevokedByUnframedProjection = this.sessionGeneration
                },
              })
            } catch (error) {
              const recovered = await this.recoverObservedLogoutProjection(
                owner.envKey,
                stillOwnsVolatileRuntime
              )
              if (recovered !== null) return recovered
              await this.failClosedForObservedLogoutDenial(owner.envKey, error)
              throw error
            }
            if (!authorityLogout) throw new SessionAuthorityRecordConflictError()

            let cleanupOwnsLease = false
            let logoutCommitted = false
            let committedCleanupPending = false
            try {
              const committedRecord = await authorityLogout.commit(stillOwnsVolatileRuntime)
              logoutCommitted = true
              committedCleanupPending = committedRecord.cleanupDebts.length > 0
              cleanupOwnsLease = true
              this.scheduleSessionAuthorityLogoutCleanup(authorityLogout)
              return {
                kind: 'committed',
                sessionGeneration: this.sessionGeneration,
                cleanup: committedCleanupPending ? 'pending' : 'not-required',
              } satisfies DesktopLogoutOutcome
            } catch (error) {
              if (logoutCommitted) {
                await this.failClosedForPendingLogout(error)
                cleanupOwnsLease = true
                this.scheduleSessionAuthorityLogoutCleanup(authorityLogout)
                return {
                  kind: 'committed',
                  sessionGeneration: this.sessionGeneration,
                  cleanup: committedCleanupPending ? 'pending' : 'not-required',
                } satisfies DesktopLogoutOutcome
              }
              if (stillOwnsVolatileRuntime()) {
                if (authorityLogout.requiresFailClosedAfterLogoutFailure()) {
                  authorityLogout.close()
                  cleanupOwnsLease = true
                  const recovered = await this.recoverObservedLogoutProjection(
                    owner.envKey,
                    stillOwnsVolatileRuntime
                  )
                  if (recovered !== null) return recovered
                  await this.failClosedForPendingLogout(error)
                }
              }
              throw error
            } finally {
              if (!cleanupOwnsLease) authorityLogout.close()
            }
          }),
        () =>
          this.commitLogoutAfterAdmissionClosed({
            envKey: owner.envKey,
            token: null,
            volatileSessionId: owner.volatileSessionId,
          })
      )
      const outcomeOperation = operation.catch(error => this.logoutNotCommitted(error))
      const completedOperation = outcomeOperation.then(outcome => {
        if (outcome.kind === 'committed') this.clearPendingLogoutAuthoritySource(owner.envKey)
        return outcome
      })
      let trackedOperation!: Promise<DesktopLogoutOutcome>
      trackedOperation = completedOperation.finally(() => {
        if (this.volatileLogoutInFlight?.promise === trackedOperation)
          this.volatileLogoutInFlight = null
        this.finishLogoutFence()
      })
      this.volatileLogoutInFlight = {
        sessionId: owner.volatileSessionId,
        promise: trackedOperation,
      }
      return trackedOperation
    }

    // Publish an in-memory cancellation fence before joining the native auth/config queue. A team
    // producer may be holding that queue while awaiting a server identity check; it must observe
    // the logout request and release the queue rather than making logout wait behind stale work.
    const owner = {
      generation: this.sessionGeneration,
      token: this.sessionToken,
      user: this.me,
      authoritySource,
      volatileSessionId: this.memoryOnlySession?.volatileSessionId,
      gfsIdentity: this.gfsScopeIdentity,
    }
    if (authoritySource) {
      this.pendingLogoutAuthoritySource = { envKey: requestedEnvKey, source: authoritySource }
    }
    this.logoutInProgress = true
    this.clearAuthenticatedSessionState()
    const runtimeRevokedGeneration = this.sessionGeneration
    void this.suspendDesktopGfsUploadsForAuthBoundary(owner.gfsIdentity ?? undefined).catch(error =>
      this.reportDeferredLogoutFailureSafely(error)
    )
    const operation = this.runCredentialProducer(
      () =>
        this.withNativeAuthEnvironmentCommit(async () => {
          const envKey = getActiveEnvKey()
          const committedOutcome = await this.runSessionPersistence(async () => {
            let runtimeRevokedByUnframedProjection: number | null = runtimeRevokedGeneration
            const stillOwnsRuntime = () =>
              getActiveEnvKey() === envKey &&
              runtimeRevokedByUnframedProjection !== null &&
              this.sessionGeneration === runtimeRevokedByUnframedProjection &&
              this.sessionToken === null &&
              this.me === null &&
              this.memoryOnlySession === undefined
            const recoveredLogout = await this.recoverObservedLogoutProjection(
              envKey,
              stillOwnsRuntime
            )
            if (recoveredLogout !== null) return recoveredLogout

            let authorityLogout: SessionAuthorityLogoutTransaction | null
            try {
              const legacyNamespace = getActiveLegacyEnvKeyInventory()
              authorityLogout = await SessionAuthorityLogoutTransaction.begin({
                tokenStore: this.tokenStore,
                userDataDirectory: this.getUserDataDirectory(),
                envKey,
                expectedToken: owner.token,
                expectedAuthoritySource: owner.authoritySource,
                expectedVolatileSessionId: owner.volatileSessionId,
                legacyEnvKeys: legacyNamespace.keys,
                legacyNamespaceComplete: legacyNamespace.complete,
                isStillOwned: stillOwnsRuntime,
                onLogoutIntentStaged: () => {
                  runtimeRevokedByUnframedProjection = this.sessionGeneration
                },
              })
            } catch (error) {
              const recovered = await this.recoverObservedLogoutProjection(envKey, stillOwnsRuntime)
              if (recovered !== null) return recovered
              await this.failClosedForObservedLogoutDenial(envKey, error)
              throw error
            }
            if (!authorityLogout) throw new SessionAuthorityRecordConflictError()

            let cleanupOwnsLease = false
            let logoutCommitted = false
            let committedCleanupPending = false
            try {
              const committedRecord = await authorityLogout.commit(stillOwnsRuntime)
              logoutCommitted = true
              committedCleanupPending = committedRecord.cleanupDebts.length > 0
              cleanupOwnsLease = true
              this.scheduleSessionAuthorityLogoutCleanup(authorityLogout)
            } catch (error) {
              if (logoutCommitted) {
                await this.failClosedForPendingLogout(error)
                cleanupOwnsLease = true
                this.scheduleSessionAuthorityLogoutCleanup(authorityLogout)
                return {
                  kind: 'committed',
                  sessionGeneration: this.sessionGeneration,
                  cleanup: committedCleanupPending ? 'pending' : 'not-required',
                } satisfies DesktopLogoutOutcome
              }
              if (stillOwnsRuntime()) {
                if (authorityLogout.requiresFailClosedAfterLogoutFailure()) {
                  authorityLogout.close()
                  cleanupOwnsLease = true
                  const recovered = await this.recoverObservedLogoutProjection(
                    envKey,
                    stillOwnsRuntime
                  )
                  if (recovered !== null) return recovered
                  await this.failClosedForPendingLogout(error)
                }
              }
              throw error
            } finally {
              if (!cleanupOwnsLease) authorityLogout.close()
            }
            return {
              kind: 'committed',
              sessionGeneration: this.sessionGeneration,
              cleanup: committedCleanupPending ? 'pending' : 'not-required',
            } satisfies DesktopLogoutOutcome
          })
          await this.commitPendingRuntimeConfigDiscoveryIfSafe().catch(() => undefined)
          return committedOutcome
        }),
      () =>
        this.commitLogoutAfterAdmissionClosed({
          envKey: requestedEnvKey,
          token: owner.token,
          authoritySource: owner.authoritySource ?? undefined,
          volatileSessionId: owner.volatileSessionId,
        })
    )
    return operation
      .catch(error => this.logoutNotCommitted(error))
      .then(outcome => {
        if (outcome.kind === 'committed') this.clearPendingLogoutAuthoritySource(requestedEnvKey)
        return outcome
      })
      .finally(() => {
        this.finishLogoutFence()
      })
  }

  private clearPendingLogoutAuthoritySource(envKey: string): void {
    if (this.pendingLogoutAuthoritySource?.envKey === envKey)
      this.pendingLogoutAuthoritySource = null
  }

  private logoutNotCommitted(error: unknown): DesktopLogoutOutcome {
    const reason =
      error instanceof QuitAdmissionClosedError
        ? 'deferred'
        : error instanceof SessionTokenStorageSupersededBeforeWriteError ||
            error instanceof SessionAuthorityRecordConflictError
          ? 'superseded'
          : 'failed'
    return { kind: 'not-committed', sessionGeneration: this.sessionGeneration, reason }
  }

  /** Complete durable logout after normal credential-producer admission has closed for quit. */
  private async commitLogoutAfterAdmissionClosed(input: {
    envKey: string
    token: string | null
    authoritySource?: SessionAuthorityCredentialSource
    volatileSessionId?: string
  }): Promise<DesktopLogoutOutcome | void> {
    // A logout rejected while another producer is draining may only publish the ordinary LP
    // cancellation fence. It must not start a second authority transaction beside that producer.
    // Likewise, a UI logout with no accepted owner remains a deferred intent, not a committed
    // logout transaction for a session that never existed.
    if (
      this.pendingCredentialProducers.size > 0 ||
      (input.token === null && !input.authoritySource && !input.volatileSessionId)
    ) {
      this.recordLogoutIntentFallback(input.envKey)
      return
    }
    const generation = this.sessionGeneration
    const isStillOwned = () =>
      getActiveEnvKey() === input.envKey &&
      this.sessionGeneration === generation &&
      this.sessionToken === null &&
      this.me === null &&
      this.memoryOnlySession === undefined
    const legacyNamespace = getActiveLegacyEnvKeyInventory()
    const transaction = await SessionAuthorityLogoutTransaction.begin({
      tokenStore: this.tokenStore,
      userDataDirectory: this.getUserDataDirectory(),
      envKey: input.envKey,
      expectedToken: input.token,
      expectedAuthoritySource: input.authoritySource,
      expectedVolatileSessionId: input.volatileSessionId,
      legacyEnvKeys: legacyNamespace.keys,
      legacyNamespaceComplete: legacyNamespace.complete,
      isStillOwned,
    })
    if (!transaction) throw new SessionAuthorityRecordConflictError()
    let cleanupOwnsTransaction = false
    try {
      const record = await transaction.commit(isStillOwned)
      cleanupOwnsTransaction = true
      this.scheduleSessionAuthorityLogoutCleanup(transaction)
      return {
        kind: 'committed',
        sessionGeneration: this.sessionGeneration,
        cleanup: record.cleanupDebts.length > 0 ? 'pending' : 'not-required',
      }
    } finally {
      if (!cleanupOwnsTransaction) transaction.close()
    }
  }

  private finishLogoutFence(): void {
    this.logoutInProgress = false
    if (this.logoutInProgress || !this.memoryOnlyExpiryDeferredDuringLogout) return
    this.memoryOnlyExpiryDeferredDuringLogout = false
    if (this.memoryOnlySession) this.endExpiredMemoryOnlySession()
  }

  /** Resolve a gfs:// URI to its current resource via the API (no local mirror). */
  async resolveGfsUri(uri: string) {
    return this.gfsClient.resolveUri(uri, this.requireSessionToken())
  }

  /**
   * Resolve then download a gfs:// resource's bytes through the brokered proxy.
   * `maxBytes` bounds the download for the preview path (rejected before an
   * oversized payload materializes); omitting it (save-to-disk, plugin SDK)
   * reads the full body.
   */
  async downloadGfsUri(uri: string, maxBytes?: number, signal?: AbortSignal) {
    return this.gfsClient.download(
      uri,
      this.requireSessionToken(),
      maxBytes !== undefined || signal !== undefined ? { maxBytes, signal } : undefined
    )
  }

  /** Capture the accepted owner before an IPC producer can wait in a lifecycle queue. */
  captureGfsRequestContext(): unknown {
    return this.sessionAuthority.captureSessionRequestContext(this.requireSessionToken())
  }

  /**
   * Resolve then STREAM a gfs:// resource's bytes into `onChunk` (R1-H2).
   *
   * The folder-zip walk uses this instead of `downloadGfsUri`: the payload is
   * written straight into the ZIP temp file chunk by chunk, so neither the
   * main process nor the renderer ever holds a whole file in memory. The
   * ceiling is enforced producer-side, mid-stream.
   */
  async downloadGfsUriInto(
    uri: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
    onChunk: (chunk: Uint8Array) => Promise<void>,
    requestContext?: unknown
  ) {
    const token = this.requireSessionToken()
    if (
      requestContext !== undefined &&
      !this.sessionAuthority.isSessionRequestContextInCurrentLineage(requestContext, token)
    ) {
      throw new SessionRequestOwnershipError()
    }

    const download = () =>
      this.gfsClient.downloadInto(uri, token, signal ? { maxBytes, signal } : { maxBytes }, onChunk)
    return requestContext === undefined
      ? download()
      : runWithSessionRequestContext(requestContext, download)
  }

  /** List a gfs directory's children (deny-by-default: only what the user is granted). */
  async listGfsChildren(resourceId: string, drive?: string, cursor?: string, signal?: AbortSignal) {
    return this.gfsClient.listChildren(resourceId, this.requireSessionToken(), {
      drive,
      cursor,
      signal,
    })
  }

  /** List explicit gfs resources the current user can read through grants or shares. */
  async listAccessibleGfsResources(drive?: string, cursor?: string) {
    return this.gfsClient.listAccessible(this.requireSessionToken(), { drive, cursor })
  }

  /**
   * Compute the delegation affordances the renderer should SHOW on a resource.
   * The held bits come from the server (the authority); `delegationAffordances`
   * (the existing pure lib) maps them to {canDelegate, grantableBits,
   * canCreateShare}. Enforcement is always server-side — this only hides controls.
   */
  async gfsAffordances(resourceId: string, drive?: string): Promise<DelegationAffordances> {
    const { held, isOperator } = await this.gfsClient.affordances(
      resourceId,
      this.requireSessionToken(),
      drive
    )
    return delegationAffordances(new Set(held), isOperator)
  }

  /**
   * Delegate a grant to one or more subjects (each subjectKey → structured
   * subject) in a single atomic bulk PUT. No-escalation is server-side.
   * `inherit` is renderer-driven; omitting it defaults the wire body to
   * `true` so a folder grant always covers the folder's contents (the
   * historical `false` default is what produced unreadable children).
   */
  async grantGfs(
    resourceId: string,
    subjectKeys: string[],
    bits: string[],
    drive?: string,
    inherit?: boolean
  ) {
    // One atomic bulk PUT for every selected subject (server caps at 100). Each
    // key is parsed to its structured subject up front, so a single malformed
    // key fails the whole call before any round-trip — never a partial write.
    await this.gfsClient.grant(
      { resourceId, drive, subjects: subjectKeys.map(parseSubjectKey), permissions: bits, inherit },
      this.requireSessionToken()
    )
  }

  /**
   * List a resource's ACL rows for the Manage modal. The row `id` is the revoke
   * handle (the grant PUT response carries no ids). View-ACL = manage-ACL is
   * enforced server-side; a caller without manage_acl gets the API's 403.
   */
  async listGfsGrants(resourceId: string, drive?: string) {
    return this.gfsClient.listGrants({ resourceId, drive }, this.requireSessionToken())
  }

  /** Revoke an ACL row by id (id learned from listGfsGrants). */
  async revokeGfsGrant(grantId: string) {
    await this.gfsClient.revokeGrant(grantId, this.requireSessionToken())
  }

  /** List direct URI shares on a resource for the combined access-management view. */
  async listGfsShares(resourceId: string, drive?: string) {
    return this.gfsClient.listShares({ resourceId, drive }, this.requireSessionToken())
  }

  /** Revoke a direct URI share by its server-issued row id. */
  async revokeGfsShare(shareId: string) {
    await this.gfsClient.revokeShare(shareId, this.requireSessionToken())
  }

  /**
   * The caller's own agents with their canonical GFS host subjects — the grant
   * targets for per-agent delegation. Served fresh from external-rest-api
   * GET /me/agents on every call, NOT from the cached name-based AccessCatalog
   * (which has no gfsSubject and would go stale across reconciliations).
   */
  async listMyAgents(): Promise<AgentWithMcpServers[]> {
    const result = await this.authClient.getMyAgents(this.requireSessionToken())
    return Array.isArray(result.agents) ? result.agents : []
  }

  /**
   * Create a read share for a subject. A "share" grants read access (the minimal
   * shared capability); the no-escalation engine still requires the caller hold
   * read + share. includeDescendants so a folder share covers its subtree.
   */
  async createGfsShare(resourceId: string, subjectKeys: string[], drive?: string) {
    await this.gfsClient.createShare(
      {
        resourceId,
        drive,
        subjects: subjectKeys.map(parseSubjectKey),
        permissions: ['read'],
        includeDescendants: true,
      },
      this.requireSessionToken()
    )
  }

  async createGfsFolder(parentResourceId: string, name: string, drive?: string) {
    return this.gfsClient.createResource(
      { parentResourceId, drive, name, kind: 'directory' },
      this.requireSessionToken()
    )
  }

  async createGfsFile(parentResourceId: string, name: string, encodedData: string, drive?: string) {
    return this.gfsClient.createResource(
      { parentResourceId, drive, name, kind: 'file', encodedData },
      this.requireSessionToken()
    )
  }

  private async desktopGfsUploadStatePath(): Promise<string> {
    const { app } = await import('electron')
    return path.join(app.getPath('userData'), DESKTOP_GFS_UPLOAD_STATE_FILE)
  }

  private enqueueDesktopGfsUploadState<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.gfsUploadStateQueue.then(operation, operation)
    this.gfsUploadStateQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async loadDesktopGfsUploadState(): Promise<{
    state: DesktopGfsUploadStateFile
    migrated: boolean
  }> {
    try {
      const raw = await fs.promises.readFile(await this.desktopGfsUploadStatePath(), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      return migrateDesktopGfsUploadState(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return {
          state: { version: DESKTOP_GFS_UPLOAD_STATE_VERSION, records: [], quarantined: [] },
          migrated: false,
        }
      }
      desktopRuntimeLog.warn('[AppService] Could not read GFS upload state:', error)
      return {
        state: { version: DESKTOP_GFS_UPLOAD_STATE_VERSION, records: [], quarantined: [] },
        migrated: false,
      }
    }
  }

  private async writeDesktopGfsUploadState(state: DesktopGfsUploadStateFile): Promise<void> {
    const filePath = await this.desktopGfsUploadStatePath()
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`
    const records = state.records
      .filter(isPersistedDesktopGfsUpload)
      .map(canonicalPersistedDesktopGfsUpload)
      .slice(-100)
    const quarantined = state.quarantined
      .map(canonicalQuarantinedDesktopGfsUpload)
      .filter((record): record is QuarantinedDesktopGfsUpload => record !== null)
      .slice(-100)
    await fs.promises.writeFile(
      temporaryPath,
      JSON.stringify({
        version: DESKTOP_GFS_UPLOAD_STATE_VERSION,
        records,
        quarantined,
      }),
      { mode: 0o600 }
    )
    await fs.promises.rename(temporaryPath, filePath)
  }

  private hasLiveDesktopGfsUpload(record: PersistedDesktopGfsUpload): boolean {
    const active = this.gfsUploadJobs.get(record.uploadId)
    if (active && sameDesktopGfsUploadScope(active.scope, record.scope)) return true
    return [...this.gfsPendingUploadJobs].some(entry => {
      const pendingSession = entry.job.snapshot().session
      return (
        pendingSession?.uploadId === record.uploadId &&
        sameDesktopGfsUploadScope(entry.scope, record.scope)
      )
    })
  }

  private async readDesktopGfsUploadState(): Promise<DesktopGfsUploadStateFile> {
    return this.enqueueDesktopGfsUploadState(async () => {
      const loaded = await this.loadDesktopGfsUploadState()
      let suspendedOrphanedActive = false
      const updatedAt = new Date().toISOString()
      const state = {
        ...loaded.state,
        records: loaded.state.records.map(record => {
          if (record.status !== 'active' || this.hasLiveDesktopGfsUpload(record)) return record
          suspendedOrphanedActive = true
          return { ...record, status: 'suspended_auth' as const, updatedAt }
        }),
      }
      if (loaded.migrated || suspendedOrphanedActive) {
        await this.writeDesktopGfsUploadState(state)
      }
      return state
    })
  }

  private async updateDesktopGfsUploadState(
    update: (state: DesktopGfsUploadStateFile) => DesktopGfsUploadStateFile
  ): Promise<void> {
    await this.enqueueDesktopGfsUploadState(async () => {
      const loaded = await this.loadDesktopGfsUploadState()
      await this.writeDesktopGfsUploadState(update(loaded.state))
    })
  }

  private async migrateLegacyDesktopGfsUploadScopes(
    identity: DesktopGfsUploadIdentity,
    legacyEnvKeys: readonly string[]
  ): Promise<void> {
    const sourceEnvKeys = new Set(
      legacyEnvKeys
        .map(key => String(key || '').trim())
        .filter(key => key && key !== identity.environmentKey)
    )
    if (!sourceEnvKeys.size) return

    await this.enqueueDesktopGfsUploadState(async () => {
      const loaded = await this.loadDesktopGfsUploadState()
      const updatedAt = new Date().toISOString()
      let changed = false
      const records = loaded.state.records.map(record => {
        if (
          !sourceEnvKeys.has(record.scope.environmentKey) ||
          record.scope.ownerId !== identity.ownerId ||
          record.scope.teamId !== identity.teamId ||
          record.scope.baseUrl !== identity.baseUrl ||
          this.hasLiveDesktopGfsUpload(record)
        ) {
          return record
        }
        changed = true
        return {
          ...record,
          scope: {
            ...record.scope,
            environmentKey: identity.environmentKey,
            authEpoch: this.gfsAuthEpoch,
          },
          status: record.status === 'active' ? ('suspended_auth' as const) : record.status,
          updatedAt,
        }
      })
      if (changed || loaded.migrated) {
        await this.writeDesktopGfsUploadState({ ...loaded.state, records })
      }
    })
  }

  private async persistDesktopGfsUpload(record: PersistedDesktopGfsUpload): Promise<void> {
    if (!isPersistedDesktopGfsUpload(record)) {
      throw new Error('Refusing to persist an invalid GFS upload record')
    }
    const canonicalRecord = canonicalPersistedDesktopGfsUpload(record)
    await this.updateDesktopGfsUploadState(state => ({
      ...state,
      records: [
        ...state.records.filter(item => item.uploadId !== canonicalRecord.uploadId),
        canonicalRecord,
      ].slice(-100),
    }))
  }

  private async clearDesktopGfsUpload(uploadId: string): Promise<void> {
    await this.updateDesktopGfsUploadState(state => ({
      ...state,
      records: state.records.filter(item => item.uploadId !== uploadId),
    }))
  }

  private async runScopedLegacyGfsUpload<T>(
    scope: DesktopGfsUploadScope,
    operation: (token: string, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    const pending = { controller, promise: Promise.resolve() as Promise<unknown>, scope }
    this.gfsPendingLegacyUploads.add(pending)
    const promise = (async () => {
      this.assertCurrentDesktopGfsUploadScope(scope)
      const result = await operation(this.requireSessionToken(), controller.signal)
      this.assertCurrentDesktopGfsUploadScope(scope)
      return result
    })()
    pending.promise = promise
    try {
      return await promise
    } finally {
      this.gfsPendingLegacyUploads.delete(pending)
    }
  }

  private async startDesktopGfsUpload(
    input: Omit<
      DesktopUploadInput,
      'transport' | 'token' | 'baseUrl' | 'onPersist' | 'onClearPersisted' | 'assertAuthEpoch'
    > & { resumeUploadId?: string }
  ): Promise<DesktopUploadSession> {
    const scope = this.currentDesktopGfsUploadScope(input.drive)
    const token = this.requireSessionToken()
    let scopedInput = { ...input, drive: scope.drive }
    if (input.resumeUploadId) {
      const state = await this.readDesktopGfsUploadState()
      const record = state.records.find(item => item.uploadId === input.resumeUploadId)
      if (!record || !sameDesktopGfsUploadScope(record.scope, scope, { includeAuthEpoch: false })) {
        throw new Error('GFS upload session is not available in the active security scope')
      }
      if (
        record.filePath !== input.filePath ||
        record.name !== input.name ||
        record.target.operation !== input.operation ||
        record.target.parentRid !== input.parentRid ||
        record.target.resourceRid !== input.resourceRid ||
        record.target.ifMatch !== input.ifMatch ||
        record.session.drive !== scope.drive
      ) {
        throw new Error('GFS upload resume metadata does not match the persisted scoped record')
      }
      scopedInput = {
        ...scopedInput,
        filePath: record.filePath,
        name: record.name,
        operation: record.target.operation,
        parentRid: record.target.parentRid,
        resourceRid: record.target.resourceRid,
        ifMatch: record.target.ifMatch,
      }
    }
    const job = new DesktopGfsUploadJob({
      ...scopedInput,
      baseUrl: scope.baseUrl,
      token,
      transport: gfsUploadTransport,
      assertAuthEpoch: () => this.assertCurrentDesktopGfsUploadScope(scope),
      onPersist: record =>
        this.persistDesktopGfsUpload({
          ...record,
          version: DESKTOP_GFS_UPLOAD_STATE_VERSION,
          scope,
          status: record.session.state === 'paused' ? 'paused' : 'active',
          updatedAt: new Date().toISOString(),
        }),
      onClearPersisted: uploadId => this.clearDesktopGfsUpload(uploadId),
    })
    const promise = job.start()
    // Capability/auth failures can reject before a resumable session exists.
    // Observe that early rejection immediately; once a session exists, the
    // lifecycle observer below records the durable failed state as usual.
    void promise.catch(() => undefined)
    const pending = { job, promise, scope }
    this.gfsPendingUploadJobs.add(pending)
    let session: DesktopUploadSession
    try {
      session = await job.waitForSession()
    } finally {
      this.gfsPendingUploadJobs.delete(pending)
    }
    this.assertCurrentDesktopGfsUploadScope(scope)
    if (session.drive !== scope.drive)
      throw new Error('upload_drive_mismatch: session does not match the active drive')
    this.gfsUploadJobs.set(session.uploadId, { job, promise, scope })
    void promise
      .then(
        () => undefined,
        async error => {
          const message = String(error instanceof Error ? error.message : error)
          if (!message.startsWith('stale_auth_epoch:')) {
            await this.updateDesktopGfsUploadState(state => ({
              ...state,
              records: state.records.map(record =>
                record.uploadId === session.uploadId &&
                sameDesktopGfsUploadScope(record.scope, scope)
                  ? { ...record, status: 'failed' as const, updatedAt: new Date().toISOString() }
                  : record
              ),
            }))
            desktopRuntimeLog.warn('[AppService] GFS upload job failed:', error)
          }
          if (this.gfsUploadJobs.get(session.uploadId)?.job === job) {
            this.gfsUploadJobs.delete(session.uploadId)
          }
        }
      )
      .catch(error =>
        desktopRuntimeLog.warn('[AppService] Could not persist GFS upload failure:', error)
      )
    return session
  }

  async startGfsFileUpload(
    parentResourceId: string,
    name: string,
    filePath: string,
    drive?: string,
    resumeUploadId?: string
  ): Promise<DesktopUploadSession> {
    const canonicalDrive = normalizeDesktopUploadDrive(drive)
    const scope = this.currentDesktopGfsUploadScope(canonicalDrive)
    try {
      return await this.startDesktopGfsUpload({
        filePath,
        name,
        drive: canonicalDrive,
        operation: 'create',
        parentRid: parentResourceId,
        resumeUploadId,
      })
    } catch (error) {
      // A legacy fallback is valid only for a fresh upload. An explicit resume
      // must remain a v2 operation so a missing capability cannot silently turn
      // a persisted session into a second non-resumable resource.
      if (
        !(error instanceof DesktopUploadCapabilityError) ||
        !error.allowLegacyFallback ||
        resumeUploadId
      )
        throw error
      const resource = await this.runScopedLegacyGfsUpload(scope, async (token, signal) => {
        const encodedData = await legacyEncodedFile(filePath)
        this.assertCurrentDesktopGfsUploadScope(scope)
        return this.gfsClient.createResource(
          { parentResourceId, drive: canonicalDrive, name, kind: 'file', encodedData },
          token,
          signal
        )
      })
      return legacyReceipt(resource, 'create')
    }
  }

  async startGfsFileReplace(
    resourceId: string,
    filePath: string,
    drive?: string,
    ifMatch?: number,
    resumeUploadId?: string
  ): Promise<DesktopUploadSession> {
    const canonicalDrive = normalizeDesktopUploadDrive(drive)
    const scope = this.currentDesktopGfsUploadScope(canonicalDrive)
    try {
      return await this.startDesktopGfsUpload({
        filePath,
        name: resourceId,
        drive: canonicalDrive,
        operation: 'replace',
        resourceRid: resourceId,
        ifMatch,
        resumeUploadId,
      })
    } catch (error) {
      if (
        !(error instanceof DesktopUploadCapabilityError) ||
        !error.allowLegacyFallback ||
        resumeUploadId
      )
        throw error
      const resource = await this.runScopedLegacyGfsUpload(scope, async (token, signal) => {
        const encodedData = await legacyEncodedFile(filePath)
        this.assertCurrentDesktopGfsUploadScope(scope)
        return this.gfsClient.replaceFile(
          { resourceId, drive: canonicalDrive, ifMatch, encodedData },
          token,
          signal
        )
      })
      return legacyReceipt(resource, 'replace')
    }
  }

  async getGfsUploadSnapshot(uploadId: string, drive?: string) {
    const entry = this.gfsUploadJobs.get(uploadId)
    // Snapshot is read-only and an existing job already owns its captured
    // token/scope. It must remain observable during a finite internal team hop;
    // only a brand-new user-facing dispatch is fenced by that hop.
    const scope = this.currentDesktopGfsUploadScope(drive, { allowTransientTeamHop: true })
    if (entry && sameDesktopGfsUploadScope(entry.scope, scope)) return entry.job.snapshot()
    const state = await this.readDesktopGfsUploadState()
    const record = state.records.find(
      item =>
        item.uploadId === uploadId &&
        sameDesktopGfsUploadScope(item.scope, scope, { includeAuthEpoch: false })
    )
    if (!record) return null
    return {
      // `active` is the persistence marker for a process-owned upload. The
      // renderer contract describes the same resumable state as `uploading`;
      // never leak the storage-only marker across the IPC boundary after a
      // restart.
      state: record.status === 'active' ? 'uploading' : record.status,
      session: record.session,
      uploadedBytes: record.session.committedBytes,
      totalBytes: record.fileSize,
    }
  }

  async pauseGfsUpload(uploadId: string, drive?: string): Promise<DesktopUploadSession> {
    const entry = this.gfsUploadJobs.get(uploadId)
    const scope = this.currentDesktopGfsUploadScope(drive, {
      allowTransientTeamHop: Boolean(entry),
    })
    if (!entry || !sameDesktopGfsUploadScope(entry.scope, scope))
      throw new Error('GFS upload is not active in the current security scope')
    const session = await entry.job.pause()
    await this.updateDesktopGfsUploadState(state => ({
      ...state,
      records: state.records.map(record =>
        record.uploadId === uploadId && sameDesktopGfsUploadScope(record.scope, scope)
          ? { ...record, session, status: 'paused' as const, updatedAt: new Date().toISOString() }
          : record
      ),
    }))
    return session
  }

  async resumeGfsUpload(uploadId: string, drive?: string): Promise<DesktopUploadSession> {
    const entry = this.gfsUploadJobs.get(uploadId)
    const scope = this.currentDesktopGfsUploadScope(drive, {
      allowTransientTeamHop: Boolean(entry),
    })
    if (entry) {
      if (!sameDesktopGfsUploadScope(entry.scope, scope))
        throw new Error('GFS upload is not active in the current security scope')
      return entry.job.resume()
    }
    const state = await this.readDesktopGfsUploadState()
    const record = state.records.find(
      item =>
        item.uploadId === uploadId &&
        sameDesktopGfsUploadScope(item.scope, scope, { includeAuthEpoch: false })
    )
    if (!record) throw new Error('GFS upload session is not available in the active security scope')
    if (!['suspended_auth', 'paused', 'failed'].includes(record.status)) {
      throw new Error(`GFS upload cannot be explicitly resumed from ${record.status}`)
    }
    return this.startDesktopGfsUpload({
      filePath: record.filePath,
      name: record.name,
      drive: record.scope.drive,
      operation: record.target.operation,
      parentRid: record.target.parentRid,
      resourceRid: record.target.resourceRid,
      ifMatch: record.target.ifMatch,
      resumeUploadId: record.uploadId,
    })
  }

  async cancelGfsUpload(uploadId: string, drive?: string): Promise<void> {
    const entry = this.gfsUploadJobs.get(uploadId)
    const scope = this.currentDesktopGfsUploadScope(drive, {
      allowTransientTeamHop: Boolean(entry),
    })
    if (entry) {
      if (!sameDesktopGfsUploadScope(entry.scope, scope))
        throw new Error('GFS upload is not active in the current security scope')
      await entry.job.cancel()
      this.gfsUploadJobs.delete(uploadId)
      return
    }
    const state = await this.readDesktopGfsUploadState()
    const record = state.records.find(
      item =>
        item.uploadId === uploadId &&
        sameDesktopGfsUploadScope(item.scope, scope, { includeAuthEpoch: false })
    )
    if (!record) throw new Error('GFS upload session is not available in the active security scope')
    const url = new URL(
      `/api/v1/me/gfs/uploads/${encodeURIComponent(uploadId)}`,
      `${scope.baseUrl}/`
    )
    url.searchParams.set('drive', scope.drive)
    await gfsUploadTransport.requestJson('DELETE', url.toString(), {
      token: this.requireSessionToken(),
      timeoutMs: 10 * 60 * 1000,
    })
    this.assertCurrentDesktopGfsUploadScope(scope)
    await this.clearDesktopGfsUpload(uploadId)
  }

  async listGfsUploadSessions(drive?: string): Promise<DesktopGfsUploadSummary[]> {
    // Listing persisted state is read-only and must remain available while a
    // finite internal team hop temporarily borrows another team's token.
    const scope = this.currentDesktopGfsUploadScope(drive, { allowTransientTeamHop: true })
    const state = await this.readDesktopGfsUploadState()
    return state.records
      .filter(record => sameDesktopGfsUploadScope(record.scope, scope, { includeAuthEpoch: false }))
      .map(record => ({
        uploadId: record.uploadId,
        fileName: record.fileName,
        fileSize: record.fileSize,
        target: record.target,
        name: record.name,
        drive: record.scope.drive,
        status: record.status,
      }))
  }

  async createGfsFileFromPath(
    parentResourceId: string,
    name: string,
    filePath: string,
    drive?: string
  ): Promise<DesktopUploadSession> {
    const canonicalDrive = normalizeDesktopUploadDrive(drive)
    const scope = this.currentDesktopGfsUploadScope(canonicalDrive)
    try {
      const session = await this.startDesktopGfsUpload({
        filePath,
        name,
        drive: canonicalDrive,
        operation: 'create',
        parentRid: parentResourceId,
      })
      this.assertCurrentDesktopGfsUploadScope(scope)
      const entry = this.gfsUploadJobs.get(session.uploadId)
      if (!entry || !sameDesktopGfsUploadScope(entry.scope, scope)) {
        throw new Error('stale_auth_epoch: GFS upload left the active security scope')
      }
      return await entry.promise
    } catch (error) {
      if (!(error instanceof DesktopUploadCapabilityError) || !error.allowLegacyFallback)
        throw error
      const resource = await this.runScopedLegacyGfsUpload(scope, async (token, signal) => {
        const encodedData = await legacyEncodedFile(filePath)
        this.assertCurrentDesktopGfsUploadScope(scope)
        return this.gfsClient.createResource(
          { parentResourceId, drive: canonicalDrive, name, kind: 'file', encodedData },
          token,
          signal
        )
      })
      return legacyReceipt(resource, 'create')
    }
  }

  async replaceGfsFile(resourceId: string, encodedData: string, drive?: string, ifMatch?: number) {
    return this.gfsClient.replaceFile(
      { resourceId, drive, encodedData, ifMatch },
      this.requireSessionToken()
    )
  }

  async replaceGfsFileFromPath(
    resourceId: string,
    filePath: string,
    drive?: string,
    ifMatch?: number
  ): Promise<DesktopUploadSession> {
    const canonicalDrive = normalizeDesktopUploadDrive(drive)
    const scope = this.currentDesktopGfsUploadScope(canonicalDrive)
    try {
      const session = await this.startDesktopGfsUpload({
        filePath,
        name: resourceId,
        drive: canonicalDrive,
        operation: 'replace',
        resourceRid: resourceId,
        ifMatch,
      })
      this.assertCurrentDesktopGfsUploadScope(scope)
      const entry = this.gfsUploadJobs.get(session.uploadId)
      if (!entry || !sameDesktopGfsUploadScope(entry.scope, scope)) {
        throw new Error('stale_auth_epoch: GFS upload left the active security scope')
      }
      return await entry.promise
    } catch (error) {
      if (!(error instanceof DesktopUploadCapabilityError) || !error.allowLegacyFallback)
        throw error
      const resource = await this.runScopedLegacyGfsUpload(scope, async (token, signal) => {
        const encodedData = await legacyEncodedFile(filePath)
        this.assertCurrentDesktopGfsUploadScope(scope)
        return this.gfsClient.replaceFile(
          { resourceId, drive: canonicalDrive, ifMatch, encodedData },
          token,
          signal
        )
      })
      return legacyReceipt(resource, 'replace')
    }
  }

  async renameGfsResource(resourceId: string, newName: string, drive?: string, ifMatch?: number) {
    return this.gfsClient.renameResource(
      { resourceId, drive, newName, ifMatch },
      this.requireSessionToken()
    )
  }

  /**
   * Move a resource into a destination folder (PATCH newParentId). Move
   * authority is parent-relative (write+delete on the old parent, write on the
   * destination) and is enforced server-side; ifMatch pins the resource version.
   * An optional newName performs a combined rename+move in the same PATCH.
   */
  async moveGfsResource(
    resourceId: string,
    destinationId: string,
    drive?: string,
    ifMatch?: number,
    newName?: string
  ) {
    return this.gfsClient.moveResource(
      { resourceId, drive, destinationId, ifMatch, ...(newName !== undefined ? { newName } : {}) },
      this.requireSessionToken()
    )
  }

  async deleteGfsResource(resourceId: string, drive?: string, ifMatch?: number) {
    return this.gfsClient.deleteResource({ resourceId, drive, ifMatch }, this.requireSessionToken())
  }

  private requireSessionToken(): string {
    const token = this.sessionToken
    if (!token) throw new Error('Not authenticated')
    if (this.memoryOnlySession) this.assertMemoryOnlySessionCurrent()
    enterSessionRequestContext(this.sessionAuthority.captureSessionRequestContext(token))
    return token
  }

  private scheduleMemoryOnlySessionExpiry(
    lease: MemoryOnlySessionLease,
    retryDelayMs?: number
  ): void {
    if (this.memoryOnlySessionExpiryTimer) clearTimeout(this.memoryOnlySessionExpiryTimer)
    const timer = setTimeout(
      () => {
        const expired = this.checkTemporarySessionExpiry()
        // A transient marker read must not permanently disable the lease
        // deadline. Protected requests fail while ownership is uncertain, and
        // this bounded retry rechecks the durable fence until it can be read.
        if (!expired && this.memoryOnlySession === lease) {
          this.scheduleMemoryOnlySessionExpiry(lease, 1_000)
        }
      },
      Math.max(0, Math.min(lease.expiresAt - Date.now(), retryDelayMs ?? Number.POSITIVE_INFINITY))
    )
    timer.unref?.()
    this.memoryOnlySessionExpiryTimer = timer
  }

  private notifyTemporarySessionEnded(sessionGeneration = this.sessionGeneration): void {
    try {
      this.notifySessionExpired(sessionGeneration)
    } catch (error) {
      this.reportDeferredLogoutFailureSafely(error)
    }
  }

  private suspendMemoryOnlySessionForAuthBoundary(): Promise<void> {
    if (this.memoryOnlySessionTermination) return this.memoryOnlySessionTermination
    const termination = this.suspendDesktopGfsUploadsForAuthBoundary().finally(() => {
      if (this.memoryOnlySessionTermination === termination) {
        this.memoryOnlySessionTermination = null
      }
    })
    this.memoryOnlySessionTermination = termination
    return termination
  }

  private endMemoryOnlySession(): void {
    if (!this.memoryOnlySession) return
    const termination = this.suspendMemoryOnlySessionForAuthBoundary()
    this.clearAuthenticatedSessionState()
    this.notifyTemporarySessionEnded()
    void termination.catch(error => this.reportDeferredLogoutFailureSafely(error))
  }

  private endExpiredMemoryOnlySession(): void {
    this.endMemoryOnlySession()
  }

  private endInvalidatedMemoryOnlySession(token: string, requestOwner?: unknown): void {
    const ownership = this.sessionAuthority.inspectMemorySessionTokenRequest(token, requestOwner)
    if (ownership.status === 'stale') return
    if (ownership.status === 'invalid') {
      this.handleMemoryOnlySessionAssertionFailure(ownership.error)
      return
    }
    this.endMemoryOnlySession()
  }

  private assertTemporarySessionRequestAllowed(token: string, requestContext?: unknown): unknown {
    if (requestContext === undefined) throw new SessionRequestOwnershipError()
    try {
      return this.sessionAuthority.assertTemporaryRequestAllowed(token, requestContext)
    } catch (error) {
      this.handleMemoryOnlySessionAssertionFailure(error)
      throw error
    }
  }

  private withCandidateSessionRequest<T>(
    token: string,
    envKey: string,
    generation: number,
    isOwnerCurrent: () => boolean,
    operation: () => T
  ): T {
    const requestContext = this.sessionAuthority.createCandidateSessionRequestContext({
      token,
      envKey,
      generation,
      isOwnerCurrent,
    })
    return runWithSessionRequestContext(requestContext, operation)
  }

  private assertMemoryOnlySessionCurrent(expected = this.memoryOnlySession): void {
    try {
      this.sessionAuthority.assertMemoryOnlySessionCurrent(expected)
    } catch (error) {
      this.handleMemoryOnlySessionAssertionFailure(error)
      throw error
    }
  }

  private handleMemoryOnlySessionAssertionFailure(error: unknown): void {
    if (error instanceof TemporarySessionExpiredError) {
      if (this.logoutInProgress) this.memoryOnlyExpiryDeferredDuringLogout = true
      else this.endExpiredMemoryOnlySession()
    } else if (
      error instanceof TemporarySessionEnvironmentChangedError ||
      error instanceof TemporarySessionAuthorityUnavailableError
    ) {
      this.clearAuthenticatedSessionState()
      this.notifyTemporarySessionEnded()
    }
  }

  /** Called on OS resume as well as by a bounded timer; every protected request checks too. */
  checkTemporarySessionExpiry(): boolean {
    const lease = this.memoryOnlySession
    if (!lease) return false
    try {
      this.assertMemoryOnlySessionCurrent(lease)
      return false
    } catch (error) {
      if (error instanceof TemporarySessionExpiredError) return true
      if (error instanceof TemporarySessionAuthorityUnavailableError) return true
      if (error instanceof TemporarySessionEnvironmentChangedError) return true
      this.reportDeferredLogoutFailureSafely(error)
      return false
    }
  }

  private temporarySessionState(): Pick<SessionState, 'sessionMode' | 'expiresAt'> {
    const lease = this.memoryOnlySession
    return lease ? { sessionMode: 'temporary', expiresAt: lease.expiresAt } : {}
  }

  async getSessionState(): Promise<SessionState> {
    if (this.memoryOnlySession) this.assertMemoryOnlySessionCurrent()
    if (!this.sessionToken || !this.me) {
      if (this.restoreSavedSessionInFlight) return this.restoreSavedSession()
      // createWindow() already performs the saved-token restore before showing
      // the renderer. Do not immediately repeat a failed 60-second network
      // attempt from the renderer bootstrap; a new app launch or environment
      // selection gets a fresh attempt because its service/env key is new.
      if (
        this.savedSessionRestoreAttemptedEnvKey === getActiveEnvKey() &&
        Date.now() - this.savedSessionRestoreAttemptedAtMs < SAVED_SESSION_RESTORE_RETRY_DELAY_MS
      ) {
        return { authenticated: false, me: null }
      }
      return this.restoreSavedSession()
    }
    return { authenticated: true, me: this.me, ...this.temporarySessionState() }
  }

  /**
   * Synchronous read of the cached session user id. The plugin SDK broker needs
   * the current user to key grants and audit lines on every request, and it
   * cannot await mid-decision without opening a window where a logout races the
   * consent check. Returns null whenever there is no live session.
   */
  getCachedUserId(): string | null {
    if (this.memoryOnlySession) {
      try {
        this.assertMemoryOnlySessionCurrent()
      } catch {
        return null
      }
    }
    if (!this.sessionToken || !this.me) return null
    return this.me.id
  }

  async listTeams(): Promise<{ currentTeamId: string; items: TeamSummary[] }> {
    const token = this.requireSessionToken()
    return this.authClient.listTeams(token)
  }

  async listTeamMembers(): Promise<TeamMember[]> {
    const token = this.requireSessionToken()
    const result = await this.authClient.getTeamMembers(token)
    return Array.isArray(result.items) ? result.items : []
  }

  async listPendingWorkflowApprovals(limit = 20): Promise<PendingWorkflowApproval[]> {
    const token = this.requireSessionToken()
    try {
      const listed = await this.authClient.listTeams(token)
      const teams = Array.isArray(listed.items) ? listed.items : []
      if (!teams.length) {
        const result = await this.authClient.listPendingWorkflowApprovals(token, limit)
        const items = Array.isArray(result.items) ? result.items : []
        this.rememberWorkflowApprovalTeams(items)
        return items
      }

      const allApprovals: PendingWorkflowApproval[] = []
      const seen = new Set<string>()
      for (const team of teams) {
        const teamId = String(team.id || '').trim()
        if (!teamId) continue
        try {
          const result = await this.runWithTeamContext(teamId, teamToken =>
            this.authClient.listPendingWorkflowApprovals(teamToken, limit)
          )
          const items = Array.isArray(result.items) ? result.items : []
          for (const approval of items) {
            if (seen.has(approval.id)) continue
            seen.add(approval.id)
            allApprovals.push(approval)
          }
        } catch (error) {
          desktopRuntimeLog.warn(`[AppService] Failed loading approvals for team ${teamId}:`, error)
        }
      }
      allApprovals.sort(
        (left, right) =>
          new Date(right.requestedAt).getTime() - new Date(left.requestedAt).getTime()
      )
      const items = allApprovals.slice(0, limit)
      this.rememberWorkflowApprovalTeams(items)
      return items
    } catch {
      const result = await this.authClient.listPendingWorkflowApprovals(token, limit)
      const items = Array.isArray(result.items) ? result.items : []
      this.rememberWorkflowApprovalTeams(items)
      return items
    }
  }

  async acknowledgeNotificationDelivery(
    notificationId: string
  ): Promise<{ ok: boolean; status: string }> {
    const token = this.requireSessionToken()
    return this.authClient.acknowledgeNotificationDelivery(token, notificationId)
  }

  async getNotificationPreferences(): Promise<UserNotificationPreferences> {
    const token = this.requireSessionToken()
    return this.authClient.getNotificationPreferences(token)
  }

  async getExternalChannelsSummary(): Promise<ExternalChannelsSummary> {
    const token = this.requireSessionToken()
    const [targetsResponse, accountsResponse] = await Promise.all([
      this.authClient.listExternalChannelTargets(token),
      this.authClient.listExternalChannelAccounts(token),
    ])
    return {
      targets: Array.isArray(targetsResponse.items) ? targetsResponse.items : [],
      accounts: Array.isArray(accountsResponse.items) ? accountsResponse.items : [],
    }
  }

  async updateNotificationPreferences(body: {
    preferredMedium: 'telegram' | 'slack' | null
    channelFallbackEnabled: boolean
  }): Promise<UserNotificationPreferences> {
    const token = this.requireSessionToken()
    return this.authClient.updateNotificationPreferences(token, body)
  }

  async decideWorkflowApproval(
    approvalId: string,
    decision: 'approve' | 'deny',
    note?: string,
    options: { teamId?: string | null } = {}
  ): Promise<WorkflowApprovalDecisionResult> {
    const targetTeamId =
      String(options.teamId || '').trim() || this.workflowApprovalTeamById.get(approvalId) || null
    const result = await this.runWithTeamContext(
      targetTeamId,
      token => this.authClient.decideWorkflowApproval(token, approvalId, decision, note),
      { mutation: true }
    )
    this.workflowApprovalTeamById.delete(approvalId)
    return result
  }

  startEntityChangeStream(
    streamId: string,
    ownerId: number,
    onEvent: (event: EntityChangeStreamEvent) => void
  ): void {
    this.entityChangeSubscribers.set(streamId, { ownerId, onEvent })
    this.ensureEntityChangeConnection()
  }

  private emitEntityChangeEvent(event: EntityChangeStreamEvent): void {
    if ('cursor' in event) this.entityChangeCursor = event.cursor
    for (const subscriber of Array.from(this.entityChangeSubscribers.values())) {
      try {
        subscriber.onEvent(event)
      } catch {
        // A destroyed renderer must not interrupt delivery to other windows.
      }
    }
  }

  private updateEntityChangeSessionToken(token: string | null): void {
    const requestContext = token ? this.sessionAuthority.captureSessionRequestContext(token) : null
    if (
      this.entityChangeSessionToken === token &&
      ((requestContext === null && this.entityChangeSessionRequestContext === null) ||
        (requestContext !== null &&
          this.entityChangeSessionRequestContext !== null &&
          this.sessionAuthority.sessionRequestContextsMatchOwner(
            this.entityChangeSessionRequestContext,
            requestContext
          )))
    )
      return
    this.entityChangeSessionToken = token
    this.entityChangeSessionRequestContext = requestContext
    this.entityChangeSessionGeneration += 1
  }

  private handleEntityChangeSessionExpiry(connectionGeneration: number): void {
    const hasNewerCommittedSession =
      this.entityChangeSessionGeneration > connectionGeneration &&
      Boolean(this.entityChangeSessionToken)
    if (hasNewerCommittedSession) {
      this.restartEntityChangeStreamForSessionReplacement()
      return
    }

    this.entityChangeConnectionStop?.({ silent: true })
    if (this.gfsTransientTeamHopDepth > 0) {
      this.entityChangeSessionExpiryDeferred = true
      return
    }

    this.emitEntityChangeSessionExpired()
  }

  private emitEntityChangeSessionExpired(): void {
    this.emitEntityChangeEvent({
      type: 'stream.closing',
      schemaVersion: 1,
      cursor: this.entityChangeCursor ?? '00000000-0000-0000-0000-000000000000',
      reason: 'session_expired',
    })
    // Keep renderer-owned subscriptions dormant so a newly committed session
    // can rebind the stream without requiring a renderer remount. The expired
    // connection itself is already stopped; logout and renderer teardown remove
    // these owners through stopAllStreams/stopEntityChangeStreamsForOwner.
  }

  private ensureEntityChangeConnection(): void {
    if (this.entityChangeEnvironmentSwitching) return
    if (this.entityChangeConnectionStop || this.entityChangeSubscribers.size === 0) return
    if (
      !this.entityChangeSessionToken &&
      this.sessionToken &&
      this.gfsTransientTeamHopDepth === 0
    ) {
      this.updateEntityChangeSessionToken(this.sessionToken)
    }
    if (!this.entityChangeSessionToken) return
    let closed = false
    let abortController: AbortController | null = null
    let retryTimer: NodeJS.Timeout | null = null
    let idleTimer: NodeJS.Timeout | null = null
    let backoffMs = 1000
    let serverRetryAfterMs: number | undefined
    const clearRetry = () => {
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
    }
    const clearIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = null
    }
    const armIdleTimer = (attemptController: AbortController) => {
      clearIdleTimer()
      idleTimer = setTimeout(() => {
        idleTimer = null
        if (!closed && abortController === attemptController) attemptController.abort()
      }, ENTITY_CHANGE_STREAM_IDLE_TIMEOUT_MS)
    }
    const stop = (opts?: { silent?: boolean }) => {
      if (closed) return
      closed = true
      clearRetry()
      clearIdleTimer()
      abortController?.abort()
      if (this.entityChangeConnectionStop === stop) this.entityChangeConnectionStop = null
      if (!opts?.silent) this.emitEntityChangeEvent({ type: 'closed' })
    }
    this.entityChangeConnectionStop = stop

    const connect = async () => {
      if (closed) return
      const connectionToken = this.entityChangeSessionToken
      const connectionRequestContext = this.entityChangeSessionRequestContext
      const connectionGeneration = this.entityChangeSessionGeneration
      if (!connectionToken || !connectionRequestContext) {
        stop({ silent: true })
        return
      }
      const attemptController = new AbortController()
      abortController = attemptController
      armIdleTimer(attemptController)
      try {
        await runWithSessionRequestContext(connectionRequestContext, () =>
          this.authClient.openEntityChangeStream(
            connectionToken,
            this.entityChangeCursor,
            event => {
              if (closed) return
              if (
                event.type === 'heartbeat' ||
                event.type === 'scope.invalidated' ||
                event.type === 'resync_required' ||
                event.type === 'stream.closing'
              ) {
                armIdleTimer(attemptController)
                // Transport-open is synthetic: it proves only that fetch
                // returned headers. Reset retry pressure only after the server
                // produces a validated schema-v1 frame.
                backoffMs = 1000
              }
              if (event.type === 'stream.closing' && event.reason === 'session_expired') {
                this.handleEntityChangeSessionExpiry(connectionGeneration)
                return
              }
              this.emitEntityChangeEvent(event)
            },
            attemptController.signal
          )
        )
      } catch (error) {
        if (!closed) {
          if (error instanceof SessionRequestOwnershipError) {
            stop({ silent: true })
          } else if (error instanceof ApiError && error.status === 401) {
            this.handleEntityChangeSessionExpiry(connectionGeneration)
          } else {
            serverRetryAfterMs =
              error instanceof ApiError
                ? parseEntityChangeRetryAfterMs(error.retryAfter)
                : undefined
            this.emitEntityChangeEvent({
              type: 'error',
              message: 'Live updates disconnected; reconnecting.',
            })
          }
        }
      } finally {
        if (closed) return
        clearIdleTimer()
        clearRetry()
        const localBackoffMs = backoffMs + Math.floor(Math.random() * Math.max(1, backoffMs * 0.2))
        const delay = Math.max(localBackoffMs, serverRetryAfterMs ?? 0)
        serverRetryAfterMs = undefined
        backoffMs = Math.min(backoffMs * 2, 15_000)
        retryTimer = setTimeout(() => void connect(), delay)
      }
    }

    void connect()
  }

  private restartEntityChangeStreamForSessionReplacement(): void {
    this.entityChangeSessionExpiryDeferred = false
    this.entityChangeCursor = null
    this.entityChangeConnectionStop?.({ silent: true })
    this.ensureEntityChangeConnection()
  }

  stopEntityChangeStream(streamId: string, requesterOwnerId?: number): boolean {
    const subscriber = this.entityChangeSubscribers.get(streamId)
    if (!subscriber) return true
    if (requesterOwnerId !== undefined && subscriber.ownerId !== requesterOwnerId) return false
    this.entityChangeSubscribers.delete(streamId)
    if (this.entityChangeSubscribers.size === 0) this.entityChangeConnectionStop?.({ silent: true })
    return true
  }

  stopEntityChangeStreamsForOwner(ownerId: number): void {
    for (const [streamId, subscriber] of this.entityChangeSubscribers) {
      if (subscriber.ownerId === ownerId) this.entityChangeSubscribers.delete(streamId)
    }
    if (this.entityChangeSubscribers.size === 0) this.entityChangeConnectionStop?.({ silent: true })
  }

  startWorkflowNotificationStream(
    streamId: string,
    ownerId: number,
    onEvent: (event: WorkflowNotificationStreamEvent) => void
  ): void {
    const token = this.requireSessionToken()

    let closed = false
    let abortController: AbortController | null = null
    let retryTimer: NodeJS.Timeout | null = null
    let backoffMs = 1000

    const clearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    }

    const stop = (opts?: { silent?: boolean }) => {
      if (closed) return
      closed = true
      clearRetry()
      if (abortController) abortController.abort()
      this.notificationStreams.delete(streamId)
      // `silent` (bulk teardown on logout/team-switch) aborts without emitting the
      // final `closed`: the renderer's own `releaseAll()`/reset tears its trackers
      // down, so a fabricated `closed` here would only fire a spurious stream-loss
      // terminal against a still-live tracker (R-F13). See `stopAllStreams`.
      if (!opts?.silent) onEvent({ type: 'closed' })
    }

    this.notificationStreams.set(streamId, {
      ownerId,
      state: 'connecting',
      approvalRequested: 0,
      snapshot: 0,
      updated: 0,
      completed: 0,
      stop,
    })

    const connect = async () => {
      if (closed) return
      let gracefulStreamClosing = false
      abortController = new AbortController()
      const entry = this.notificationStreams.get(streamId)
      if (entry) entry.state = 'connecting'
      try {
        await this.authClient.openWorkflowNotificationStream(
          token,
          event => {
            if (closed) return
            if (event.type === 'open') {
              backoffMs = 1000
              const current = this.notificationStreams.get(streamId)
              if (current) current.state = 'open'
            }
            if (event.type === 'stream.closing') {
              gracefulStreamClosing = true
              const current = this.notificationStreams.get(streamId)
              if (current) current.state = 'connecting'
            }
            if (event.type === 'approval.requested') {
              this.rememberWorkflowApprovalTeam(event.approval)
            }
            if (event.type === 'notification.snapshot') {
              this.rememberWorkflowApprovalTeams(event.items)
            }
            const current = this.notificationStreams.get(streamId)
            if (current && event.type === 'approval.requested') current.approvalRequested += 1
            if (current && event.type === 'notification.snapshot') current.snapshot += 1
            const eventType = (event as { type?: string }).type
            if (current && event.type === 'approval.updated') current.updated += 1
            if (current && eventType === 'workflow.run.completed') current.completed += 1
            onEvent(event)
          },
          abortController.signal
        )
        if (!closed) {
          const current = this.notificationStreams.get(streamId)
          if (gracefulStreamClosing) {
            if (current) current.state = 'connecting'
          } else {
            if (current) current.state = 'error'
            onEvent({ type: 'error', message: 'Notification stream disconnected; reconnecting' })
          }
        }
      } catch (error) {
        if (closed) return
        const current = this.notificationStreams.get(streamId)
        if (current) current.state = 'error'
        onEvent({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        if (closed) return
        clearRetry()
        retryTimer = setTimeout(() => {
          backoffMs = Math.min(backoffMs * 2, 15000)
          void connect()
        }, backoffMs)
      }
    }

    void connect()
  }

  stopWorkflowNotificationStream(streamId: string, requesterOwnerId?: number): boolean {
    const entry = this.notificationStreams.get(streamId)
    if (!entry) return true
    if (requesterOwnerId !== undefined && entry.ownerId !== requesterOwnerId) {
      return false
    }
    entry.stop()
    return true
  }

  stopWorkflowNotificationStreamsForOwner(ownerId: number): void {
    const toStop: string[] = []
    for (const [streamId, entry] of this.notificationStreams.entries()) {
      if (entry.ownerId === ownerId) toStop.push(streamId)
    }
    for (const streamId of toStop) {
      this.stopWorkflowNotificationStream(streamId)
    }
  }

  /**
   * Close EVERY live upstream SSE the app owns — progress (per task), activity
   * (per agent), host status, and workflow notification streams — regardless of
   * owner. Called on `logout()` and on a deliberate `switchTeam()` (spec-v2
   * §4.5-3, R-F13 / GAP-N4 main half): the session/team those streams belong to
   * is going away, so no late terminal/activity event may fire against a torn-down
   * auth or team context, and no reconnect may re-mint a token for the old team.
   * Uses the SILENT stop: each entry aborts its socket and deletes its map entry
   * but does NOT emit the final `closed`. The renderer half (`releaseAll()` /
   * `fsm.reset()` / `resetChat`) tears its own trackers down; a fabricated `closed`
   * here would instead fire a spurious `source:'stream'` terminal against a
   * still-live tracker (its release runs AFTER the `team.switch` IPC resolves),
   * running post-teardown side effects — exactly the R-F13 bug this closes.
   */
  private stopAllStreams(): void {
    for (const entry of Array.from(this.progressStreams.values())) entry.stop({ silent: true })
    for (const entry of Array.from(this.hostActivityStreams.values())) entry.stop({ silent: true })
    for (const entry of Array.from(this.hostStatusStreams.values())) entry.stop({ silent: true })
    for (const entry of Array.from(this.notificationStreams.values())) entry.stop({ silent: true })
    this.entityChangeSubscribers.clear()
    this.entityChangeSessionExpiryDeferred = false
    this.entityChangeConnectionStop?.({ silent: true })
    this.entityChangeCursor = null
  }

  getWorkflowNotificationStreamStatus(): {
    active: number
    open: number
    connecting: number
    error: number
    approvalRequested: number
    snapshot: number
    updated: number
    completed: number
  } {
    let open = 0
    let connecting = 0
    let error = 0
    let approvalRequested = 0
    let snapshot = 0
    let updated = 0
    let completed = 0
    for (const stream of this.notificationStreams.values()) {
      if (stream.state === 'open') open += 1
      else if (stream.state === 'connecting') connecting += 1
      else error += 1
      approvalRequested += stream.approvalRequested
      snapshot += stream.snapshot
      updated += stream.updated
      completed += stream.completed
    }
    return {
      active: this.notificationStreams.size,
      open,
      connecting,
      error,
      approvalRequested,
      snapshot,
      updated,
      completed,
    }
  }

  async listWorkflows(): Promise<WorkflowRecipeListResult> {
    const token = this.requireSessionToken()
    try {
      const listed = await this.authClient.listTeams(token)
      const teams = Array.isArray(listed.items) ? listed.items : []
      if (!teams.length) {
        this.workflowTeamByKey.clear()
        return this.authClient.listWorkflows(token)
      }

      const orderedTeams = [
        ...teams.filter(team => team.id === listed.currentTeamId),
        ...teams.filter(team => team.id !== listed.currentTeamId),
      ]
      const items: WorkflowRecipeListResult['items'] = []
      const seen = new Set<string>()
      const nextWorkflowTeamByKey = new Map<string, string>()

      for (const team of orderedTeams) {
        const teamId = String(team.id || '').trim()
        if (!teamId) continue
        try {
          const result = await this.runWithTeamContext(teamId, teamToken =>
            this.authClient.listWorkflows(teamToken)
          )
          const teamItems = Array.isArray(result.items) ? result.items : []
          for (const item of teamItems) {
            const namespace = String(item.metadata?.namespace || '').trim()
            const name = String(item.metadata?.name || '').trim()
            if (!namespace || !name) continue
            const key = this.workflowKey(namespace, name)
            if (seen.has(key)) continue
            seen.add(key)
            nextWorkflowTeamByKey.set(key, teamId)
            items.push(item)
          }
        } catch (error) {
          desktopRuntimeLog.warn(`[AppService] Failed loading workflows for team ${teamId}:`, error)
        }
      }

      this.workflowTeamByKey.clear()
      for (const [key, teamId] of nextWorkflowTeamByKey) {
        this.workflowTeamByKey.set(key, teamId)
      }
      return { items, count: items.length }
    } catch {
      this.workflowTeamByKey.clear()
      return this.authClient.listWorkflows(token)
    }
  }

  async readWorkflow(ns: string, name: string): Promise<unknown> {
    const teamId = this.workflowTeamByKey.get(this.workflowKey(ns, name)) || null
    return this.runWithTeamContext(teamId, token => this.authClient.readWorkflow(token, ns, name))
  }

  async getWorkflowHealth(ns: string, name: string): Promise<unknown> {
    const teamId = this.workflowTeamByKey.get(this.workflowKey(ns, name)) || null
    return this.runWithTeamContext(teamId, token =>
      this.authClient.getWorkflowHealth(token, ns, name)
    )
  }

  async triggerWorkflow(
    ns: string,
    name: string,
    inputs?: Record<string, unknown>,
    idempotencyKey?: string
  ): Promise<unknown> {
    const body: Record<string, unknown> = {}
    if (inputs) body.inputs = inputs
    const teamId = this.workflowTeamByKey.get(this.workflowKey(ns, name)) || null
    return this.runWithTeamContext(
      teamId,
      token => this.authClient.triggerWorkflow(token, ns, name, body, idempotencyKey),
      { mutation: true }
    )
  }

  async listWorkflowRuns(ns: string, name: string, limit?: number): Promise<unknown> {
    const teamId = this.workflowTeamByKey.get(this.workflowKey(ns, name)) || null
    return this.runWithTeamContext(teamId, token =>
      this.authClient.listWorkflowRuns(token, ns, name, limit)
    )
  }

  async getInitialTeamsDirectory(): Promise<TeamDirectoryResult> {
    const sessionToken = this.requireSessionToken()
    const result = await this.authClient.getInitialTeamDirectory(sessionToken)
    this.teamDirectoryCache = result
    return result
  }

  async listWorkflowRunArtifacts(
    ns: string,
    name: string,
    runId: string
  ): Promise<WorkflowRunArtifactsResult> {
    const teamId = this.workflowTeamByKey.get(this.workflowKey(ns, name)) || null
    return this.runWithTeamContext(teamId, token =>
      this.authClient.listWorkflowRunArtifacts(token, ns, name, runId)
    )
  }

  async downloadWorkflowRunArtifact(
    ns: string,
    name: string,
    runId: string,
    artifactName: string
  ): Promise<Buffer> {
    const teamId = this.workflowTeamByKey.get(this.workflowKey(ns, name)) || null
    return this.runWithTeamContext(teamId, token =>
      this.authClient.downloadWorkflowRunArtifact(token, ns, name, runId, artifactName)
    )
  }

  async getTeamsDirectory(): Promise<TeamDirectoryResult> {
    return this.getInitialTeamsDirectory()
  }

  switchTeam(teamId: string): Promise<SessionState> {
    return this.runCredentialProducer(() => this.switchTeamOnce(teamId))
  }

  private async switchTeamOnce(teamId: string): Promise<SessionState> {
    const targetTeamId = String(teamId || '').trim()
    if (!targetTeamId) throw new Error('teamId is required')
    // Explicit team changes fence opportunistic wake immediately. A failed
    // switch can safely leave prewarm canceled; the message path remains live.
    const releasePrewarm = this.beginPrewarmAuthTransition()
    // Keep the new team token fenced until the old GFS jobs have been
    // suspended. The native owner spans the entire deliberate transition so
    // another team-context operation cannot commit between token installation
    // and GFS activation.
    const releaseTransientHop = this.enterGfsTransientTeamHop()
    let previousToken = ''
    let previousRequestContext: unknown
    let previousGeneration = 0
    let previousEnvKey = ''
    let previousUserId = ''
    try {
      return await this.withNativeAuthEnvironmentCommit(async () => {
        const previousIdentity =
          this.gfsScopeIdentity ?? (this.me ? desktopGfsUploadIdentity(this.me) : undefined)
        previousToken = this.requireSessionToken()
        previousRequestContext = this.sessionAuthority.captureSessionRequestContext(previousToken)
        previousGeneration = this.sessionGeneration
        previousEnvKey = getActiveEnvKey()
        previousUserId = this.me?.id ?? ''
        // §4.5-3 (GAP-N4 main half): a deliberate team switch tears down every live
        // stream — the old team's progress/activity/status/notification sockets must
        // not survive it. Done AFTER the switch SUCCEEDS (silently), mirroring the
        // renderer, which only calls `resetChat()`/`releaseAll()` once the `team.switch`
        // IPC resolves (so a FAILED switch leaves both the streams and the trackers
        // intact rather than a frozen half-torn-down state). Tasks stay alive
        // server-side and reconverge via reconcile when the user returns to that team.
        // NOTE: only the user-initiated `switchTeam` closes streams — the transient
        // per-operation team hops in `runWithTeamContext`/`switchSessionToTeam` (e.g.
        // minting a cross-team RPC token to decide an approval) must NOT.
        await this.switchSessionToTeam(targetTeamId, previousToken, {
          activateGfsScope: true,
          beforeAcceptance: async () => {
            await this.suspendDesktopGfsUploadsForAuthBoundary(previousIdentity)
          },
        })
        // A deliberate user switch is the only team-context boundary that fences
        // in-flight uploads. Transient runWithTeamContext hops intentionally use
        // switchSessionToTeam directly and must leave those jobs untouched.
        const installedUser = this.me
        const installedToken = this.sessionToken
        if (
          !installedUser ||
          !installedToken ||
          String(installedUser.teamId || '').trim() !== targetTeamId
        ) {
          throw new SessionTokenStorageSupersededBeforeWriteError()
        }
        if (
          installedUser.id === previousUserId &&
          getActiveEnvKey() === previousEnvKey &&
          this.sessionGeneration === previousGeneration + 1
        ) {
          const nextRequestContext =
            this.sessionAuthority.captureSessionRequestContext(installedToken)
          this.acceptedTeamSwitchRequestTransition = {
            previousRequestContext,
            nextRequestContext,
            nextToken: installedToken,
            nextGeneration: this.sessionGeneration,
            envKey: getActiveEnvKey(),
            userId: installedUser.id,
          }
        }
        // The acceptance transaction already published the new owner and GFS scope. These
        // stream/notification effects are best effort and must never restore the previous owner.
        for (const effect of [
          () => this.updateEntityChangeSessionToken(this.sessionToken),
          () => this.stopAllStreams(),
          () => tryGetPluginSdkRuntime()?.notifySessionChanged(true),
        ]) {
          try {
            effect()
          } catch (error) {
            this.reportDeferredLogoutFailureSafely(error)
          }
        }
        return { authenticated: true, me: installedUser, ...this.temporarySessionState() }
      })
    } finally {
      releasePrewarm()
      releaseTransientHop()
    }
  }

  async refreshAccessCatalog(): Promise<AccessCatalog> {
    this.captureSessionRequestContextForOperation()
    this.clearRpcTokenCacheForCurrentRequest()
    const token = this.requireSessionToken()
    const me = this.me ?? (await this.authClient.getMe(token))
    this.me = me
    await this.bindCurrentChatStore(me.id)
    const currentTeamId = String(me.teamId || '').trim()

    const [userContexts, userAgents, teamContexts, teamAgents] = await Promise.all([
      this.authClient.getMyContexts(token),
      this.authClient.getMyAgents(token),
      currentTeamId
        ? this.authClient.getTeamContexts(token)
        : Promise.resolve({ teamId: '', contextIds: [] }),
      currentTeamId
        ? this.authClient.getTeamAgents(token)
        : Promise.resolve({ teamId: '', agentNames: [], agents: [] }),
    ])

    const userContextIds = AppService.dedupe(userContexts.contextIds)
    const teamContextIds = AppService.dedupe(teamContexts.contextIds)
    const contextIds = AppService.dedupe([...userContextIds, ...teamContextIds])

    const rawUserAgentNames = AppService.dedupe(userAgents.agentNames)
    const rawTeamAgentNames = AppService.dedupe(teamAgents.agentNames)
    const agentNames = AppService.dedupe([...rawUserAgentNames, ...rawTeamAgentNames])
    const activeAgentNameSet = new Set(agentNames)
    const userAgentNames = rawUserAgentNames.filter(agentName => activeAgentNameSet.has(agentName))
    const teamAgentNames = rawTeamAgentNames.filter(agentName => activeAgentNameSet.has(agentName))

    // Merge the optional per-agent MCP server lists from user + team responses.
    // The agent→servers map is intentionally a narrow interface (names only) —
    // no URLs or credentials are exposed on the session path.
    const mcpServersByAgent: Record<string, string[]> = {}
    const agentMcpServers: Record<string, Array<{ name: string }>> = {}
    const contextMcpServers: Record<string, Array<{ name: string }>> = {}
    const agentContextByName: Record<string, string | null> = {}
    const agentProviderByName: Record<string, string | null> = {}
    // Visible agent name (Agent CRD `spec.host`, arriving as the wire
    // `displayName`) keyed by `metadata.name`. This is the single producer
    // boundary for the desktop catalog: the `|| name` guard lives here only
    // (mirroring control-api's accessReconciliation `configuredDisplayName ||
    // name`), so renderer consumers read `agentDisplayByName[name]` directly
    // without sprinkling `|| name`. Filled total over
    // `agentNames` below so a lookup is never undefined.
    const agentDisplayByName: Record<string, string> = {}
    const upsertScopedServers = (
      target: Record<string, Array<{ name: string }>>,
      key: string,
      names: string[]
    ) => {
      const existing = target[key] ?? []
      const mergedNames = AppService.dedupe([
        ...existing.map(entry => String(entry?.name || '').trim()),
        ...names,
      ])
      target[key] = mergedNames.map(name => ({ name }))
    }
    const collectAgents = (
      agents?: Array<{
        name: string
        displayName?: string | null
        contextRef?: string | null
        provider?: string | null
        model?: { provider?: string | null } | null
        mcpServers?: Array<{ name: string }>
      }>
    ) => {
      if (!Array.isArray(agents)) return
      for (const a of agents) {
        const agentName = String(a?.name || '').trim()
        if (!agentName) continue
        const displayNameCandidate = typeof a?.displayName === 'string' ? a.displayName.trim() : ''
        if (
          displayNameCandidate &&
          !Object.prototype.hasOwnProperty.call(agentDisplayByName, agentName)
        ) {
          agentDisplayByName[agentName] = displayNameCandidate
        }
        const contextRef =
          typeof a?.contextRef === 'string' && a.contextRef.trim().length > 0
            ? a.contextRef.trim()
            : null
        if (
          !Object.prototype.hasOwnProperty.call(agentContextByName, agentName) ||
          agentContextByName[agentName] == null
        ) {
          agentContextByName[agentName] = contextRef
        }
        const providerCandidate =
          typeof a?.provider === 'string'
            ? a.provider.trim()
            : typeof a?.model?.provider === 'string'
              ? a.model.provider.trim()
              : ''
        if (
          providerCandidate &&
          (!Object.prototype.hasOwnProperty.call(agentProviderByName, agentName) ||
            agentProviderByName[agentName] == null)
        ) {
          agentProviderByName[agentName] = providerCandidate
        }
        const existing = mcpServersByAgent[agentName] ?? []
        const incoming = Array.isArray(a.mcpServers)
          ? a.mcpServers.map(s => String(s?.name || '').trim()).filter(Boolean)
          : []
        const merged = AppService.dedupe([...existing, ...incoming])
        mcpServersByAgent[agentName] = merged
        if (!merged.length) continue
        upsertScopedServers(agentMcpServers, agentName, merged)
        if (contextRef) {
          upsertScopedServers(contextMcpServers, contextRef, merged)
        }
      }
    }
    const filterAgentDetails = (
      agents?: Array<{
        name: string
        displayName?: string | null
        contextRef?: string | null
        provider?: string | null
        model?: { provider?: string | null } | null
        mcpServers?: Array<{ name: string }>
      }>
    ) =>
      Array.isArray(agents)
        ? agents.filter(agent => activeAgentNameSet.has(String(agent?.name || '').trim()))
        : []

    collectAgents(filterAgentDetails(userAgents.agents))
    collectAgents(filterAgentDetails(teamAgents.agents))
    for (const agentName of agentNames) {
      if (!Object.prototype.hasOwnProperty.call(agentContextByName, agentName)) {
        agentContextByName[agentName] = null
      }
      if (!Object.prototype.hasOwnProperty.call(agentProviderByName, agentName)) {
        agentProviderByName[agentName] = null
      }
      // Producer-side `|| name` guard (the only one — see Decision #6): an agent
      // whose wire entry carried no `displayName` (pre-display API build) falls
      // back to its identifier here so consumers never render an empty label.
      if (!Object.prototype.hasOwnProperty.call(agentDisplayByName, agentName)) {
        agentDisplayByName[agentName] = agentName
      }
    }

    const hasAgentScopedMcp = Object.keys(agentMcpServers).length > 0
    const hasContextScopedMcp = Object.keys(contextMcpServers).length > 0

    this.accessCatalog = {
      userId: me.id,
      teamId: currentTeamId || null,
      userContextIds,
      userAgentNames,
      teamContextIds,
      teamAgentNames,
      contextIds,
      agentNames,
      mcpServersByAgent,
      ...(hasAgentScopedMcp ? { agentMcpServers } : {}),
      ...(hasContextScopedMcp ? { contextMcpServers } : {}),
      agentContextByName,
      agentProviderByName,
      agentDisplayByName,
    }
    return this.accessCatalog
  }

  async listAccessibleMcpServers(hostRefs?: string[]): Promise<RpcAllowedServersResult> {
    const token = this.requireSessionToken()
    const effectiveHostRefs = AppService.dedupe(Array.isArray(hostRefs) ? hostRefs : [])
    if (!effectiveHostRefs.length) {
      const me = this.me ?? (await this.authClient.getMe(token))
      this.me = me
      return { userId: me.id, contextIds: [], servers: [] }
    }
    const rpc = await this.issueRpcTokenForHostRefs(MCP_SERVERS_LIST_SCOPES, effectiveHostRefs)
    try {
      return await this.rpcClient.listServers(rpc.token)
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.issueRpcTokenForHostRefs(
          MCP_SERVERS_LIST_SCOPES,
          effectiveHostRefs
        )
        return this.rpcClient.listServers(retried.token)
      }
      throw error
    }
  }

  async getAccessCatalog(): Promise<AccessCatalog> {
    // Access grants are mutable from Control UI. Always read the current
    // external catalog so the desktop never serves removed agents/contexts from
    // the main-process cache.
    return this.refreshAccessCatalog()
  }

  async invokeHostMessage(
    hostRef: string,
    request: HostMessageRequest,
    hostRefs?: string[],
    options?: { async?: boolean }
  ): Promise<HostMessageResponse> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef) {
      throw new Error('hostRef is required')
    }
    // A malformed request is rejected before any token is issued for it.
    if (request.attachments != null && !Array.isArray(request.attachments)) {
      throw new Error('Attachments must be a list.')
    }
    if (request.fileReferences !== undefined && !Array.isArray(request.fileReferences)) {
      throw new Error('File references must be a list.')
    }
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(
      HOST_WAKEABLE_OPERATION_SCOPES,
      effectiveHostRefs
    )
    const outgoingAttachmentCount = Array.isArray(request.attachments)
      ? request.attachments.length
      : 0
    if (outgoingAttachmentCount > 0) {
      desktopRuntimeLog.info(
        `[AppService] invokeHostMessage host=${targetHostRef} attachments=${outgoingAttachmentCount}`
      )
    }
    const contextualRequest: HostMessageRequest = {
      content: request.content,
      channelType: 'rpc',
      channelId: targetHostRef,
      hostRef: targetHostRef,
      sender: this.me?.id,
      metadata: this.me?.teamId ? { teamId: this.me.teamId } : {},
      threadId: typeof request.threadId === 'string' ? request.threadId : undefined,
      attachments: Array.isArray(request.attachments) ? request.attachments : undefined,
      // Forward the optional piggybacked per-session model (R2 "Option A"). This
      // build is a field allow-list, so an unlisted field would be dropped —
      // thread `model` through explicitly. NOTE: rpc-proxy ALSO rebuilds the body
      // as its own allow-list (routes/rpc.ts `forwardedBody`), so `model` must be
      // forwarded there too — it does not pass the body through unchanged.
      ...(typeof request.model === 'string' && request.model ? { model: request.model } : {}),
      ...(request.modelSelectionRevision === undefined
        ? {}
        : { modelSelectionRevision: request.modelSelectionRevision }),
      // Structured references (#666): parsed at the IPC boundary; rpc-proxy
      // forwards them and mcp-host resolves each one.
      ...(request.fileReferences === undefined ? {} : { fileReferences: request.fileReferences }),
    }
    try {
      return await this.rpcClient.invokeHostMessage(
        rpc.token,
        targetHostRef,
        contextualRequest,
        options
      )
    } catch (error) {
      const availabilityError = AppService.toHostAvailabilityError(targetHostRef, error)
      if (availabilityError) throw availabilityError
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.issueRpcTokenForHostRefs(
          HOST_WAKEABLE_OPERATION_SCOPES,
          effectiveHostRefs
        )
        try {
          return await this.rpcClient.invokeHostMessage(
            retried.token,
            targetHostRef,
            contextualRequest,
            options
          )
        } catch (retryError) {
          const retryAvailabilityError = AppService.toHostAvailabilityError(
            targetHostRef,
            retryError
          )
          if (retryAvailabilityError) throw retryAvailabilityError
          throw retryError
        }
      }
      throw error
    }
  }

  async getTaskResult(
    hostRef: string,
    taskId: string,
    hostRefs?: string[]
  ): Promise<HostMessageResponse> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef) {
      throw new Error('hostRef is required')
    }
    const targetTaskId = String(taskId || '').trim()
    if (!targetTaskId) {
      throw new Error('taskId is required')
    }
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(
      HOST_WAKEABLE_OPERATION_SCOPES,
      effectiveHostRefs
    )
    try {
      return await this.rpcClient.getTaskResult(rpc.token, targetHostRef, targetTaskId)
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.issueRpcTokenForHostRefs(
          HOST_WAKEABLE_OPERATION_SCOPES,
          effectiveHostRefs
        )
        return this.rpcClient.getTaskResult(retried.token, targetHostRef, targetTaskId)
      }
      throw error
    }
  }

  async getHostStatus(hostRef: string, hostRefs?: string[]): Promise<HostRuntimeStatus> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef) {
      throw new Error('hostRef is required')
    }
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(HOST_STATUS_SCOPES, effectiveHostRefs)
    try {
      return await this.rpcClient.getHostStatus(rpc.token, targetHostRef)
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.issueRpcTokenForHostRefs(HOST_STATUS_SCOPES, effectiveHostRefs)
        return this.rpcClient.getHostStatus(retried.token, targetHostRef)
      }
      throw error
    }
  }

  /**
   * Fire-and-forget pre-warm of a (possibly suspended) stateless host.
   *
   * POSTs the rpc-proxy wake route with the same RPC token the app already
   * uses for messages so the pod is Ready by the time the user types. Every
   * response on the wake contract is terminal (200 active / 202
   * wake-requested / 409 not-stateless) — no polling. A 202 means HCC has NOT
   * acted yet and its raw watch can lose the single projected event, so a
   * bounded background re-emission ({@link runPrewarmReemissionLoop}) re-POSTs
   * while 202 persists — up to PREWARM_REEMIT_MAX_ATTEMPTS times, then gives
   * up to the reactive message path. Failures are
   * warn-logged here (hostRef + reason, never the token) and returned as a
   * structured result instead of thrown, so the renderer's login/catalog path
   * can never be blocked or broken by prewarm.
   *
   * MUST only be invoked from authenticated access-catalog paths — never from
   * the host status stream lifecycle, whose ~300s token-TTL reconnects would
   * resurrect a suspended host forever.
   */
  async prewarmHost(hostRef: string, hostRefs?: string[]): Promise<PrewarmHostResult> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef) {
      throw new Error('hostRef is required')
    }
    if (this.prewarmAuthTransitionCount > 0) {
      return { requested: false, skipped: 'auth-changed' }
    }
    const authEpoch = this.prewarmAuthEpoch
    const now = Date.now()
    const lastAttemptAt = this.prewarmAttemptAtByHostRef.get(targetHostRef)
    if (lastAttemptAt !== undefined && now - lastAttemptAt < PREWARM_COOLDOWN_MS) {
      return { requested: false, skipped: 'cooldown' }
    }
    if (this.prewarmReemitLoopHostRefs.has(targetHostRef)) {
      // Structural backstop behind the cooldown gate: even if this host's
      // cooldown entry was evicted from the bounded map, never run two
      // re-emission loops for the same host at once.
      return { requested: false, skipped: 'in-flight' }
    }
    this.prewarmAttemptAtByHostRef.delete(targetHostRef)
    if (this.prewarmAttemptAtByHostRef.size >= PREWARM_COOLDOWN_MAX_HOSTS) {
      const oldestHostRef = this.prewarmAttemptAtByHostRef.keys().next().value
      if (oldestHostRef !== undefined) {
        this.prewarmAttemptAtByHostRef.delete(oldestHostRef)
      }
    }
    this.prewarmAttemptAtByHostRef.set(targetHostRef, now)
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    try {
      this.captureSessionRequestContextForOperation()
      const rpc = await this.issueRpcTokenForHostRefs(
        HOST_WAKEABLE_OPERATION_SCOPES,
        effectiveHostRefs
      )
      if (this.prewarmAuthEpoch !== authEpoch || this.prewarmAuthTransitionCount > 0) {
        return { requested: false, skipped: 'auth-changed' }
      }
      const result = await this.rpcClient.prewarmHost(rpc.token, targetHostRef)
      if (
        result.status === 'wake-requested' &&
        this.prewarmAuthEpoch === authEpoch &&
        this.prewarmAuthTransitionCount === 0
      ) {
        // HCC has not acted yet and its watch may have lost the event. Run
        // the bounded background re-emission tied to THIS catalog-driven
        // invocation — the renderer never awaits it, and the cooldown gate
        // (checked above, not refreshed by re-emits) keeps it single-flight.
        this.prewarmReemitLoopHostRefs.add(targetHostRef)
        const controller = new AbortController()
        this.prewarmReemitAbortControllers.set(targetHostRef, controller)
        void this.runPrewarmReemissionLoop(targetHostRef, rpc.token, authEpoch, controller.signal)
      }
      return { requested: true, status: result.status }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A generation change is expected when logout or account replacement wins
      // while this best-effort request is waiting for its team-scoped token.
      // Report cancellation as such; it is not a host prewarm failure.
      if (
        message === 'stale_session_generation' ||
        this.prewarmAuthEpoch !== authEpoch ||
        this.prewarmAuthTransitionCount > 0
      ) {
        return { requested: false, skipped: 'auth-changed' }
      }
      desktopRuntimeLog.warn(`[AppService] prewarmHost failed host=${targetHostRef}`, error)
      return { requested: false, error: message }
    }
  }

  /** Injectable so tests stay deterministic; fake timers advance it. */
  private prewarmReemitDelay = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise(resolve => {
      if (signal?.aborted) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }, ms)
      const abort = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      signal?.addEventListener('abort', abort, { once: true })
    })

  /**
   * Bounded background wake re-emission (see PREWARM_REEMIT_* constants).
   * Re-POSTs the wake while the route keeps answering 202 wake-requested;
   * stops immediately on 200 active (HCC acted), on any other status, on any
   * error, or after the bounded attempts — then the reactive message path is
   * the backstop. Runs at most once per hostRef (prewarmReemitLoopHostRefs)
   * and never touches the cooldown map, so re-emits cannot extend or refresh
   * the cooldown window. Deliberately NOT reachable from the host status
   * stream lifecycle — the anti-flap invariant is unchanged.
   */
  private async runPrewarmReemissionLoop(
    hostRef: string,
    rpcToken: string,
    authEpoch: number,
    signal: AbortSignal
  ): Promise<void> {
    try {
      for (let attempt = 1; attempt <= PREWARM_REEMIT_MAX_ATTEMPTS; attempt++) {
        await this.prewarmReemitDelay(PREWARM_REEMIT_INTERVAL_MS, signal)
        if (signal.aborted || this.prewarmAuthEpoch !== authEpoch) return
        const result = await this.rpcClient.prewarmHost(rpcToken, hostRef)
        desktopRuntimeLog.info(
          `[AppService] prewarmHost re-emit host=${hostRef} attempt=${attempt} status=${result.status}`
        )
        if (result.status !== 'wake-requested') {
          return
        }
      }
      desktopRuntimeLog.warn(
        `[AppService] prewarmHost re-emission gave up host=${hostRef} after ${PREWARM_REEMIT_MAX_ATTEMPTS} re-emits: wake still unacknowledged; the reactive message path will cover the user's message`
      )
    } catch (error) {
      desktopRuntimeLog.warn(`[AppService] prewarmHost re-emit failed host=${hostRef}`, error)
    } finally {
      if (this.prewarmReemitAbortControllers.get(hostRef)?.signal === signal) {
        this.prewarmReemitLoopHostRefs.delete(hostRef)
        this.prewarmReemitAbortControllers.delete(hostRef)
      }
    }
  }

  async getHostActivity(
    hostRef: string,
    options?: { limit?: number; sinceEventId?: string; hostRefs?: string[] }
  ): Promise<HostActivitySnapshot> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef) {
      throw new Error('hostRef is required')
    }
    const effectiveHostRefs =
      options?.hostRefs && options.hostRefs.length > 0 ? options.hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(HOST_ACTIVITY_SCOPES, effectiveHostRefs)
    try {
      return await this.rpcClient.getHostActivity(rpc.token, targetHostRef, {
        limit: options?.limit,
        sinceEventId: options?.sinceEventId,
      })
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.issueRpcTokenForHostRefs(HOST_ACTIVITY_SCOPES, effectiveHostRefs)
        return this.rpcClient.getHostActivity(retried.token, targetHostRef, {
          limit: options?.limit,
          sinceEventId: options?.sinceEventId,
        })
      }
      throw error
    }
  }

  startHostStatusStream(
    streamId: string,
    ownerId: number,
    hostRef: string,
    hostRefs: string[] | undefined,
    onEvent: (event: HostStatusStreamEvent) => void
  ): void {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef) {
      throw new Error('hostRef is required')
    }
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    this.requireSessionToken()
    let streamRequestContext = getSessionRequestContext()

    let closed = false
    let abortController: AbortController | null = null
    let retryTimer: NodeJS.Timeout | null = null
    let backoffMs = 1000

    const clearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    }

    const stop = (opts?: { silent?: boolean }) => {
      if (closed) return
      closed = true
      clearRetry()
      if (abortController) {
        abortController.abort()
      }
      this.hostStatusStreams.delete(streamId)
      // `silent`: bulk teardown skips the final `closed` (see `stopAllStreams`).
      if (!opts?.silent) onEvent({ type: 'closed' })
    }

    const connect = async () => {
      if (closed) return
      abortController = new AbortController()
      try {
        const rpc = await this.issueRpcTokenForHostRefs(HOST_STATUS_SCOPES, effectiveHostRefs)
        streamRequestContext = getSessionRequestContext() ?? streamRequestContext
        await this.rpcClient.openHostStatusStream(
          rpc.token,
          targetHostRef,
          ({ event, data }) => {
            if (closed) return
            if (event === 'open') {
              backoffMs = 1000
              const payload = data as { hostRef?: string; observedAt?: string }
              onEvent({
                type: 'open',
                hostRef: String(payload?.hostRef || targetHostRef),
                observedAt: String(payload?.observedAt || new Date().toISOString()),
              })
              return
            }
            if (event === 'status') {
              backoffMs = 1000
              const payload = data as HostRuntimeStatus
              onEvent({ type: 'status', status: payload })
              return
            }
            if (event === 'auth-expired') {
              // Upstream rejected the captured RPC token (TTL is 300s; this
              // is normal on long-lived sessions). Drop the cached token so
              // the upcoming retry calls authClient.issueRpcToken with the
              // long-lived session and gets a fresh one — no relogin needed.
              this.clearRpcTokenCacheForRequestContext(streamRequestContext)
              const payload = data as { message?: string }
              onEvent({
                type: 'error',
                message: String(payload?.message || 'RPC token expired; reconnecting'),
              })
              return
            }
            const payload = data as { message?: string }
            onEvent({
              type: 'error',
              message: String(payload?.message || 'Status stream event error'),
            })
          },
          abortController.signal
        )
        if (!closed) {
          onEvent({ type: 'error', message: 'Status stream disconnected' })
        }
      } catch (error) {
        if (closed) return
        if (error instanceof ApiError && error.status === 401) {
          this.clearRpcTokenCacheForRequestContext(streamRequestContext)
        }
        onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally {
        if (closed) return
        clearRetry()
        retryTimer = setTimeout(() => {
          backoffMs = Math.min(backoffMs * 2, 15000)
          void connect()
        }, backoffMs)
      }
    }

    this.hostStatusStreams.set(streamId, { ownerId, stop })
    void connect()
  }

  stopHostStatusStream(streamId: string, requesterOwnerId?: number): boolean {
    const entry = this.hostStatusStreams.get(streamId)
    if (!entry) return true
    if (requesterOwnerId !== undefined && entry.ownerId !== requesterOwnerId) {
      return false
    }
    entry.stop()
    return true
  }

  stopHostStatusStreamsForOwner(ownerId: number): void {
    const toStop: string[] = []
    for (const [streamId, entry] of this.hostStatusStreams.entries()) {
      if (entry.ownerId === ownerId) toStop.push(streamId)
    }
    for (const streamId of toStop) {
      this.stopHostStatusStream(streamId)
    }
  }

  startHostActivityStream(
    streamId: string,
    ownerId: number,
    hostRef: string,
    hostRefs: string[] | undefined,
    onEvent: (event: HostActivityStreamEvent) => void
  ): void {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef) {
      throw new Error('hostRef is required')
    }
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    this.requireSessionToken()
    let streamRequestContext = getSessionRequestContext()

    let closed = false
    let abortController: AbortController | null = null
    let retryTimer: NodeJS.Timeout | null = null
    let backoffMs = 1000

    const clearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    }

    const stop = (opts?: { silent?: boolean }) => {
      if (closed) return
      closed = true
      clearRetry()
      if (abortController) abortController.abort()
      this.hostActivityStreams.delete(streamId)
      // `silent`: bulk teardown skips the final `closed` (see `stopAllStreams`).
      if (!opts?.silent) onEvent({ type: 'closed' })
    }

    const connect = async () => {
      if (closed) return
      abortController = new AbortController()
      try {
        const rpc = await this.issueRpcTokenForHostRefs(HOST_ACTIVITY_SCOPES, effectiveHostRefs)
        streamRequestContext = getSessionRequestContext() ?? streamRequestContext
        await this.rpcClient.openHostActivityStream(
          rpc.token,
          targetHostRef,
          ({ event, data }) => {
            if (closed) return
            if (event === 'open') {
              backoffMs = 1000
              const payload = data as { hostRef?: string; observedAt?: string }
              onEvent({
                type: 'open',
                hostRef: String(payload?.hostRef || targetHostRef),
                observedAt: String(payload?.observedAt || new Date().toISOString()),
              })
              return
            }
            if (event === 'activity') {
              backoffMs = 1000
              onEvent({ type: 'activity', activity: data as HostActivitySnapshot['items'][number] })
              return
            }
            if (event === 'auth-expired') {
              // §4.5-5 / GAP-D2: parity with the status stream (:1374). Upstream
              // rejected the captured RPC token (TTL 300s) as an SSE event rather
              // than a transport 401 — clear the cached token so the retry re-mints
              // a fresh one, then surface an error to drive the reconnect. Without
              // this the retry re-used the still-"valid" (client-side) dead token.
              // The token is never forwarded to the renderer.
              this.clearRpcTokenCacheForRequestContext(streamRequestContext)
              const payload = data as { message?: string }
              onEvent({
                type: 'error',
                message: String(payload?.message || 'RPC token expired; reconnecting'),
              })
              return
            }
            const payload = data as { message?: string }
            onEvent({
              type: 'error',
              message: String(payload?.message || 'Activity stream event error'),
            })
          },
          abortController.signal
        )
        if (!closed) onEvent({ type: 'error', message: 'Activity stream disconnected' })
      } catch (error) {
        if (closed) return
        if (error instanceof ApiError && error.status === 401) {
          this.clearRpcTokenCacheForRequestContext(streamRequestContext)
        }
        onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally {
        if (closed) return
        clearRetry()
        retryTimer = setTimeout(() => {
          backoffMs = Math.min(backoffMs * 2, 15000)
          void connect()
        }, backoffMs)
      }
    }

    this.hostActivityStreams.set(streamId, { ownerId, stop })
    void connect()
  }

  stopHostActivityStream(streamId: string, requesterOwnerId?: number): boolean {
    const entry = this.hostActivityStreams.get(streamId)
    if (!entry) return true
    if (requesterOwnerId !== undefined && entry.ownerId !== requesterOwnerId) {
      return false
    }
    entry.stop()
    return true
  }

  stopHostActivityStreamsForOwner(ownerId: number): void {
    const toStop: string[] = []
    for (const [streamId, entry] of this.hostActivityStreams.entries()) {
      if (entry.ownerId === ownerId) toStop.push(streamId)
    }
    for (const streamId of toStop) {
      this.stopHostActivityStream(streamId)
    }
  }

  startTaskProgressStream(
    streamId: string,
    ownerId: number,
    hostRef: string,
    taskId: string,
    hostRefs: string[] | undefined,
    onEvent: (event: TaskProgressStreamEvent) => void
  ): void {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef) {
      throw new Error('hostRef is required')
    }
    const targetTaskId = String(taskId || '').trim()
    if (!targetTaskId) {
      throw new Error('taskId is required')
    }
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    this.requireSessionToken()
    let streamRequestContext = getSessionRequestContext()

    let closed = false
    // Reassigned per reconnect attempt; `stop()` aborts whichever attempt is live.
    let abortController = new AbortController()
    let streamOpened = false
    // De-collapse (§4.5-1): `waiting` and `open` are now distinct renderer events.
    // Each is emitted at most once per subscription (dedup across bridge-internal
    // reconnects — the tracker is already following this streamId).
    let waitingEmitted = false

    const stop = (opts?: { silent?: boolean }) => {
      if (closed) return
      closed = true
      abortController.abort()
      this.progressStreams.delete(streamId)
      // `silent`: bulk teardown on logout/team-switch aborts the socket WITHOUT a
      // fabricated `closed`, which would otherwise fire a spurious stream-loss
      // terminal against a live tracker before the renderer's own release runs
      // (R-F13). The abort alone stops any reconnect/token re-mint. See
      // `stopAllStreams`.
      if (!opts?.silent) onEvent({ type: 'closed' })
    }

    this.progressStreams.set(streamId, { ownerId, stop })

    void (async () => {
      // stream-recovery (A): a dropped transport is not a task failure — the task
      // is durable server-side. Reconnect a bounded number of times before
      // surfacing an error; mcp-host replays the buffered terminal to a late
      // subscriber, so a blip recovers transparently. Only after exhausting the
      // attempts do we emit `error` (→ the renderer reconciles, B).
      let attempt = 0
      let giveUp = false // non-retryable: task_not_found_or_expired, 401, or a
      let forwardedError = false // structured task error already sent to the renderer.
      // §4.5-2: the reason surfaced to the renderer as a structured `gone` event
      // when the bridge gives up without a clean terminal.
      let goneReason = 'reconnect_exhausted'
      let attemptTimer: ReturnType<typeof setTimeout> | null = null
      let waitingForOpenTimer: ReturnType<typeof setTimeout> | null = null
      const clearAttemptTimeout = () => {
        if (attemptTimer) {
          clearTimeout(attemptTimer)
          attemptTimer = null
        }
      }
      const clearWaitingForOpenTimeout = () => {
        if (waitingForOpenTimer) {
          clearTimeout(waitingForOpenTimer)
          waitingForOpenTimer = null
        }
      }
      const clearTimers = () => {
        clearAttemptTimeout()
        clearWaitingForOpenTimeout()
      }

      const handleEvent = ({ event, data }: { event: string; data: unknown }) => {
        if (closed) return
        // F3: `waiting` proves the HTTP connection is ESTABLISHED — we received
        // bytes from the server. It does NOT prove the task is streaming: mcp-host
        // sends `waiting`, then blocks in waitFor(reporter, 180s) before `open`,
        // with no keepalive in between. So on `waiting` we clear the 8s
        // establishment bound and arm a longer "waiting-for-open" bound matching the
        // server's reporter-wait budget (+ margin); a >8s pre-`open` stall no longer
        // aborts a live task. §4.5-1: forward `waiting` as its OWN renderer event
        // (no longer collapsed to `open`) so the renderer distinguishes a queued
        // task from a live reporter and does NOT reset its re-rejoin budget on it.
        // `waiting` deliberately does NOT reset the bridge's reconnect budget either.
        if (event === 'waiting') {
          clearAttemptTimeout()
          if (!waitingForOpenTimer) {
            waitingForOpenTimer = setTimeout(
              () => abortController.abort(),
              RECONNECT_WAITING_FOR_OPEN_TIMEOUT_MS
            )
          }
          if (!waitingEmitted) {
            waitingEmitted = true
            const payload = data as { taskId?: string; hostRef?: string } | undefined
            onEvent({
              type: 'waiting',
              taskId: String(payload?.taskId || targetTaskId),
              hostRef: String(payload?.hostRef || targetHostRef),
            })
          }
          return
        }
        // Any non-`waiting` event: the connection is producing genuine traffic —
        // clear BOTH timers.
        clearTimers()
        // §4.5-5 / GAP-D2: upstream rejected the captured RPC token mid-stream (TTL
        // is 300s — normal on long-lived sessions). Drop the cached token so the
        // next reconnect attempt re-mints a fresh one, then let the current attempt
        // end and reconnect. Parity with the status stream (:1374); without this the
        // reconnect re-used the still-"valid" (client-side) dead token and looped
        // until the budget exhausted. The token never crosses to the renderer.
        if (event === 'auth-expired') {
          this.clearRpcTokenCacheForRequestContext(streamRequestContext)
          return
        }
        // §4.5-1: a real reporter-live `open` (the mcp-host waiting→open handshake
        // completed). Emitted distinctly from `waiting`; `streamOpened` dedups it
        // across bridge-internal reconnects. Does NOT reset the reconnect budget (a
        // flapping open must still exhaust MAX_RECONNECT_ATTEMPTS).
        if (event === 'open') {
          if (streamOpened) return
          streamOpened = true
          const payload = data as { taskId?: string; hostRef?: string } | undefined
          onEvent({
            type: 'open',
            taskId: String(payload?.taskId || targetTaskId),
            hostRef: String(payload?.hostRef || targetHostRef),
          })
          return
        }
        // F4: genuine POST-open traffic (a heartbeat or task progress) proves this
        // connection is alive and streaming, so reset the reconnect budget. A
        // long-lived stream that already absorbed a couple of transient drops then
        // gets a full retry allowance for a later blip; `attempt` is otherwise only
        // ever incremented.
        attempt = 0
        if (event === 'done') {
          const payload = data as { taskId?: string } | undefined
          onEvent({
            type: 'terminal',
            data: { taskId: String(payload?.taskId || targetTaskId), status: 'completed' },
          })
          this.stopTaskProgressStream(streamId)
          return
        }
        if (event === 'terminal') {
          // Phase D unified terminal event — forward and close the stream
          // (BUG-14: was silently dropped by KNOWN_PROGRESS_EVENTS allowlist)
          onEvent({ type: 'terminal', data } as TaskProgressStreamEvent)
          this.stopTaskProgressStream(streamId)
          return
        }
        if (event === 'error' || event === 'closed') {
          const payload = data as
            | {
                taskId?: string
                code?: string
                message?: string
                retryable?: boolean
                provider?: string
              }
            | undefined
          // Structured task error (has `code`) — a real failure, not a transport
          // blip. Forward it as-is and stop retrying.
          if (
            event === 'error' &&
            payload &&
            typeof payload.code === 'string' &&
            typeof payload.message === 'string'
          ) {
            onEvent({
              type: 'error',
              message: payload.message,
              data: {
                taskId: String(payload.taskId || targetTaskId),
                code: payload.code,
                message: payload.message,
                retryable: Boolean(payload.retryable),
                provider: String(payload.provider || 'unknown'),
              },
            })
            forwardedError = true
            giveUp = true
            return
          }
          // task_not_found_or_expired → the reporter+result are gone; reconnect
          // can't help. Give up so the renderer reconciles against /messages (B).
          if (String(payload?.message || '').includes('task_not_found_or_expired')) {
            giveUp = true
            goneReason = 'task_not_found_or_expired'
            return
          }
          // Other transport-level error/closed: do NOT forward mid-retry — let the
          // attempt end so the loop reconnects.
          return
        }
        // Forward only known progress event types (incl. heartbeat keepalives)
        if (KNOWN_PROGRESS_EVENTS.has(event)) {
          onEvent({ type: event, data } as TaskProgressStreamEvent)
        }
        // Silently ignore unrecognized event types
      }

      try {
        while (!closed && !giveUp) {
          abortController = new AbortController()
          // F3: this 8s bound guards CONNECTION ESTABLISHMENT only (open request →
          // first server bytes). It's cleared on `waiting` (connection established),
          // which then arms the longer waiting-for-open bound. A server that never
          // sends `waiting` within 8s still aborts and retries as before.
          attemptTimer = setTimeout(() => abortController.abort(), RECONNECT_ATTEMPT_TIMEOUT_MS)
          try {
            const rpc = await this.issueRpcTokenForHostRefs(HOST_ACTIVITY_SCOPES, effectiveHostRefs)
            streamRequestContext = getSessionRequestContext() ?? streamRequestContext
            await this.rpcClient.openTaskProgressStream(
              rpc.token,
              targetHostRef,
              targetTaskId,
              handleEvent,
              abortController.signal
            )
          } catch (error) {
            // F4: a 401 on token re-issue (the 300s RPC token expired mid-stream)
            // clears the cache so the NEXT attempt re-mints a fresh token, then
            // falls through to retry. A single transient 401 must NOT collapse a
            // live stream — only a persistent 401 (genuinely revoked session) still
            // terminates, bounded by MAX_RECONNECT_ATTEMPTS below. The structured
            // task-error path above keeps its own `giveUp` for truly non-retryable
            // failures.
            if (error instanceof ApiError && error.status === 401) {
              this.clearRpcTokenCacheForRequestContext(streamRequestContext)
            }
            // Otherwise transient (network/abort) — fall through to retry.
          } finally {
            clearTimers()
          }
          if (closed || giveUp) break
          attempt += 1
          if (attempt >= MAX_RECONNECT_ATTEMPTS) break
          const delayMs = Math.min(
            RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
            RECONNECT_MAX_DELAY_MS
          )
          await new Promise(resolve => setTimeout(resolve, delayMs))
        }
        // Exhausted/gave up without a clean terminal → surface the loss as a
        // structured `gone` (§4.5-2), NOT the generic `error`. The renderer's
        // tracker turns this into a definitive stream-loss terminal and reconciles
        // against the server (re-attach if non-idle, else settle) rather than
        // re-attaching blindly.
        if (!closed && !forwardedError) {
          onEvent({ type: 'gone', reason: goneReason })
        }
      } finally {
        if (!closed) stop()
      }
    })()
  }

  stopTaskProgressStream(streamId: string, requesterOwnerId?: number): boolean {
    const entry = this.progressStreams.get(streamId)
    if (!entry) return true
    if (requesterOwnerId !== undefined && entry.ownerId !== requesterOwnerId) {
      return false
    }
    entry.stop()
    return true
  }

  stopTaskProgressStreamsForOwner(ownerId: number): void {
    const toStop: string[] = []
    for (const [streamId, entry] of this.progressStreams.entries()) {
      if (entry.ownerId === ownerId) toStop.push(streamId)
    }
    for (const streamId of toStop) {
      this.stopTaskProgressStream(streamId)
    }
  }

  async approveToolCall(
    hostRef: string,
    taskId: string,
    toolCallId: string,
    hostRefs?: string[],
    options: { teamId?: string | null } = {}
  ): Promise<ApprovalDecisionResult> {
    const targetHostRef = String(hostRef || '').trim()
    const targetTaskId = String(taskId || '').trim()
    const targetToolCallId = String(toolCallId || '').trim()
    if (!targetHostRef || !targetTaskId || !targetToolCallId) {
      throw new Error('hostRef, taskId, and toolCallId are required')
    }
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(
      HOST_APPROVAL_SCOPES,
      effectiveHostRefs,
      options
    )
    try {
      return await this.rpcClient.approveToolCall(
        rpc.token,
        targetHostRef,
        targetTaskId,
        targetToolCallId
      )
    } catch (error) {
      // §4.5-7: align with invoke/getTaskResult — a 401/expired-scope means the
      // 300s RPC token lapsed; clear the cache, re-mint (same `options`/team so a
      // cross-team decision still acquires the right team's token) and retry once.
      // Retry-safety (verified): `shouldRefreshRpcToken` fires ONLY on 401 or
      // 403-"missing scope". Every 401/403 reachable on this route is emitted
      // BEFORE the approval mutation runs — by rpc-proxy's auth middleware
      // (`requireRpcAuth`/`requireScope`, rpc-proxy/src/middleware/auth.ts:18-48,
      // ahead of the forward at rpc-proxy/src/routes/rpc.ts:215-250) AND by
      // mcp-host's pre-dispatch checks (`runtimeEdgeGuard`
      // mcp-host/src/server/edgeRuntimeAuth.ts:78-97 + the guards in
      // `handleApprovalRoute` mcp-host/src/server/routes.ts:401, all before
      // `approvalHandler` at :443). The only POST-mutation responses are 200 or
      // 500, neither of which triggers a refresh-retry — so a retried error is
      // always a pre-mutation rejection and the approval is never double-applied.
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.issueRpcTokenForHostRefs(
          HOST_APPROVAL_SCOPES,
          effectiveHostRefs,
          options
        )
        return this.rpcClient.approveToolCall(
          retried.token,
          targetHostRef,
          targetTaskId,
          targetToolCallId
        )
      }
      throw error
    }
  }

  async cancelTask(hostRef: string, taskId: string): Promise<void> {
    const targetHostRef = String(hostRef || '').trim()
    const targetTaskId = String(taskId || '').trim()
    if (!targetHostRef) throw new Error('hostRef is required')
    if (!targetTaskId) throw new Error('taskId is required')
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(HOST_WAKEABLE_OPERATION_SCOPES, [targetHostRef])
    try {
      await this.rpcClient.cancelTask(rpc.token, targetHostRef, targetTaskId)
    } catch (error) {
      // §4.5-7: retry once after a token refresh (previously a 401 here failed
      // outright, unlike invoke/getTaskResult).
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.issueRpcTokenForHostRefs(HOST_WAKEABLE_OPERATION_SCOPES, [
          targetHostRef,
        ])
        await this.rpcClient.cancelTask(retried.token, targetHostRef, targetTaskId)
        return
      }
      throw error
    }
  }

  async denyToolCall(
    hostRef: string,
    taskId: string,
    toolCallId: string,
    reason: string,
    hostRefs?: string[],
    options: { teamId?: string | null } = {}
  ): Promise<ApprovalDecisionResult> {
    const targetHostRef = String(hostRef || '').trim()
    const targetTaskId = String(taskId || '').trim()
    const targetToolCallId = String(toolCallId || '').trim()
    if (!targetHostRef || !targetTaskId || !targetToolCallId) {
      throw new Error('hostRef, taskId, and toolCallId are required')
    }
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(
      HOST_APPROVAL_SCOPES,
      effectiveHostRefs,
      options
    )
    try {
      return await this.rpcClient.denyToolCall(
        rpc.token,
        targetHostRef,
        targetTaskId,
        targetToolCallId,
        reason
      )
    } catch (error) {
      // §4.5-7: retry once after a token refresh, preserving `options`/team.
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.issueRpcTokenForHostRefs(
          HOST_APPROVAL_SCOPES,
          effectiveHostRefs,
          options
        )
        return this.rpcClient.denyToolCall(
          retried.token,
          targetHostRef,
          targetTaskId,
          targetToolCallId,
          reason
        )
      }
      throw error
    }
  }

  async listArtifacts(
    hostRef: string,
    hostRefs?: string[]
  ): Promise<{
    artifacts: Array<{ name: string; format: string; sizeBytes: number; createdAt: string }>
  }> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef) throw new Error('hostRef is required')
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(HOST_ARTIFACT_SCOPES, effectiveHostRefs)
    return this.rpcClient.listArtifacts(rpc.token, targetHostRef)
  }

  async downloadArtifact(hostRef: string, filename: string, hostRefs?: string[]): Promise<Buffer> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef || !filename) throw new Error('hostRef and filename are required')
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(HOST_ARTIFACT_SCOPES, effectiveHostRefs)
    return this.rpcClient.downloadArtifact(rpc.token, targetHostRef, filename)
  }

  async listSessions(
    hostRef: string,
    hostRefs?: string[],
    query: SessionsListQuery = {}
  ): Promise<SessionsListResult> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef) throw new Error('hostRef is required')
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(HOST_SESSION_SCOPES, effectiveHostRefs)
    try {
      return await this.rpcClient.listSessions(rpc.token, targetHostRef, query)
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.issueRpcTokenForHostRefs(HOST_SESSION_SCOPES, effectiveHostRefs)
        return this.rpcClient.listSessions(retried.token, targetHostRef, query)
      }
      throw error
    }
  }

  async loadSessionMessages(
    hostRef: string,
    agent: string,
    chatId: string,
    hostRefs?: string[],
    query: SessionMessagesQuery = {}
  ): Promise<SessionMessagesResult> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef || !agent || !chatId) {
      throw new Error('hostRef, agent, and chatId are required')
    }
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(HOST_SESSION_SCOPES, effectiveHostRefs)
    try {
      return await this.rpcClient.loadSessionMessages(
        rpc.token,
        targetHostRef,
        agent,
        chatId,
        query
      )
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.issueRpcTokenForHostRefs(HOST_SESSION_SCOPES, effectiveHostRefs)
        return this.rpcClient.loadSessionMessages(
          retried.token,
          targetHostRef,
          agent,
          chatId,
          query
        )
      }
      throw error
    }
  }

  /**
   * On-demand context-window breakdown for the active conversation. Mirrors
   * `loadSessionMessages` (same `host:session:read` scope, same token issuance
   * by hostRefs). Returns `{ breakdown: null }` when there is no snapshot — the
   * UI hides the chip in that case rather than treating it as an error.
   */
  async getContextBreakdown(
    hostRef: string,
    agent: string,
    chatId: string,
    hostRefs?: string[]
  ): Promise<ContextBreakdownResult> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef || !agent || !chatId) {
      throw new Error('hostRef, agent, and chatId are required')
    }
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(HOST_SESSION_SCOPES, effectiveHostRefs)
    try {
      return await this.rpcClient.getContextBreakdown(rpc.token, targetHostRef, agent, chatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('401') && message.toLowerCase().includes('missing token')) {
        desktopRuntimeLog.warn(
          '[AppService] Context breakdown unavailable because the runtime rejected the session token.'
        )
        return { breakdown: null }
      }
      throw error
    }
  }

  /**
   * Lists the models selectable for a host's active provider plus the current
   * per-session selection (R2). Uses the same `host:session:read` scope and
   * token issuance as {@link getContextBreakdown}. Returns `null` when the host
   * predates the endpoint (404/501) so the UI hides the selector (R2.6 compat).
   */
  async getHostModels(
    hostRef: string,
    chatId: string,
    hostRefs?: string[]
  ): Promise<HostModelsResult | null> {
    const targetHostRef = String(hostRef || '').trim()
    // `chatId` is OPTIONAL here: the model list is host-level (allowlist), and a
    // brand-new chat has no id yet. When absent, the server returns the list with
    // `sessionModel: null` (R2 new-chat composer selector). Only the host is
    // required to resolve the token/route.
    const targetChatId = String(chatId || '').trim()
    if (!targetHostRef) {
      throw new Error('hostRef is required')
    }
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(HOST_SESSION_SCOPES, effectiveHostRefs)
    try {
      return await this.rpcClient.getHostModels(rpc.token, targetHostRef, targetChatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('401') && message.toLowerCase().includes('missing token')) {
        desktopRuntimeLog.warn(
          '[AppService] Host models unavailable because the runtime rejected the session token.'
        )
        return null
      }
      throw error
    }
  }

  /**
   * Sets the per-session model for a host (R2.3). Applies to the next task only.
   * Issues a token carrying the dedicated `host:model:write` scope. A model
   * outside the allowlist throws with the `model_not_allowed` token in the
   * message, which the renderer detects to show a targeted error.
   */
  async setHostModel(
    hostRef: string,
    chatId: string,
    model: string,
    hostRefs?: string[],
    expectedRevision?: number
  ): Promise<SetHostModelResult> {
    const targetHostRef = String(hostRef || '').trim()
    const targetModel = String(model || '').trim()
    if (!targetHostRef || !chatId || !targetModel) {
      throw new Error('hostRef, chatId, and model are required')
    }
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(HOST_MODEL_SCOPES, effectiveHostRefs)
    return this.rpcClient.setHostModel(
      rpc.token,
      targetHostRef,
      chatId,
      targetModel,
      expectedRevision
    )
  }

  /**
   * Spec 15 Fase B — propagates an explicit user rename to the server. Mints a
   * token carrying the dedicated, NON-wake `host:session:write` scope (see
   * {@link HOST_SESSION_TITLE_SCOPES}). The raw title is never logged. Errors
   * (404 missing/foreign/channel, 400 invalid, 403 access) throw so the renderer
   * can drive the pending-rename queue (§2.5); a bounded refresh-retry mirrors
   * {@link getDesktopStatus} for the 401/403-missing-scope token-lapse case.
   */
  async renameSession(
    hostRef: string,
    agent: string,
    chatId: string,
    title: string
  ): Promise<{ title: string }> {
    const targetHostRef = String(hostRef || '').trim()
    const targetAgent = String(agent || '').trim()
    const targetChatId = String(chatId || '').trim()
    if (!targetHostRef || !targetAgent || !targetChatId) {
      throw new Error('hostRef, agent, and chatId are required')
    }
    // A rename always targets exactly one host, so the write-scope token is minted
    // for that single hostRef only — never a caller-supplied fleet list, which would
    // widen an intentionally narrow token. (Unlike setHostModel, which is multi-host.)
    const effectiveHostRefs = [targetHostRef]
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(HOST_SESSION_TITLE_SCOPES, effectiveHostRefs)
    try {
      return await this.rpcClient.renameSession(
        rpc.token,
        targetHostRef,
        targetAgent,
        targetChatId,
        title
      )
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.issueRpcTokenForHostRefs(
          HOST_SESSION_TITLE_SCOPES,
          effectiveHostRefs
        )
        return this.rpcClient.renameSession(
          retried.token,
          targetHostRef,
          targetAgent,
          targetChatId,
          title
        )
      }
      throw error
    }
  }

  getTokenMetadata(): TokenMetadata {
    const meta = this.rpcTokenManager.getMetadata()
    return {
      hasSession: Boolean(this.sessionToken),
      rpcTokenExpiresAtMs: meta.expiresAtMs,
      rpcScopes: meta.scopes,
      rpcHostRefs: meta.hostRefs,
    }
  }

  async getDesktopStatus(
    hostRef: string
  ): Promise<{ hostRef: string; status: string; message?: string }> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef) throw new Error('hostRef is required')
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(DESKTOP_VIEW_SCOPES, [targetHostRef])
    try {
      return await this.rpcClient.getDesktopStatus(rpc.token, targetHostRef)
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.issueRpcTokenForHostRefs(DESKTOP_VIEW_SCOPES, [targetHostRef])
        return this.rpcClient.getDesktopStatus(retried.token, targetHostRef)
      }
      throw error
    }
  }

  async openDesktop(
    hostRef: string,
    onWindowClosed?: (closedHostRef: string) => void
  ): Promise<void> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef) throw new Error('hostRef is required')
    this.captureSessionRequestContextForOperation()
    const rpc = await this.issueRpcTokenForHostRefs(DESKTOP_VIEW_SCOPES, [targetHostRef])
    const { closeAllDesktopWindows, openDesktopWindow } = await import('./desktopWindow.js')
    this.closeDesktopWindowsForSession = closeAllDesktopWindows
    this.assertCurrentSessionRequestContext()
    const requestOwnerContext = getSessionRequestContext()
    if (requestOwnerContext === undefined) throw new SessionRequestOwnershipError()
    await openDesktopWindow({
      hostRef: targetHostRef,
      jwt: rpc.token,
      rpcProxyUrl: this.getEffectiveRpcProxyBaseUrl(),
      requestOwnerContext,
      sessionRequestContextsMatchOwner: (left, right) =>
        this.sessionAuthority.sessionRequestContextsMatchOwner(left, right),
      assertRequestOwnerCurrent: () => this.assertCurrentSessionRequestContext(),
      onClose: onWindowClosed,
    })
  }

  async closeDesktop(hostRef: string): Promise<void> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef) throw new Error('hostRef is required')
    const { closeDesktopWindow } = await import('./desktopWindow.js')
    closeDesktopWindow(targetHostRef)
  }

  // ─── Sandbox UI ───────────────────────────────────────────────────

  /** Picker payload for the renderer's sandbox-ui app list. */
  async listSandboxUiApps(): Promise<{ apps: import('./rpcProxyClient.js').SandboxUiApp[] }> {
    const token = this.requireSessionToken()
    const rpc = await this.getRpcTokenForCurrentSession(token, SANDBOX_UI_VIEW_SCOPES, [
      SANDBOX_UI_HOST_REF_SENTINEL,
    ])
    try {
      return await this.rpcClient.listSandboxUiApps(rpc.token)
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.getRpcTokenForCurrentSession(token, SANDBOX_UI_VIEW_SCOPES, [
          SANDBOX_UI_HOST_REF_SENTINEL,
        ])
        return this.rpcClient.listSandboxUiApps(retried.token)
      }
      throw error
    }
  }

  /**
   * Mint a per-recipe UI session cookie. Returns the raw Set-Cookie value
   * so the WebContentsView driver can install it into the per-recipe
   * Electron partition.
   */
  async mintSandboxUiSession(recipeNs: string, recipeName: string): Promise<{ setCookie: string }> {
    const ns = String(recipeNs || '').trim()
    const name = String(recipeName || '').trim()
    if (!ns || !name) throw new Error('recipeNs and recipeName are required')
    const token = this.requireSessionToken()
    const rpc = await this.getRpcTokenForCurrentSession(token, SANDBOX_UI_VIEW_SCOPES, [
      SANDBOX_UI_HOST_REF_SENTINEL,
    ])
    try {
      return await this.rpcClient.mintSandboxUiSession(rpc.token, ns, name)
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.getRpcTokenForCurrentSession(token, SANDBOX_UI_VIEW_SCOPES, [
          SANDBOX_UI_HOST_REF_SENTINEL,
        ])
        return this.rpcClient.mintSandboxUiSession(retried.token, ns, name)
      }
      throw error
    }
  }

  /**
   * Embed clicked `clerum://oauth?clientId=…`. Fetch the provider authorize
   * URL via rpc-proxy and `shell.openExternal` it. The rest of the flow
   * runs in the OS browser; control-api's callback stores the grant and
   * bounces back to `clerum://oauth-completed`, which `main.ts` routes to
   * the active embed via `dispatchSandboxUiOauthCompleted`.
   *
   * When `background` is true (deep-link had `background=1`), a host-rendered
   * Electron confirm dialog is shown before opening the browser. If the user
   * cancels, the authorize flow is aborted.
   */
  async requestSandboxUiOauthAuthorize(
    recipeNs: string,
    recipeName: string,
    oauthClientId: string,
    background = false
  ): Promise<void> {
    const ns = String(recipeNs || '').trim()
    const name = String(recipeName || '').trim()
    const clientId = String(oauthClientId || '').trim()
    if (!ns || !name) throw new Error('recipeNs and recipeName are required')
    if (!clientId) throw new Error('oauthClientId is required')
    const sessionEpoch = this.sandboxUiSessionEpoch
    const token = this.requireSessionToken()
    const issueRpc = () =>
      this.getRpcTokenForCurrentSession(token, SANDBOX_UI_VIEW_SCOPES, [
        SANDBOX_UI_HOST_REF_SENTINEL,
      ])
    let rpc = await issueRpc()
    let result: { authorizeUrl: string }
    try {
      result = await this.rpcClient.requestSandboxUiOauthAuthorizeUrl(
        rpc.token,
        ns,
        name,
        clientId,
        background
      )
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        rpc = await issueRpc()
        result = await this.rpcClient.requestSandboxUiOauthAuthorizeUrl(
          rpc.token,
          ns,
          name,
          clientId,
          background
        )
      } else {
        throw error
      }
    }
    // The authorize URL binds the grant to the session that fetched it; never
    // hand it to the browser once that session is gone.
    this.assertSandboxUiSessionEpoch(sessionEpoch)
    if (background) {
      const { dialog, BrowserWindow } = await import('electron')
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      const opts = {
        type: 'question' as const,
        buttons: ['Cancel', 'Allow background access'],
        defaultId: 1,
        cancelId: 0,
        message: `Allow "${name}" to use your account in the background?`,
        detail:
          'The plugin will be able to act on your behalf even when you are not using it, until you disconnect it from Connected accounts.',
      }
      const result = win
        ? await dialog.showMessageBox(win, opts)
        : await dialog.showMessageBox(opts)
      if (result.response !== 1) return
      this.assertSandboxUiSessionEpoch(sessionEpoch)
    }
    await openExternalDataUrl(result.authorizeUrl, { requireHttps: true })
  }

  /**
   * U5 (mcp-oauth reactive consent) — the renderer's "Connect <server>" button.
   * A tool-call against an OAuth mcp-server suspended the task with
   * `connect_required`; this fetches a fresh provider authorize URL via rpc-proxy
   * and `shell.openExternal`s it. The rest of the flow runs in the OS browser;
   * control-api's callback stores the grant and bounces back to
   * `clerum://oauth-completed?…&source=mcp`, which `main.ts` routes to the
   * renderer to resume the suspended task (NOT the sandbox-ui embed).
   *
   * Analogous to `requestSandboxUiOauthAuthorize`, but keyed by `mcpServerName`
   * (never a recipe) and host-bound to the suspended conversation's `hostRef`
   * (RPC tokens require ≥1 hostRef; the user has access to the host they are
   * chatting in). `userId` is derived by rpc-proxy from `auth.sub`, never sent.
   */
  async requestMcpOauthAuthorize(
    mcpServerName: string,
    hostRef: string,
    contextId?: string,
    // Proactive panel (spec 11 U3/D-4): when the connector is `oauth-context`
    // ("shared by the team"), authorizing affects the WHOLE Context, so the
    // panel asks main to show an explicit confirm dialog first. The reactive
    // U5 path never sets this, so its behavior is byte-identical.
    options?: { confirmShared?: boolean }
  ): Promise<void> {
    const server = String(mcpServerName || '').trim()
    const targetHostRef = String(hostRef || '').trim()
    if (!server) throw new Error('mcpServerName is required')
    if (!targetHostRef) throw new Error('hostRef is required')
    const ctx = contextId ? String(contextId).trim() || undefined : undefined
    this.captureSessionRequestContextForOperation()
    if (options?.confirmShared) {
      const confirmed = await this.confirmSharedConnectorAction('connect', server)
      if (!confirmed) return
    }
    let rpc = await this.issueRpcTokenForHostRefs(MCP_SERVER_INVOKE_SCOPES, [targetHostRef])
    let result: { authorizeUrl: string }
    try {
      result = await this.rpcClient.requestMcpOauthAuthorizeUrl(rpc.token, server, ctx)
    } catch (error) {
      // §4.5-7: a 401/expired-scope means the 300s RPC token lapsed; clear the
      // cache, re-mint (same hostRef) and retry once. Every 401/403-missing-scope
      // on this route is emitted by rpc-proxy's auth middleware BEFORE any grant
      // mutation, so a retried error is always a pre-effect rejection — the
      // authorize-url mint is idempotent regardless.
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        rpc = await this.issueRpcTokenForHostRefs(MCP_SERVER_INVOKE_SCOPES, [targetHostRef])
        result = await this.rpcClient.requestMcpOauthAuthorizeUrl(rpc.token, server, ctx)
      } else {
        throw error
      }
    }
    await openExternalDataUrl(result.authorizeUrl, { requireHttps: true })
  }

  /**
   * Proactive connectors read-model (spec 11 U2). Returns the user's agent fleet
   * with each connector classified tri-state (`authorized`/`requires_setup`/
   * `no_oauth`). Host refs come from the access catalog purely to mint the
   * `mcp:servers:list` RPC token (rpc-proxy derives the userId from `auth.sub`
   * and enumerates agents server-side). Retry-after-refresh mirrors
   * {@link listAccessibleMcpServers}.
   */
  async getConnectors(): Promise<RpcConnectorsResult> {
    const token = this.requireSessionToken()
    const catalog = await this.getAccessCatalog()
    const hostRefs = AppService.dedupe(
      (catalog.agentNames || []).map(name => String(name || '').trim()).filter(Boolean)
    )
    if (!hostRefs.length) {
      const me = this.me ?? (await this.authClient.getMe(token))
      this.me = me
      return { userId: me.id, agents: [] }
    }
    const rpc = await this.issueRpcTokenForHostRefs(MCP_SERVERS_LIST_SCOPES, hostRefs)
    try {
      return await this.rpcClient.getConnectors(rpc.token)
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        const retried = await this.issueRpcTokenForHostRefs(MCP_SERVERS_LIST_SCOPES, hostRefs)
        return this.rpcClient.getConnectors(retried.token)
      }
      throw error
    }
  }

  /**
   * Disconnect (revoke) an mcp-server's OAuth grant from the proactive panel
   * (spec 11 U4). Host-bound to the agent whose row triggered it (RPC tokens
   * require ≥1 hostRef; `mcp:server:invoke`, same as connect). Disconnect is
   * destructive, so it ALWAYS asks for explicit confirmation via a native
   * dialog (D-4); for an `oauth-context` connector the copy names the team-wide
   * blast radius. `userId` is derived by rpc-proxy from `auth.sub`, never sent.
   * Resolves `{ confirmed:false }` when the user cancels (nothing was revoked).
   */
  async disconnectMcpServer(
    mcpServerName: string,
    hostRef: string,
    contextId?: string,
    options?: { shared?: boolean }
  ): Promise<{ confirmed: boolean }> {
    const server = String(mcpServerName || '').trim()
    const targetHostRef = String(hostRef || '').trim()
    if (!server) throw new Error('mcpServerName is required')
    if (!targetHostRef) throw new Error('hostRef is required')
    const ctx = contextId ? String(contextId).trim() || undefined : undefined
    this.captureSessionRequestContextForOperation()
    const confirmed = await this.confirmSharedConnectorAction(
      'disconnect',
      server,
      Boolean(options?.shared)
    )
    if (!confirmed) return { confirmed: false }
    let rpc = await this.issueRpcTokenForHostRefs(MCP_SERVER_INVOKE_SCOPES, [targetHostRef])
    try {
      await this.rpcClient.deleteMcpOauthGrant(rpc.token, server, ctx)
    } catch (error) {
      // The DELETE is idempotent and rpc-proxy emits every 401/403-missing-scope
      // from its auth middleware BEFORE the upstream call, so a retried error is
      // always a pre-effect rejection — safe to re-mint (same hostRef) and retry.
      if (AppService.shouldRefreshRpcToken(error)) {
        this.clearRpcTokenCacheForCurrentRequest()
        rpc = await this.issueRpcTokenForHostRefs(MCP_SERVER_INVOKE_SCOPES, [targetHostRef])
        await this.rpcClient.deleteMcpOauthGrant(rpc.token, server, ctx)
      } else {
        throw error
      }
    }
    return { confirmed: true }
  }

  /**
   * Native confirmation dialog for a connector action whose effect is either
   * destructive (any disconnect) or team-wide (`oauth-context`). Mirrors the
   * background-consent dialog of {@link requestSandboxUiOauthAuthorize}. The
   * `shared` copy names the Context blast radius; every disconnect carries the
   * revocation-latency note (D-5 — no immediate push; eviction is by idle
   * timeout). Returns true iff the user confirmed.
   */
  private async confirmSharedConnectorAction(
    action: 'connect' | 'disconnect',
    server: string,
    shared = true
  ): Promise<boolean> {
    const { dialog, BrowserWindow } = await import('electron')
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const verb = action === 'connect' ? 'Connect' : 'Disconnect'
    // Revocation is NOT immediate and — critically — has no fixed upper bound for
    // the shared (oauth-context) flavor: SHARED partitions are exempt from the
    // 15-min idle eviction (mcp-host), so a live session ends only on the next
    // grant-revocation sweep, which is fail-open. Don't promise "a few minutes".
    const latencyNote =
      action === 'disconnect'
        ? ' It is not immediate — active sessions end on the next revocation sweep.'
        : ''
    const message = shared ? `${verb} "${server}" for the whole team?` : `${verb} "${server}"?`
    const detail = shared
      ? action === 'connect'
        ? `This connector is shared by the team. Authorizing it connects every agent in this context on your behalf.${latencyNote}`
        : `This connector is shared by the team. Disconnecting removes access for every agent in this context.${latencyNote}`
      : `This removes your authorization for this connector.${latencyNote}`
    const opts = {
      type: (action === 'disconnect' ? 'warning' : 'question') as 'warning' | 'question',
      buttons: ['Cancel', verb],
      // Disconnect is destructive: default to Cancel (0) so a stray Enter does
      // NOT revoke. Connect is additive, so its default stays on the action (1).
      defaultId: action === 'disconnect' ? 0 : 1,
      cancelId: 0,
      message,
      detail,
    }
    const result = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    return result.response === 1
  }

  /**
   * Open the sandbox-ui WebContentsView. Mints a session cookie, installs it
   * into the per-recipe Electron partition, and mounts a single embedded
   * view at the bounds the renderer reserved.
   *
   * Only one sandbox-ui view exists at a time across the desktop app —
   * re-opening recipe B while A is up tears down A first, before B's session
   * is minted, so a failed open leaves no view at all. This keeps memory + GPU
   * usage bounded and avoids accidental cross-recipe focus / cookie-jar
   * mixups.
   */
  openSandboxUi(args: {
    /** Names the view this open mounts in every event about it. */
    launchId: string
    recipeNs: string
    recipeName: string
    title?: string
    defaultPath?: string
    routePath?: string
    bounds: import('./sandboxUiDriver.js').SandboxUiBounds
    parentWindow: import('electron').BrowserWindow
    /** Exactly once per view this open mounts, even if the open then rejects. */
    onReleased?: (event: import('./sandboxUiDriver.js').SandboxUiReleasedEvent) => void
    onRefreshError?: (message: string) => void
    /** A refresh succeeded after `onRefreshError` reported that it had given up. */
    onRefreshRecovered?: () => void
    onOauthError?: (message: string) => void
    onTitleChanged?: (title: string) => void
  }): Promise<void> {
    // Captured at request time, not when the queue reaches it: an open asked for
    // under one session must not run under the next one. Enqueued synchronously:
    // a close for this launch sent right after it must find it ahead in the queue.
    const sessionEpoch = this.sandboxUiSessionEpoch
    return this.enqueueSandboxUiLifecycle(() => this.openSandboxUiNow(args, sessionEpoch))
  }

  private async openSandboxUiNow(
    args: Parameters<AppService['openSandboxUi']>[0],
    sessionEpoch: number
  ): Promise<void> {
    const recipeNs = String(args.recipeNs || '').trim()
    const recipeName = String(args.recipeName || '').trim()
    if (!recipeNs || !recipeName) throw new Error('recipeNs and recipeName are required')
    this.sandboxUiGeneration += 1
    // An open replaces the current view whatever its outcome, so the outgoing
    // view goes BEFORE the network mint: a failed mint must not leave it
    // painted (with its refresh loop still minting) after the renderer has been
    // told the open failed. Failure is reported only by the rejection.
    await this.teardownSandboxUiView('replaced')
    try {
      await this.mintAndMountSandboxUiView(args, recipeNs, recipeName, sessionEpoch)
    } catch (error) {
      // Only this open's own view, never one another launch owns; its release
      // goes out before the rejection. `open_failed` tells the renderer that
      // rejection is on its way, so it reports the failure instead of an
      // abandoned launch; a session that ended meanwhile is the real cause.
      const reason = this.sandboxUiSessionEpoch === sessionEpoch ? 'open_failed' : 'session'
      await this.teardownSandboxUiView(reason, args.launchId)
      throw error
    }
  }

  private async mintAndMountSandboxUiView(
    args: Parameters<AppService['openSandboxUi']>[0],
    recipeNs: string,
    recipeName: string,
    sessionEpoch: number
  ): Promise<void> {
    // The close queued by a session clear only runs after this open settles, so
    // the open itself must refuse to install the cleared session's cookie or
    // attach a view for it.
    this.assertSandboxUiSessionEpoch(sessionEpoch)
    const mintedAt = Date.now()
    const { setCookie } = await this.mintSandboxUiSession(recipeNs, recipeName)
    this.assertSandboxUiSessionEpoch(sessionEpoch)
    const driver = await import('./sandboxUiDriver.js')
    const refreshModule = await import('./sandboxUiSessionRefresh.js')
    this.assertSandboxUiSessionEpoch(sessionEpoch)
    await driver.mountSandboxUiView({
      recipeNs,
      recipeName,
      setCookie,
      rpcProxyUrl: this.getEffectiveRpcProxyBaseUrl(),
      defaultPath: args.defaultPath,
      routePath: args.routePath,
      parentWindow: args.parentWindow,
      bounds: args.bounds,
      launchId: args.launchId,
      onReleased: args.onReleased,
      // A teardown main did not ask for (crash, parent window closed) skips
      // `teardownSandboxUiView`, so its cleanup runs here.
      onClosed: () => {
        // Cancel refresh first so the timer doesn't keep firing against a
        // partition we're about to evict on the next mount.
        refreshModule.cancelSandboxUiRefresh()
        // Unpin before anything else can observe a dead surface as pinned:
        // per-mount SDK state (session denials, prompt budget, rate budget)
        // dies with the mount.
        tryGetPluginSdkRuntime()?.unpinAllSandboxUiSurfaces()
      },
      onGfsOpen: uri => {
        const active = tryGetPluginSdkRuntime()
        const surface = driver.getActiveSandboxUi()
        if (!active || !surface) return
        void active.openGfsResourceFromNavigation(surface.webContentsId, uri)
      },
      onTitleChanged: args.onTitleChanged,
      onUnauthorizedNavigation: webContentsId => {
        refreshModule.handleSandboxUiUnauthorizedNavigation(webContentsId)
      },
      onOauthAuthorize: (oauthClientId, background) => {
        void this.requestSandboxUiOauthAuthorize(
          recipeNs,
          recipeName,
          oauthClientId,
          background
        ).catch(err => {
          const message = err instanceof Error ? err.message : String(err)
          desktopRuntimeLog.warn('[SandboxUI] oauth authorize-url fetch failed:', err)
          args.onOauthError?.(message)
        })
      },
      isCurrent: () => this.sandboxUiSessionEpoch === sessionEpoch,
    })
    this.assertSandboxUiSessionEpoch(sessionEpoch)
    const activeView = driver.getActiveSandboxUi()
    if (!activeView || activeView.launchId !== args.launchId) {
      // The view died before the open finished (its renderer crashed, its
      // window closed). An open resolves only when it leaves its view mounted,
      // and its refresh loop must not attach to whatever is active now.
      throw new Error('The app view closed before it finished opening')
    }
    // Pin the surface so the SDK broker can derive this plugin's identity from
    // `webContents.id` — the plugin never asserts who it is.
    tryGetPluginSdkRuntime()?.pinSandboxUiSurface({
      pluginId: activeView.appRef,
      pluginTitle: String(args.title || '').trim() || recipeName,
      webContentsId: activeView.webContentsId,
      generation: this.sandboxUiGeneration,
    })
    refreshModule.startSandboxUiRefresh({
      recipeNs,
      recipeName,
      webContentsId: activeView.webContentsId,
      parentWindow: args.parentWindow,
      mintedAt,
      // A refresh minted before a session clear can land before the queued
      // close cancels this loop. Rejecting fails the attempt without writing
      // the cleared session's cookie, and any retry before the close runs is
      // refused before it reaches rpc-proxy, so the next session's token never
      // mints for this view. The user has nothing to act on, so it is not
      // reported.
      refresh: async (ns, name) => {
        this.assertSandboxUiSessionEpoch(sessionEpoch)
        return this.mintSandboxUiSession(ns, name)
      },
      installCookie: async setCookieValue => {
        this.assertSandboxUiSessionEpoch(sessionEpoch)
        await driver.installSandboxUiCookie(setCookieValue)
      },
      reload: () => {
        if (driver.getActiveSandboxUi()?.webContentsId !== activeView.webContentsId) return
        driver.reloadActiveSandboxUiView()
      },
      onError: err => {
        if (this.sandboxUiSessionEpoch !== sessionEpoch) return
        args.onRefreshError?.(err instanceof Error ? err.message : String(err))
      },
      onRecovered: () => {
        if (this.sandboxUiSessionEpoch !== sessionEpoch) return
        args.onRefreshRecovered?.()
      },
    })
  }

  /**
   * With a `launchId`, closes the view only if that launch still owns it: a
   * close that arrives after its view was replaced must not take down the
   * replacement. Without one, closes whatever is live; only main's own callers
   * (session change, renderer replaced) do that, the renderer must always name
   * its launch. Enqueued synchronously, like `openSandboxUi`.
   */
  closeSandboxUi(
    options: {
      launchId?: string
      reason?: import('./sandboxUiDriver.js').SandboxUiReleaseReason
    } = {}
  ): Promise<void> {
    return this.enqueueSandboxUiLifecycle(() =>
      this.teardownSandboxUiView(options.reason ?? 'closed', options.launchId)
    )
  }

  /**
   * Reloads the document of the view `launchId` owns, in place: same view, same
   * session cookie, same refresh loop, so nothing is minted. Enqueued
   * synchronously like `openSandboxUi`, so it acts on the view the queue holds
   * when it gets there; a launch that no longer owns the view reloads nothing.
   */
  reloadSandboxUi(options: { launchId: string }): Promise<void> {
    return this.enqueueSandboxUiLifecycle(async () => {
      const driver = await import('./sandboxUiDriver.js')
      if (driver.getActiveSandboxUi()?.launchId !== options.launchId) return
      driver.reloadActiveSandboxUiView()
    })
  }

  private async teardownSandboxUiView(
    reason: import('./sandboxUiDriver.js').SandboxUiReleaseReason,
    onlyLaunchId?: string
  ): Promise<void> {
    const driver = await import('./sandboxUiDriver.js')
    const refreshModule = await import('./sandboxUiSessionRefresh.js')
    if (onlyLaunchId !== undefined && driver.getActiveSandboxUi()?.launchId !== onlyLaunchId) {
      return
    }
    // Neither must keep the view from being unmounted and released.
    try {
      refreshModule.cancelSandboxUiRefresh()
    } catch (error) {
      console.error('[SandboxUI] Could not cancel the session refresh of a closing view:', error)
    }
    try {
      tryGetPluginSdkRuntime()?.unpinAllSandboxUiSurfaces()
    } catch (error) {
      console.error('[SandboxUI] Could not unpin the surfaces of a closing view:', error)
    }
    await driver.unmountSandboxUiView(reason)
  }

  async createSandboxUiDeepLink(teamId?: string): Promise<{ url: string }> {
    const driver = await import('./sandboxUiDriver.js')
    const { buildSandboxUiWebLink } = await import('./sandboxUiDeepLinks.js')
    const location = driver.getActiveSandboxUiLocation()
    if (!location) throw new Error('No app is currently open')
    const profileUiBaseUrl = await this.resolveProfileUiBaseUrl(undefined, {
      fallbackOnLookupError: false,
    })
    return {
      url: buildSandboxUiWebLink(profileUiBaseUrl, {
        ...location,
        teamId: String(teamId || '').trim() || undefined,
      }),
    }
  }

  async setSandboxUiBounds(bounds: import('./sandboxUiDriver.js').SandboxUiBounds): Promise<void> {
    const { setSandboxUiBounds } = await import('./sandboxUiDriver.js')
    setSandboxUiBounds(bounds)
  }

  async setSandboxUiVisible(visible: boolean): Promise<void> {
    const { setSandboxUiVisible } = await import('./sandboxUiDriver.js')
    setSandboxUiVisible(visible)
  }

  async captureSandboxUiPreview(): Promise<string | null> {
    const { captureSandboxUiPreview } = await import('./sandboxUiDriver.js')
    return captureSandboxUiPreview()
  }

  async findInActiveSandboxUi(
    query: string,
    operation: import('./sandboxUiDriver.js').SandboxUiFindOperation,
    clientRequestId: number,
    onResult: (result: import('./sandboxUiDriver.js').SandboxUiFindResult) => void
  ): Promise<import('./sandboxUiDriver.js').SandboxUiFindStartResult> {
    const { findInActiveSandboxUi } = await import('./sandboxUiDriver.js')
    return findInActiveSandboxUi(query, operation, clientRequestId, onResult)
  }

  async stopActiveSandboxUiFind(): Promise<void> {
    const { stopActiveSandboxUiFind } = await import('./sandboxUiDriver.js')
    stopActiveSandboxUiFind()
  }

  async focusActiveSandboxUi(): Promise<boolean> {
    const { focusActiveSandboxUi } = await import('./sandboxUiDriver.js')
    return focusActiveSandboxUi()
  }

  /**
   * Embed-side refresh request. The IPC layer hands us the sender's
   * `webContents.id`; we delegate to the refresh module which gates the
   * call by the pinning map and per-view rate-limit.
   */
  async requestSandboxUiRefresh(senderId: number): Promise<void> {
    const refreshModule = await import('./sandboxUiSessionRefresh.js')
    await refreshModule.handleEmbedRefreshRequest(senderId)
  }

  async listContextSharedFilesystems(
    contextId: string
  ): Promise<{ items: ContextSharedFilesystemSummary[] }> {
    const token = this.requireSessionToken()
    if (!contextId.trim()) throw new Error('contextId is required')
    try {
      return await this.sharedFilesClient.listAttached(token, contextId.trim())
    } catch (error) {
      if (AppService.isForbiddenSharedFilesListError(error)) {
        return { items: [] }
      }
      throw error
    }
  }

  async listSharedFilesystemDirectory(
    contextId: string,
    sfsName: string,
    relPath: string
  ): Promise<SharedFileListResult> {
    const token = this.requireSessionToken()
    if (!contextId.trim()) throw new Error('contextId is required')
    if (!sfsName.trim()) throw new Error('sfsName is required')
    return this.sharedFilesClient.listDirectory(token, contextId.trim(), sfsName.trim(), relPath)
  }

  async downloadSharedFile(
    contextId: string,
    sfsName: string,
    relPath: string
  ): Promise<{ bytes: Buffer; filename: string; contentType: string | null }> {
    const token = this.requireSessionToken()
    if (!contextId.trim()) throw new Error('contextId is required')
    if (!sfsName.trim()) throw new Error('sfsName is required')
    if (!relPath.trim()) throw new Error('relPath is required')
    return this.sharedFilesClient.downloadFile(token, contextId.trim(), sfsName.trim(), relPath)
  }
}
