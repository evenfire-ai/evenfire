import { createHash, randomBytes } from 'node:crypto'
import type { DbClient } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import {
  type GrokCatalogOutcome,
  type GrokCatalogTransport,
  rebuildLiveGrokUnionAllowlist,
  syncGrokSubscriptionCatalog,
} from './grokSubscriptionCatalog.js'
import {
  GrokSubscriptionFingerprintConflictError,
  type GrokSubscriptionSafeConnection,
  GrokSubscriptionStaleRevisionError,
  acquireGrokSubscriptionRefreshLock,
  assertGrokConnectionKey,
  getSafeGrokSubscriptionConnection,
  insertInitialGrokSubscriptionConnection,
  loadGrokSubscriptionSecrets,
  markGrokRefreshSubjectMismatch,
  persistGrokRefreshCiphertextFirst,
  releaseGrokSubscriptionRefreshLock,
  revokeGrokSubscriptionConnection,
  rotateGrokSubscriptionCredentials,
  updateGrokAccessTokenInPlace,
} from './grokSubscriptionConnection.js'
import {
  type GrokSubscriptionOAuthIntent,
  type GrokSubscriptionOAuthSafeState,
  cancelGrokSubscriptionOAuthState,
  consumeGrokSubscriptionOAuthState,
  expireGrokSubscriptionOAuthState,
  insertGrokSubscriptionOAuthState,
  peekPendingGrokSubscriptionOAuthState,
} from './grokSubscriptionOAuthState.js'

const log = rootLogger.child({ module: 'grok-subscription-oauth' })

export const GROK_OAUTH_DEVICE_URL = 'https://auth.x.ai/oauth2/device/code'
export const GROK_OAUTH_TOKEN_URL = 'https://auth.x.ai/oauth2/token'
export const GROK_OAUTH_REVOKE_URL = 'https://auth.x.ai/oauth2/revoke'
export const GROK_OAUTH_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
export const GROK_OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'grok-cli:access',
  'api:access',
  'conversations:read',
  'conversations:write',
] as const

const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60
const TOKEN_TIMEOUT_MS = 15_000
const REFRESH_LOCK_TTL_MS = 30_000
const REFRESH_LOCK_POLL_MS = 200
const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60_000

function accessTokenIsUsable(secrets: {
  accessToken?: string | null
  accessTokenExpiresAt?: Date | null
}): boolean {
  if (!secrets.accessToken) return false
  return secrets.accessTokenExpiresAt == null || secrets.accessTokenExpiresAt.getTime() > Date.now()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export type GrokOAuthErrorCode =
  | 'disabled'
  | 'not_connected'
  | 'state_replayed'
  | 'state_expired'
  | 'state_cancelled'
  | 'replacement_required'
  | 'stale_revision'
  | 'refresh_in_flight'
  | 'provider_unavailable'
  | 'no_grant'
  | 'invalid_callback'
  | 'fingerprint_in_use'
  | 'connection_mismatch'
  | 'reauth_required'

const GROK_OAUTH_ERROR_CODES: ReadonlySet<GrokOAuthErrorCode> = new Set([
  'disabled',
  'not_connected',
  'state_replayed',
  'state_expired',
  'state_cancelled',
  'replacement_required',
  'stale_revision',
  'refresh_in_flight',
  'provider_unavailable',
  'no_grant',
  'invalid_callback',
  'fingerprint_in_use',
  'connection_mismatch',
  'reauth_required',
])

export function isGrokOAuthErrorCode(value: string): value is GrokOAuthErrorCode {
  return GROK_OAUTH_ERROR_CODES.has(value as GrokOAuthErrorCode)
}

export class GrokSubscriptionOAuthError extends Error {
  readonly code: GrokOAuthErrorCode

  constructor(code: GrokOAuthErrorCode, message: string) {
    super(message)
    this.name = 'GrokSubscriptionOAuthError'
    this.code = code
  }
}

export type GrokOAuthDeps = {
  db: DbClient
  encryptionKey: Buffer
  fetchFn: typeof fetch
  clientId: string
  enabled: boolean
  connectionKey: string
}

function connectionKeyOf(deps: GrokOAuthDeps): string {
  return assertGrokConnectionKey(deps.connectionKey)
}

function completionConnectionKey(deps: GrokOAuthDeps, stateKey: string): string {
  const target = assertGrokConnectionKey(stateKey)
  const requested = connectionKeyOf(deps)
  if (requested !== target) {
    log.warn(
      { event: 'grok_oauth_connection_mismatch', requested, target },
      'OAuth completion key does not match the state'
    )
    throw new GrokSubscriptionOAuthError(
      'connection_mismatch',
      'OAuth state is bound to a different connection'
    )
  }
  return target
}

function requireEnabled(deps: GrokOAuthDeps): void {
  if (!deps.enabled) {
    throw new GrokSubscriptionOAuthError('disabled', 'Grok subscription is disabled')
  }
}

export type GrokDeviceStartResult = {
  userCode: string
  verificationUri: string
  verificationUriComplete: string | null
  intervalSeconds: number
  expiresAt: Date
  state: string
  intent: GrokSubscriptionOAuthIntent
}

export type GrokDevicePollResult =
  | {
      status: 'pending' | 'slow_down'
      intervalSeconds: number
      state: GrokSubscriptionOAuthSafeState
    }
  | { status: 'expired' | 'denied' }
  | { status: 'connected'; connection: GrokSubscriptionSafeConnection }

export type GrokCatalogSyncResult =
  | { ok: true; catalogStatus: 'ready'; connection: GrokSubscriptionSafeConnection }
  | {
      ok: false
      catalogStatus: GrokCatalogOutcome | 'never_synced'
      reason?: GrokOAuthErrorCode | 'catalog_sync_failed' | 'stale_revision' | 'no_grant'
    }

export async function getGrokSubscriptionConnection(
  deps: GrokOAuthDeps
): Promise<GrokSubscriptionSafeConnection | { connectionKey: string; status: 'disconnected' }> {
  requireEnabled(deps)
  const row = await getSafeGrokSubscriptionConnection(deps.db, connectionKeyOf(deps))
  return row ?? { connectionKey: connectionKeyOf(deps), status: 'disconnected' }
}

export async function startGrokDeviceConnect(
  deps: GrokOAuthDeps,
  intent: GrokSubscriptionOAuthIntent = 'connect'
): Promise<GrokDeviceStartResult> {
  requireEnabled(deps)
  const connectionKey = connectionKeyOf(deps)
  const started = await postForm(deps, GROK_OAUTH_DEVICE_URL, {
    client_id: deps.clientId,
    scope: GROK_OAUTH_SCOPES.join(' '),
  })
  if (!started.ok) {
    throw new GrokSubscriptionOAuthError('provider_unavailable', 'device authorization failed')
  }
  const body = started.body
  const deviceCode = requiredString(body.device_code, 'device_code')
  const userCode = requiredString(body.user_code, 'user_code')
  const verificationUri = assertVerificationUri(
    typeof body.verification_uri === 'string' ? body.verification_uri : ''
  )
  const verificationUriComplete =
    typeof body.verification_uri_complete === 'string' && body.verification_uri_complete
      ? assertVerificationUri(body.verification_uri_complete)
      : null
  const intervalSeconds = parsePositiveNumber(body.interval, 5)
  const expiresAt = parseDeviceExpiry(body)
  const state = randomBytes(24).toString('base64url')
  const safe = await insertGrokSubscriptionOAuthState(deps.db, deps.encryptionKey, {
    state,
    intent,
    deviceCode,
    expiresAt,
    connectionKey,
  })
  log.info({ event: 'grok_oauth_device_start', intent: safe.intent }, 'device OAuth start')
  return {
    userCode,
    verificationUri,
    verificationUriComplete,
    intervalSeconds,
    expiresAt: safe.expiresAt,
    state,
    intent: safe.intent,
  }
}

export async function pollGrokDevice(
  deps: GrokOAuthDeps,
  state: string
): Promise<GrokDevicePollResult> {
  requireEnabled(deps)
  const pending = await peekPendingGrokSubscriptionOAuthState(deps.db, deps.encryptionKey, state)
  if (!pending) {
    throw new GrokSubscriptionOAuthError('state_replayed', 'device state is not pending')
  }
  completionConnectionKey(deps, pending.safe.connectionKey)
  if (pending.safe.expiresAt.getTime() <= Date.now()) {
    await expireGrokSubscriptionOAuthState(deps.db, state)
    return { status: 'expired' }
  }
  if (!pending.deviceCode) {
    throw new GrokSubscriptionOAuthError(
      'invalid_callback',
      'device state is missing a device code'
    )
  }
  const tokenResult = await pollDeviceAuthorization(deps, pending.deviceCode)
  if (tokenResult.kind === 'pending') {
    return { status: 'pending', intervalSeconds: tokenResult.intervalSeconds, state: pending.safe }
  }
  if (tokenResult.kind === 'slow_down') {
    return {
      status: 'slow_down',
      intervalSeconds: tokenResult.intervalSeconds,
      state: pending.safe,
    }
  }
  if (tokenResult.kind === 'expired') {
    await expireGrokSubscriptionOAuthState(deps.db, state)
    return { status: 'expired' }
  }
  if (tokenResult.kind === 'denied') {
    await cancelGrokSubscriptionOAuthState(deps.db, state)
    return { status: 'denied' }
  }
  const consumed = await consumeGrokSubscriptionOAuthState(deps.db, deps.encryptionKey, state)
  if (!consumed) {
    throw new GrokSubscriptionOAuthError('state_replayed', 'device state was consumed concurrently')
  }
  const connection = await persistGrantedTokens(
    deps,
    consumed.safe.intent,
    tokenResult.parsed,
    completionConnectionKey(deps, consumed.safe.connectionKey)
  )
  return { status: 'connected', connection }
}

export async function refreshGrokSubscriptionConnection(
  deps: GrokOAuthDeps
): Promise<GrokSubscriptionSafeConnection> {
  requireEnabled(deps)
  const key = connectionKeyOf(deps)
  const current = await getSafeGrokSubscriptionConnection(deps.db, key)
  if (!current || current.status === 'revoked' || current.status === 'disconnected') {
    throw new GrokSubscriptionOAuthError('not_connected', 'no active Grok subscription')
  }
  const lockToken = randomBytes(16).toString('hex')
  const locked = await acquireGrokSubscriptionRefreshLock(
    deps.db,
    lockToken,
    REFRESH_LOCK_TTL_MS,
    key
  )
  if (!locked) {
    throw new GrokSubscriptionOAuthError('refresh_in_flight', 'another refresh holds the lock')
  }
  try {
    return await rotateLockedRefresh(deps, key, lockToken)
  } finally {
    await releaseGrokSubscriptionRefreshLock(deps.db, lockToken, key)
  }
}

export async function revokeGrokSubscription(
  deps: GrokOAuthDeps
): Promise<GrokSubscriptionSafeConnection | { connectionKey: string; status: 'disconnected' }> {
  requireEnabled(deps)
  const key = connectionKeyOf(deps)
  const secrets = await loadGrokSubscriptionSecrets(deps.db, deps.encryptionKey, key)
  const local = await revokeGrokSubscriptionConnection(deps.db, key)
  await rebuildLiveGrokUnionAllowlist(deps.db)
  if (secrets?.refreshToken) {
    try {
      await postForm(deps, GROK_OAUTH_REVOKE_URL, {
        token_type_hint: 'refresh_token',
        client_id: deps.clientId,
        token: secrets.refreshToken,
      })
    } catch (err) {
      log.warn({ event: 'grok_oauth_upstream_revoke_failed', err }, 'upstream revoke failed')
    }
  }
  log.info({ event: 'grok_oauth_revoked_local' }, 'local Grok subscription revoked')
  return local ?? { connectionKey: key, status: 'disconnected' }
}

export async function ensureFreshGrokAccessToken(deps: GrokOAuthDeps): Promise<void> {
  requireEnabled(deps)
  const key = connectionKeyOf(deps)
  const secrets = await loadGrokSubscriptionSecrets(deps.db, deps.encryptionKey, key)
  if (!secrets) {
    throw new GrokSubscriptionOAuthError('no_grant', 'encrypted refresh token missing')
  }
  const expiring =
    secrets.accessTokenExpiresAt != null &&
    secrets.accessTokenExpiresAt.getTime() - Date.now() < ACCESS_TOKEN_REFRESH_SKEW_MS
  if (secrets.accessToken && !expiring) return

  let lockToken = randomBytes(16).toString('hex')
  let locked = await acquireGrokSubscriptionRefreshLock(
    deps.db,
    lockToken,
    REFRESH_LOCK_TTL_MS,
    key
  )
  if (!locked) {
    const deadline = Date.now() + REFRESH_LOCK_TTL_MS
    while (true) {
      await sleep(REFRESH_LOCK_POLL_MS)
      const latest = await loadGrokSubscriptionSecrets(deps.db, deps.encryptionKey, key)
      if (!latest) {
        throw new GrokSubscriptionOAuthError('no_grant', 'encrypted refresh token missing')
      }
      if (accessTokenIsUsable(latest)) return
      if (Date.now() >= deadline) {
        throw new GrokSubscriptionOAuthError('refresh_in_flight', 'another refresh holds the lock')
      }
      lockToken = randomBytes(16).toString('hex')
      locked = await acquireGrokSubscriptionRefreshLock(
        deps.db,
        lockToken,
        REFRESH_LOCK_TTL_MS,
        key
      )
      if (locked) break
    }
  }
  try {
    await rotateLockedRefresh(deps, key, lockToken)
  } finally {
    await releaseGrokSubscriptionRefreshLock(deps.db, lockToken, key)
  }
}

export async function runGrokCatalogSync(
  deps: GrokOAuthDeps,
  connectionKey: string,
  transport: GrokCatalogTransport
): Promise<GrokCatalogSyncResult> {
  const key = assertGrokConnectionKey(connectionKey)
  try {
    const keyed = { ...deps, connectionKey: key }
    await ensureFreshGrokAccessToken(keyed)
    const secrets = await loadGrokSubscriptionSecrets(deps.db, deps.encryptionKey, key)
    if (!secrets?.accessToken) {
      return { ok: false, catalogStatus: 'never_synced', reason: 'no_grant' }
    }
    const synced = await syncGrokSubscriptionCatalog(deps.db, transport, secrets.accessToken, {
      connectionKey: key,
    })
    if (!synced.connection) {
      return { ok: false, catalogStatus: 'never_synced', reason: 'stale_revision' }
    }
    if (synced.outcome !== 'ready') {
      return { ok: false, catalogStatus: synced.outcome }
    }
    return { ok: true, catalogStatus: 'ready', connection: synced.connection }
  } catch (err) {
    log.warn(
      { err, event: 'grok_catalog_auto_sync_failed', connectionKey: key },
      'automatic catalog sync after grant failed'
    )
    const reason: GrokOAuthErrorCode | 'catalog_sync_failed' =
      err instanceof GrokSubscriptionOAuthError ? err.code : 'catalog_sync_failed'
    return { ok: false, catalogStatus: 'never_synced', reason }
  }
}

async function rotateLockedRefresh(
  deps: GrokOAuthDeps,
  key: string,
  lockToken: string
): Promise<GrokSubscriptionSafeConnection> {
  const secrets = await loadGrokSubscriptionSecrets(deps.db, deps.encryptionKey, key)
  if (!secrets) {
    throw new GrokSubscriptionOAuthError('no_grant', 'encrypted refresh token missing')
  }
  const current = await getSafeGrokSubscriptionConnection(deps.db, key)
  const observedRevision = secrets.credentialRevision
  const pair = await exchangeRefreshToken(deps, secrets.refreshToken, {
    expectedRevision: observedRevision,
    lockToken,
    connectionKey: key,
  })
  try {
    const persisted = await persistGrokRefreshCiphertextFirst(deps.db, deps.encryptionKey, {
      connectionKey: key,
      expectedRevision: observedRevision,
      lockToken,
      refreshToken: pair.refreshToken,
    })
    let subject: string
    try {
      subject = subjectFromTokens(pair.idToken, pair.accessToken)
    } catch (err) {
      const marked = await markGrokRefreshSubjectMismatch(
        deps.db,
        key,
        persisted.credentialRevision
      )
      if (marked) return marked
      throw err
    }
    const accountFingerprint = fingerprintAccount(subject)
    const updated = await updateGrokAccessTokenInPlace(
      deps.db,
      deps.encryptionKey,
      persisted.credentialRevision,
      {
        accessToken: pair.accessToken,
        accessTokenExpiresAt: pair.expiresAt,
      },
      key,
      lockToken
    )
    if (
      current?.accountFingerprint &&
      accountFingerprint &&
      current.accountFingerprint !== accountFingerprint
    ) {
      const marked = await markGrokRefreshSubjectMismatch(deps.db, key, updated.credentialRevision)
      return marked ?? { ...updated, status: 'reauth_required' }
    }
    return updated
  } catch (err) {
    if (err instanceof GrokSubscriptionStaleRevisionError) {
      throw new GrokSubscriptionOAuthError('stale_revision', 'refresh lost the credential race')
    }
    throw err
  }
}

async function persistGrantedTokens(
  deps: GrokOAuthDeps,
  intent: GrokSubscriptionOAuthIntent,
  parsed: ParsedGrokToken,
  connectionKey: string
): Promise<GrokSubscriptionSafeConnection> {
  const key = assertGrokConnectionKey(connectionKey)
  const existing = await getSafeGrokSubscriptionConnection(deps.db, key)
  if (existing?.revokedAt || existing?.status === 'revoked') {
    throw new GrokSubscriptionOAuthError(
      'not_connected',
      'revoked grant cannot be reused; create a new connection'
    )
  }
  if (
    existing?.accountFingerprint &&
    existing.accountFingerprint !== parsed.accountFingerprint &&
    intent !== 'replace'
  ) {
    throw new GrokSubscriptionOAuthError(
      'replacement_required',
      'different account requires an explicit replace intent'
    )
  }
  const write = {
    refreshToken: parsed.refreshToken,
    accessToken: parsed.accessToken,
    accessTokenExpiresAt: parsed.expiresAt,
    accountFingerprint: parsed.accountFingerprint,
    status: 'connected' as const,
  }
  if (!existing) {
    const created = await insertInitialGrokSubscriptionConnection(
      deps.db,
      deps.encryptionKey,
      write,
      key
    )
    log.info({ event: 'grok_oauth_persisted', connectionKey: key }, 'Grok grant persisted')
    return created
  }
  try {
    const rotated = await rotateGrokSubscriptionCredentials(
      deps.db,
      deps.encryptionKey,
      existing.credentialRevision,
      write,
      key
    )
    log.info({ event: 'grok_oauth_persisted', connectionKey: key }, 'Grok grant persisted')
    return rotated
  } catch (err) {
    if (err instanceof GrokSubscriptionStaleRevisionError) {
      throw new GrokSubscriptionOAuthError('stale_revision', 'connection was replaced concurrently')
    }
    if (err instanceof GrokSubscriptionFingerprintConflictError) {
      throw new GrokSubscriptionOAuthError(
        'fingerprint_in_use',
        'a live Grok subscription already uses this account'
      )
    }
    throw err
  }
}

type GrokTokenPair = {
  accessToken: string
  refreshToken: string
  expiresAt: Date | null
  idToken: string | null
}

type ParsedGrokToken = GrokTokenPair & {
  accountFingerprint: string
}

async function pollDeviceAuthorization(
  deps: GrokOAuthDeps,
  deviceCode: string
): Promise<
  | { kind: 'ok'; parsed: ParsedGrokToken }
  | { kind: 'pending'; intervalSeconds: number }
  | { kind: 'slow_down'; intervalSeconds: number }
  | { kind: 'expired' }
  | { kind: 'denied' }
> {
  const result = await postForm(deps, GROK_OAUTH_TOKEN_URL, {
    grant_type: GROK_OAUTH_DEVICE_GRANT,
    device_code: deviceCode,
    client_id: deps.clientId,
  })
  if (result.ok) {
    return { kind: 'ok', parsed: parseTokenResponse(result.body, { requireRefresh: true }) }
  }
  const error = readUpstreamErrorCode(result.body)
  if (error === 'authorization_pending') {
    return { kind: 'pending', intervalSeconds: parsePositiveNumber(result.body.interval, 5) }
  }
  if (error === 'slow_down') {
    return { kind: 'slow_down', intervalSeconds: parsePositiveNumber(result.body.interval, 10) }
  }
  if (error === 'expired_token') return { kind: 'expired' }
  if (error === 'access_denied') return { kind: 'denied' }
  if (result.status === 403) {
    throw new GrokSubscriptionOAuthError(
      'provider_unavailable',
      'device token poll was entitlement-denied'
    )
  }
  throw new GrokSubscriptionOAuthError('provider_unavailable', 'device token poll failed')
}

async function exchangeRefreshToken(
  deps: GrokOAuthDeps,
  refreshToken: string,
  fence: { expectedRevision: number; lockToken: string; connectionKey: string }
): Promise<GrokTokenPair> {
  const result = await postForm(deps, GROK_OAUTH_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: deps.clientId,
  })
  if (result.status === 402 || result.status === 403) {
    throw new GrokSubscriptionOAuthError('provider_unavailable', 'refresh was entitlement-denied')
  }
  if (!result.ok) {
    const error = readUpstreamErrorCode(result.body)
    if ((result.status === 400 || result.status === 401) && error === 'invalid_grant') {
      const latest = await loadGrokSubscriptionSecrets(
        deps.db,
        deps.encryptionKey,
        fence.connectionKey
      )
      const current = await getSafeGrokSubscriptionConnection(deps.db, fence.connectionKey)
      const lockChanged = !current?.refreshLockHeld
      const revisionChanged = latest?.credentialRevision !== fence.expectedRevision
      if (lockChanged || revisionChanged) {
        throw new GrokSubscriptionOAuthError(
          'stale_revision',
          'invalid_grant observed after a lost refresh race'
        )
      }
      await markGrokRefreshSubjectMismatch(deps.db, fence.connectionKey, fence.expectedRevision)
      throw new GrokSubscriptionOAuthError('reauth_required', 'refresh token was rejected')
    }
    throw new GrokSubscriptionOAuthError('provider_unavailable', 'refresh token exchange failed')
  }
  return readGrokTokenPair(result.body, { requireRefresh: true })
}

function readGrokTokenPair(
  body: Record<string, unknown>,
  opts: { requireRefresh: boolean }
): GrokTokenPair {
  const accessToken = requiredString(body.access_token, 'access_token')
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : ''
  if (opts.requireRefresh && !refreshToken) {
    throw new GrokSubscriptionOAuthError(
      'provider_unavailable',
      'token response omitted refresh_token'
    )
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null
  const idToken = typeof body.id_token === 'string' ? body.id_token : null
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    idToken,
  }
}

function parseTokenResponse(
  body: Record<string, unknown>,
  opts: { requireRefresh: boolean }
): ParsedGrokToken {
  const pair = readGrokTokenPair(body, opts)
  return {
    ...pair,
    accountFingerprint: fingerprintAccount(subjectFromTokens(pair.idToken, pair.accessToken)),
  }
}

function subjectFromTokens(idToken: string | null, accessToken: string): string {
  const fromId = subjectFromJwt(idToken)
  if (fromId) return fromId
  const fromAccess = subjectFromJwt(accessToken)
  if (fromAccess) return fromAccess
  throw new GrokSubscriptionOAuthError('invalid_callback', 'token response omitted a subject')
}

function subjectFromJwt(token: string | null): string | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      sub?: unknown
    }
    if (typeof payload.sub === 'string' && payload.sub.length > 0) return payload.sub
  } catch {
    return null
  }
  return null
}

function fingerprintAccount(subject: string): string {
  return createHash('sha256').update(subject, 'utf8').digest('hex')
}

function assertVerificationUri(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new GrokSubscriptionOAuthError(
      'provider_unavailable',
      'device verification URI is invalid'
    )
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'auth.x.ai') {
    throw new GrokSubscriptionOAuthError(
      'provider_unavailable',
      'device verification URI origin is not frozen'
    )
  }
  return parsed.toString()
}

async function postForm(
  deps: GrokOAuthDeps,
  url: string,
  params: Record<string, string>
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  return post(deps, url, new URLSearchParams(params).toString())
}

async function post(
  deps: GrokOAuthDeps,
  url: string,
  body: string
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  let response: Response
  try {
    response = await deps.fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    })
  } catch (err) {
    log.warn({ event: 'grok_oauth_upstream_unreachable', err }, 'Grok OAuth upstream unreachable')
    throw new GrokSubscriptionOAuthError('provider_unavailable', 'Grok OAuth upstream unreachable')
  }
  if (response.status >= 300 && response.status < 400) {
    log.warn(
      { event: 'grok_oauth_redirect_denied', status: response.status },
      'Grok OAuth upstream returned a redirect'
    )
    throw new GrokSubscriptionOAuthError(
      'provider_unavailable',
      'Grok OAuth upstream returned a redirect'
    )
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: response.ok, status: response.status, body: json }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value
  throw new GrokSubscriptionOAuthError('provider_unavailable', `upstream omitted ${field}`)
}

function readUpstreamErrorCode(body: Record<string, unknown>): string {
  const error = body.error
  if (typeof error === 'string') return error
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code
  }
  return ''
}

function parsePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return fallback
}

function parseDeviceExpiry(body: Record<string, unknown>): Date {
  if (typeof body.expires_at === 'string') {
    const parsed = new Date(body.expires_at)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  const expiresIn = parsePositiveNumber(body.expires_in, DEVICE_CODE_TIMEOUT_SECONDS)
  return new Date(Date.now() + expiresIn * 1000)
}
