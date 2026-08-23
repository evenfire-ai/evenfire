import { createHash, randomBytes } from 'node:crypto'
import type { DbClient } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import { chatgptAccountIdFromJwt } from './chatgptAccountId.js'
import { rebuildLiveCodexUnionAllowlist } from './codexSubscriptionCatalog.js'
import {
  CodexSubscriptionFingerprintConflictError,
  type CodexSubscriptionSafeConnection,
  CodexSubscriptionStaleRevisionError,
  acquireCodexSubscriptionRefreshLock,
  getSafeCodexSubscriptionConnection,
  insertInitialCodexSubscriptionConnection,
  loadCodexSubscriptionSecrets,
  normalizeCodexConnectionKey,
  persistCodexChatgptAccountId,
  releaseCodexSubscriptionRefreshLock,
  revokeCodexSubscriptionConnection,
  rotateCodexSubscriptionCredentials,
  updateCodexAccessTokenInPlace,
} from './codexSubscriptionConnection.js'
import {
  type CodexSubscriptionOAuthIntent,
  type CodexSubscriptionOAuthSafeState,
  cancelCodexSubscriptionOAuthState,
  consumeCodexSubscriptionOAuthState,
  expireCodexSubscriptionOAuthState,
  insertCodexSubscriptionOAuthState,
  peekPendingCodexSubscriptionOAuthState,
} from './codexSubscriptionOAuthState.js'

const log = rootLogger.child({ module: 'codex-subscription-oauth' })

export const CODEX_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
/** Prefix shared by the Codex CLI device-auth routes. */
export const CODEX_OAUTH_DEVICE_URL = 'https://auth.openai.com/api/accounts/deviceauth'
export const CODEX_OAUTH_DEVICE_USERCODE_URL = `${CODEX_OAUTH_DEVICE_URL}/usercode`
export const CODEX_OAUTH_DEVICE_TOKEN_URL = `${CODEX_OAUTH_DEVICE_URL}/token`
export const CODEX_OAUTH_DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device'
export const CODEX_OAUTH_DEVICE_CALLBACK_URI = 'https://auth.openai.com/deviceauth/callback'
export const CODEX_OAUTH_REVOKE_URL = 'https://auth.openai.com/oauth/revoke'
export const CODEX_OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60

const TOKEN_TIMEOUT_MS = 15_000
const REFRESH_LOCK_TTL_MS = 30_000
const BROWSER_STATE_TTL_MS = 10 * 60_000
const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60_000

export type CodexOAuthErrorCode =
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
  | 'browser_oauth_unregistered'
  | 'fingerprint_in_use'

export class CodexSubscriptionOAuthError extends Error {
  readonly code: CodexOAuthErrorCode

  constructor(code: CodexOAuthErrorCode, message: string) {
    super(message)
    this.name = 'CodexSubscriptionOAuthError'
    this.code = code
  }
}

export type CodexOAuthDeps = {
  db: DbClient
  encryptionKey: Buffer
  fetchFn: typeof fetch
  clientId: string
  redirectUri: string
  enabled: boolean
  connectionKey?: string
}

function connectionKeyOf(deps: CodexOAuthDeps): string {
  return normalizeCodexConnectionKey(deps.connectionKey)
}

export type CodexBrowserStartResult = {
  authorizeUrl: string
  state: string
  intent: CodexSubscriptionOAuthIntent
  expiresAt: Date
}

export type CodexDeviceStartResult = {
  userCode: string
  verificationUri: string
  verificationUriComplete: string | null
  intervalSeconds: number
  expiresAt: Date
  state: string
  intent: CodexSubscriptionOAuthIntent
}

export type CodexDevicePollResult =
  | { status: 'pending'; intervalSeconds: number; state: CodexSubscriptionOAuthSafeState }
  | { status: 'slow_down'; intervalSeconds: number; state: CodexSubscriptionOAuthSafeState }
  | { status: 'connected'; connection: CodexSubscriptionSafeConnection }
  | { status: 'expired' }
  | { status: 'denied' }

function requireEnabled(deps: CodexOAuthDeps): void {
  if (!deps.enabled) {
    throw new CodexSubscriptionOAuthError('disabled', 'Codex subscription is disabled')
  }
}

export async function getCodexSubscriptionConnection(
  deps: CodexOAuthDeps
): Promise<CodexSubscriptionSafeConnection | { connectionKey: string; status: 'disconnected' }> {
  requireEnabled(deps)
  const row = await getSafeCodexSubscriptionConnection(deps.db, connectionKeyOf(deps))
  return row ?? { connectionKey: connectionKeyOf(deps), status: 'disconnected' }
}

export async function startCodexBrowserConnect(
  deps: CodexOAuthDeps,
  intent: CodexSubscriptionOAuthIntent = 'connect'
): Promise<CodexBrowserStartResult> {
  requireEnabled(deps)
  const state = randomBytes(24).toString('base64url')
  const pkceVerifier = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + BROWSER_STATE_TTL_MS)
  const safe = await insertCodexSubscriptionOAuthState(deps.db, deps.encryptionKey, {
    state,
    flow: 'browser',
    intent,
    pkceVerifier,
    expiresAt,
    connectionKey: connectionKeyOf(deps),
  })
  const challenge = createHash('sha256').update(pkceVerifier).digest('base64url')
  const url = new URL(CODEX_OAUTH_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', deps.clientId)
  url.searchParams.set('redirect_uri', deps.redirectUri)
  url.searchParams.set('scope', CODEX_OAUTH_SCOPES.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  log.info({ event: 'codex_oauth_browser_start', intent: safe.intent }, 'browser OAuth start')
  return { authorizeUrl: url.toString(), state, intent: safe.intent, expiresAt: safe.expiresAt }
}

export async function startCodexDeviceConnect(
  deps: CodexOAuthDeps,
  intent: CodexSubscriptionOAuthIntent = 'connect'
): Promise<CodexDeviceStartResult> {
  requireEnabled(deps)
  const started = await postJson(deps, CODEX_OAUTH_DEVICE_USERCODE_URL, {
    client_id: deps.clientId,
  })
  if (!started.ok) {
    throw new CodexSubscriptionOAuthError('provider_unavailable', 'device authorization failed')
  }
  const body = started.body
  const deviceAuthId = requiredString(body.device_auth_id, 'device_auth_id')
  const userCode = requiredString(body.user_code ?? body.usercode, 'user_code')
  const intervalSeconds = parsePositiveNumber(body.interval, 5)
  const expiresAt = parseDeviceExpiry(body)
  const state = randomBytes(24).toString('base64url')
  const safe = await insertCodexSubscriptionOAuthState(deps.db, deps.encryptionKey, {
    state,
    flow: 'device',
    intent,
    deviceCode: encodeDeviceAuthHandle({ deviceAuthId, userCode }),
    expiresAt,
    connectionKey: connectionKeyOf(deps),
  })
  log.info({ event: 'codex_oauth_device_start', intent: safe.intent }, 'device OAuth start')
  return {
    userCode,
    verificationUri: CODEX_OAUTH_DEVICE_VERIFICATION_URI,
    verificationUriComplete: null,
    intervalSeconds,
    expiresAt: safe.expiresAt,
    state,
    intent: safe.intent,
  }
}

export async function handleCodexBrowserCallback(
  deps: CodexOAuthDeps,
  input: { code: string; state: string }
): Promise<CodexSubscriptionSafeConnection> {
  requireEnabled(deps)
  if (!input.code || !input.state) {
    throw new CodexSubscriptionOAuthError('invalid_callback', 'missing code or state')
  }
  const consumed = await consumeCodexSubscriptionOAuthState(
    deps.db,
    deps.encryptionKey,
    input.state
  )
  if (!consumed) {
    throw new CodexSubscriptionOAuthError('state_replayed', 'OAuth state is not reusable')
  }
  if (consumed.safe.flow !== 'browser' || !consumed.pkceVerifier) {
    throw new CodexSubscriptionOAuthError('invalid_callback', 'state is not a browser PKCE flow')
  }
  const token = await exchangeAuthorizationCode(deps, input.code, consumed.pkceVerifier)
  return persistGrantedTokens(deps, consumed.safe.intent, token)
}

export async function pollCodexDevice(
  deps: CodexOAuthDeps,
  state: string
): Promise<CodexDevicePollResult> {
  requireEnabled(deps)
  const pending = await peekPendingCodexSubscriptionOAuthState(deps.db, deps.encryptionKey, state)
  if (!pending) {
    throw new CodexSubscriptionOAuthError('state_replayed', 'device state is not pending')
  }
  if (pending.safe.expiresAt.getTime() <= Date.now()) {
    await expireCodexSubscriptionOAuthState(deps.db, state)
    return { status: 'expired' }
  }
  const handle = decodeDeviceAuthHandle(pending.deviceCode)
  if (!handle) {
    throw new CodexSubscriptionOAuthError(
      'invalid_callback',
      'device state is missing a device auth handle'
    )
  }
  const tokenResult = await pollDeviceAuthorization(deps, handle)
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
    await expireCodexSubscriptionOAuthState(deps.db, state)
    return { status: 'expired' }
  }
  if (tokenResult.kind === 'denied') {
    await cancelCodexSubscriptionOAuthState(deps.db, state)
    return { status: 'denied' }
  }
  const consumed = await consumeCodexSubscriptionOAuthState(deps.db, deps.encryptionKey, state)
  if (!consumed) {
    throw new CodexSubscriptionOAuthError(
      'state_replayed',
      'device state was consumed concurrently'
    )
  }
  const connection = await persistGrantedTokens(deps, consumed.safe.intent, tokenResult.parsed)
  return { status: 'connected', connection }
}

export async function refreshCodexSubscriptionConnection(
  deps: CodexOAuthDeps
): Promise<CodexSubscriptionSafeConnection> {
  requireEnabled(deps)
  const key = connectionKeyOf(deps)
  const current = await getSafeCodexSubscriptionConnection(deps.db, key)
  if (!current || current.status === 'revoked' || current.status === 'disconnected') {
    throw new CodexSubscriptionOAuthError('not_connected', 'no active Codex subscription')
  }
  const lockToken = randomBytes(16).toString('hex')
  const locked = await acquireCodexSubscriptionRefreshLock(
    deps.db,
    lockToken,
    REFRESH_LOCK_TTL_MS,
    key
  )
  if (!locked) {
    throw new CodexSubscriptionOAuthError('refresh_in_flight', 'another refresh holds the lock')
  }
  try {
    const secrets = await loadCodexSubscriptionSecrets(deps.db, deps.encryptionKey, key)
    if (!secrets)
      throw new CodexSubscriptionOAuthError('no_grant', 'encrypted refresh token missing')
    const token = await exchangeRefreshToken(deps, secrets.refreshToken)
    try {
      return await rotateCodexSubscriptionCredentials(
        deps.db,
        deps.encryptionKey,
        secrets.credentialRevision,
        {
          refreshToken: token.refreshToken ?? secrets.refreshToken,
          accessToken: token.accessToken,
          accessTokenExpiresAt: token.expiresAt,
          chatgptAccountId: token.chatgptAccountId,
          accountFingerprint: token.accountFingerprint,
        },
        key
      )
    } catch (err) {
      if (err instanceof CodexSubscriptionStaleRevisionError) {
        throw new CodexSubscriptionOAuthError('stale_revision', 'refresh lost the credential race')
      }
      if (err instanceof CodexSubscriptionFingerprintConflictError) {
        throw new CodexSubscriptionOAuthError(
          'fingerprint_in_use',
          'a live Codex subscription already uses this ChatGPT account'
        )
      }
      throw err
    }
  } finally {
    await releaseCodexSubscriptionRefreshLock(deps.db, lockToken, key)
  }
}

export async function revokeCodexSubscription(
  deps: CodexOAuthDeps
): Promise<CodexSubscriptionSafeConnection | { connectionKey: string; status: 'disconnected' }> {
  requireEnabled(deps)
  const key = connectionKeyOf(deps)
  const secrets = await loadCodexSubscriptionSecrets(deps.db, deps.encryptionKey, key)
  const local = await revokeCodexSubscriptionConnection(deps.db, key)
  try {
    await rebuildLiveCodexUnionAllowlist(deps.db)
  } catch (err) {
    log.warn(
      { event: 'codex_union_rebuild_after_revoke_failed', err },
      'union allowlist rebuild failed'
    )
  }
  if (secrets?.refreshToken) {
    try {
      const revokePayload: Record<string, string> = {
        token_type_hint: 'refresh_token',
        client_id: deps.clientId,
      }
      revokePayload['token'] = secrets.refreshToken
      await postForm(deps, CODEX_OAUTH_REVOKE_URL, revokePayload)
    } catch (err) {
      log.warn({ event: 'codex_oauth_upstream_revoke_failed', err }, 'upstream revoke failed')
    }
  }
  log.info({ event: 'codex_oauth_revoked_local' }, 'local Codex subscription revoked')
  return local ?? { connectionKey: key, status: 'disconnected' }
}

async function persistGrantedTokens(
  deps: CodexOAuthDeps,
  intent: CodexSubscriptionOAuthIntent,
  parsed: ParsedCodexToken
): Promise<CodexSubscriptionSafeConnection> {
  const key = connectionKeyOf(deps)
  const existing = await getSafeCodexSubscriptionConnection(deps.db, key)
  if (
    existing?.accountFingerprint &&
    existing.accountFingerprint !== parsed.accountFingerprint &&
    intent !== 'replace'
  ) {
    throw new CodexSubscriptionOAuthError(
      'replacement_required',
      'different account requires an explicit replace intent'
    )
  }
  const write = {
    refreshToken: parsed.refreshToken ?? '',
    accessToken: parsed.accessToken,
    accessTokenExpiresAt: parsed.expiresAt,
    chatgptAccountId: parsed.chatgptAccountId,
    accountFingerprint: parsed.accountFingerprint,
    status: 'connected' as const,
  }
  if (!write.refreshToken) {
    throw new CodexSubscriptionOAuthError(
      'provider_unavailable',
      'token response omitted refresh token'
    )
  }
  if (!existing) {
    return insertInitialCodexSubscriptionConnection(deps.db, deps.encryptionKey, write, key)
  }
  try {
    return await rotateCodexSubscriptionCredentials(
      deps.db,
      deps.encryptionKey,
      existing.credentialRevision,
      write,
      key
    )
  } catch (err) {
    if (err instanceof CodexSubscriptionStaleRevisionError) {
      throw new CodexSubscriptionOAuthError(
        'stale_revision',
        'connection was replaced concurrently'
      )
    }
    if (err instanceof CodexSubscriptionFingerprintConflictError) {
      throw new CodexSubscriptionOAuthError(
        'fingerprint_in_use',
        'a live Codex subscription already uses this ChatGPT account'
      )
    }
    throw err
  }
}

type ParsedCodexToken = {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
  accountFingerprint: string
  chatgptAccountId?: string
}

/**
 * Refresh the ChatGPT access token without bumping credential_revision.
 * Authorize tickets bind that revision; rotating it after issue invalidates them.
 */
export async function ensureFreshCodexAccessToken(deps: CodexOAuthDeps): Promise<void> {
  requireEnabled(deps)
  const key = connectionKeyOf(deps)
  const secrets = await loadCodexSubscriptionSecrets(deps.db, deps.encryptionKey, key)
  if (!secrets) {
    throw new CodexSubscriptionOAuthError('no_grant', 'encrypted refresh token missing')
  }
  let accountId = secrets.chatgptAccountId || chatgptAccountIdFromJwt(secrets.accessToken)
  const expiring =
    secrets.accessTokenExpiresAt != null &&
    secrets.accessTokenExpiresAt.getTime() - Date.now() < ACCESS_TOKEN_REFRESH_SKEW_MS
  if (secrets.accessToken && !expiring && accountId) {
    if (!secrets.chatgptAccountId) {
      await persistCodexChatgptAccountId(deps.db, deps.encryptionKey, accountId, key)
    }
    return
  }

  const lockToken = randomBytes(16).toString('hex')
  const locked = await acquireCodexSubscriptionRefreshLock(
    deps.db,
    lockToken,
    REFRESH_LOCK_TTL_MS,
    key
  )
  if (!locked) {
    await new Promise(resolve => setTimeout(resolve, 400))
    return
  }
  try {
    const latest = await loadCodexSubscriptionSecrets(deps.db, deps.encryptionKey, key)
    if (!latest) {
      throw new CodexSubscriptionOAuthError('no_grant', 'encrypted refresh token missing')
    }
    const token = await exchangeRefreshToken(deps, latest.refreshToken)
    accountId = token.chatgptAccountId || chatgptAccountIdFromJwt(token.accessToken) || accountId
    await updateCodexAccessTokenInPlace(
      deps.db,
      deps.encryptionKey,
      latest.credentialRevision,
      {
        accessToken: token.accessToken,
        accessTokenExpiresAt: token.expiresAt,
        refreshToken: token.refreshToken,
        chatgptAccountId: accountId,
      },
      key
    )
  } catch (err) {
    if (err instanceof CodexSubscriptionStaleRevisionError) {
      throw new CodexSubscriptionOAuthError(
        'stale_revision',
        'in-place refresh lost the credential race'
      )
    }
    throw err
  } finally {
    await releaseCodexSubscriptionRefreshLock(deps.db, lockToken, key)
  }
}

async function exchangeAuthorizationCode(
  deps: CodexOAuthDeps,
  code: string,
  pkceVerifier: string,
  redirectUri = deps.redirectUri
): Promise<ParsedCodexToken> {
  const result = await postForm(deps, CODEX_OAUTH_TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: deps.clientId,
    code_verifier: pkceVerifier,
  })
  if (!result.ok) {
    throw new CodexSubscriptionOAuthError(
      'provider_unavailable',
      'authorization code exchange failed'
    )
  }
  return parseTokenResponse(result.body)
}

async function exchangeRefreshToken(
  deps: CodexOAuthDeps,
  refreshToken: string
): Promise<ParsedCodexToken> {
  const result = await postForm(deps, CODEX_OAUTH_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: deps.clientId,
  })
  if (!result.ok) {
    throw new CodexSubscriptionOAuthError('provider_unavailable', 'refresh token exchange failed')
  }
  return parseTokenResponse(result.body)
}

type CodexDeviceAuthHandle = {
  deviceAuthId: string
  userCode: string
}

function encodeDeviceAuthHandle(handle: CodexDeviceAuthHandle): string {
  return JSON.stringify(handle)
}

function decodeDeviceAuthHandle(value: string | undefined): CodexDeviceAuthHandle | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as { deviceAuthId?: unknown; userCode?: unknown }
    if (
      typeof parsed.deviceAuthId === 'string' &&
      parsed.deviceAuthId.length > 0 &&
      typeof parsed.userCode === 'string' &&
      parsed.userCode.length > 0
    ) {
      return { deviceAuthId: parsed.deviceAuthId, userCode: parsed.userCode }
    }
  } catch {
    return null
  }
  return null
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

async function pollDeviceAuthorization(
  deps: CodexOAuthDeps,
  handle: CodexDeviceAuthHandle
): Promise<
  | { kind: 'ok'; parsed: ParsedCodexToken }
  | { kind: 'pending'; intervalSeconds: number }
  | { kind: 'slow_down'; intervalSeconds: number }
  | { kind: 'expired' }
  | { kind: 'denied' }
> {
  const result = await postJson(deps, CODEX_OAUTH_DEVICE_TOKEN_URL, {
    device_auth_id: handle.deviceAuthId,
    user_code: handle.userCode,
  })
  if (result.ok) {
    const authorizationCode = requiredString(result.body.authorization_code, 'authorization_code')
    const codeVerifier = requiredString(result.body.code_verifier, 'code_verifier')
    return {
      kind: 'ok',
      parsed: await exchangeAuthorizationCode(
        deps,
        authorizationCode,
        codeVerifier,
        CODEX_OAUTH_DEVICE_CALLBACK_URI
      ),
    }
  }
  if (result.status === 403 || result.status === 404) {
    return { kind: 'pending', intervalSeconds: parsePositiveNumber(result.body.interval, 5) }
  }
  const error = readUpstreamErrorCode(result.body)
  if (error === 'authorization_pending' || error === 'deviceauth_authorization_pending') {
    return { kind: 'pending', intervalSeconds: parsePositiveNumber(result.body.interval, 5) }
  }
  if (error === 'slow_down') {
    return { kind: 'slow_down', intervalSeconds: parsePositiveNumber(result.body.interval, 10) }
  }
  if (error === 'expired_token' || error === 'deviceauth_expired') return { kind: 'expired' }
  if (error === 'access_denied' || error === 'deviceauth_denied') return { kind: 'denied' }
  throw new CodexSubscriptionOAuthError('provider_unavailable', 'device token poll failed')
}

function parseTokenResponse(body: Record<string, unknown>): ParsedCodexToken {
  const accessToken = requiredString(body.access_token, 'access_token')
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : null
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null
  const idToken = typeof body.id_token === 'string' ? body.id_token : null
  const subject = subjectFromIdToken(idToken)
  const chatgptAccountId = chatgptAccountIdFromJwt(idToken) || chatgptAccountIdFromJwt(accessToken)
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    accountFingerprint: fingerprintAccount(subject),
    ...(chatgptAccountId ? { chatgptAccountId } : {}),
  }
}

function subjectFromIdToken(idToken: string | null): string {
  if (!idToken) {
    throw new CodexSubscriptionOAuthError('invalid_callback', 'token response omitted id_token')
  }
  const parts = idToken.split('.')
  if (parts.length < 2) {
    throw new CodexSubscriptionOAuthError('invalid_callback', 'id_token is malformed')
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      sub?: unknown
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new Error('missing sub')
    }
    return payload.sub
  } catch {
    throw new CodexSubscriptionOAuthError('invalid_callback', 'id_token subject is unreadable')
  }
}

function fingerprintAccount(subject: string): string {
  return createHash('sha256').update(subject, 'utf8').digest('hex')
}

async function postForm(
  deps: CodexOAuthDeps,
  url: string,
  params: Record<string, string>
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  return post(
    deps,
    url,
    'application/x-www-form-urlencoded',
    new URLSearchParams(params).toString()
  )
}

async function postJson(
  deps: CodexOAuthDeps,
  url: string,
  payload: Record<string, string>
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  return post(deps, url, 'application/json', JSON.stringify(payload))
}

async function post(
  deps: CodexOAuthDeps,
  url: string,
  contentType: string,
  body: string
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  let response: Response
  try {
    response = await deps.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': contentType, accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    })
  } catch (err) {
    log.warn({ event: 'codex_oauth_upstream_unreachable', err }, 'Codex OAuth upstream unreachable')
    throw new CodexSubscriptionOAuthError(
      'provider_unavailable',
      'Codex OAuth upstream unreachable'
    )
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: response.ok, status: response.status, body: json }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CodexSubscriptionOAuthError('provider_unavailable', `upstream omitted ${field}`)
  }
  return value
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
