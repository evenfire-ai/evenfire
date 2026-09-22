import { DEFAULT_MAX_BODY_BYTES } from './requestLimits.js'

export type GrokLlmProxyConfig = {
  runtimePort: number
  adminPort: number
  probePort: number
  maxBodyBytes: number
  maxStreamDurationMs: number
  maxDeadlineMs: number
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GrokLlmProxyConfig {
  return {
    runtimePort: requiredPositiveInt(
      'GROK_LLM_PROXY_RUNTIME_PORT',
      env.GROK_LLM_PROXY_RUNTIME_PORT,
      8080
    ),
    adminPort: requiredPositiveInt(
      'GROK_LLM_PROXY_ADMIN_PORT',
      env.GROK_LLM_PROXY_ADMIN_PORT,
      8081
    ),
    probePort: requiredPositiveInt(
      'GROK_LLM_PROXY_PROBE_PORT',
      env.GROK_LLM_PROXY_PROBE_PORT,
      9090
    ),
    maxBodyBytes: requiredPositiveInt(
      'GROK_LLM_PROXY_MAX_BODY_BYTES',
      env.GROK_LLM_PROXY_MAX_BODY_BYTES,
      DEFAULT_MAX_BODY_BYTES
    ),
    maxStreamDurationMs: requiredPositiveInt(
      'GROK_LLM_PROXY_MAX_STREAM_DURATION_MS',
      env.GROK_LLM_PROXY_MAX_STREAM_DURATION_MS,
      300_000
    ),
    maxDeadlineMs: requiredPositiveInt(
      'GROK_LLM_PROXY_MAX_DEADLINE_MS',
      env.GROK_LLM_PROXY_MAX_DEADLINE_MS,
      300_000
    ),
    jwtIssuer: env.GROK_LLM_PROXY_JWT_ISSUER?.trim() || 'control-api',
    jwtPublicKey: requiredPem('GROK_LLM_PROXY_JWT_PUBLIC_KEY', env.GROK_LLM_PROXY_JWT_PUBLIC_KEY),
    executionEnabled: env.GROK_LLM_PROXY_EXECUTION_ENABLED === 'true',
    controlApiBaseUrl: requiredHttpUrl(
      'GROK_LLM_PROXY_CONTROL_API_URL',
      env.GROK_LLM_PROXY_CONTROL_API_URL
    ),
    controlApiServiceName: env.GROK_LLM_PROXY_CONTROL_API_SERVICE?.trim() || 'grok-llm-proxy',
    controlApiServiceToken: requiredNonEmpty(
      'GROK_LLM_PROXY_CONTROL_API_TOKEN',
      env.GROK_LLM_PROXY_CONTROL_API_TOKEN
    ),
  }
}
