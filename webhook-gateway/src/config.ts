import { readFileSync } from 'node:fs'
import type { GatewayConfig, WebhookConfigEntry } from './types'

/**
 * Slowloris budgets are *not* recipe-author tunable (spec §7). They
 * are read from environment variables so ops can tweak per-cluster
 * without rebuilding the image, but the defaults match the spec
 * verbatim and we expect them to never change in v1.
 */
export interface RuntimeBudgets {
  /** Header-receive timeout (ms). */
  headerTimeoutMs: number
  /** Body-receive idle timeout (ms). */
  bodyIdleTimeoutMs: number
  /** Total request lifetime (ms). */
  totalTimeoutMs: number
  /** Maximum concurrent in-flight requests; above → 503 gateway_busy. */
  maxInFlight: number
}

export const DEFAULT_BUDGETS: Readonly<RuntimeBudgets> = Object.freeze({
  headerTimeoutMs: 5_000,
  bodyIdleTimeoutMs: 10_000,
  totalTimeoutMs: 30_000,
  maxInFlight: 256,
})

export interface ServerOptions {
  /** Public-facing port serving /:webhookId routes. */
  httpPort: number
  /** Metrics + /healthz port. Always different from httpPort. */
  metricsPort: number
  budgets: RuntimeBudgets
  configPath: string
  /** When true, log debug info; off in production. */
  debug: boolean
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer; got ${JSON.stringify(raw)}`)
  }
  return n
}

export function loadServerOptions(): ServerOptions {
  return {
    httpPort: intFromEnv('GATEWAY_HTTP_PORT', 8090),
    metricsPort: intFromEnv('GATEWAY_METRICS_PORT', 9090),
    budgets: {
      headerTimeoutMs: intFromEnv('GATEWAY_HEADER_TIMEOUT_MS', DEFAULT_BUDGETS.headerTimeoutMs),
      bodyIdleTimeoutMs: intFromEnv(
        'GATEWAY_BODY_IDLE_TIMEOUT_MS',
        DEFAULT_BUDGETS.bodyIdleTimeoutMs
      ),
      totalTimeoutMs: intFromEnv('GATEWAY_TOTAL_TIMEOUT_MS', DEFAULT_BUDGETS.totalTimeoutMs),
      maxInFlight: intFromEnv('GATEWAY_MAX_IN_FLIGHT', DEFAULT_BUDGETS.maxInFlight),
    },
    configPath: process.env.GATEWAY_CONFIG_PATH || '/etc/webhook-gateway/config.json',
    debug: process.env.GATEWAY_DEBUG === 'true',
  }
}

/**
 * Pattern shared between webhook-proxy URL parsing and gateway-side
 * revalidation. The gateway re-checks `webhookId` against this
 * BEFORE any config / secret / filesystem lookup as defense-in-depth
 * against a webhook-proxy bug (must-fix #2 in spec security analysis).
 */
export const WEBHOOK_ID_RE = /^[a-z0-9-]{1,63}$/

/** Read + parse the gateway config from disk. Throws on malformed JSON. */
export function loadGatewayConfig(path: string): GatewayConfig {
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw)
  return validateGatewayConfig(parsed)
}

/**
 * Tolerant validator. We trust WRC to write correct config (it just
 * reconciled from the CRD), but we still defensively check shape so a
 * truncated or partially-written file fails loudly instead of running
 * with `undefined` upstreams.
 */
export function validateGatewayConfig(value: unknown): GatewayConfig {
  if (!isObject(value) || !isObject(value.webhooks)) {
    throw new Error('gateway config: missing or non-object `webhooks`')
  }
  const webhooks: Record<string, WebhookConfigEntry> = {}
  for (const [id, entry] of Object.entries(value.webhooks)) {
    if (!WEBHOOK_ID_RE.test(id)) {
      throw new Error(
        `gateway config: webhook id ${JSON.stringify(id)} fails ${WEBHOOK_ID_RE} (config corruption?)`
      )
    }
    webhooks[id] = validateEntry(id, entry)
  }
  return { webhooks }
}

function validateEntry(id: string, value: unknown): WebhookConfigEntry {
  if (!isObject(value)) {
    throw new Error(`gateway config: webhook ${id} is not an object`)
  }
  if (value.id !== id) {
    throw new Error(`gateway config: webhook ${id} has mismatching .id field ${JSON.stringify(value.id)}`)
  }
  const methods = value.methods
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new Error(`gateway config: webhook ${id} has empty/missing methods`)
  }
  for (const m of methods) {
    if (m !== 'POST' && m !== 'GET') {
      throw new Error(`gateway config: webhook ${id} has unsupported method ${JSON.stringify(m)}`)
    }
  }
  if (!methods.includes('POST')) {
    throw new Error(`gateway config: webhook ${id} methods must include POST`)
  }
  const maxBodyBytes = value.maxBodyBytes
  if (typeof maxBodyBytes !== 'number' || maxBodyBytes < 1024 || maxBodyBytes > 10_485_760) {
    throw new Error(`gateway config: webhook ${id} maxBodyBytes out of range`)
  }
  const verification = validateVerification(id, value.verification)
  const replay = validateReplay(id, value.replay, verification.scheme)
  const upstream = validateUpstream(id, value.upstream)
  const setupHandshake = validateSetupHandshake(id, value.setupHandshake, methods as Array<string>)
  const dormant = value.dormant === true
  const dormantSecretName =
    typeof value.dormantSecretName === 'string' && value.dormantSecretName.length > 0
      ? value.dormantSecretName
      : undefined
  return {
    id,
    methods: methods as ReadonlyArray<'POST' | 'GET'>,
    maxBodyBytes,
    verification,
    setupHandshake,
    replay,
    upstream,
    dormant: dormant || undefined,
    dormantSecretName: dormant ? dormantSecretName : undefined,
  }
}

function validateSetupHandshake(
  id: string,
  value: unknown,
  methods: Array<string>,
): WebhookConfigEntry['setupHandshake'] {
  if (value === undefined) {
    if (methods.includes('GET')) {
      throw new Error(
        `gateway config: webhook ${id} methods includes GET but no setupHandshake — admission should have rejected this (W13)`,
      )
    }
    return undefined
  }
  if (!isObject(value)) {
    throw new Error(`gateway config: webhook ${id} setupHandshake is not an object`)
  }
  const strategy = value.strategy
  if (
    strategy !== 'meta-hub-challenge' &&
    strategy !== 'slack-url-verification' &&
    strategy !== 'stripe-verify'
  ) {
    throw new Error(
      `gateway config: webhook ${id} setupHandshake.strategy ${JSON.stringify(strategy)} is not supported`,
    )
  }
  const secretPath = value.secretPath
  if (strategy === 'meta-hub-challenge') {
    if (typeof secretPath !== 'string' || secretPath.length === 0) {
      throw new Error(`gateway config: webhook ${id} meta-hub-challenge requires setupHandshake.secretPath`)
    }
    if (!methods.includes('GET')) {
      throw new Error(`gateway config: webhook ${id} meta-hub-challenge requires methods to include GET`)
    }
    return { strategy, secretPath }
  }
  // slack-url-verification + stripe-verify: secretPath optional / unused.
  if (secretPath !== undefined && (typeof secretPath !== 'string' || secretPath.length === 0)) {
    throw new Error(`gateway config: webhook ${id} setupHandshake.secretPath must be a non-empty string when set`)
  }
  return { strategy, secretPath: typeof secretPath === 'string' ? secretPath : undefined }
}

function validateVerification(id: string, value: unknown): WebhookConfigEntry['verification'] {
  if (!isObject(value)) {
    throw new Error(`gateway config: webhook ${id} is missing verification`)
  }
  switch (value.scheme) {
    case 'hmac-sha256-body':
    case 'hmac-sha256-timestamp-body': {
      const sigHeader = value.signatureHeader
      const sigEncoding = value.signatureEncoding
      const secretPath = value.secretPath
      if (typeof sigHeader !== 'string' || sigHeader.length === 0) {
        throw new Error(`gateway config: webhook ${id} ${value.scheme} missing signatureHeader`)
      }
      if (sigEncoding !== 'hex' && sigEncoding !== 'base64') {
        throw new Error(
          `gateway config: webhook ${id} ${value.scheme} unsupported signatureEncoding ${JSON.stringify(sigEncoding)}`
        )
      }
      if (typeof secretPath !== 'string' || secretPath.length === 0) {
        throw new Error(`gateway config: webhook ${id} ${value.scheme} missing secretPath`)
      }
      return {
        scheme: value.scheme,
        signatureHeader: sigHeader.toLowerCase(),
        signaturePrefix: typeof value.signaturePrefix === 'string' ? value.signaturePrefix : undefined,
        signatureEncoding: sigEncoding,
        secretPath,
      }
    }
    case 'jwt-bearer-jwks': {
      // W1.4 lands the actual verifier; v1.1 schema acceptance only.
      const jwksUrl = value.jwksUrl
      const issuer = value.issuer
      const audience = value.audience
      const jwksPath = value.jwksPath
      if (
        typeof jwksUrl !== 'string' ||
        typeof issuer !== 'string' ||
        typeof audience !== 'string' ||
        typeof jwksPath !== 'string'
      ) {
        throw new Error(`gateway config: webhook ${id} jwt-bearer-jwks missing required fields`)
      }
      return { scheme: 'jwt-bearer-jwks', jwksUrl, issuer, audience, jwksPath }
    }
    case 'static-bearer': {
      const secretPath = value.secretPath
      if (typeof secretPath !== 'string' || secretPath.length === 0) {
        throw new Error(`gateway config: webhook ${id} static-bearer missing secretPath`)
      }
      // Optional custom header / prefix. Author-supplied empty string for
      // tokenPrefix is meaningful ("no prefix"), so we treat undefined and
      // empty string as distinct cases. tokenHeader stores lowercase per
      // type contract — config-write side is expected to lowercase already.
      const rawTokenHeader = value.tokenHeader
      const tokenHeader =
        rawTokenHeader === undefined
          ? undefined
          : typeof rawTokenHeader === 'string' && rawTokenHeader.length > 0
            ? rawTokenHeader.toLowerCase()
            : (() => {
                throw new Error(
                  `gateway config: webhook ${id} static-bearer tokenHeader must be a non-empty string when present`
                )
              })()
      const rawTokenPrefix = value.tokenPrefix
      const tokenPrefix =
        rawTokenPrefix === undefined
          ? undefined
          : typeof rawTokenPrefix === 'string'
            ? rawTokenPrefix
            : (() => {
                throw new Error(
                  `gateway config: webhook ${id} static-bearer tokenPrefix must be a string when present`
                )
              })()
      return {
        scheme: 'static-bearer',
        secretPath,
        ...(tokenHeader !== undefined ? { tokenHeader } : {}),
        ...(tokenPrefix !== undefined ? { tokenPrefix } : {}),
      }
    }
    default:
      throw new Error(
        `gateway config: webhook ${id} has unknown scheme ${JSON.stringify(value.scheme)}`
      )
  }
}

function validateReplay(
  id: string,
  value: unknown,
  scheme: WebhookConfigEntry['verification']['scheme']
): WebhookConfigEntry['replay'] {
  if (scheme === 'hmac-sha256-timestamp-body') {
    if (!isObject(value)) {
      throw new Error(`gateway config: webhook ${id} hmac-sha256-timestamp-body missing replay`)
    }
    if (typeof value.timestampHeader !== 'string' || value.timestampHeader.length === 0) {
      throw new Error(`gateway config: webhook ${id} replay missing timestampHeader`)
    }
    if (
      typeof value.toleranceSec !== 'number' ||
      value.toleranceSec < 10 ||
      value.toleranceSec > 3600
    ) {
      throw new Error(`gateway config: webhook ${id} replay.toleranceSec out of [10,3600]`)
    }
    return {
      timestampHeader: value.timestampHeader.toLowerCase(),
      toleranceSec: value.toleranceSec,
    }
  }
  if (value !== undefined) {
    throw new Error(`gateway config: webhook ${id} replay set on non-timestamp scheme ${scheme}`)
  }
  return undefined
}

function validateUpstream(id: string, value: unknown): WebhookConfigEntry['upstream'] {
  if (!isObject(value)) {
    throw new Error(`gateway config: webhook ${id} missing upstream`)
  }
  if (typeof value.host !== 'string' || value.host.length === 0) {
    throw new Error(`gateway config: webhook ${id} upstream missing host`)
  }
  if (typeof value.port !== 'number' || value.port < 1 || value.port > 65535) {
    throw new Error(`gateway config: webhook ${id} upstream.port out of range`)
  }
  if (typeof value.path !== 'string' || !value.path.startsWith('/')) {
    throw new Error(`gateway config: webhook ${id} upstream.path must start with /`)
  }
  return { host: value.host, port: value.port, path: value.path }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
