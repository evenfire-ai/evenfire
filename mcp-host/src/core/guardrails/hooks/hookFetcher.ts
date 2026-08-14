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
 * In-cluster (`image`/`service`) targets resolve to cluster-private IPs and are
 * dialed directly. A `remote` (external) target — `descriptor.external` — is
 * dialed through the SSRF-guarded transport (`../../net/ssrf`: reject
 * private/loopback/link-local/metadata ranges, DNS-pin the connection), so a
 * hosted provider (e.g. guardrails.aporia.com) works while an internal/metadata
 * URL is refused (spec §8.3). An SSRF refusal maps to `unavailable` → the hook's
 * fail-mode.
 */
import { SsrfBlockedError, requestPinned, resolvePinnedPublicIp } from '../../net/ssrf'
import type { HookFetcher, LifecyclePoint } from './types'

/** Minimal fetch surface (injectable for tests + the in-cluster path). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ status: number; text: () => Promise<string> }>

export interface HookFetcherDeps {
  getAuthToken: () => string
  timeoutMs?: number
  maxOutputBytes?: number
  /** In-cluster transport. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike
  /** External (remote) transport. Defaults to the SSRF-guarded impl. Injectable for tests. */
  externalFetchImpl?: FetchLike
}

const POINT_PATH: Record<LifecyclePoint, string> = {
  pre_call: 'pre_call',
  moderate: 'moderate',
  post_call: 'post_call',
  on_error: 'on_error',
  pre_tool_use: 'pre_tool_use',
  post_tool_use: 'post_tool_use',
}

/** Build `{endpoint}{path}/v1/{point}`, normalizing slashes (spec §8.1). */
export function buildHookUrl(endpoint: string, path: string, point: LifecyclePoint): string {
  const base = endpoint.replace(/\/+$/, '')
  const mid = !path || path === '/' ? '' : '/' + path.replace(/^\/+|\/+$/g, '')
  return `${base}${mid}/v1/${POINT_PATH[point]}`
}

/**
 * SSRF-guarded transport for `remote` hook targets: requires https, validates
 * the host resolves only to public IPs, and connects to a pinned IP. Adapts to
 * the `FetchLike` shape so the outcome classification is shared with the
 * in-cluster path. Throws `SsrfBlockedError` on a blocked/unverifiable host.
 */
function makeSsrfGuardedFetch(timeoutMs: number, maxBytes: number): FetchLike {
  return async (urlStr, init) => {
    const url = new URL(urlStr)
    if (url.protocol !== 'https:') {
      throw new SsrfBlockedError(`remote hook URL must be https (got ${url.protocol})`)
    }
    const pinnedIp = await resolvePinnedPublicIp(url) // throws SsrfBlockedError on private/unresolvable
    const { statusCode, body } = await requestPinned({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      pinnedIp,
      timeoutMs,
      // Absolute deadline (idle-independent) + streaming byte cap: a trickling or
      // flooding remote hook can no longer hang or OOM the pod (settles → §8.6).
      signal: init.signal,
      maxBytes,
    })
    return { status: statusCode, text: async () => body }
  }
}

/**
 * In-cluster transport (default): the global `fetch` honors the abort `signal`
 * (absolute deadline) and the body is read WITH a streaming byte cap, so an
 * oversized in-cluster response is never fully buffered either.
 */
function makeInClusterFetch(maxBytes: number): FetchLike {
  return async (urlStr, init) => {
    const res = await (globalThis.fetch as unknown as (u: string, i: unknown) => Promise<Response>)(
      urlStr,
      init
    )
    return {
      status: res.status,
      text: async () => {
        const stream = res.body as ReadableStream<Uint8Array> | null
        if (!stream) return res.text()
        const reader = stream.getReader()
        const chunks: Buffer[] = []
        let total = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            total += value.length
            if (total > maxBytes) {
              await reader.cancel()
              throw new Error('response exceeded maxBytes') // → caught → unavailable
            }
            chunks.push(Buffer.from(value))
          }
        }
        return Buffer.concat(chunks).toString('utf-8')
      },
    }
  }
}

export function createHookFetcher(deps: HookFetcherDeps): HookFetcher {
  const timeoutMs = deps.timeoutMs ?? 5000
  const maxOutputBytes = deps.maxOutputBytes ?? 65536
  const inClusterFetch: FetchLike = deps.fetchImpl ?? makeInClusterFetch(maxOutputBytes)
  const externalFetch: FetchLike =
    deps.externalFetchImpl ?? makeSsrfGuardedFetch(timeoutMs, maxOutputBytes)

  return async ({ point, descriptor, body }) => {
    const url = buildHookUrl(descriptor.endpoint, descriptor.path, point)
    const doFetch = descriptor.external ? externalFetch : inClusterFetch
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
    } catch (err) {
      // timeout / connection error / SSRF refusal → unavailable (→ fail-mode, §8.6).
      if (err instanceof SsrfBlockedError) {
        console.warn(
          `[Guardrails] remote hook ${descriptor.id} blocked by SSRF guard: ${err.message}`
        )
      }
      return { status: 0, body: undefined, unavailable: true }
    }
  }
}
