import { type PinnedFetchError, pinnedFetch } from '../http/pinnedFetch.js'
import { rootLogger } from '../observability/logger.js'
import { type DiscoveryDeps, guardedFetchJson, trimmedPath } from './discovery.js'

/**
 * MCP transport probe for the remote OAuth carril (issue 26-09-25, mini-spec D3).
 *
 * The remote wizard's Detect + install saga validate the per-path OAuth metadata
 * chain (RFC 9728 → 8414) but never touch the MCP TRANSPORT. A URL whose OAuth
 * metadata answers on `/mcp` but whose MCP `initialize` there 404s (Vercel serves MCP
 * at the root `/`) passes Detect + install and only fails at mcp-host's first
 * `initialize`. This module closes that gap: a tokenless `POST initialize` through the
 * SAME IP-pinned fetch the carril uses ({@link pinnedFetch}, spec §4 kernel + pin per
 * hop), classified against the decision table, blocking install ONLY when the path is
 * provably dead (404/405). Ambiguity never blocks — the probe vetoes only what it can
 * prove dead, and warns otherwise.
 *
 * Shared by Detect and install (D4 — one rule, one implementation). The `initialize`
 * 200 is a `text/event-stream` that may not close, so the probe reads HEADERS ONLY
 * (`readBody:false`) and tears the socket down at the headers.
 */

/** Version advertised in the probe's `clientInfo`; cosmetic — the body is never read back. */
const PROBE_CLIENT_VERSION: string = (() => {
  try {
    // CommonJS build: read the service version at runtime without a static (rootDir-
    // bound) JSON import. The value only decorates the probe's clientInfo.
    return (require('../../package.json') as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** MCP protocol version mcp-host's StreamableHTTP client sends on `initialize`. */
const PROBE_PROTOCOL_VERSION = '2025-11-25'

/** 8s: an `initialize` that neither answers nor resets by then is treated as inconclusive. */
export const PROBE_TIMEOUT_MS = 8_000

export type TransportProbeOutcome =
  | { status: 'alive'; probedUrl: string; httpStatus: number; challenge: boolean }
  | { status: 'dead'; probedUrl: string; httpStatus: 404 | 405; suggestedBaseUrl?: string }
  | {
      status: 'inconclusive'
      probedUrl: string
      reason:
        | 'timeout'
        | 'transport_failed'
        | 'redirect'
        | 'unexpected_status'
        | 'content_encoding_rejected'
        | 'kernel_rejected'
      httpStatus?: number
      detail: string
    }

/**
 * Build the tokenless JSON-RPC `initialize` body the probe POSTs — the exact method +
 * params shape mcp-host's StreamableHTTP client sends, so a server that answers a real
 * `initialize` answers this one identically.
 */
export function buildInitializeProbeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: PROBE_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'clerum-control-api-probe', version: PROBE_CLIENT_VERSION },
    },
  })
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * Classify a tokenless `POST initialize` response (mini-spec D3 decision table). PURE.
 *
 * - 200/202 → alive (path accepts `initialize`).
 * - 401 → alive; `challenge` true iff a `www-authenticate` header is present (RFC 9728
 *   compliant transport asking for a token — the exact case the issue must NOT break).
 * - 403 → alive (transport exists; treated as an auth signal).
 * - 404/405 → dead (path has no MCP).
 * - 3xx → inconclusive/redirect (the pin never follows; mcp-host's undici does at
 *   runtime, so a redirect must not block).
 * - any other 4xx / 5xx → inconclusive/unexpected_status (something processed the POST,
 *   or the server is down ≠ wrong URL — fail-open on the SIGNAL, never on security).
 */
export function classifyInitializeResponse(
  status: number,
  headers: Record<string, string | string[] | undefined>
):
  | { status: 'alive'; challenge: boolean }
  | { status: 'dead' }
  | { status: 'inconclusive'; reason: 'redirect' | 'unexpected_status' } {
  if (status === 200 || status === 202) return { status: 'alive', challenge: false }
  if (status === 401) {
    return { status: 'alive', challenge: headers['www-authenticate'] !== undefined }
  }
  if (status === 403) return { status: 'alive', challenge: false }
  if (status === 404 || status === 405) return { status: 'dead' }
  if (isRedirectStatus(status)) return { status: 'inconclusive', reason: 'redirect' }
  return { status: 'inconclusive', reason: 'unexpected_status' }
}

/** Map a {@link PinnedFetchError} onto the probe's inconclusive reasons (never blocks). */
function inconclusiveFromPinnedError(
  probedUrl: string,
  error: PinnedFetchError
): Extract<TransportProbeOutcome, { status: 'inconclusive' }> {
  switch (error.kind) {
    case 'kernel_rejected':
      return {
        status: 'inconclusive',
        probedUrl,
        reason: 'kernel_rejected',
        detail: `ssrf kernel rejected ${error.field}`,
      }
    case 'transport_failed': {
      // AbortSignal.timeout rejects with an abort/timeout message; keep them distinct.
      const reason = /timeout|aborted|abort/i.test(error.detail) ? 'timeout' : 'transport_failed'
      return { status: 'inconclusive', probedUrl, reason, detail: error.detail }
    }
    case 'content_encoding_rejected':
      return {
        status: 'inconclusive',
        probedUrl,
        reason: 'content_encoding_rejected',
        detail: `content-encoding ${error.encoding}`,
      }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Canonical-URL suggestion (mini-spec §"Algoritmo de sugerencia"), only run when the
 * typed path probed DEAD and is not already the root. Bounded to +1 GET + 1 POST and
 * never suggests a URL it did not verify alive.
 *
 * Candidate = the root PRM's `resource` when it is a same-origin string that differs in
 * path from what was typed (Vercel: `https://mcp.vercel.com/`), else `${origin}/`. The
 * candidate is then re-probed through the same classifier; only an `alive` candidate is
 * suggested. The PRM GET goes through {@link guardedFetchJson} (kernel-guarded + pinned,
 * redirects re-pinned per hop).
 */
async function suggestCanonicalBaseUrl(
  baseUrl: string,
  deps: DiscoveryDeps
): Promise<string | undefined> {
  let typed: URL
  try {
    typed = new URL(baseUrl)
  } catch {
    return undefined
  }
  const origin = typed.origin
  const prmRootUrl = `${origin}/.well-known/oauth-protected-resource`

  let candidate = `${origin}/`
  const fetched = await guardedFetchJson(prmRootUrl, 'prmUrl', deps)
  if (fetched.ok && isRecord(fetched.json) && typeof fetched.json.resource === 'string') {
    try {
      const resourceUrl = new URL(fetched.json.resource)
      if (resourceUrl.origin === origin && trimmedPath(resourceUrl) !== trimmedPath(typed)) {
        candidate = fetched.json.resource
      }
    } catch {
      // Non-URL resource → keep the `${origin}/` fallback.
    }
  }

  const candidateOutcome = await probeMcpTransport(candidate, deps, { suggest: false })
  return candidateOutcome.status === 'alive' ? candidate : undefined
}

/**
 * Probe the MCP transport at `baseUrl` with a tokenless `POST initialize` through the
 * IP-pinned fetch, classify it, and (when dead and `suggest` is not false) look for the
 * canonical URL. Never throws — a kernel/transport failure is a non-blocking
 * `inconclusive`. `opts.suggest` is false on the recursive candidate probe so the
 * suggestion search cannot recurse.
 */
export async function probeMcpTransport(
  baseUrl: string,
  deps: DiscoveryDeps,
  opts: { suggest?: boolean } = {}
): Promise<TransportProbeOutcome> {
  const log = (deps.logger ?? rootLogger).child({ module: 'mcp-transport-probe' })

  const body = buildInitializeProbeBody()
  const fetched = await pinnedFetch(baseUrl, 'baseUrl', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
    readBody: false,
    timeoutMs: PROBE_TIMEOUT_MS,
    resolveDns: deps.resolveDns,
    transport: deps.transport,
  })

  let outcome: TransportProbeOutcome
  if (!fetched.ok) {
    outcome = inconclusiveFromPinnedError(baseUrl, fetched.error)
    if (fetched.error.kind === 'kernel_rejected') {
      // Practically impossible (the caller validated the same URL moments earlier);
      // log it because a probe hitting the kernel is a signal worth seeing. Names only.
      log.warn(
        { event: 'remote_transport_probe_kernel_rejected', field: fetched.error.field },
        'mcp transport probe rejected by ssrf kernel'
      )
    }
  } else {
    const classified = classifyInitializeResponse(fetched.response.status, fetched.response.headers)
    if (classified.status === 'alive') {
      outcome = {
        status: 'alive',
        probedUrl: baseUrl,
        httpStatus: fetched.response.status,
        challenge: classified.challenge,
      }
    } else if (classified.status === 'dead') {
      const httpStatus = fetched.response.status as 404 | 405
      let suggestedBaseUrl: string | undefined
      if (opts.suggest !== false) {
        let pathname = '/'
        try {
          pathname = new URL(baseUrl).pathname
        } catch {
          pathname = '/'
        }
        if (pathname !== '/') {
          suggestedBaseUrl = await suggestCanonicalBaseUrl(baseUrl, deps)
        }
      }
      outcome = {
        status: 'dead',
        probedUrl: baseUrl,
        httpStatus,
        ...(suggestedBaseUrl ? { suggestedBaseUrl } : {}),
      }
    } else {
      outcome = {
        status: 'inconclusive',
        probedUrl: baseUrl,
        reason: classified.reason,
        httpStatus: fetched.response.status,
        detail: `HTTP ${fetched.response.status}`,
      }
    }
  }

  log.info(
    {
      event: 'remote_transport_probe',
      status: outcome.status,
      httpStatus: 'httpStatus' in outcome ? outcome.httpStatus : undefined,
      reason: outcome.status === 'inconclusive' ? outcome.reason : undefined,
      hasSuggestion: outcome.status === 'dead' ? Boolean(outcome.suggestedBaseUrl) : undefined,
    },
    'mcp transport probe'
  )
  return outcome
}
