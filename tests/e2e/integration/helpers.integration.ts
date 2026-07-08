/**
 * Integration test helpers — require a running minikube cluster.
 *
 * All helpers check service availability and expose skip guards.
 * Use: `if (!await isServiceUp(URL)) { return; }` at the top of tests.
 */

export const CONTROL_API_URL =
  process.env.CONTROL_API_URL || process.env.CONTROL_API_BASE_URL || 'http://localhost:8090'
export const EXTERNAL_REST_API_URL =
  process.env.EXTERNAL_REST_API_URL ||
  process.env.EXTERNAL_REST_API_BASE_URL ||
  'http://localhost:8091'
export const RPC_PROXY_URL =
  process.env.RPC_PROXY_URL || process.env.RPC_PROXY_BASE_URL || 'http://localhost:8094'
export const MCP_HOST_URL =
  process.env.MCP_HOST_URL || process.env.MCP_HOST_RUNTIME_BASE_URL || 'http://localhost:8080'
export const MCP_PROXY_URL = process.env.MCP_PROXY_URL || 'http://localhost:8083'

/** Returns true if the service at baseUrl responds with 2xx on /health. */
export async function isServiceUp(baseUrl: string, path = '/health'): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(2000),
    })
    return res.status < 500
  } catch {
    return false
  }
}

/** Fetch JSON with status code — does not throw on HTTP errors. */
export async function fetchJson<T = unknown>(
  url: string,
  opts?: RequestInit
): Promise<{ status: number; data: T }> {
  const res = await fetch(url, opts)
  const text = await res.text()
  let data: T
  try {
    data = JSON.parse(text) as T
  } catch {
    data = text as unknown as T
  }
  return { status: res.status, data }
}

/** POST JSON body, return { status, data }. */
export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: T }> {
  return fetchJson<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** PUT JSON body, return { status, data }. */
export async function putJson<T = unknown>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: T }> {
  return fetchJson<T>(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** DELETE request, return { status, data }. */
export async function deleteJson<T = unknown>(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: T }> {
  return fetchJson<T>(url, { method: 'DELETE', headers })
}

/** Returns a Bearer auth header object. */
export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}
