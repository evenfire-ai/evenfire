import { createHash, createPublicKey } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

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
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim()
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

const HISTORICAL_DEV_JWT_PUBLIC_FINGERPRINTS: ReadonlySet<string> = new Set([
  '4292d721765a93b0275f9f4ceb0a4667517fae00b5face8faa270513d610bb27',
  'f7dc08c248bf2b7724dead80dd96f9a5eeb49cf9920ba6fb46cf457a788d503e',
  '2d05f607d125e4bd3c157d5c6115bf63cb454c1e45cc5bcc8eed950771dcfd31',
])

function assertUsableJwtPublicKey(publicPem: string, envName: string): string {
  const normalized = normalizePem(publicPem)
  let fingerprint: string
  let canonicalPublicPem: string
  try {
    // OpenSSL accepts the first key in a bundle and ignores trailing material.
    // Require one public PEM block before parsing so the validated and used key agree.
    if (
      !/^-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY)-----\n[A-Za-z0-9+/=\s]+\n-----END \1-----$/.test(
        normalized
      )
    ) {
      throw new Error('Expected one public key')
    }
    const key = createPublicKey(normalized)
    if (key.asymmetricKeyType !== 'rsa') throw new Error('Expected RSA')
    const der = key.export({ type: 'spki', format: 'der' })
    fingerprint = createHash('sha256').update(der).digest('hex')
    canonicalPublicPem = key.export({ type: 'spki', format: 'pem' }).toString().trim()
  } catch {
    throw new Error(`${envName} must be a single PEM-encoded RSA public key`)
  }
  if (HISTORICAL_DEV_JWT_PUBLIC_FINGERPRINTS.has(fingerprint)) {
    throw new Error(`${envName} must not use a historically committed dev JWT key`)
  }
  return canonicalPublicPem
}

function readDevJwtPublicKey(storeDir: string, fileName: string, envName: string): string {
  const publicPath = join(storeDir, fileName)
  const missingStore = () =>
    new Error(
      `CLERUM_DEV_MODE=true requires the control-api dev key store at ${storeDir}. ` +
        `Start control-api once with CLERUM_DEV_MODE=true, or set ${envName}.`
    )
  let directoryStats
  try {
    directoryStats = lstatSync(storeDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw missingStore()
    throw err
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`Dev JWT key store path is not a directory: ${storeDir}`)
  }
  if (process.geteuid && directoryStats.uid !== process.geteuid()) {
    throw new Error(`Dev JWT key store directory is not owned by the current user: ${storeDir}`)
  }
  if ((directoryStats.mode & 0o077) !== 0) {
    throw new Error(
      `Dev JWT key store directory has group/other permissions; expected 0700: ${storeDir}`
    )
  }
  let fd: number
  try {
    // NONBLOCK avoids hanging on a hostile FIFO; fstat rejects every special file.
    fd = openSync(publicPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw missingStore()
    if (code === 'ELOOP')
      throw new Error(`Dev JWT key store path is a symbolic link: ${publicPath}`)
    throw err
  }
  try {
    const fileStats = fstatSync(fd)
    if (!fileStats.isFile()) {
      throw new Error(`Dev JWT key store path is not a regular file: ${publicPath}`)
    }
    if (process.geteuid && fileStats.uid !== process.geteuid()) {
      throw new Error(`Dev JWT key store file is not owned by the current user: ${publicPath}`)
    }
    if ((fileStats.mode & 0o022) !== 0) {
      throw new Error(
        `Dev JWT key store public file must not be group/other writable: ${publicPath}`
      )
    }
    // Read the descriptor whose identity and permissions were checked above.
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * Env var first; explicit dev mode loads the public half published next to the
 * control-api signing key; every other mode fails closed. The resolved key is
 * always fingerprint-checked so a historically committed public key is never
 * accepted as a verifier.
 */
function resolveSessionJwtPublicKey(): string {
  const envName = 'EXTERNAL_REST_API_JWT_PUBLIC_KEY'
  if (process.env.NODE_ENV === 'production' && process.env.CLERUM_DEV_MODE === 'true') {
    throw new Error(
      '[SECURITY] Startup rejected: CLERUM_DEV_MODE=true is not allowed with NODE_ENV=production.'
    )
  }
  const fromEnv = process.env[envName]
  if (fromEnv) return assertUsableJwtPublicKey(fromEnv, envName)
  if (process.env.CLERUM_DEV_MODE === 'true') {
    const override = process.env.EVENFIRE_DEV_KEY_STORE?.trim()
    if (override && !isAbsolute(override)) {
      throw new Error('EVENFIRE_DEV_KEY_STORE must be an absolute path')
    }
    const storeDir = override || join(serviceRoot(), '..', 'control-api', '.dev-keys')
    const fromStore = readDevJwtPublicKey(storeDir, 'session.public.pem', envName)
    return assertUsableJwtPublicKey(fromStore, envName)
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
  externalGfsEdgeAggregateRlPerMin: externalGfsEdgeRateLimits.externalGfsEdgeAggregateRlPerMin,
  externalGfsEdgeAuthenticatedIpRlPerMin:
    externalGfsEdgeRateLimits.externalGfsEdgeAuthenticatedIpRlPerMin,
  externalGfsEdgeTokenIpRlPerMin: externalGfsEdgeRateLimits.externalGfsEdgeTokenIpRlPerMin,
}

if (process.env.NODE_ENV === 'production' && config.corsOrigin === '*') {
  throw new Error("EXTERNAL_REST_API_CORS_ORIGIN cannot be '*' in production")
}
