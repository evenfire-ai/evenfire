export type CodexLlmProxyConfig = {
  runtimePort: number
  adminPort: number
  probePort: number
  maxBodyBytes: number
  maxStreamDurationMs: number
  maxDeadlineMs: number
  jwtIssuer: string
  jwtPublicKey: string
  executionEnabled: boolean
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CodexLlmProxyConfig {
  return {
    runtimePort: requiredPositiveInt('CODEX_LLM_PROXY_RUNTIME_PORT', env.CODEX_LLM_PROXY_RUNTIME_PORT, 8080),
    adminPort: requiredPositiveInt('CODEX_LLM_PROXY_ADMIN_PORT', env.CODEX_LLM_PROXY_ADMIN_PORT, 8081),
    probePort: requiredPositiveInt('CODEX_LLM_PROXY_PROBE_PORT', env.CODEX_LLM_PROXY_PROBE_PORT, 9090),
    maxBodyBytes: requiredPositiveInt(
      'CODEX_LLM_PROXY_MAX_BODY_BYTES',
      env.CODEX_LLM_PROXY_MAX_BODY_BYTES,
      1_048_576
    ),
    maxStreamDurationMs: requiredPositiveInt(
      'CODEX_LLM_PROXY_MAX_STREAM_DURATION_MS',
      env.CODEX_LLM_PROXY_MAX_STREAM_DURATION_MS,
      300_000
    ),
    maxDeadlineMs: requiredPositiveInt(
      'CODEX_LLM_PROXY_MAX_DEADLINE_MS',
      env.CODEX_LLM_PROXY_MAX_DEADLINE_MS,
      300_000
    ),
    jwtIssuer: env.CODEX_LLM_PROXY_JWT_ISSUER?.trim() || 'control-api',
    jwtPublicKey: requiredPem('CODEX_LLM_PROXY_JWT_PUBLIC_KEY', env.CODEX_LLM_PROXY_JWT_PUBLIC_KEY),
    executionEnabled: env.CODEX_LLM_PROXY_EXECUTION_ENABLED === 'true',
  }
}
