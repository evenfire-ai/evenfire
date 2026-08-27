/**
 * Broker-backed per-connection token provider for oauth mcp-servers
 * (mini-spec 03 §1/§5, spec §U4/§U6).
 *
 * Reaches the control-api OAuth broker through the workflow-approval gateway
 * (decision #6/B — a POST-only L7-allowlisted location, NOT a new direct egress
 * to control-api). The subject (a userId, or empty for the shared context
 * identity) is baked into each provider INSTANCE, and its cache lives in a
 * closure local to that instance: a provider built for user A can never POST —
 * nor return — user B's token. The factory
 * builds a fresh provider per ClientKey, so per-user cache isolation is
 * structural, keyed by principal.
 *
 * Fail-closed contract (frozen cross-service, built in U1 — mcp-host is the
 * consumer):
 *   - 200 {token, expiresAt}         → return token; cache honoring expiry.
 *   - 404 {error:'no_grant'} / 403   → resolve() undefined; the call is NOT
 *                                      forwarded (surfaces as the auth failure
 *                                      U5 later turns into connect_required).
 *   - missing gateway / control token → undefined (fail closed).
 *   - 401                            → the mcp-host control JWT expired; refresh
 *                                      it ONCE and retry, then throw.
 *   - any other non-200 / malformed 200 body → throw (never forward a stale or
 *     empty token).
 */
import type { McpTokenProvider } from './client'

/** House fetch timeout (matches runtimeAuthFactory REISSUE_FETCH_TIMEOUT_MS). */
export const DEFAULT_BROKER_FETCH_TIMEOUT_MS = 10_000
/** Reuse a cached token only with this much headroom before its expiry. */
const CACHE_EXPIRY_HEADROOM_MS = 30_000
/**
 * Hard re-consult interval for a NON-expiring token (`expiresAt:null`). control-api
 * emits this shape for providers whose upstream token never expires — Notion and
 * ClickUp always (`parseTokenResponse` hard-codes `expiresIn: undefined`), any
 * other provider when its response omits `expires_in`. Without a cap, an ACTIVE
 * partition (used within the manager idle window, so never evicted) would keep
 * serving such a token forever, and because a non-expiring upstream never 401s,
 * the mcp-server-401 → refresh → no_grant revocation backstop never fires either:
 * a grant revoked in control-api would be honored indefinitely. Re-consulting the
 * broker at least this often bounds that revocation latency (R1-M1).
 */
export const NULL_EXPIRY_MAX_AGE_MS = 5 * 60_000

export interface BrokerTokenSubject {
  /**
   * The per-user grant subject. Absent (`{}`) for oauth-context, where control-api
   * resolves the shared grant server-side from `server.spec.contextRef` and
   * mcp-host transports NO context identity (invariant I1). There is deliberately
   * no `contextId` here: the factory never sends one, so accepting it would be an
   * unreachable branch that contradicts I1.
   */
  userId?: string
}

export interface BrokerTokenProviderDeps {
  /** Base URL of the workflow-approval gateway (config.mcpHostGatewayUrl). */
  gatewayUrl: () => string | undefined
  /** The mcp-host control JWT (scope 'oauth:user-token'). */
  controlToken: () => string | undefined
  /**
   * Mint a fresh mcp-host control JWT after control-api rejects the current one
   * with 401, so `controlToken()` returns a live value on the retry. This is the
   * same reactive recovery every sibling control-api consumer already gets
   * (`refreshOnUnauthorized: () => refreshWithRecovery(auth)` in main.ts).
   *
   * NOTE: this is the CONTROL JWT (mcp-host → control-api), not the downstream
   * OAuth token that `McpTokenProvider.refresh()` re-exchanges after an
   * mcp-server 401. Omitted → no recovery, a 401 throws as before.
   */
  refreshControlToken?: () => Promise<void>
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Bounded per-request timeout; defaults to DEFAULT_BROKER_FETCH_TIMEOUT_MS. */
  timeoutMs?: number
  /** Injectable clock for expiry math; defaults to Date.now. */
  now?: () => number
}

export function createBrokerTokenProvider(
  server: { name: string },
  subject: BrokerTokenSubject,
  deps: BrokerTokenProviderDeps
): McpTokenProvider {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? DEFAULT_BROKER_FETCH_TIMEOUT_MS
  const now = deps.now ?? (() => Date.now())
  let cached: { token: string; expiresAtMs: number | null; cachedAtMs: number } | undefined

  const fetchToken = async (): Promise<string | undefined> => {
    const gatewayUrl = deps.gatewayUrl()?.trim()
    if (!gatewayUrl) {
      console.warn('[BrokerTokenProvider] gateway URL not configured; failing closed')
      return undefined
    }
    const controlToken = deps.controlToken()
    if (!controlToken) {
      console.warn('[BrokerTokenProvider] control token unavailable; failing closed')
      return undefined
    }
    const body: { mcpServerName: string; userId?: string } = {
      mcpServerName: server.name,
    }
    if (subject.userId) body.userId = subject.userId
    const payload = JSON.stringify(body)

    const post = async (bearer: string): Promise<Response> =>
      fetchImpl(`${gatewayUrl}/api/v1/mcp-oauth/user-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
        },
        body: payload,
        // A hung broker must not stall the lazy per-user connect.
        signal: AbortSignal.timeout(timeoutMs),
      })

    let res = await post(controlToken)

    // The control JWT has a ~10 min TTL and only rotates when the runtime-auth
    // chain refreshes. An idle pod therefore reaches control-api with an expired
    // bearer and gets 401 on every exchange, with nothing in this path to heal
    // it. Refresh ONCE and retry; the `refreshed` latch plus the "token actually
    // changed" check bound this to a single extra request per fetchToken() call,
    // so a refresh that fails (or that control-api answers without a new control
    // token) cannot loop.
    if (res.status === 401 && deps.refreshControlToken) {
      let rotated: string | undefined
      try {
        await deps.refreshControlToken()
        rotated = deps.controlToken()
      } catch (err) {
        // Keep the stable broker error below as the surfaced failure; the cause
        // is logged rather than swallowed.
        console.warn(
          `[BrokerTokenProvider] control token refresh failed after 401 for ${server.name}:`,
          err instanceof Error ? err.message : String(err)
        )
      }
      if (rotated && rotated !== controlToken) {
        res = await post(rotated)
      }
    }

    if (res.status === 200) {
      // Reset up front so ANY throw below (a malformed JSON body from res.json(),
      // or the empty-token guard) leaves no stale entry behind — no error branch
      // may keep a token the caller can later reuse (R1-L1).
      cached = undefined
      const data = (await res.json()) as { token?: unknown; expiresAt?: unknown }
      if (typeof data.token !== 'string' || data.token.length === 0) {
        throw new Error(`mcp-oauth broker returned malformed 200 body for ${server.name}`)
      }
      const parsed = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN
      cached = {
        token: data.token,
        expiresAtMs: Number.isNaN(parsed) ? null : parsed,
        cachedAtMs: now(),
      }
      return data.token
    }
    // 404 no_grant → normal, expected revocation; fail closed silently.
    if (res.status === 404) {
      cached = undefined
      return undefined
    }
    // 403 → control-api rejected the principal (a platform/permission defect,
    // NOT a normal revocation). Fail closed like 404, but WARN so it is
    // distinguishable in logs: reconnecting will never fix it. server.name is
    // non-PII; never log the token, userId, or the control token.
    if (res.status === 403) {
      console.warn(
        `[BrokerTokenProvider] broker returned 403 for ${server.name}; failing closed (platform/permission defect, reconnect will not fix)`
      )
      cached = undefined
      return undefined
    }
    // Any other status (400/500/502/503/…) → fail closed with an error.
    cached = undefined
    throw new Error(`mcp-oauth broker returned ${res.status} for ${server.name}`)
  }

  return {
    resolve: async () => {
      // Reuse a cached token only while it is demonstrably fresh; otherwise
      // re-consult the broker so a revoked grant stops being honored within a
      // bounded window. Two freshness regimes:
      //   - expiring token → reuse while it keeps CACHE_EXPIRY_HEADROOM_MS of
      //     headroom before its own expiry.
      //   - non-expiring token (expiresAtMs === null) → reuse only within
      //     NULL_EXPIRY_MAX_AGE_MS of when it was cached; see that constant for
      //     why an unbounded reuse would honor a revoked grant forever (R1-M1).
      if (cached) {
        const fresh =
          cached.expiresAtMs === null
            ? now() - cached.cachedAtMs < NULL_EXPIRY_MAX_AGE_MS
            : cached.expiresAtMs - now() > CACHE_EXPIRY_HEADROOM_MS
        if (fresh) return cached.token
      }
      return fetchToken()
    },
    refresh: async () => {
      // Force a fresh exchange (bypass cache) — used after a live 401.
      cached = undefined
      return fetchToken()
    },
  }
}
