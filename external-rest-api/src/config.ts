import { dirname, join } from 'node:path'
import { parseVerifierMaterial } from '@clerum/jwt-key-policy'
import { readDevVerifierMaterial, resolveDevKeyStoreDir } from '@clerum/jwt-key-policy/dev-store'

const DEV_MODE_ENABLED = process.env.CLERUM_DEV_MODE === 'true'
if (process.env.NODE_ENV === 'production' && DEV_MODE_ENABLED) {
  throw new Error(
    '[SECURITY] Startup rejected: CLERUM_DEV_MODE=true is not allowed with NODE_ENV=production.'
  )
}

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
  desktopProfileUiBaseUrl: string
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

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.')
}

function isPrivateIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false
  const octets = hostname.split('.').map(Number)
  return (
    octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) ||
    octets[0] >= 224
  )
}

export function validateDesktopProfileUiBaseUrl(raw: string, publicRestBaseUrl: string): string {
  const value = raw.trim()
  const rawOrigin = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(value)
  if (
    !value ||
    value !== raw ||
    /[\u0000-\u0020\u007f]/.test(value) ||
    !rawOrigin ||
    (rawOrigin[3] !== '' && rawOrigin[3] !== '/') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    throw new Error('DESKTOP_PROFILE_UI_PUBLIC_BASE_URL must be an absolute HTTP(S) origin')
  }

  let profileUrl: URL
  let restUrl: URL
  try {
    profileUrl = new URL(value)
    restUrl = new URL(publicRestBaseUrl)
  } catch {
    throw new Error('DESKTOP_PROFILE_UI_PUBLIC_BASE_URL must be an absolute HTTP(S) origin')
  }
  if (
    !['http:', 'https:'].includes(profileUrl.protocol) ||
    profileUrl.username ||
    profileUrl.password ||
    !['http:', 'https:'].includes(restUrl.protocol)
  ) {
    throw new Error('DESKTOP_PROFILE_UI_PUBLIC_BASE_URL must be an absolute HTTP(S) origin')
  }

  const profileHost = profileUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const restLoopback = isLoopbackHostname(restUrl.hostname)
  const profileLoopback = isLoopbackHostname(profileHost)
  if (profileLoopback && !restLoopback) {
    throw new Error('Loopback Profile UI origin requires a loopback External REST origin')
  }
  if (!profileLoopback && profileUrl.protocol !== 'https:') {
    throw new Error('Non-loopback Profile UI origins must use HTTPS')
  }
  const mappedIpv4 = profileHost.match(/^::ffff:(.+)$/i)?.[1]
  let mappedPrivateIpv4 = false
  if (mappedIpv4 && isIP(mappedIpv4) === 4) {
    mappedPrivateIpv4 = isPrivateIpv4(mappedIpv4)
  } else if (mappedIpv4 && /^[0-9a-f:]+$/i.test(mappedIpv4)) {
    const groups = mappedIpv4.split(':').filter(Boolean)
    const low = Number.parseInt(groups.at(-1) || '0', 16)
    const high = Number.parseInt(groups.at(-2) || '0', 16)
    mappedPrivateIpv4 = isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  const privateIpv6 =
    isIP(profileHost) === 6 && (profileHost === '::' || /^(fc|fd|fe[89a-f])/i.test(profileHost))
  if (!profileLoopback && (isPrivateIpv4(profileHost) || mappedPrivateIpv4 || privateIpv6)) {
    throw new Error('Private IP Profile UI origins are not permitted')
  }
  return profileUrl.origin
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

function serviceRoot(): string {
  // Works in every supported runtime: CommonJS (dist and ts-node) resolves
  // __dirname to <service>/dist or <service>/src; Vitest's ESM transform falls
  // back to the service working directory used by every test/npm script.
  return typeof __dirname === 'string' && __dirname ? dirname(__dirname) : process.cwd()
}

/**
 * Env var first; explicit dev mode loads the public half published next to the
 * control-api signing key; every other mode fails closed. The resolved key is
 * always fingerprint-checked so a historically committed public key is never
 * accepted as a verifier.
 */
function resolveSessionJwtPublicKey(): string {
  const envName = 'EXTERNAL_REST_API_JWT_PUBLIC_KEY'
  const fromEnv = process.env[envName]
  if (fromEnv) return parseVerifierMaterial(fromEnv, envName).publicPem
  if (DEV_MODE_ENABLED) {
    const storeDir = resolveDevKeyStoreDir(
      join(serviceRoot(), '..', 'control-api'),
      process.env.EVENFIRE_DEV_KEY_STORE
    )
    return readDevVerifierMaterial('session', storeDir).publicPem
  }
  return required(envName)
}

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
  jwtPublicKey: resolveSessionJwtPublicKey(),
  jwtIssuer: requiredOrDevDefault('EXTERNAL_REST_API_JWT_ISSUER', 'control-api'),
  jwtAudience: requiredOrDevDefault('EXTERNAL_REST_API_JWT_AUDIENCE', 'profile-ui'),
  profileSessionCookieTtlSeconds: positiveIntegerFromEnv(
    'EXTERNAL_REST_API_PROFILE_SESSION_COOKIE_TTL_SECONDS',
    60 * 60 * 24 * 7
  ),
  publicBaseUrl: requiredOrDevDefault(
    'EXTERNAL_REST_API_PUBLIC_BASE_URL',
    'http://127.0.0.1:8091'
  ).replace(/\/+$/, ''),
  desktopRpcProxyBaseUrl: requiredOrDevDefault(
    'EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL',
    'http://127.0.0.1:8094'
  ).replace(/\/+$/, ''),
  desktopProfileUiBaseUrl: validateDesktopProfileUiBaseUrl(
    requiredOrDevDefault('DESKTOP_PROFILE_UI_PUBLIC_BASE_URL', 'http://127.0.0.1:3001'),
    requiredOrDevDefault('EXTERNAL_REST_API_PUBLIC_BASE_URL', 'http://127.0.0.1:8091')
  ),
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
  externalGfsEdgeAggregateRlPerMin: externalGfsEdgeRateLimits.externalGfsEdgeAggregateRlPerMin,
  externalGfsEdgeAuthenticatedIpRlPerMin:
    externalGfsEdgeRateLimits.externalGfsEdgeAuthenticatedIpRlPerMin,
  externalGfsEdgeTokenIpRlPerMin: externalGfsEdgeRateLimits.externalGfsEdgeTokenIpRlPerMin,
}

if (process.env.NODE_ENV === 'production' && config.corsOrigin === '*') {
  throw new Error("EXTERNAL_REST_API_CORS_ORIGIN cannot be '*' in production")
}
