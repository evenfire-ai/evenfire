export interface AuthProxyConfig {
  httpPort: number
  metricsPort: number
  controlApiBaseUrl: string
  controlApiServiceToken: string
  controlApiServiceName: string
  upstreamTimeoutMs: number
  maxResponseBytes: number
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

export function loadConfig(): AuthProxyConfig {
  return {
    httpPort: intFromEnv('AUTH_PROXY_HTTP_PORT', 8096),
    metricsPort: intFromEnv('AUTH_PROXY_METRICS_PORT', 9090),
    controlApiBaseUrl:
      process.env.AUTH_PROXY_CONTROL_API_BASE_URL ||
      'http://control-api.control-plane.svc.cluster.local:8090/api/v1',
    controlApiServiceToken:
      process.env.AUTH_PROXY_CONTROL_API_SERVICE_TOKEN || 'dev-auth-proxy-token',
    controlApiServiceName: process.env.AUTH_PROXY_CONTROL_API_SERVICE_NAME || 'auth-proxy',
    upstreamTimeoutMs: intFromEnv('AUTH_PROXY_UPSTREAM_TIMEOUT_MS', 30_000),
    maxResponseBytes: intFromEnv('AUTH_PROXY_MAX_RESPONSE_BYTES', 1_048_576),
  }
}
