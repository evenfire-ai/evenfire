import { createHash, randomBytes } from 'node:crypto'
import type { DbClient } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import {
  type CodexSubscriptionSafeConnection,
  CodexSubscriptionStaleRevisionError,
  acquireCodexSubscriptionRefreshLock,
  getSafeCodexSubscriptionConnection,
  insertInitialCodexSubscriptionConnection,
  loadCodexSubscriptionSecrets,
  releaseCodexSubscriptionRefreshLock,
  revokeCodexSubscriptionConnection,
  rotateCodexSubscriptionCredentials,
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
export const CODEX_OAUTH_DEVICE_URL = 'https://auth.openai.com/api/accounts/deviceauth'
export const CODEX_OAUTH_REVOKE_URL = 'https://auth.openai.com/oauth/revoke'
export const CODEX_OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const

const TOKEN_TIMEOUT_MS = 15_000
const REFRESH_LOCK_TTL_MS = 30_000
const BROWSER_STATE_TTL_MS = 10 * 60_000

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
): Promise<
  CodexSubscriptionSafeConnection | { connectionKey: 'deployment-default'; status: 'disconnected' }
> {
  requireEnabled(deps)
  const row = await getSafeCodexSubscriptionConnection(deps.db)
  return row ?? { connectionKey: 'deployment-default', status: 'disconnected' }
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
  const started = await postJson(deps, CODEX_OAUTH_DEVICE_URL, {
    client_id: deps.clientId,
    scope: CODEX_OAUTH_SCOPES.join(' '),
  })
  if (!started.ok) {
    throw new CodexSubscriptionOAuthError('provider_unavailable', 'device authorization failed')
  }
  const body = started.body as Record<string, unknown>
  const deviceCode = requiredString(body.device_code, 'device_code')
  const userCode = requiredString(body.user_code, 'user_code')
  const verificationUri = requiredString(
    body.verification_uri ?? body.verification_uri_complete,
    'verification_uri'
  )
  const intervalSeconds = positiveNumber(body.interval, 5)
  const expiresIn = positiveNumber(body.expires_in, 600)
  const expiresAt = new Date(Date.now() + expiresIn * 1000)
  const state = randomBytes(24).toString('base64url')
  const safe = await insertCodexSubscriptionOAuthState(deps.db, deps.encryptionKey, {
    state,
    flow: 'device',
    intent,
    deviceCode,
    expiresAt,
  })
  log.info({ event: 'codex_oauth_device_start', intent: safe.intent }, 'device OAuth start')
  return {
    userCode,
    verificationUri,
    verificationUriComplete:
      typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : null,
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
  if (!pending.deviceCode) {
    throw new CodexSubscriptionOAuthError(
      'invalid_callback',
      'device state is missing a device code'
    )
  }
  const tokenResult = await exchangeDeviceCode(deps, pending.deviceCode)
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
  const connection = await persistGrantedTokens(deps, consumed.safe.intent, tokenResult.token)
  return { status: 'connected', connection }
}

export async function refreshCodexSubscriptionConnection(
  deps: CodexOAuthDeps
): Promise<CodexSubscriptionSafeConnection> {
  requireEnabled(deps)
  const current = await getSafeCodexSubscriptionConnection(deps.db)
  if (!current || current.status === 'revoked' || current.status === 'disconnected') {
    throw new CodexSubscriptionOAuthError('not_connected', 'no active Codex subscription')
  }
  const lockToken = randomBytes(16).toString('hex')
  const locked = await acquireCodexSubscriptionRefreshLock(deps.db, lockToken, REFRESH_LOCK_TTL_MS)
  if (!locked) {
    throw new CodexSubscriptionOAuthError('refresh_in_flight', 'another refresh holds the lock')
  }
  try {
    const secrets = await loadCodexSubscriptionSecrets(deps.db, deps.encryptionKey)
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
          accountFingerprint: token.accountFingerprint,
        }
      )
    } catch (err) {
      if (err instanceof CodexSubscriptionStaleRevisionError) {
        throw new CodexSubscriptionOAuthError('stale_revision', 'refresh lost the credential race')
      }
      throw err
    }
  } finally {
    await releaseCodexSubscriptionRefreshLock(deps.db, lockToken)
  }
}

export async function revokeCodexSubscription(
  deps: CodexOAuthDeps
): Promise<
  CodexSubscriptionSafeConnection | { connectionKey: 'deployment-default'; status: 'disconnected' }
> {
  requireEnabled(deps)
  const secrets = await loadCodexSubscriptionSecrets(deps.db, deps.encryptionKey)
  const local = await revokeCodexSubscriptionConnection(deps.db)
  if (secrets?.refreshToken) {
    try {
      await postForm(deps, CODEX_OAUTH_REVOKE_URL, {
        token: secrets.refreshToken,
        token_type_hint: 'refresh_token',
        client_id: deps.clientId,
      })
    } catch (err) {
      log.warn({ event: 'codex_oauth_upstream_revoke_failed', err }, 'upstream revoke failed')
    }
  }
  log.info({ event: 'codex_oauth_revoked_local' }, 'local Codex subscription revoked')
  return local ?? { connectionKey: 'deployment-default', status: 'disconnected' }
}

async function persistGrantedTokens(
  deps: CodexOAuthDeps,
  intent: CodexSubscriptionOAuthIntent,
  token: ParsedCodexToken
): Promise<CodexSubscriptionSafeConnection> {
  const existing = await getSafeCodexSubscriptionConnection(deps.db)
  if (
    existing?.accountFingerprint &&
    existing.accountFingerprint !== token.accountFingerprint &&
    intent !== 'replace'
  ) {
    throw new CodexSubscriptionOAuthError(
      'replacement_required',
      'different account requires an explicit replace intent'
    )
  }
  const write = {
    refreshToken: token.refreshToken ?? '',
    accessToken: token.accessToken,
    accessTokenExpiresAt: token.expiresAt,
    accountFingerprint: token.accountFingerprint,
    status: 'connected' as const,
  }
  if (!write.refreshToken) {
    throw new CodexSubscriptionOAuthError(
      'provider_unavailable',
      'token response omitted refresh token'
    )
  }
  if (!existing) {
    return insertInitialCodexSubscriptionConnection(deps.db, deps.encryptionKey, write)
  }
  try {
    return await rotateCodexSubscriptionCredentials(
      deps.db,
      deps.encryptionKey,
      existing.credentialRevision,
      write
    )
  } catch (err) {
    if (err instanceof CodexSubscriptionStaleRevisionError) {
      throw new CodexSubscriptionOAuthError(
        'stale_revision',
        'connection was replaced concurrently'
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
}

async function exchangeAuthorizationCode(
  deps: CodexOAuthDeps,
  code: string,
  pkceVerifier: string
): Promise<ParsedCodexToken> {
  const result = await postForm(deps, CODEX_OAUTH_TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: deps.redirectUri,
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

async function exchangeDeviceCode(
  deps: CodexOAuthDeps,
  deviceCode: string
): Promise<
  | { kind: 'ok'; token: ParsedCodexToken }
  | { kind: 'pending'; intervalSeconds: number }
  | { kind: 'slow_down'; intervalSeconds: number }
  | { kind: 'expired' }
  | { kind: 'denied' }
> {
  const result = await postForm(deps, CODEX_OAUTH_TOKEN_URL, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: deps.clientId,
  })
  if (result.ok) return { kind: 'ok', token: parseTokenResponse(result.body) }
  const error = typeof result.body.error === 'string' ? result.body.error : ''
  if (error === 'authorization_pending') return { kind: 'pending', intervalSeconds: 5 }
  if (error === 'slow_down') return { kind: 'slow_down', intervalSeconds: 10 }
  if (error === 'expired_token') return { kind: 'expired' }
  if (error === 'access_denied') return { kind: 'denied' }
  throw new CodexSubscriptionOAuthError('provider_unavailable', 'device token poll failed')
}

function parseTokenResponse(body: Record<string, unknown>): ParsedCodexToken {
  const accessToken = requiredString(body.access_token, 'access_token')
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : null
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null
  const subject = subjectFromIdToken(typeof body.id_token === 'string' ? body.id_token : null)
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    accountFingerprint: fingerprintAccount(subject),
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
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
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
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  return post(deps, url, 'application/json', JSON.stringify(payload))
}

async function post(
  deps: CodexOAuthDeps,
  url: string,
  contentType: string,
  body: string
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
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
  return { ok: response.ok, body: json }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CodexSubscriptionOAuthError('provider_unavailable', `upstream omitted ${field}`)
  }
  return value
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
