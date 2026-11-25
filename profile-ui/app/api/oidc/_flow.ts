import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import {
  OIDC_SIGNED_IN_MARKER_COOKIE,
  OIDC_SIGNED_IN_MARKER_MAX_AGE_SECONDS,
  type OidcReturnTo,
  isOidcReturnTo,
} from '../../constants/oidc'
import { EXTERNAL_REST_API_INTERNAL_URL } from '../../constants/serverApi'
import {
  OIDC_REFUSAL_REASONS,
  type OidcAttemptExtras,
  type OidcCompletionOutcome,
  type OidcRefusalReason,
} from './types'

export const OIDC_BROWSER_COOKIE_MAX_AGE_SECONDS = 600
/** Control API and Profile UI clocks can differ by a small amount. */
export const OIDC_BROWSER_CLOCK_SKEW_SECONDS = 60
/** Same budget Control API uses for one OIDC operation. Profile UI waits longer so that budget can answer first. */
export const OIDC_OPERATION_DEADLINE_MS = 12_000
export const OIDC_PROFILE_FETCH_TIMEOUT_MS = OIDC_OPERATION_DEADLINE_MS + 2_000

const BINDING_RE = /^[A-Za-z0-9_-]{43}$/
const STATE_RE = /^[A-Za-z0-9_-]{32,512}$/
/** The one-time code Evenfire Desktop redeems for its own session. */
const DESKTOP_SIGN_IN_CODE_RE = /^[A-Za-z0-9_-]{43}$/
const CALLBACK_PATH = '/api/oidc/callback'
/** The member session cookie External REST sets for password login (`sessionCookie.ts`). */
export const PROFILE_SESSION_COOKIE_PREFIX = 'profile_session='
const SAFE_FAILURES = [
  'oidc_not_configured',
  'oidc_attempt_rejected',
  'invalid_oidc_attempt',
  'oidc_configuration_unavailable',
  'oidc_provider_unavailable',
  'oidc_provider_incompatible',
  'oidc_storage_unavailable',
  'oidc_operation_cancelled',
  'oidc_unavailable',
  'desktop_sign_in_unavailable',
] as const
const REFUSAL_REASON_SET: ReadonlySet<string> = new Set(OIDC_REFUSAL_REASONS)
const SAFE_FAILURE_SET: ReadonlySet<string> = new Set(SAFE_FAILURES)

export type OidcProfileConfiguration = Readonly<{
  redirectUri: string
  memberAuthenticationActivated: boolean
}>

export type { OidcAttemptExtras, OidcCompletionOutcome }

export type OidcFailureCode = (typeof SAFE_FAILURES)[number] | 'invalid_upstream'

export class OidcProfileFlowError extends Error {
  constructor(
    readonly status: number,
    readonly code: OidcFailureCode,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number
  ) {
    super('OIDC profile flow request failed')
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  })
}

export function noStoreText(message: string, status: number, retryAfterSeconds?: number): Response {
  return new Response(message, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      ...(retryAfterSeconds !== undefined && retryAfterSeconds > 0
        ? { 'retry-after': String(Math.ceil(retryAfterSeconds)) }
        : {}),
    },
  })
}

/**
 * Best-effort browser IP: a valid `cf-connecting-ip`, otherwise the left-most `x-forwarded-for`
 * entry. Only a valid IP is returned. It is forwarded as `x-forwarded-for`; External REST
 * keys its per-browser limit on it. External REST's per-socket limit is the capacity bound.
 */
export function oidcBrowserClientIp(request: Request): string | undefined {
  const connecting = request.headers.get('cf-connecting-ip')?.trim() ?? ''
  if (connecting && isIP(connecting) !== 0) return connecting
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? ''
  if (!forwarded || isIP(forwarded) === 0) return undefined
  return forwarded
}

function externalUrl(path: string): string {
  const base = EXTERNAL_REST_API_INTERNAL_URL.replace(/\/+$/, '')
  return `${base}/api/v1${path}`
}

async function requestExternal<T>(path: string, init?: RequestInit, request?: Request): Promise<T> {
  return (await requestExternalWithHeaders<T>(path, init, request)).body
}

async function requestExternalWithHeaders<T>(
  path: string,
  init?: RequestInit,
  request?: Request
): Promise<{ body: T; headers: Headers }> {
  const clientIp = request ? oidcBrowserClientIp(request) : undefined
  let response: Response
  try {
    response = await fetch(externalUrl(path), {
      ...init,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(OIDC_PROFILE_FETCH_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        'x-oidc-operation-deadline-ms': String(OIDC_OPERATION_DEADLINE_MS),
        ...(clientIp ? { 'x-forwarded-for': clientIp } : {}),
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
      },
    })
  } catch {
    // The attempt may still be pending. Keep it reusable until a response says otherwise.
    throw new OidcProfileFlowError(503, 'oidc_unavailable', true)
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'))
    throw new OidcProfileFlowError(
      429,
      'oidc_unavailable',
      true,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
    )
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new OidcProfileFlowError(503, 'oidc_unavailable', true)
  }
  if (!response.ok) {
    const error =
      body &&
      typeof body === 'object' &&
      'error' in body &&
      typeof body.error === 'string' &&
      SAFE_FAILURE_SET.has(body.error)
        ? (body.error as OidcFailureCode)
        : 'oidc_unavailable'
    const retryableCode =
      error === 'oidc_provider_unavailable' ||
      error === 'oidc_storage_unavailable' ||
      error === 'oidc_unavailable' ||
      error === 'oidc_operation_cancelled'
    const retrySameAttempt =
      body &&
      typeof body === 'object' &&
      'retrySameAttempt' in body &&
      typeof body.retrySameAttempt === 'boolean'
        ? body.retrySameAttempt
        : true
    // 409 is External REST's "Desktop sign-in is off here" (desktop_sign_in_unavailable).
    throw new OidcProfileFlowError(
      [400, 404, 409, 429, 503].includes(response.status) ? response.status : 503,
      error,
      retryableCode && retrySameAttempt !== false
    )
  }
  return { body: body as T, headers: response.headers }
}

export async function getOidcProfileConfiguration(
  request: Request
): Promise<OidcProfileConfiguration> {
  const config = await requestExternal<OidcProfileConfiguration>(
    '/oidc/profile-flow/configuration',
    undefined,
    request
  )
  if (
    !config ||
    typeof config.redirectUri !== 'string' ||
    typeof config.memberAuthenticationActivated !== 'boolean'
  ) {
    throw new OidcProfileFlowError(503, 'oidc_unavailable', true)
  }
  let callback: URL
  try {
    callback = new URL(config.redirectUri)
  } catch {
    throw new OidcProfileFlowError(503, 'oidc_unavailable', false)
  }
  if (
    callback.protocol !== 'https:' ||
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.pathname !== CALLBACK_PATH ||
    callback.search
  ) {
    throw new OidcProfileFlowError(503, 'oidc_unavailable', false)
  }
  return config
}

export function responseForFlowError(error: unknown): Response {
  if (error instanceof OidcProfileFlowError) {
    return json({ error: error.code }, error.status)
  }
  return json({ error: 'oidc_unavailable' }, 503)
}

export function originMatchesCallback(request: Request, callback: string): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    const expected = new URL(callback)
    return origin === expected.origin
  } catch {
    return false
  }
}

/**
 * Compares only the path. `request.url` does not carry the public origin: `next start`
 * builds it from its own listener (`<proto>://localhost:<port>`) and ignores Host and
 * X-Forwarded-Host, so behind the proxy its origin never equals the redirect URI.
 * The public origin is enforced without trusting request headers: `/start` sets the
 * binding cookie only when the browser's Origin is the redirect URI origin, the
 * `__Host-` cookie is sent back only to that host, and Control API claims an attempt
 * only for the stored binding and the configured redirect URI.
 */
export function requestPathMatchesCallback(request: Request, callback: string): boolean {
  try {
    return new URL(request.url).pathname === new URL(callback).pathname
  } catch {
    return false
  }
}

export function newBrowserBinding(): string {
  return randomBytes(32).toString('base64url')
}

function stateCookieSuffix(state: string): string {
  return createHash('sha256').update(state).digest('hex').slice(0, 24)
}

export function browserCookieName(state: string): string {
  return `__Host-ef_oidc_${stateCookieSuffix(state)}`
}

export function validBinding(value: unknown): value is string {
  return typeof value === 'string' && BINDING_RE.test(value)
}

export function validState(value: unknown): value is string {
  return typeof value === 'string' && STATE_RE.test(value)
}

export function readSingleCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (!header || header.length > 16_384) return undefined
  const matches: string[] = []
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    if (pair.slice(0, separator).trim() === name) matches.push(pair.slice(separator + 1).trim())
  }
  if (matches.length !== 1 || !validBinding(matches[0])) return undefined
  return matches[0]
}

/**
 * Carries the page that started sign-in (a closed-set value) from `/start` to the callback.
 * Named from the state like the binding cookie, so concurrent attempts don't collide.
 */
export function returnToCookieName(state: string): string {
  return `__Host-ef_oidc_return_${stateCookieSuffix(state)}`
}

/** Every value the request's Cookie header carries under `name`, or none for an oversized header. */
export function cookieValues(request: Request, name: string): string[] {
  const header = request.headers.get('cookie')
  if (!header || header.length > 16_384) return []
  const values: string[] = []
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    if (pair.slice(0, separator).trim() === name) values.push(pair.slice(separator + 1).trim())
  }
  return values
}

/**
 * The return value only when the cookie is present once and in the closed set. Anything else
 * yields undefined and the callback lands on `/oidc/signed-in`: the value is a convenience,
 * not an authority, so dropping a missing or tampered one is the correct outcome.
 */
export function readReturnToCookie(request: Request, state: string): OidcReturnTo | undefined {
  const values = cookieValues(request, returnToCookieName(state))
  return values.length === 1 && isOidcReturnTo(values[0]) ? values[0] : undefined
}

/**
 * The cookies a finished attempt expires: the binding, and the return cookie whenever the
 * request carries one under this state's name, valid or not.
 */
export function finishedAttemptCookies(request: Request, state: string): string[] {
  const returnName = returnToCookieName(state)
  return [
    clearBrowserCookie(browserCookieName(state)),
    ...(cookieValues(request, returnName).length > 0 ? [clearBrowserCookie(returnName)] : []),
  ]
}

/** An attempt cookie (the binding or the return value) that lives as long as the attempt. */
export function setBrowserCookie(name: string, value: string, maxAgeSeconds: number): string {
  const age = Math.max(0, Math.min(OIDC_BROWSER_COOKIE_MAX_AGE_SECONDS, Math.floor(maxAgeSeconds)))
  return `${name}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`
}

export function clearBrowserCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`
}

export async function postOidcProfileFlow<T>(
  route: 'attempts' | 'cancel',
  body: Record<string, unknown>,
  request: Request
): Promise<T> {
  return requestExternal<T>(
    `/oidc/profile-flow/${route}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    request
  )
}

/**
 * Completes the attempt. When member sign-in is on, External REST answers a sign-in
 * with the same `profile_session` Set-Cookie header password login sets; it is relayed
 * to the browser unchanged, so the token never passes through a response body. A refusal
 * carries one of the listed reasons and never a session. A Desktop attempt's answer carries a
 * one-time code and the edge's environment instead of a session; each outcome is read field by
 * field, and any other key in the answer is ignored.
 */
export async function completeOidcProfileFlow(
  body: Record<string, unknown>,
  request: Request
): Promise<OidcCompletionOutcome> {
  const { body: result, headers } = await requestExternalWithHeaders<{
    outcome?: unknown
    memberAuthenticationActivated?: unknown
    reason?: unknown
    code?: unknown
    environment?: unknown
  }>('/oidc/profile-flow/complete', { method: 'POST', body: JSON.stringify(body) }, request)
  if (
    result?.outcome === 'identity_proof_verified' &&
    result.memberAuthenticationActivated !== true
  ) {
    return { kind: 'identity_proof_verified' }
  }
  if (result?.outcome === 'member_signed_in' && result.memberAuthenticationActivated === true) {
    const sessionCookies = headers
      .getSetCookie()
      .filter(cookie => cookie.startsWith(PROFILE_SESSION_COOKIE_PREFIX))
    if (sessionCookies.length === 1 && sessionCookies[0].length <= 8192) {
      return { kind: 'member_signed_in', sessionCookie: sessionCookies[0] }
    }
  }
  if (
    result?.outcome === 'refused' &&
    result.memberAuthenticationActivated === true &&
    typeof result.reason === 'string' &&
    REFUSAL_REASON_SET.has(result.reason)
  ) {
    return { kind: 'refused', reason: result.reason as OidcRefusalReason }
  }
  if (
    result?.outcome === 'desktop_code_issued' &&
    result.memberAuthenticationActivated === true &&
    typeof result.code === 'string' &&
    DESKTOP_SIGN_IN_CODE_RE.test(result.code) &&
    typeof result.environment === 'string'
  ) {
    return { kind: 'desktop_code_issued', code: result.code, environment: result.environment }
  }
  // The attempt was consumed upstream; an unrecognised answer cannot be retried.
  throw new OidcProfileFlowError(503, 'oidc_unavailable', false)
}

function redirectHeaders(location: string): Headers {
  return new Headers({
    location,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
}

/**
 * The session, the finished attempt's cookie clears and a marker that tells `/oidc/signed-in`
 * the session is new.
 */
export function memberSignedInRedirect(
  location: string,
  sessionCookie: string,
  clearCookies: readonly string[]
): Response {
  const headers = redirectHeaders(location)
  headers.append('set-cookie', sessionCookie)
  for (const cookie of clearCookies) headers.append('set-cookie', cookie)
  headers.append(
    'set-cookie',
    `${OIDC_SIGNED_IN_MARKER_COOKIE}=1; Path=/; Max-Age=${OIDC_SIGNED_IN_MARKER_MAX_AGE_SECONDS}; Secure; SameSite=Lax`
  )
  return new Response(null, { status: 303, headers })
}

/** A refusal sets no session; it only releases the finished attempt's cookies. */
export function refusedRedirect(location: string, clearCookies: readonly string[]): Response {
  const headers = redirectHeaders(location)
  for (const cookie of clearCookies) headers.append('set-cookie', cookie)
  return new Response(null, { status: 303, headers })
}

/**
 * Starts an attempt. `extras` is copied field by field, so nothing else in it reaches External
 * REST. For a Desktop attempt the edge echoes `signInContext`; the caller checks it. The answer is
 * unchecked: `validatedAttemptRedirect` reads it.
 */
export async function beginOidcAttempt(
  browserBinding: string,
  request: Request,
  extras: OidcAttemptExtras = {}
): Promise<{ authorizationUrl: unknown; expiresAt: unknown; signInContext?: unknown }> {
  return postOidcProfileFlow(
    'attempts',
    {
      browserBinding,
      ...(extras.desktopSignIn
        ? { desktopSignIn: { codeChallenge: extras.desktopSignIn.codeChallenge } }
        : {}),
      ...(extras.invitationToken !== undefined ? { invitationToken: extras.invitationToken } : {}),
    },
    request
  )
}

/**
 * Where to send the browser for a started attempt, with the provider `state` that names its
 * cookies and the cookies' Max-Age. Undefined when the authorization URL fails
 * `validateAuthorizationUrl`, or the expiry is not a date, already past, or later than the cookie
 * lifetime plus the allowed clock skew.
 */
export function validatedAttemptRedirect(
  attempt: Readonly<{ authorizationUrl: unknown; expiresAt: unknown }>,
  configuration: OidcProfileConfiguration
): Readonly<{ authorizationUrl: URL; state: string; maxAge: number }> | undefined {
  const authorizationUrl = validateAuthorizationUrl(
    attempt.authorizationUrl,
    configuration.redirectUri
  )
  // Read as before the extraction: a value that is not a date string gives an invalid date or
  // one outside the window, and is refused below.
  const expiresAt = new Date(attempt.expiresAt as string)
  const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  const state = authorizationUrl?.searchParams.get('state')
  if (
    !authorizationUrl ||
    !state ||
    !Number.isFinite(expiresAt.getTime()) ||
    maxAge <= 0 ||
    maxAge > OIDC_BROWSER_COOKIE_MAX_AGE_SECONDS + OIDC_BROWSER_CLOCK_SKEW_SECONDS
  ) {
    return undefined
  }
  return { authorizationUrl, state, maxAge }
}

export function validateAuthorizationUrl(rawUrl: unknown, callback: string): URL | undefined {
  if (typeof rawUrl !== 'string' || rawUrl.length > 8192) return undefined
  try {
    const url = new URL(rawUrl)
    const state = url.searchParams.getAll('state')
    const redirectUri = url.searchParams.getAll('redirect_uri')
    const responseType = url.searchParams.getAll('response_type')
    const responseMode = url.searchParams.getAll('response_mode')
    const challenge = url.searchParams.getAll('code_challenge')
    const challengeMethod = url.searchParams.getAll('code_challenge_method')
    const nonce = url.searchParams.getAll('nonce')
    const clientId = url.searchParams.getAll('client_id')
    const scopes = url.searchParams.getAll('scope')
    const scopeSet = scopes[0]?.split(' ').filter(Boolean)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      state.length !== 1 ||
      !validState(state[0]) ||
      redirectUri.length !== 1 ||
      redirectUri[0] !== callback ||
      responseType.length !== 1 ||
      responseType[0] !== 'code' ||
      responseMode.length !== 1 ||
      responseMode[0] !== 'query' ||
      challenge.length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge[0]) ||
      challengeMethod.length !== 1 ||
      challengeMethod[0] !== 'S256' ||
      nonce.length !== 1 ||
      !/^[A-Za-z0-9_-]{32,512}$/.test(nonce[0]) ||
      clientId.length !== 1 ||
      !clientId[0] ||
      clientId[0].length > 512 ||
      scopes.length !== 1 ||
      !scopeSet ||
      new Set(scopeSet).size !== scopeSet.length ||
      scopeSet.length !== 3 ||
      !['openid', 'profile', 'email'].every(scope => scopeSet.includes(scope)) ||
      url.searchParams.has('client_secret')
    ) {
      return undefined
    }
    return url
  } catch {
    return undefined
  }
}

export function parseCallbackParameters(
  request: Request
):
  | Readonly<{ kind: 'success'; state: string; code: string; issuer?: string }>
  | Readonly<{ kind: 'denied'; state: string }>
  | Readonly<{ kind: 'retryable-error'; state: string }>
  | Readonly<{ kind: 'provider-error'; state: string }>
  | Readonly<{ kind: 'invalid' }> {
  const params = new URL(request.url).searchParams
  const stateValues = params.getAll('state')
  const codes = params.getAll('code')
  const errors = params.getAll('error')
  const issuers = params.getAll('iss')
  if (
    stateValues.length !== 1 ||
    !validState(stateValues[0]) ||
    codes.length > 1 ||
    errors.length > 1 ||
    issuers.length > 1 ||
    (codes.length > 0 && errors.length > 0)
  ) {
    return { kind: 'invalid' }
  }
  const state = stateValues[0]
  if (codes.length === 1) {
    const issuer = issuers[0]
    const code = codes[0]
    if (
      !/^[\x21-\x7e]{1,4096}$/.test(code) ||
      (issuer !== undefined && (issuer.length === 0 || issuer.length > 2048))
    ) {
      return { kind: 'invalid' }
    }
    return { kind: 'success', state, code, ...(issuer !== undefined ? { issuer } : {}) }
  }
  if (errors.length === 1 && errors[0] === 'access_denied') {
    return { kind: 'denied', state }
  }
  if (errors.length === 1 && ['server_error', 'temporarily_unavailable'].includes(errors[0])) {
    return { kind: 'retryable-error', state }
  }
  // Any other provider error (`login_required`, for example). Its state is kept so the attempt
  // it ends can be answered; the error value itself goes no further.
  if (errors.length === 1) {
    return { kind: 'provider-error', state }
  }
  return { kind: 'invalid' }
}

export function noStoreRedirect(url: string, cookies: string | readonly string[]): Response {
  const headers = redirectHeaders(url)
  for (const cookie of typeof cookies === 'string' ? [cookies] : cookies) {
    headers.append('set-cookie', cookie)
  }
  return new Response(null, { status: 303, headers })
}

export function noStoreResult(
  message: string,
  status: number,
  cookies: readonly string[] = []
): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(message, { status, headers })
}
