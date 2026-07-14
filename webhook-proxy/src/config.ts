/**
 * webhook-proxy is a stateless TLS-terminator + registry-validated
 * forwarder. The only knobs it needs are:
 *   - the public port to listen on
 *   - the control-api base URL + service token used for registry lookups
 *   - the recipe namespace pin (defense-in-depth; control-api also pins)
 *   - the registry cache TTL (default 5s — same value mcp-proxy uses)
 */
export interface ProxyConfig {
  /** Public-facing port (HTTP — TLS termination is at the cluster ingress). */
  httpPort: number
  /** /healthz + /metrics port. */
  metricsPort: number
  /** Base URL of control-api (e.g. http://control-api.control-plane.svc.cluster.local:8090). */
  controlApiBaseUrl: string
  /** Base URL of workflow-approval-request-reader for provider approval/chat webhooks. */
  workflowApprovalReaderBaseUrl: string
  /** Service token registered in control-api for `webhook-proxy`. */
  controlApiServiceToken: string
  /** Namespace where recipes live. Pinned at admission. */
  sandboxNamespace: string
  /** Cache TTL for both positive and negative registry results (ms). */
  registryCacheTtlMs: number
  /** Upstream timeout for the gateway forward (ms). */
  upstreamTimeoutMs: number
  /** Hard cap on inbound body bytes regardless of registry value. */
  maxBodyBytesCeiling: number
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

export function loadConfig(): ProxyConfig {
  return {
    httpPort: intFromEnv('WEBHOOK_PROXY_HTTP_PORT', 8095),
    metricsPort: intFromEnv('WEBHOOK_PROXY_METRICS_PORT', 9090),
    controlApiBaseUrl:
      process.env.WEBHOOK_PROXY_CONTROL_API_BASE_URL ||
      'http://control-api.control-plane.svc.cluster.local:8090/api/v1',
    workflowApprovalReaderBaseUrl:
      process.env.WEBHOOK_PROXY_WORKFLOW_APPROVAL_READER_BASE_URL ||
      'http://workflow-approval-request-reader.channels.svc.cluster.local:8098',
    controlApiServiceToken:
      process.env.WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN || 'dev-webhook-proxy-token',
    sandboxNamespace: process.env.WEBHOOK_PROXY_SANDBOX_NAMESPACE || 'sandbox-recipes',
    registryCacheTtlMs: intFromEnv('WEBHOOK_PROXY_REGISTRY_CACHE_TTL_MS', 5_000),
    upstreamTimeoutMs: intFromEnv('WEBHOOK_PROXY_UPSTREAM_TIMEOUT_MS', 30_000),
    maxBodyBytesCeiling: intFromEnv('WEBHOOK_PROXY_MAX_BODY_BYTES_CEILING', 10 * 1024 * 1024),
  }
}

/** Same regex as the gateway (and the CRD); revalidated here. */
export const RECIPE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
export const WEBHOOK_ID_RE = /^[a-z0-9-]{1,63}$/
