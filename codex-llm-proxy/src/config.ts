import { LIMITS } from '@clerum/llm-provider-attempt-contract'
import { STREAM_LIMITS } from './requestLimits.js'
import { DEFAULT_HEARTBEAT_INTERVAL_MS, MAX_HEARTBEAT_INTERVAL_MS } from './sseHeartbeat.js'

export type CodexLlmProxyConfig = {
  runtimePort: number
  adminPort: number
  probePort: number
  maxBodyBytes: number
  maxVisualBodyBytes: number
  maxStreamDurationMs: number
  maxDeadlineMs: number
  /** Lowers STREAM_LIMITS.upstreamIdleTimeoutMs; the transport never raises it. */
  upstreamIdleTimeoutMs: number
  /** Interval between SSE keepalive comments once the redeem succeeded. */
  heartbeatIntervalMs: number
  jwtIssuer: string
  jwtPublicKey: string
  executionEnabled: boolean
  controlApiBaseUrl: string
  controlApiServiceName: string
  controlApiServiceToken: string
}

function requiredPositiveInt(name: string, raw: string | undefined, fallback?: number): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw)
  if (value === undefined || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a finite integer greater than zero`)
  }
  if (value === Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name} must be a bounded positive integer`)
  }
  return value
}

function atMost(name: string, value: number, max: number): number {
  if (value > max) throw new Error(`${name} must be at most ${max}`)
  return value
}

function requiredPem(name: string, raw: string | undefined): string {
  const value = raw?.trim() ?? ''
  if (!value.includes('BEGIN') || !value.includes('KEY')) {
    throw new Error(`${name} must be a PEM-encoded public key`)
  }
  return value
}

// Fail at startup instead of at the first redeem. Messages name the variable
// only; the raw value (URL or service token) is never echoed.
function requiredHttpUrl(name: string, raw: string | undefined): string {
  const value = raw?.trim() ?? ''
  if (!value) throw new Error(`${name} must be set`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must be an absolute http(s) URL`)
  }
  return value
}

function requiredNonEmpty(name: string, raw: string | undefined): string {
  const value = raw?.trim() ?? ''
  if (!value) throw new Error(`${name} must be set`)
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CodexLlmProxyConfig {
  const maxBodyBytes = requiredPositiveInt(
    'CODEX_LLM_PROXY_MAX_BODY_BYTES',
    env.CODEX_LLM_PROXY_MAX_BODY_BYTES,
    LIMITS.maxRequestBodyBytes
  )
  const maxVisualBodyBytes = requiredPositiveInt(
    'CODEX_LLM_PROXY_MAX_VISUAL_BODY_BYTES',
    env.CODEX_LLM_PROXY_MAX_VISUAL_BODY_BYTES,
    LIMITS.maxVisualRequestBodyBytes
  )
  if (maxVisualBodyBytes < LIMITS.maxVisualRequestBodyBytes) {
    throw new Error('Visual Codex requests require the full shared envelope byte budget')
  }
  return {
    runtimePort: requiredPositiveInt(
      'CODEX_LLM_PROXY_RUNTIME_PORT',
      env.CODEX_LLM_PROXY_RUNTIME_PORT,
      8080
    ),
    adminPort: requiredPositiveInt(
      'CODEX_LLM_PROXY_ADMIN_PORT',
      env.CODEX_LLM_PROXY_ADMIN_PORT,
      8081
    ),
    probePort: requiredPositiveInt(
      'CODEX_LLM_PROXY_PROBE_PORT',
      env.CODEX_LLM_PROXY_PROBE_PORT,
      9090
    ),
    maxBodyBytes,
    maxVisualBodyBytes,
    maxStreamDurationMs: requiredPositiveInt(
      'CODEX_LLM_PROXY_MAX_STREAM_DURATION_MS',
      env.CODEX_LLM_PROXY_MAX_STREAM_DURATION_MS,
      1_800_000
    ),
    maxDeadlineMs: requiredPositiveInt(
      'CODEX_LLM_PROXY_MAX_DEADLINE_MS',
      env.CODEX_LLM_PROXY_MAX_DEADLINE_MS,
      1_800_000
    ),
    upstreamIdleTimeoutMs: requiredPositiveInt(
      'CODEX_LLM_PROXY_UPSTREAM_IDLE_TIMEOUT_MS',
      env.CODEX_LLM_PROXY_UPSTREAM_IDLE_TIMEOUT_MS,
      STREAM_LIMITS.upstreamIdleTimeoutMs
    ),
    // Refused rather than lowered: the operator's value is either applied or
    // the proxy does not start.
    heartbeatIntervalMs: atMost(
      'CODEX_LLM_PROXY_HEARTBEAT_INTERVAL_MS',
      requiredPositiveInt(
        'CODEX_LLM_PROXY_HEARTBEAT_INTERVAL_MS',
        env.CODEX_LLM_PROXY_HEARTBEAT_INTERVAL_MS,
        DEFAULT_HEARTBEAT_INTERVAL_MS
      ),
      MAX_HEARTBEAT_INTERVAL_MS
    ),
    jwtIssuer: env.CODEX_LLM_PROXY_JWT_ISSUER?.trim() || 'control-api',
    jwtPublicKey: requiredPem('CODEX_LLM_PROXY_JWT_PUBLIC_KEY', env.CODEX_LLM_PROXY_JWT_PUBLIC_KEY),
    executionEnabled: env.CODEX_LLM_PROXY_EXECUTION_ENABLED === 'true',
    controlApiBaseUrl: requiredHttpUrl(
      'CODEX_LLM_PROXY_CONTROL_API_URL',
      env.CODEX_LLM_PROXY_CONTROL_API_URL
    ),
    controlApiServiceName: env.CODEX_LLM_PROXY_CONTROL_API_SERVICE?.trim() || 'codex-llm-proxy',
    controlApiServiceToken: requiredNonEmpty('CODEX_LLM_PROXY_CONTROL_API_TOKEN', env.CODEX_LLM_PROXY_CONTROL_API_TOKEN),
  }
}
