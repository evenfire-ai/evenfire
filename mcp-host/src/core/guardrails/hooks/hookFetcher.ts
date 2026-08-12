/**
 * Concrete `/v1` HTTP transport for installed hooks (spec §8.1 wire contract).
 *
 * POSTs JSON to `{endpoint}{path}/v1/{point}` with a short-lived bearer token
 * (mcp-host's env-injected token via a `getAuthToken` closure — the same pattern
 * as `credentialBrokerClient.ts`; no in-process signing). Enforces the timeout
 * and body cap, and classifies the outcome per §8.1: `5xx` / timeout /
 * connection error / malformed or oversized body → `unavailable` (→ the hook's
 * fail-mode, §8.6). `4xx`/`2xx` are returned for the per-point mapping to judge.
 *
 * In-cluster (`image`/`service`) targets are trusted and dialed directly. The
 * SSRF-guarded `remote`-mode transport (DNS-pin + `isPrivateIp`, spec §8.3) is a
 * later increment — pass a guarded `fetchImpl` to reuse this shell for it.
 */
import type { HookFetcher, LifecyclePoint } from './types'

/** Minimal fetch surface (injectable for tests + a future SSRF-guarded impl). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ status: number; text: () => Promise<string> }>

export interface HookFetcherDeps {
  getAuthToken: () => string
  timeoutMs?: number
  maxOutputBytes?: number
  /** Defaults to the global `fetch`. Inject an SSRF-guarded impl for `remote` hooks. */
  fetchImpl?: FetchLike
}

const POINT_PATH: Record<LifecyclePoint, string> = {
  pre_call: 'pre_call',
  moderate: 'moderate',
  post_call: 'post_call',
  on_error: 'on_error',
}

/** Build `{endpoint}{path}/v1/{point}`, normalizing slashes (spec §8.1). */
export function buildHookUrl(endpoint: string, path: string, point: LifecyclePoint): string {
  const base = endpoint.replace(/\/+$/, '')
  const mid = !path || path === '/' ? '' : '/' + path.replace(/^\/+|\/+$/g, '')
  return `${base}${mid}/v1/${POINT_PATH[point]}`
}

export function createHookFetcher(deps: HookFetcherDeps): HookFetcher {
  const timeoutMs = deps.timeoutMs ?? 5000
  const maxOutputBytes = deps.maxOutputBytes ?? 65536
  const doFetch: FetchLike = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)

  return async ({ point, descriptor, body }) => {
    const url = buildHookUrl(descriptor.endpoint, descriptor.path, point)
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${deps.getAuthToken()}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      if (text.length > maxOutputBytes) {
        return { status: res.status, body: undefined, unavailable: true } // oversized → unavailable
      }
      let parsed: unknown = {}
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          return { status: res.status, body: undefined, unavailable: true } // malformed → unavailable
        }
      }
      // 5xx → unavailable; 2xx/4xx are returned for the mapping to classify.
      return { status: res.status, body: parsed, unavailable: res.status >= 500 }
    } catch {
      // timeout / connection error → unavailable
      return { status: 0, body: undefined, unavailable: true }
    }
  }
}
