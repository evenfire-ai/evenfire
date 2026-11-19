import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { EXTERNAL_REST_API_INTERNAL_URL } from '../../constants/serverApi'

export const OIDC_BROWSER_COOKIE_MAX_AGE_SECONDS = 600
/** Control API and Profile UI clocks can differ by a small amount. */
export const OIDC_BROWSER_CLOCK_SKEW_SECONDS = 60
/** Same budget Control API uses for one OIDC operation. Profile UI waits longer so that budget can answer first. */
export const OIDC_OPERATION_DEADLINE_MS = 12_000
export const OIDC_PROFILE_FETCH_TIMEOUT_MS = OIDC_OPERATION_DEADLINE_MS + 2_000

const BINDING_RE = /^[A-Za-z0-9_-]{43}$/
const STATE_RE = /^[A-Za-z0-9_-]{32,512}$/
const CALLBACK_PATH = '/api/oidc/callback'
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
] as const
const SAFE_FAILURE_SET: ReadonlySet<string> = new Set(SAFE_FAILURES)

export type OidcProfileConfiguration = Readonly<{
  redirectUri: string
  memberAuthenticationActivated: false
}>

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

export function oidcClientKey(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? ''
  if (!forwarded || isIP(forwarded) === 0) return undefined
  return createHash('sha256').update(forwarded).digest('hex')
}

function externalUrl(path: string): string {
  const base = EXTERNAL_REST_API_INTERNAL_URL.replace(/\/+$/, '')
  return `${base}/api/v1${path}`
}

async function requestExternal<T>(
  path: string,
  init?: RequestInit,
  clientKey?: string
): Promise<T> {
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
        ...(clientKey ? { 'x-oidc-client-key': clientKey } : {}),
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
    throw new OidcProfileFlowError(
      [400, 404, 429, 503].includes(response.status) ? response.status : 503,
      error,
      retryableCode && retrySameAttempt !== false
    )
  }
  return body as T
}

export async function getOidcProfileConfiguration(
  request: Request
): Promise<OidcProfileConfiguration> {
  const config = await requestExternal<OidcProfileConfiguration>(
    '/oidc/profile-flow/configuration',
    undefined,
    oidcClientKey(request)
  )
  if (
    !config ||
    typeof config.redirectUri !== 'string' ||
    config.memberAuthenticationActivated !== false
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

export function requestMatchesCallback(request: Request, callback: string): boolean {
  try {
    const incoming = new URL(request.url)
    const expected = new URL(callback)
    return incoming.origin === expected.origin && incoming.pathname === expected.pathname
  } catch {
    return false
  }
}

export function newBrowserBinding(): string {
  return randomBytes(32).toString('base64url')
}

export function browserCookieName(state: string): string {
  const suffix = createHash('sha256').update(state).digest('hex').slice(0, 24)
  return `__Host-ef_oidc_${suffix}`
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

export function setBrowserCookie(name: string, binding: string, maxAgeSeconds: number): string {
  const age = Math.max(0, Math.min(OIDC_BROWSER_COOKIE_MAX_AGE_SECONDS, Math.floor(maxAgeSeconds)))
  return `${name}=${binding}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`
}

export function clearBrowserCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`
}

export async function postOidcProfileFlow<T>(
  route: 'attempts' | 'complete' | 'cancel',
  body: Record<string, unknown>,
  request: Request
): Promise<T> {
  return requestExternal<T>(
    `/oidc/profile-flow/${route}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    oidcClientKey(request)
  )
}

export async function beginOidcAttempt(
  browserBinding: string,
  request: Request
): Promise<{
  authorizationUrl: string
  expiresAt: string
}> {
  return postOidcProfileFlow('attempts', { browserBinding }, request)
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
  return { kind: 'invalid' }
}

export function noStoreRedirect(url: string, cookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: url,
      'set-cookie': cookie,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
}

export function noStoreResult(message: string, status: number, cookie?: string): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  if (cookie) headers.append('set-cookie', cookie)
  return new Response(message, { status, headers })
}
