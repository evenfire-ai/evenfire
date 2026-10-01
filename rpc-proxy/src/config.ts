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
  corsOrigin: string[] | '*'
  jwtPublicKey: string
  jwtIssuer: string
  jwtAudience: string
  upstreamTimeoutMs: number
  maxTokenLength: number
  allowedMethodPattern: RegExp
  controlApiBaseUrl: string
  controlApiServiceToken: string
  controlApiServiceName: string
  controlApiCacheTtlMs: number
  artifactDownloadMaxBytes: number
  artifactDownloadTimeoutMs: number
  streamMaxLifetimeMs: number
  streamIntervalMs: number
  streamKeepaliveMs: number
  streamMaxConcurrent: number
  streamMaxPerUser: number
  streamMaxPerUserHost: number
  streamIdleTimeoutMs: number
  activityStreamMaxLifetimeMs: number
  activityStreamKeepaliveMs: number
  activityStreamIdleTimeoutMs: number
  activityStreamMaxConcurrent: number
  activityStreamMaxPerUser: number
  activityStreamMaxPerUserHost: number
  /**
   * Stateless wake-and-hold (Stage 5): a request hitting a down/draining
   * stateless host is parked while control-api wakes the pod, bounded by
   * `wakeMaxHoldMs` (values above MAX_REQUEST_HOLD_MS are clamped at load).
   * Readiness is re-checked every `wakePollMs` and the wake
   * is re-triggered every `wakeRetriggerMs` (covers a dropped HCC watch
   * event). See src/services/wakeAndHold.ts.
   */
  wakeMaxHoldMs: number
  wakePollMs: number
  wakeRetriggerMs: number
  hccBaseUrl: string
  hostNamespace: string
  desktopCookieName: string
  desktopCookieMaxAgeMs: number
  desktopCookieSecret: string
  desktopPort: number
  desktopApiToken: string
  sandboxUiNamespace: string
  sandboxUiRegistryCacheTtlMs: number
  sandboxUiCookieName: string
  sandboxUiCookieSecret: string
  sandboxUiCookieMaxAgeSec: number
  sandboxUiAllowedPorts: ReadonlySet<number>
  /**
   * Spec §9.9 — public base URL of control-api. The OAuth `redirect_uri`
   * sent to providers (Slack, Salesforce, Notion, Microsoft Graph, Google)
   * is constructed from this; the user's browser hits the same URL after
   * the provider redirect, so it MUST be reachable from the user's machine
   * (in dev: the port-forward; in prod: the public ingress).
   */
  oauthCallbackBaseUrl: string
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

export function parseSandboxUiAllowedPorts(raw: string): ReadonlySet<number> {
  const ports = new Set<number>()
  for (const token of raw.split(',')) {
    const trimmed = token.trim()
    if (!trimmed) continue
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(
        `RPC_PROXY_SANDBOX_UI_ALLOWED_PORTS contains invalid port "${trimmed}" (must be integer 1-65535)`
      )
    }
    ports.add(n)
  }
  if (ports.size === 0) {
    throw new Error('RPC_PROXY_SANDBOX_UI_ALLOWED_PORTS must list at least one port')
  }
  return ports
}

export function parseArtifactDownloadMaxBytes(rawMb: string): number {
  const trimmed = rawMb.trim()
  const mb = Number(trimmed)
  if (!Number.isFinite(mb) || mb <= 0) {
    throw new Error(
      `RPC_PROXY_ARTIFACT_DOWNLOAD_MAX_MB contains invalid value "${trimmed}" (must be > 0)`
    )
  }
  const bytes = Math.floor(mb * 1024 * 1024)
  if (bytes < 1) {
    throw new Error('RPC_PROXY_ARTIFACT_DOWNLOAD_MAX_MB must resolve to at least one byte')
  }
  return bytes
}

/** Largest delay setTimeout/AbortSignal.timeout accept; above it they fire immediately. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

export function parsePositiveIntMs(name: string, raw: string): number {
  const trimmed = raw.trim()
  const n = Number(trimmed)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} contains invalid value "${trimmed}" (must be a positive integer)`)
  }
  if (n > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `${name} contains invalid value "${trimmed}" (must be at most ${MAX_TIMER_DELAY_MS} ms)`
    )
  }
  return n
}

/**
 * Upper bound of one held request: it leaves room for a final upstream attempt
 * before Desktop's own 60s deadline. The hold budget is capped here, at config
 * load, so the configured value is the effective one.
 */
export const MAX_REQUEST_HOLD_MS = 48_000

/**
 * An operator-set value above the cap is clamped and warned about at boot.
 * The built-in default equals the cap, so it never reaches the warning.
 */
export function parseWakeMaxHoldMs(raw: string): number {
  const configuredMs = parsePositiveIntMs('RPC_PROXY_WAKE_MAX_HOLD_MS', raw)
  if (configuredMs <= MAX_REQUEST_HOLD_MS) return configuredMs
  console.warn(
    `[RPC_PROXY] RPC_PROXY_WAKE_MAX_HOLD_MS=${configuredMs} exceeds the request hold cap; clamped to ${MAX_REQUEST_HOLD_MS}`
  )
  return MAX_REQUEST_HOLD_MS
}

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
function resolveRpcJwtPublicKey(): string {
  const envName = 'RPC_PROXY_JWT_PUBLIC_KEY'
  const fromEnv = process.env[envName]
  if (fromEnv) return parseVerifierMaterial(fromEnv, envName).publicPem
  if (DEV_MODE_ENABLED) {
    const storeDir = resolveDevKeyStoreDir(
      join(serviceRoot(), '..', 'control-api'),
      process.env.EVENFIRE_DEV_KEY_STORE
    )
    return readDevVerifierMaterial('rpc', storeDir).publicPem
  }
  return required(envName)
}

export const config: Config = {
  port: Number(process.env.RPC_PROXY_PORT || 8094),
  corsOrigin: parseCorsOrigin(
    requiredOrDevDefault('RPC_PROXY_CORS_ORIGIN', 'http://localhost:3000')
  ),
  jwtPublicKey: resolveRpcJwtPublicKey(),
  jwtIssuer: requiredOrDevDefault('RPC_PROXY_JWT_ISSUER', 'control-api'),
  jwtAudience: requiredOrDevDefault('RPC_PROXY_JWT_AUDIENCE', 'rpc-proxy'),
  upstreamTimeoutMs: parsePositiveIntMs(
    'RPC_PROXY_UPSTREAM_TIMEOUT_MS',
    process.env.RPC_PROXY_UPSTREAM_TIMEOUT_MS || '8000'
  ),
  maxTokenLength: Number(process.env.RPC_PROXY_MAX_TOKEN_LENGTH || 4096),
  allowedMethodPattern: new RegExp(
    process.env.RPC_PROXY_ALLOWED_METHOD_PATTERN || '^[a-zA-Z0-9_./:-]{1,120}$'
  ),
  controlApiBaseUrl: requiredOrDevDefault(
    'RPC_PROXY_CONTROL_API_BASE_URL',
    'http://control-api.control-plane.svc.cluster.local:8090/api/v1'
  ),
  controlApiServiceToken: (() => {
    const v = requiredOrDevDefault('RPC_PROXY_CONTROL_API_SERVICE_TOKEN', 'dev-rpc-proxy-token')
    assertNotPlaceholder('RPC_PROXY_CONTROL_API_SERVICE_TOKEN', v)
    return v
  })(),
  controlApiServiceName: process.env.RPC_PROXY_CONTROL_API_SERVICE_NAME || 'rpc-proxy',
  controlApiCacheTtlMs: Number(process.env.RPC_PROXY_CONTROL_API_CACHE_TTL_MS || 30000),
  artifactDownloadMaxBytes: parseArtifactDownloadMaxBytes(
    process.env.RPC_PROXY_ARTIFACT_DOWNLOAD_MAX_MB || '50'
  ),
  artifactDownloadTimeoutMs: parsePositiveIntMs(
    'RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS',
    process.env.RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS || '60000'
  ),
  streamMaxLifetimeMs: Number(process.env.RPC_PROXY_STREAM_MAX_LIFETIME_MS || 600000),
  streamIntervalMs: Number(process.env.RPC_PROXY_STREAM_INTERVAL_MS || 3000),
  streamKeepaliveMs: Number(process.env.RPC_PROXY_STREAM_KEEPALIVE_MS || 15000),
  streamMaxConcurrent: Number(process.env.RPC_PROXY_STREAM_MAX_CONCURRENT || 1000),
  streamMaxPerUser: Number(process.env.RPC_PROXY_STREAM_MAX_PER_USER || 3),
  streamMaxPerUserHost: Number(process.env.RPC_PROXY_STREAM_MAX_PER_USER_HOST || 1),
  streamIdleTimeoutMs: Number(process.env.RPC_PROXY_STREAM_IDLE_TIMEOUT_MS || 60000),
  activityStreamMaxLifetimeMs: Number(
    process.env.RPC_PROXY_ACTIVITY_STREAM_MAX_LIFETIME_MS || 600000
  ),
  activityStreamKeepaliveMs: Number(process.env.RPC_PROXY_ACTIVITY_STREAM_KEEPALIVE_MS || 15000),
  activityStreamIdleTimeoutMs: Number(
    process.env.RPC_PROXY_ACTIVITY_STREAM_IDLE_TIMEOUT_MS || 60000
  ),
  activityStreamMaxConcurrent: Number(process.env.RPC_PROXY_ACTIVITY_STREAM_MAX_CONCURRENT || 1000),
  activityStreamMaxPerUser: Number(process.env.RPC_PROXY_ACTIVITY_STREAM_MAX_PER_USER || 3),
  activityStreamMaxPerUserHost: Number(
    process.env.RPC_PROXY_ACTIVITY_STREAM_MAX_PER_USER_HOST || 1
  ),
  wakeMaxHoldMs: parseWakeMaxHoldMs(process.env.RPC_PROXY_WAKE_MAX_HOLD_MS || '48000'),
  wakePollMs: parsePositiveIntMs(
    'RPC_PROXY_WAKE_POLL_MS',
    process.env.RPC_PROXY_WAKE_POLL_MS || '2000'
  ),
  wakeRetriggerMs: parsePositiveIntMs(
    'RPC_PROXY_WAKE_RETRIGGER_MS',
    process.env.RPC_PROXY_WAKE_RETRIGGER_MS || '15000'
  ),
  hccBaseUrl: requiredOrDevDefault(
    'RPC_PROXY_HCC_BASE_URL',
    // Must mirror the real topology: rpc-proxy reaches HCC only through the
    // nginx api-gateway in control-plane. The egress NetworkPolicy in
    // deploy/base/rpc-proxy/networkpolicies.yaml only allows that peer, and no
    // host-context-controller Service exists in mcp-server. Kept in sync with
    // the deployed configmap by config.hccBaseUrl.test.ts.
    'http://host-context-controller-api-gateway.control-plane.svc.cluster.local:8081'
  ),
  hostNamespace: requiredOrDevDefault('RPC_PROXY_HOST_NAMESPACE', 'mcp-host'),
  desktopCookieName: process.env.RPC_PROXY_DESKTOP_COOKIE_NAME || 'clerum_desktop_session',
  desktopCookieMaxAgeMs: Number(process.env.RPC_PROXY_DESKTOP_COOKIE_MAX_AGE_MS || 3_600_000),
  desktopCookieSecret: requiredOrDevDefault(
    'RPC_PROXY_DESKTOP_COOKIE_SECRET',
    'dev-desktop-cookie-secret-32chars!'
  ),
  desktopPort: Number(process.env.RPC_PROXY_DESKTOP_PORT || 3000),
  desktopApiToken: process.env.RPC_PROXY_DESKTOP_API_TOKEN || '',
  sandboxUiNamespace: process.env.RPC_PROXY_SANDBOX_UI_NAMESPACE || 'sandbox-ui',
  // 5s cache for the registry lookup. Keep the value short — a recipe
  // transitioning from `deploying` to `active` should be picked up on the
  // user's next click, not after a multi-minute TTL expires.
  sandboxUiRegistryCacheTtlMs: Number(
    process.env.RPC_PROXY_SANDBOX_UI_REGISTRY_CACHE_TTL_MS || 5000
  ),
  sandboxUiCookieName: process.env.RPC_PROXY_SANDBOX_UI_COOKIE_NAME || 'clerum_sandbox_ui_session',
  sandboxUiCookieSecret: requiredOrDevDefault(
    'RPC_PROXY_SANDBOX_UI_COOKIE_SECRET',
    'dev-sandbox-ui-cookie-secret-32chars!'
  ),
  // 5 minute TTL on the UI session cookie.
  sandboxUiCookieMaxAgeSec: Number(process.env.RPC_PROXY_SANDBOX_UI_COOKIE_MAX_AGE_SEC || 300),
  // Defence-in-depth: even though the NetworkPolicy
  // `allow-sandbox-ui-egress-rpc-proxy` already restricts rpc-proxy egress to
  // a single port, recipe authors set `ui.port` freely (CRD: 1-65535). When
  // NetworkPolicy enforcement is disabled, this allow-list is the only thing
  // stopping a malicious recipe from pointing rpc-proxy at privileged or
  // control-plane-style ports on its own UI pod.
  //
  // Default: 8080 — matches the port pinned in the egress NetworkPolicy. To
  // expand, update both this env var AND `allow-sandbox-ui-egress-rpc-proxy`.
  sandboxUiAllowedPorts: parseSandboxUiAllowedPorts(
    process.env.RPC_PROXY_SANDBOX_UI_ALLOWED_PORTS || '8080'
  ),
  oauthCallbackBaseUrl: requiredOrDevDefault(
    'RPC_PROXY_OAUTH_CALLBACK_BASE_URL',
    'http://localhost:8090'
  ).replace(/\/+$/, ''),
}

if (process.env.NODE_ENV === 'production' && config.corsOrigin === '*') {
  throw new Error("RPC_PROXY_CORS_ORIGIN cannot be '*' in production")
}
