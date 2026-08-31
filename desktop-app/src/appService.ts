import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AuthClient } from './authClient.js'
import { bindChatStoreForUser, unbindChatStore } from './chatStoreBinding.js'
import {
  clearDesktopRuntimeConfigSelection,
  config,
  deleteDesktopRuntimeConfigOption,
  getActiveEnvKey,
  getActiveLegacyEnvKeys,
  getDesktopRuntimeConfigState,
  hydrateDesktopRuntimeConfig,
  isDesktopRuntimeConfigured,
  resolveEnvKey,
  saveDesktopRuntimeConfig,
  selectDesktopRuntimeConfigOption,
} from './config.js'
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
import { ApiError, requestJson, withTimeout } from './httpClient.js'
import { MemberRegistrationServiceClient } from './memberRegistrationServiceClient.js'
import { tryGetPluginSdkRuntime } from './pluginSdkRuntime.js'
import { RpcProxyClient } from './rpcProxyClient.js'
import { RpcTokenManager } from './rpcTokenManager.js'
import {
  ContextSharedFilesystemSummary,
  SharedFileListResult,
  SharedFilesClient,
} from './sharedFilesClient.js'
import { TokenStore } from './tokenStore.js'
import {
  AccessCatalog,
  AgentWithMcpServers,
  ApprovalDecisionResult,
  ContextBreakdownResult,
  DependencyHealth,
  DesktopAppInfo,
  DesktopReleaseStatus,
  DesktopRuntimeConfig,
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
  PendingApprovalLite,
  PendingWorkflowApproval,
  PrewarmHostResult,
  ProfileSettingsOpenOptions,
  RpcAllowedServersResult,
  RpcConnectorsResult,
  RpcScope,
  SessionLifecycleState,
  SessionMe,
  SessionMessagesQuery,
  SessionMessagesResult,
  SessionState,
  SessionTokensLite,
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

const HOST_WAKE_SCOPE: RpcScope = 'host:wake:write'
const PROFILE_UI_BASE_URL_ORIGIN_ERROR =
  'PROFILE_UI_BASE_URL must be an origin URL with a root pathname and no search parameters'

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
    const response = await fetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, ...headers },
      body: body as unknown as BodyInit,
      // Node's fetch requires this opt-in for a streaming request body.
      duplex: 'half',
      signal: withTimeout(signal, timeoutMs),
    } as RequestInit & { duplex: 'half' })
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
    teamId: me.teamId ? String(me.teamId).trim() : null,
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

export class AppService {
  private readonly authClient = new AuthClient()
  private readonly memberRegistrationServiceClient = new MemberRegistrationServiceClient()
  private readonly rpcClient = new RpcProxyClient()
  private readonly sharedFilesClient = new SharedFilesClient()
  private readonly gfsClient = new GfsClient({
    get baseUrl() {
      return config.externalRestApiBaseUrl
    },
    requestJson,
    fetchBytes: async (url, token) => {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
      if (!res.ok) {
        throw new ApiError(`gfs download failed: ${res.status}`, res.status, '')
      }
      return res.arrayBuffer()
    },
  })
  private readonly tokenStore = new TokenStore()
  private readonly rpcTokenManager = new RpcTokenManager(this.authClient)
  private sessionToken: string | null = null
  private me: SessionMe | null = null
  private profileUiBaseUrlCache: { key: string; value: string } | null = null
  private accessCatalog: AccessCatalog | null = null
  private teamDirectoryCache: TeamDirectoryResult | null = null
  private teamContextQueue: Promise<void> = Promise.resolve()
  private restoreSavedSessionInFlight: Promise<SessionState> | null = null
  private savedSessionRestoreAttemptedEnvKey: string | null = null
  private savedSessionRestoreAttemptedAtMs = 0
  private logoutInProgress = false
  private gfsAuthEpoch = 0
  private gfsDispatchBlocked = true
  // A transient runWithTeamContext hop temporarily installs another team's
  // token in sessionToken. Existing GFS jobs keep their captured token and
  // scope, but new GFS operations must not capture that temporary token.
  private gfsTransientTeamHopDepth = 0
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
  }>()
  private sessionGeneration = 0
  private sandboxUiLifecycleQueue: Promise<void> = Promise.resolve()
  private workflowApprovalTeamById = new Map<string, string>()
  private workflowTeamByKey = new Map<string, string>()
  private readonly prewarmAttemptAtByHostRef = new Map<string, number>()
  private readonly prewarmReemitLoopHostRefs = new Set<string>()
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
  private progressStreams = new Map<
    string,
    { ownerId: number; stop: (opts?: { silent?: boolean }) => void }
  >()

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

  private static isRejectedStoredSessionError(error: unknown): boolean {
    return (
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403 || error.status === 410)
    )
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

  private async bindCurrentChatStore(userId: string): Promise<void> {
    await bindChatStoreForUser(userId, getActiveEnvKey(), {
      legacyEnvKeys: getActiveLegacyEnvKeys(),
    })
  }

  private async commitSessionToken(
    token: string,
    options: { refreshMe?: boolean } = {}
  ): Promise<void> {
    const tokenChanged = token !== this.sessionToken
    if (tokenChanged) this.sessionGeneration += 1
    this.sessionToken = token
    if (tokenChanged) {
      this.rpcTokenManager.clear()
      this.profileUiBaseUrlCache = null
      this.accessCatalog = null
      await this.tokenStore.setSessionToken(token, getActiveEnvKey())
    }
    if (options.refreshMe) {
      try {
        this.me = await this.authClient.getMe(token)
      } catch (error) {
        unbindChatStore()
        throw error
      }
      await this.bindCurrentChatStore(this.me.id)
      this.updateCachedCurrentTeam(this.me.teamId)
    }
  }

  private async getCurrentSessionTeamId(token: string): Promise<string> {
    if (this.me?.teamId) return this.me.teamId
    this.me = await this.authClient.getMe(token)
    await this.bindCurrentChatStore(this.me.id)
    this.updateCachedCurrentTeam(this.me.teamId)
    return this.me.teamId || ''
  }

  private async switchSessionToTeam(teamId: string, token = this.requireSessionToken()) {
    const releaseTransientHop = this.enterGfsTransientTeamHop()
    const targetTeamId = String(teamId || '').trim()
    try {
      if (!targetTeamId) throw new Error('teamId is required')
      const switchGeneration = this.sessionGeneration
      if (this.sessionToken !== token || !this.me) {
        throw new Error('stale_auth_epoch: authenticated team scope changed before switch dispatch')
      }
      const previousIdentity =
        this.gfsScopeIdentity ?? (this.me ? desktopGfsUploadIdentity(this.me) : undefined)
      let switchedToken: string | null = null
      try {
        const switched = await this.authClient.switchTeam(token, targetTeamId)
        switchedToken = switched.token
        if (this.sessionGeneration !== switchGeneration || this.sessionToken !== token) {
          throw new Error('stale_auth_epoch: authenticated team scope changed during switch')
        }
        await this.commitSessionToken(switched.token, { refreshMe: true })
        if (!this.me) throw new Error('Team switch ended without an authenticated session')
        return switched.token
      } catch (error) {
        if (!switchedToken && this.sessionToken === token && this.me) {
          // A failed transient hop leaves the deliberate GFS scope untouched.
        } else {
          // Once the auth service has issued a replacement token, the previous
          // authenticated scope is no longer safe to continue. Fence and
          // persist its uploads before clearing the partially switched session;
          // otherwise a failed refresh/restore could leave a job running with a
          // token whose team ownership is unknown. The fence is best effort:
          // clearing the in-memory scope and revoking the persisted token must
          // still happen when its state write is unavailable.
          try {
            await this.suspendDesktopGfsUploadsForAuthBoundary(previousIdentity)
          } catch (fenceError) {
            console.warn(
              '[AppService] Failed to persist the GFS authentication fence during team switch:',
              fenceError
            )
          }
          this.clearAuthenticatedSessionState()
          try {
            await this.tokenStore.clearSessionToken(getActiveEnvKey(), {
              legacyEnvKeys: getActiveLegacyEnvKeys(),
            })
          } catch (clearError) {
            console.warn(
              '[AppService] Failed to clear a partially switched team session:',
              clearError
            )
          }
        }
        throw error
      }
    } finally {
      releaseTransientHop()
    }
  }

  private enterGfsTransientTeamHop(): () => void {
    this.gfsTransientTeamHopDepth += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.gfsTransientTeamHopDepth = Math.max(0, this.gfsTransientTeamHopDepth - 1)
    }
  }

  private assertGfsDispatchAllowed(): void {
    if (this.gfsTransientTeamHopDepth > 0) {
      throw new Error('GFS upload dispatch is unavailable during a transient team hop')
    }
  }

  private async runWithTeamContext<T>(
    teamId: string | null | undefined,
    operation: (sessionToken: string) => Promise<T>
  ): Promise<T> {
    const targetTeamId = String(teamId || '').trim()
    if (!targetTeamId) {
      await this.teamContextQueue.catch(() => undefined)
      return operation(this.requireSessionToken())
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

    let operationError: unknown
    try {
      const originalToken = this.requireSessionToken()
      const originalTeamId = await this.getCurrentSessionTeamId(originalToken)
      let activeToken = originalToken
      const shouldSwitch = originalTeamId !== targetTeamId
      const shouldRestore = Boolean(originalTeamId && shouldSwitch)
      const releaseTransientHop = shouldSwitch ? this.enterGfsTransientTeamHop() : undefined

      try {
        if (shouldSwitch) {
          activeToken = await this.switchSessionToTeam(targetTeamId, originalToken)
        }

        try {
          return await operation(activeToken)
        } catch (error) {
          operationError = error
          throw error
        } finally {
          if (shouldRestore) {
            try {
              await this.switchSessionToTeam(originalTeamId, this.requireSessionToken())
            } catch (restoreError) {
              if (!operationError) throw restoreError
              console.warn(
                '[AppService] Failed to restore team context after operation:',
                restoreError
              )
            }
          }
        }
      } finally {
        releaseTransientHop?.()
      }
    } finally {
      releaseQueue()
    }
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

  private enqueueSandboxUiLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sandboxUiLifecycleQueue.then(operation)
    this.sandboxUiLifecycleQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async issueRpcTokenForHostRefs(
    scopes: RpcScope[],
    hostRefs: string[],
    options: { teamId?: string | null } = {}
  ) {
    const targetTeamId =
      String(options.teamId || '').trim() || (await this.resolveTeamForHostRefs(hostRefs))
    return this.runWithTeamContext(targetTeamId, token =>
      this.rpcTokenManager.getOrIssue(token, scopes, hostRefs)
    )
  }

  private clearAuthenticatedSessionState(): void {
    this.sessionGeneration += 1
    this.gfsAuthEpoch += 1
    this.gfsDispatchBlocked = true
    this.gfsScopeIdentity = null
    this.stopAllStreams()
    this.sessionToken = null
    this.me = null
    this.profileUiBaseUrlCache = null
    this.accessCatalog = null
    this.teamDirectoryCache = null
    this.workflowApprovalTeamById.clear()
    this.workflowTeamByKey.clear()
    this.rpcTokenManager.clear()
    unbindChatStore()
  }

  private activateGfsAuthScope(identityOverride?: DesktopGfsUploadIdentity): void {
    this.gfsAuthEpoch += 1
    this.gfsDispatchBlocked = false
    this.gfsScopeIdentity = identityOverride ?? (this.me ? desktopGfsUploadIdentity(this.me) : null)
  }

  private currentDesktopGfsUploadScope(
    driveValue: string | undefined,
    options: { allowTransientTeamHop?: boolean } = {}
  ): DesktopGfsUploadScope {
    if (this.gfsDispatchBlocked || !this.sessionToken || !this.me) {
      throw new Error('GFS upload dispatch is unavailable without an active authenticated scope')
    }
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
    const jobs = new Set([
      ...[...this.gfsUploadJobs.values()].map(entry => entry.job),
      ...[...this.gfsPendingUploadJobs].map(entry => entry.job),
    ])
    const jobSuspensions = [...jobs].map(job => job.suspendForAuth())
    const legacyUploads = [...this.gfsPendingLegacyUploads]
    for (const upload of legacyUploads) {
      upload.controller.abort(new Error('GFS legacy upload suspended by authentication fence'))
    }
    await Promise.all([
      ...jobSuspensions,
      ...legacyUploads.map(upload => upload.promise.catch(() => undefined)),
    ])
    this.gfsUploadJobs.clear()
    this.gfsPendingUploadJobs.clear()
    this.gfsPendingLegacyUploads.clear()
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
    const restore = this.restoreSavedSessionOnce(options)
    this.restoreSavedSessionInFlight = restore
    try {
      return await restore
    } finally {
      // No newer restore can start while this promise is installed, so the
      // single-flight slot can be cleared unconditionally after it settles.
      this.restoreSavedSessionInFlight = null
    }
  }

  private async restoreSavedSessionOnce(options: { runLaunchMaintenance?: boolean } = {}) {
    if (this.logoutInProgress) return { authenticated: false, me: null }
    const restoreGeneration = this.sessionGeneration
    hydrateDesktopRuntimeConfig()
    const envKey = getActiveEnvKey()
    const legacyEnvKeys = getActiveLegacyEnvKeys()
    this.savedSessionRestoreAttemptedEnvKey = envKey
    this.savedSessionRestoreAttemptedAtMs = Date.now()
    let token: string | null
    try {
      token = await this.tokenStore.getSessionToken(envKey, { legacyEnvKeys })
    } catch (error) {
      console.warn('[AppService] Failed to read the saved session token:', error)
      if (this.sessionGeneration === restoreGeneration) {
        this.clearAuthenticatedSessionState()
      }
      return { authenticated: false, me: null }
    }
    if (this.logoutInProgress) return { authenticated: false, me: null }
    if (!token) {
      if (this.sessionGeneration === restoreGeneration) {
        this.clearAuthenticatedSessionState()
      }
      return { authenticated: false, me: null }
    }

    if (this.sessionGeneration !== restoreGeneration) {
      return { authenticated: Boolean(this.sessionToken && this.me), me: this.me }
    }
    this.sessionToken = token
    try {
      const restoredMe = await this.authClient.getMe(token)
      if (this.sessionGeneration !== restoreGeneration || this.sessionToken !== token) {
        return { authenticated: Boolean(this.sessionToken && this.me), me: this.me }
      }
      await bindChatStoreForUser(restoredMe.id, envKey, { legacyEnvKeys })
      if (this.sessionGeneration !== restoreGeneration || this.sessionToken !== token) {
        if (this.me) {
          await this.bindCurrentChatStore(this.me.id)
        } else {
          unbindChatStore()
        }
        return { authenticated: Boolean(this.sessionToken && this.me), me: this.me }
      }
      this.me = restoredMe
      this.accessCatalog = null
      this.teamDirectoryCache = null
      this.workflowApprovalTeamById.clear()
      this.workflowTeamByKey.clear()
      // Persisted uploads are never auto-resumed. The active owner/team/env can
      // list only its own scoped records and must explicitly resume one, at
      // which point the record is rebound to this newly activated auth epoch.
      this.activateGfsAuthScope()
      // Launch-time sandbox-ui partition GC. Fire-and-forget: a failure
      // here must not block the user from logging in. Any network or fs
      // error is logged inside the module.
      if (options.runLaunchMaintenance) {
        void this.runSandboxUiPartitionGcSafely()
      }
      return { authenticated: true, me: this.me }
    } catch (error) {
      if (this.sessionGeneration !== restoreGeneration || this.sessionToken !== token) {
        return { authenticated: Boolean(this.sessionToken && this.me), me: this.me }
      }
      this.clearAuthenticatedSessionState()
      if (AppService.isRejectedStoredSessionError(error)) {
        await this.tokenStore.clearSessionToken(envKey, { legacyEnvKeys })
      } else {
        console.warn('[AppService] Saved session restore failed; keeping token for retry:', error)
      }
      return { authenticated: false, me: null }
    }
  }

  async initialize(): Promise<SessionState> {
    return this.restoreSavedSession({ runLaunchMaintenance: true })
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
        console.info(
          `[SandboxUI] partition GC complete: wiped=${result.wiped.length}, ` +
            `evicted=${result.evicted.length}`
        )
      }
    } catch (err) {
      console.warn('[SandboxUI] partition GC failed:', err)
    }
  }

  private async installAuthenticatedLogin(result: {
    token: string
    me: SessionMe
  }): Promise<SessionState> {
    const previousToken = this.sessionToken
    const previousMe = this.me
    const previousGeneration = this.sessionGeneration
    const hadAuthenticatedScope = Boolean(previousToken && previousMe)
    if (hadAuthenticatedScope) {
      try {
        await this.suspendDesktopGfsUploadsForAuthBoundary()
      } catch (error) {
        if (
          this.sessionGeneration === previousGeneration &&
          this.sessionToken === previousToken &&
          this.me === previousMe
        ) {
          this.activateGfsAuthScope()
        }
        throw error
      }
      if (
        this.sessionGeneration !== previousGeneration ||
        this.sessionToken !== previousToken ||
        this.me !== previousMe
      ) {
        throw new Error('stale_auth_epoch: authenticated scope changed during login replacement')
      }
    }
    this.logoutInProgress = false
    this.sessionGeneration += 1
    this.sessionToken = result.token
    this.me = result.me
    await this.bindCurrentChatStore(result.me.id)
    this.accessCatalog = null
    this.teamDirectoryCache = null
    this.workflowApprovalTeamById.clear()
    this.workflowTeamByKey.clear()
    this.rpcTokenManager.clear()
    await this.tokenStore.setSessionToken(result.token, getActiveEnvKey())
    this.activateGfsAuthScope()
    return { authenticated: true, me: result.me }
  }

  private async completePasswordLogin(email: string, password: string): Promise<SessionState> {
    const result = await this.authClient.passwordLogin(email, password)
    return this.installAuthenticatedLogin(result)
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

  private async applyRuntimeEnvironmentChange(operation: () => Promise<void>): Promise<void> {
    const oldEnvKey = getActiveEnvKey()
    const oldBaseUrl = normalizeDesktopUploadBaseUrl(config.externalRestApiBaseUrl)
    const oldLegacyEnvKeys = getActiveLegacyEnvKeys()
    const hadAuthenticatedScope = Boolean(this.sessionToken && this.me)
    // Invalidate a restore that may still be awaiting keychain/getMe before it
    // can bind an old-environment token to the newly selected runtime.
    this.sessionGeneration += 1
    if (hadAuthenticatedScope) await this.suspendDesktopGfsUploadsForAuthBoundary()
    try {
      await operation()
    } catch (error) {
      if (hadAuthenticatedScope && this.sessionToken && this.me) this.activateGfsAuthScope()
      throw error
    }
    const boundaryChanged =
      getActiveEnvKey() !== oldEnvKey ||
      normalizeDesktopUploadBaseUrl(config.externalRestApiBaseUrl) !== oldBaseUrl
    if (boundaryChanged) {
      this.clearAuthenticatedSessionState()
      await this.tokenStore.clearSessionToken(oldEnvKey, { legacyEnvKeys: oldLegacyEnvKeys })
    } else if (hadAuthenticatedScope && this.sessionToken && this.me) {
      this.activateGfsAuthScope()
    }
  }

  async selectRuntimeConfig(optionId: string) {
    const state = getDesktopRuntimeConfigState()
    const selected = state.options.find(option => option.id === String(optionId || '').trim())
    const nextEnvKey = selected
      ? resolveEnvKey(selected.externalRestApiBaseUrl, selected.rpcProxyBaseUrl)
      : null
    const sameUploadBoundary =
      nextEnvKey === state.envKey &&
      selected !== undefined &&
      normalizeDesktopUploadBaseUrl(selected.externalRestApiBaseUrl) ===
        normalizeDesktopUploadBaseUrl(config.externalRestApiBaseUrl)
    if (sameUploadBoundary) await selectDesktopRuntimeConfigOption(optionId)
    else await this.applyRuntimeEnvironmentChange(() => selectDesktopRuntimeConfigOption(optionId))
    return getDesktopRuntimeConfigState()
  }

  async clearRuntimeConfigSelection() {
    await this.applyRuntimeEnvironmentChange(clearDesktopRuntimeConfigSelection)
    return getDesktopRuntimeConfigState()
  }

  async saveRuntimeConfig(next: DesktopRuntimeConfig) {
    const nextEnvKey = resolveEnvKey(next.externalRestApiBaseUrl, next.rpcProxyBaseUrl || '')
    const sameUploadBoundary =
      nextEnvKey === getActiveEnvKey() &&
      normalizeDesktopUploadBaseUrl(next.externalRestApiBaseUrl) ===
        normalizeDesktopUploadBaseUrl(config.externalRestApiBaseUrl)
    if (sameUploadBoundary) await saveDesktopRuntimeConfig(next)
    else await this.applyRuntimeEnvironmentChange(() => saveDesktopRuntimeConfig(next))
    await this.resolveRuntimeConfigIfNeeded().catch(() => undefined)
    return getDesktopRuntimeConfigState()
  }

  async deleteRuntimeConfig(optionId: string) {
    const state = getDesktopRuntimeConfigState()
    if (state.activeOptionId === String(optionId || '').trim())
      await this.applyRuntimeEnvironmentChange(() => deleteDesktopRuntimeConfigOption(optionId))
    else await deleteDesktopRuntimeConfigOption(optionId)
    return getDesktopRuntimeConfigState()
  }

  async googleLogin(idToken: string): Promise<SessionState> {
    const result = await this.authClient.googleLogin(idToken)
    return this.installAuthenticatedLogin(result)
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
    try {
      const activation = await this.memberRegistrationServiceClient.completeDesktopSetup(
        normalizedEmail,
        authorizationToken
      )
      if (activation.email.trim().toLowerCase() !== normalizedEmail) {
        throw new Error('desktop setup configuration mismatch')
      }

      await saveDesktopRuntimeConfig({
        externalRestApiBaseUrl: activation.externalRestApiBaseUrl,
        rpcProxyBaseUrl: '',
        appName: activation.appName,
      })
      await this.resolveRuntimeConfigIfNeeded().catch(() => undefined)
      return getDesktopRuntimeConfigState()
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new Error('desktop_setup_not_found')
      }
      throw error
    }
  }

  async passwordLogin(email: string, password: string): Promise<PasswordLoginResult> {
    hydrateDesktopRuntimeConfig()
    const normalizedEmail = email.trim().toLowerCase()
    if (!isDesktopRuntimeConfigured()) {
      throw new Error('desktop_setup_required')
    }
    await this.resolveRuntimeConfigIfNeeded()

    return this.completePasswordLogin(normalizedEmail, password)
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
    hydrateDesktopRuntimeConfig()
    if (!isDesktopRuntimeConfigured()) return
    if (config.rpcProxyBaseUrl?.trim()) return
    const discovered = await this.authClient.getDesktopEnvironment()
    await saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: discovered.externalRestApiBaseUrl || config.externalRestApiBaseUrl,
      rpcProxyBaseUrl: discovered.rpcProxyBaseUrl,
      appName: discovered.appName || config.appName,
    })
  }

  async getDesktopReleaseStatus(): Promise<DesktopReleaseStatus> {
    const { app } = await import('electron')
    const currentVersion = resolveDesktopAppVersion(app)
    const token = this.requireSessionToken()
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

  async logout(): Promise<void> {
    this.logoutInProgress = true
    try {
      const envKey = getActiveEnvKey()
      const legacyEnvKeys = getActiveLegacyEnvKeys()
      await this.suspendDesktopGfsUploadsForAuthBoundary()
      this.clearAuthenticatedSessionState()
      await this.tokenStore.clearSessionToken(envKey, { legacyEnvKeys })
      // Grants survive logout (they are keyed by userId), but every cached SDK
      // result must not: the next user of this machine gets nothing of this one's.
      tryGetPluginSdkRuntime()?.notifySessionChanged(false)
    } finally {
      this.logoutInProgress = false
    }
  }

  /** Resolve a gfs:// URI to its current resource via the API (no local mirror). */
  async resolveGfsUri(uri: string) {
    return this.gfsClient.resolveUri(uri, this.requireSessionToken())
  }

  /** Resolve then download a gfs:// resource's bytes through the brokered proxy. */
  async downloadGfsUri(uri: string) {
    return this.gfsClient.download(uri, this.requireSessionToken())
  }

  /** List a gfs directory's children (deny-by-default: only what the user is granted). */
  async listGfsChildren(resourceId: string, drive?: string, cursor?: string) {
    return this.gfsClient.listChildren(resourceId, this.requireSessionToken(), { drive, cursor })
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
   * `inherit` is renderer-driven (agent grants on directories default it ON so
   * contained files are covered); omitted means the client's historical `false`.
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
      console.warn('[AppService] Could not read GFS upload state:', error)
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
    const pending = { controller, promise: Promise.resolve() as Promise<unknown> }
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
            console.warn('[AppService] GFS upload job failed:', error)
          }
          if (this.gfsUploadJobs.get(session.uploadId)?.job === job) {
            this.gfsUploadJobs.delete(session.uploadId)
          }
        }
      )
      .catch(error => console.warn('[AppService] Could not persist GFS upload failure:', error))
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
   */
  async moveGfsResource(
    resourceId: string,
    destinationId: string,
    drive?: string,
    ifMatch?: number
  ) {
    return this.gfsClient.moveResource(
      { resourceId, drive, destinationId, ifMatch },
      this.requireSessionToken()
    )
  }

  async deleteGfsResource(resourceId: string, drive?: string, ifMatch?: number) {
    return this.gfsClient.deleteResource({ resourceId, drive, ifMatch }, this.requireSessionToken())
  }

  private requireSessionToken(): string {
    if (!this.sessionToken) {
      throw new Error('Not authenticated')
    }
    return this.sessionToken
  }

  async getSessionState(): Promise<SessionState> {
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
    return { authenticated: true, me: this.me }
  }

  /**
   * Synchronous read of the cached session user id. The plugin SDK broker needs
   * the current user to key grants and audit lines on every request, and it
   * cannot await mid-decision without opening a window where a logout races the
   * consent check. Returns null whenever there is no live session.
   */
  getCachedUserId(): string | null {
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
          console.warn(`[AppService] Failed loading approvals for team ${teamId}:`, error)
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
    const result = await this.runWithTeamContext(targetTeamId, token =>
      this.authClient.decideWorkflowApproval(token, approvalId, decision, note)
    )
    this.workflowApprovalTeamById.delete(approvalId)
    return result
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
          console.warn(`[AppService] Failed loading workflows for team ${teamId}:`, error)
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
    return this.runWithTeamContext(teamId, token =>
      this.authClient.triggerWorkflow(token, ns, name, body, idempotencyKey)
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

  async switchTeam(teamId: string): Promise<SessionState> {
    const targetTeamId = String(teamId || '').trim()
    if (!targetTeamId) throw new Error('teamId is required')
    const previousIdentity =
      this.gfsScopeIdentity ?? (this.me ? desktopGfsUploadIdentity(this.me) : undefined)
    // Keep the new team token fenced until the old GFS jobs have been
    // suspended. `switchSessionToTeam` has its own nested gate, but releases
    // it when the token exchange returns; this outer gate closes that small
    // interval before the auth-boundary persistence completes.
    const releaseTransientHop = this.enterGfsTransientTeamHop()
    try {
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
      await this.switchSessionToTeam(targetTeamId)
      if (!this.me) throw new Error('Team switch ended without an authenticated session')
      // A deliberate user switch is the only team-context boundary that fences
      // in-flight uploads. Transient runWithTeamContext hops intentionally use
      // switchSessionToTeam directly and must leave those jobs untouched.
      try {
        await this.suspendDesktopGfsUploadsForAuthBoundary(previousIdentity)
      } catch (error) {
        // The replacement session is already installed at this point. If the
        // auth-boundary state write fails, do not leave that token/me paired
        // with a blocked or stale GFS scope. Cleanup remains inside the outer
        // transient-hop gate, and the original persistence error is preserved.
        this.clearAuthenticatedSessionState()
        try {
          await this.tokenStore.clearSessionToken(getActiveEnvKey(), {
            legacyEnvKeys: getActiveLegacyEnvKeys(),
          })
        } catch (clearError) {
          console.warn(
            '[AppService] Failed to clear a partially switched team session:',
            clearError
          )
        }
        throw error
      }
      this.activateGfsAuthScope()
      this.stopAllStreams()
      // Grants are keyed by userId, not by team, so they carry over — but every
      // cached org/agents/contexts answer is now about the wrong team. Drop the
      // cache and tell mounted plugins to refetch.
      tryGetPluginSdkRuntime()?.notifySessionChanged(true)
      return { authenticated: true, me: this.me }
    } finally {
      releaseTransientHop()
    }
  }

  async refreshAccessCatalog(): Promise<AccessCatalog> {
    this.rpcTokenManager.clear()
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
        this.rpcTokenManager.clear()
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
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    const rpc = await this.issueRpcTokenForHostRefs(
      HOST_WAKEABLE_OPERATION_SCOPES,
      effectiveHostRefs
    )
    const outgoingAttachmentCount = Array.isArray(request.attachments)
      ? request.attachments.length
      : 0
    if (outgoingAttachmentCount > 0) {
      console.info(
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
        this.rpcTokenManager.clear()
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
    const rpc = await this.issueRpcTokenForHostRefs(
      HOST_WAKEABLE_OPERATION_SCOPES,
      effectiveHostRefs
    )
    try {
      return await this.rpcClient.getTaskResult(rpc.token, targetHostRef, targetTaskId)
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.rpcTokenManager.clear()
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
    const rpc = await this.issueRpcTokenForHostRefs(HOST_STATUS_SCOPES, effectiveHostRefs)
    try {
      return await this.rpcClient.getHostStatus(rpc.token, targetHostRef)
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.rpcTokenManager.clear()
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
      const rpc = await this.issueRpcTokenForHostRefs(
        HOST_WAKEABLE_OPERATION_SCOPES,
        effectiveHostRefs
      )
      const result = await this.rpcClient.prewarmHost(rpc.token, targetHostRef)
      if (result.status === 'wake-requested') {
        // HCC has not acted yet and its watch may have lost the event. Run
        // the bounded background re-emission tied to THIS catalog-driven
        // invocation — the renderer never awaits it, and the cooldown gate
        // (checked above, not refreshed by re-emits) keeps it single-flight.
        this.prewarmReemitLoopHostRefs.add(targetHostRef)
        void this.runPrewarmReemissionLoop(targetHostRef, rpc.token)
      }
      return { requested: true, status: result.status }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[AppService] prewarmHost failed host=${targetHostRef}: ${message}`)
      return { requested: false, error: message }
    }
  }

  /** Injectable so tests stay deterministic; fake timers advance it. */
  private prewarmReemitDelay = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms))

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
  private async runPrewarmReemissionLoop(hostRef: string, rpcToken: string): Promise<void> {
    try {
      for (let attempt = 1; attempt <= PREWARM_REEMIT_MAX_ATTEMPTS; attempt++) {
        await this.prewarmReemitDelay(PREWARM_REEMIT_INTERVAL_MS)
        const result = await this.rpcClient.prewarmHost(rpcToken, hostRef)
        console.info(
          `[AppService] prewarmHost re-emit host=${hostRef} attempt=${attempt} status=${result.status}`
        )
        if (result.status !== 'wake-requested') {
          return
        }
      }
      console.warn(
        `[AppService] prewarmHost re-emission gave up host=${hostRef} after ${PREWARM_REEMIT_MAX_ATTEMPTS} re-emits: wake still unacknowledged; the reactive message path will cover the user's message`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[AppService] prewarmHost re-emit failed host=${hostRef}: ${message}`)
    } finally {
      this.prewarmReemitLoopHostRefs.delete(hostRef)
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
    const rpc = await this.issueRpcTokenForHostRefs(HOST_ACTIVITY_SCOPES, effectiveHostRefs)
    try {
      return await this.rpcClient.getHostActivity(rpc.token, targetHostRef, {
        limit: options?.limit,
        sinceEventId: options?.sinceEventId,
      })
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.rpcTokenManager.clear()
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
    this.requireSessionToken()

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
              this.rpcTokenManager.clear()
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
          this.rpcTokenManager.clear()
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
    this.requireSessionToken()

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
              this.rpcTokenManager.clear()
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
          this.rpcTokenManager.clear()
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
    this.requireSessionToken()

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
          this.rpcTokenManager.clear()
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
              this.rpcTokenManager.clear()
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
        this.rpcTokenManager.clear()
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
    const rpc = await this.issueRpcTokenForHostRefs(HOST_WAKEABLE_OPERATION_SCOPES, [targetHostRef])
    try {
      await this.rpcClient.cancelTask(rpc.token, targetHostRef, targetTaskId)
    } catch (error) {
      // §4.5-7: retry once after a token refresh (previously a 401 here failed
      // outright, unlike invoke/getTaskResult).
      if (AppService.shouldRefreshRpcToken(error)) {
        this.rpcTokenManager.clear()
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
        this.rpcTokenManager.clear()
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
    const rpc = await this.issueRpcTokenForHostRefs(HOST_ARTIFACT_SCOPES, effectiveHostRefs)
    return this.rpcClient.listArtifacts(rpc.token, targetHostRef)
  }

  async downloadArtifact(hostRef: string, filename: string, hostRefs?: string[]): Promise<Buffer> {
    const targetHostRef = String(hostRef || '').trim()
    if (!targetHostRef || !filename) throw new Error('hostRef and filename are required')
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
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
    const rpc = await this.issueRpcTokenForHostRefs(HOST_SESSION_SCOPES, effectiveHostRefs)
    try {
      return await this.rpcClient.listSessions(rpc.token, targetHostRef, query)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('401') && message.toLowerCase().includes('missing token')) {
        console.warn(
          '[AppService] Session catalog unavailable because the runtime rejected the session token.'
        )
        return { items: [] }
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
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('401') && message.toLowerCase().includes('missing token')) {
        console.warn(
          '[AppService] Session messages unavailable because the runtime rejected the session token.'
        )
        return {
          agent,
          chatId,
          turns: [],
          totalTurns: 0,
          hasMoreBefore: false,
          hasMoreAfter: false,
        }
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
    const rpc = await this.issueRpcTokenForHostRefs(HOST_SESSION_SCOPES, effectiveHostRefs)
    try {
      return await this.rpcClient.getContextBreakdown(rpc.token, targetHostRef, agent, chatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('401') && message.toLowerCase().includes('missing token')) {
        console.warn(
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
    const rpc = await this.issueRpcTokenForHostRefs(HOST_SESSION_SCOPES, effectiveHostRefs)
    try {
      return await this.rpcClient.getHostModels(rpc.token, targetHostRef, targetChatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('401') && message.toLowerCase().includes('missing token')) {
        console.warn(
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
    hostRefs?: string[]
  ): Promise<SetHostModelResult> {
    const targetHostRef = String(hostRef || '').trim()
    const targetModel = String(model || '').trim()
    if (!targetHostRef || !chatId || !targetModel) {
      throw new Error('hostRef, chatId, and model are required')
    }
    const effectiveHostRefs = hostRefs && hostRefs.length > 0 ? hostRefs : [targetHostRef]
    const rpc = await this.issueRpcTokenForHostRefs(HOST_MODEL_SCOPES, effectiveHostRefs)
    return this.rpcClient.setHostModel(rpc.token, targetHostRef, chatId, targetModel)
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
    const rpc = await this.issueRpcTokenForHostRefs(DESKTOP_VIEW_SCOPES, [targetHostRef])
    try {
      return await this.rpcClient.getDesktopStatus(rpc.token, targetHostRef)
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.rpcTokenManager.clear()
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
    const rpc = await this.issueRpcTokenForHostRefs(DESKTOP_VIEW_SCOPES, [targetHostRef])
    const { openDesktopWindow } = await import('./desktopWindow.js')
    await openDesktopWindow({
      hostRef: targetHostRef,
      jwt: rpc.token,
      rpcProxyUrl: config.rpcProxyBaseUrl,
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
    const rpc = await this.rpcTokenManager.getOrIssue(token, SANDBOX_UI_VIEW_SCOPES, [
      SANDBOX_UI_HOST_REF_SENTINEL,
    ])
    try {
      return await this.rpcClient.listSandboxUiApps(rpc.token)
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.rpcTokenManager.clear()
        const retried = await this.rpcTokenManager.getOrIssue(token, SANDBOX_UI_VIEW_SCOPES, [
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
    const rpc = await this.rpcTokenManager.getOrIssue(token, SANDBOX_UI_VIEW_SCOPES, [
      SANDBOX_UI_HOST_REF_SENTINEL,
    ])
    try {
      return await this.rpcClient.mintSandboxUiSession(rpc.token, ns, name)
    } catch (error) {
      if (AppService.shouldRefreshRpcToken(error)) {
        this.rpcTokenManager.clear()
        const retried = await this.rpcTokenManager.getOrIssue(token, SANDBOX_UI_VIEW_SCOPES, [
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
    const token = this.requireSessionToken()
    const issueRpc = () =>
      this.rpcTokenManager.getOrIssue(token, SANDBOX_UI_VIEW_SCOPES, [SANDBOX_UI_HOST_REF_SENTINEL])
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
        this.rpcTokenManager.clear()
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
        this.rpcTokenManager.clear()
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
        this.rpcTokenManager.clear()
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
        this.rpcTokenManager.clear()
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
   * re-opening recipe B while A is up tears down A first (the driver enforces
   * this). This keeps memory + GPU usage bounded and avoids accidental
   * cross-recipe focus / cookie-jar mixups.
   */
  openSandboxUi(args: {
    recipeNs: string
    recipeName: string
    title?: string
    defaultPath?: string
    routePath?: string
    bounds: import('./sandboxUiDriver.js').SandboxUiBounds
    parentWindow: import('electron').BrowserWindow
    onClosed?: () => void
    onRefreshError?: (message: string) => void
    onOauthError?: (message: string) => void
  }): Promise<void> {
    return this.enqueueSandboxUiLifecycle(() => this.openSandboxUiNow(args))
  }

  private async openSandboxUiNow(args: {
    recipeNs: string
    recipeName: string
    title?: string
    defaultPath?: string
    routePath?: string
    bounds: import('./sandboxUiDriver.js').SandboxUiBounds
    parentWindow: import('electron').BrowserWindow
    onClosed?: () => void
    onRefreshError?: (message: string) => void
    onOauthError?: (message: string) => void
  }): Promise<void> {
    const recipeNs = String(args.recipeNs || '').trim()
    const recipeName = String(args.recipeName || '').trim()
    if (!recipeNs || !recipeName) throw new Error('recipeNs and recipeName are required')
    this.sandboxUiGeneration += 1
    const { setCookie } = await this.mintSandboxUiSession(recipeNs, recipeName)
    const driver = await import('./sandboxUiDriver.js')
    const refreshModule = await import('./sandboxUiSessionRefresh.js')
    await driver.mountSandboxUiView({
      recipeNs,
      recipeName,
      setCookie,
      rpcProxyUrl: config.rpcProxyBaseUrl,
      defaultPath: args.defaultPath,
      routePath: args.routePath,
      parentWindow: args.parentWindow,
      bounds: args.bounds,
      onClosed: () => {
        // Cancel refresh first so the timer doesn't keep firing against a
        // partition we're about to evict on the next mount.
        refreshModule.cancelSandboxUiRefresh()
        // Unpin before anything else can observe a dead surface as pinned:
        // per-mount SDK state (session denials, prompt budget, rate budget)
        // dies with the mount.
        tryGetPluginSdkRuntime()?.unpinAllSandboxUiSurfaces()
        args.onClosed?.()
      },
      onGfsOpen: uri => {
        const active = tryGetPluginSdkRuntime()
        const surface = driver.getActiveSandboxUi()
        if (!active || !surface) return
        void active.openGfsResourceFromNavigation(surface.webContentsId, uri)
      },
      onOauthAuthorize: (oauthClientId, background) => {
        void this.requestSandboxUiOauthAuthorize(
          recipeNs,
          recipeName,
          oauthClientId,
          background
        ).catch(err => {
          const message = err instanceof Error ? err.message : String(err)
          console.warn('[SandboxUI] oauth authorize-url fetch failed:', message)
          args.onOauthError?.(message)
        })
      },
    })
    const activeView = driver.getActiveSandboxUi()
    if (!activeView || activeView.appRef !== `${recipeNs}/${recipeName}`) {
      // A queued close or newer mount can invalidate this operation while an
      // async cookie write is in flight. Do not cross-wire its refresh loop
      // to whichever recipe is active now.
      return
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
      refresh: (ns, name) => this.mintSandboxUiSession(ns, name),
      installCookie: setCookieValue => driver.installSandboxUiCookie(setCookieValue),
      onError: err => {
        args.onRefreshError?.(err instanceof Error ? err.message : String(err))
      },
    })
  }

  closeSandboxUi(): Promise<void> {
    return this.enqueueSandboxUiLifecycle(async () => {
      const driver = await import('./sandboxUiDriver.js')
      const refreshModule = await import('./sandboxUiSessionRefresh.js')
      refreshModule.cancelSandboxUiRefresh()
      tryGetPluginSdkRuntime()?.unpinAllSandboxUiSurfaces()
      await driver.unmountSandboxUiView()
    })
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

  // In-place hard-reload of the active embed (user-initiated "Refresh"). The
  // session cookie is still valid, so this only reloads page content — it does
  // NOT re-mint the session or cancel the refresh timer. No-op when nothing is
  // mounted.
  async reloadSandboxUi(): Promise<void> {
    const driver = await import('./sandboxUiDriver.js')
    driver.reloadActiveSandboxUiView()
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
