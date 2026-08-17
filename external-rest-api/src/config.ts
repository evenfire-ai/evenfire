type Config = {
  port: number
  jsonBodyLimit: string
  corsOrigin: string[] | '*'
  googleClientId: string
  controlApiBaseUrl: string
  controlApiServiceToken: string
  controlApiServiceName: string
  jwtPublicKey: string
  jwtIssuer: string
  jwtAudience: string
  profileSessionCookieTtlSeconds: number
  publicBaseUrl: string
  desktopRpcProxyBaseUrl: string
  desktopAppName: string
  desktopReleaseBaseUrl: string
  gfsUploadRequestPerMinute: number
  gfsUploadMaxPartBytes: number
  externalGfsEdgeAggregateRlPerMin: number
  externalGfsEdgeAuthenticatedIpRlPerMin: number
  externalGfsEdgeTokenIpRlPerMin: number
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function requiredOrDevDefault(name: string, devDefault: string): string {
  const value = process.env[name]
  if (value) return value
  if (process.env.NODE_ENV !== 'production') return devDefault
  return required(name)
}

function positiveIntegerFromEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return defaultValue

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function boundedIntegerFromEnv(name: string, defaultValue: number, maxValue: number): number {
  const value = positiveIntegerFromEnv(name, defaultValue)
  if (value > maxValue) throw new Error(`${name} must be an integer between 1 and ${maxValue}`)
  return value
}

function boundedPositiveIntegerFromEnv(name: string, defaultValue: number, max: number): number {
  const value = positiveIntegerFromEnv(name, defaultValue)
  if (value > max) throw new Error(`${name} must be <= ${max}`)
  return value
}

/**
 * Parse a CORS-origin env value. A bare `*` stays the literal `'*'` (handled
 * specially in app.ts). Anything else is split on commas into a trimmed,
 * non-empty list, which the `cors` package matches per-request — required for
 * credentialed multi-origin CORS, where a single fixed string cannot work.
 */
export function parseCorsOrigin(raw: string): string[] | '*' {
  if (raw.trim() === '*') return '*'
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function assertNotPlaceholder(label: string, value: string): void {
  // Fail loud if the former overlay placeholder ever leaks into a running pod.
  // Populated out-of-band by deploy/scripts/apply-inter-service-tokens.sh.
  if (/^replace-with-/.test(value)) {
    throw new Error(
      `${label} has placeholder value "${value}". Run deploy/scripts/apply-inter-service-tokens.sh before deploying.`
    )
  }
}

function normalizePem(value: string): string {
  return value.replace(/\\n/g, '\n').trim()
}

const DEV_SESSION_JWT_PUBLIC_KEY = normalizePem(`-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwrZja9jS/r+e2YF1FqEQ
NMLsnffebYzXrZOb7uPMKhXBoKjJh/taR9v3kX2srfVtoikcKKr0Sfa7MMSLnZWd
ETmi7MvbeVD3HpsXpVejmw9D0zeYYSGZplLF/b6HY0Lz2XVM8WdJl3Dicyu+SZbZ
xeHZtMCMTTjvmoI/IYmmO4N3Pgz/SGi7V3EiwoALODP4OWDvd/1xFUiMPslLPgZU
EczQ5tIpAaD4e0om3gUNsyOKYc5igojm6ooVqI9T3TUGBVJ0uSZB7ntWxKQ39WyI
aH+oqnwDGbDcDLQ/wTuBtcn4brWTDgW1xA73HVBSImGFvvHCWBiQBiI1nvovUP0u
WQIDAQAB
-----END PUBLIC KEY-----`)

const EXTERNAL_GFS_EDGE_AGGREGATE_ENV = 'EXTERNAL_REST_API_GFS_EDGE_AGGREGATE_RL_PER_MIN'
const EXTERNAL_GFS_EDGE_CLIENT_IP_ENV = 'EXTERNAL_REST_API_GFS_EDGE_AUTHENTICATED_IP_RL_PER_MIN'
const EXTERNAL_GFS_EDGE_TOKEN_IP_ENV = 'EXTERNAL_REST_API_GFS_EDGE_TOKEN_IP_RL_PER_MIN'
const EXTERNAL_GFS_EDGE_RATE_LIMIT_MAX = 1_000_000

function parseExternalGfsEdgeRateLimits() {
  const externalGfsEdgeAggregateRlPerMin = boundedPositiveIntegerFromEnv(
    EXTERNAL_GFS_EDGE_AGGREGATE_ENV,
    1_800,
    EXTERNAL_GFS_EDGE_RATE_LIMIT_MAX
  )
  const externalGfsEdgeAuthenticatedIpRlPerMin = boundedPositiveIntegerFromEnv(
    EXTERNAL_GFS_EDGE_CLIENT_IP_ENV,
    1_200,
    EXTERNAL_GFS_EDGE_RATE_LIMIT_MAX
  )
  const externalGfsEdgeTokenIpRlPerMin = boundedPositiveIntegerFromEnv(
    EXTERNAL_GFS_EDGE_TOKEN_IP_ENV,
    600,
    EXTERNAL_GFS_EDGE_RATE_LIMIT_MAX
  )

  if (
    externalGfsEdgeTokenIpRlPerMin > externalGfsEdgeAuthenticatedIpRlPerMin ||
    externalGfsEdgeAuthenticatedIpRlPerMin >= externalGfsEdgeAggregateRlPerMin
  ) {
    throw new Error(
      `External REST GFS edge rate limits must satisfy ${EXTERNAL_GFS_EDGE_TOKEN_IP_ENV} <= ` +
        `${EXTERNAL_GFS_EDGE_CLIENT_IP_ENV} < ${EXTERNAL_GFS_EDGE_AGGREGATE_ENV}`
    )
  }

  return {
    externalGfsEdgeAggregateRlPerMin,
    externalGfsEdgeAuthenticatedIpRlPerMin,
    externalGfsEdgeTokenIpRlPerMin,
  }
}

const externalGfsEdgeRateLimits = parseExternalGfsEdgeRateLimits()

export const config: Config = {
  port: Number(process.env.EXTERNAL_REST_API_PORT || 8091),
  jsonBodyLimit: process.env.EXTERNAL_REST_API_JSON_BODY_LIMIT || '150mb',
  corsOrigin: parseCorsOrigin(
    requiredOrDevDefault('EXTERNAL_REST_API_CORS_ORIGIN', 'http://localhost:3001')
  ),
  googleClientId: requiredOrDevDefault(
    'EXTERNAL_REST_API_GOOGLE_CLIENT_ID',
    'dev-google-client-id'
  ),
  controlApiBaseUrl: requiredOrDevDefault(
    'EXTERNAL_REST_API_CONTROL_API_BASE_URL',
    'http://profile-control-funnel.profiles.svc.cluster.local:8080/api/v1'
  ),
  controlApiServiceToken: (() => {
    const v = requiredOrDevDefault(
      'EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN',
      'dev-external-rest-api-token'
    )
    assertNotPlaceholder('EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN', v)
    return v
  })(),
  controlApiServiceName:
    process.env.EXTERNAL_REST_API_CONTROL_API_SERVICE_NAME || 'external-rest-api',
  jwtPublicKey: normalizePem(
    requiredOrDevDefault('EXTERNAL_REST_API_JWT_PUBLIC_KEY', DEV_SESSION_JWT_PUBLIC_KEY)
  ),
  jwtIssuer: requiredOrDevDefault('EXTERNAL_REST_API_JWT_ISSUER', 'control-api'),
  jwtAudience: requiredOrDevDefault('EXTERNAL_REST_API_JWT_AUDIENCE', 'profile-ui'),
  profileSessionCookieTtlSeconds: positiveIntegerFromEnv(
    'EXTERNAL_REST_API_PROFILE_SESSION_COOKIE_TTL_SECONDS',
    60 * 60 * 12
  ),
  publicBaseUrl: requiredOrDevDefault(
    'EXTERNAL_REST_API_PUBLIC_BASE_URL',
    'http://127.0.0.1:8091'
  ).replace(/\/+$/, ''),
  desktopRpcProxyBaseUrl: requiredOrDevDefault(
    'EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL',
    'http://127.0.0.1:8094'
  ).replace(/\/+$/, ''),
  desktopAppName: process.env.EXTERNAL_REST_API_DESKTOP_APP_NAME || 'Evenfire',
  desktopReleaseBaseUrl: (
    process.env.EXTERNAL_REST_API_DESKTOP_RELEASE_BASE_URL ||
    'https://github.com/evenfire-ai/evenfire/releases'
  ).replace(/\/+$/, ''),
  // Coarse per-instance edge guard. The replica-safe principal/IP request and
  // weighted-byte budgets live in control-api's PostgreSQL admission layer.
  gfsUploadRequestPerMinute: positiveIntegerFromEnv(
    'EXTERNAL_REST_API_GFS_UPLOAD_REQUESTS_PER_MINUTE',
    120
  ),
  gfsUploadMaxPartBytes: boundedIntegerFromEnv(
    'EXTERNAL_REST_API_GFS_UPLOAD_MAX_PART_BYTES',
    16 * 1024 * 1024,
    16 * 1024 * 1024
  ),
  // Coherent GFS-only tiers: token IP <= client IP < process aggregate. The
  // Control API's distributed 10/min token and 30/min session/actor budgets
  // remain authoritative.
  ...externalGfsEdgeRateLimits,
}

if (process.env.NODE_ENV === 'production' && config.corsOrigin === '*') {
  throw new Error("EXTERNAL_REST_API_CORS_ORIGIN cannot be '*' in production")
}
