/**
 * Grant-existence client for the hot-revocation poll-sweep (mini-spec 13
 * §4.1/§4.3). Sibling of `brokerTokenProvider.ts` — it reaches the SAME
 * control-api OAuth broker through the SAME workflow-approval gateway, reusing
 * that module's `BrokerTokenProviderDeps` (gateway URL + control JWT accessor +
 * refresh-on-401) and its house fetch timeout WITHOUT editing it. Where the
 * broker MINTS a per-connection token, this only ASKS — a read-only batch
 * `POST /api/v1/mcp-oauth/grants/exists` that returns booleans, never a token.
 *
 * D4 — control-api is the sole authority for the grant: mcp-host asks, never
 * recomputes "connected". The sweep that consumes this evicts a partition ONLY
 * on a definitive `exists:false`; ANY error here THROWS so the caller fails
 * OPEN (conserve every partition — a control-api/gateway blip must not tear down
 * live sessions; the 15-min idle-evict is the backstop, §4.2).
 */
import type { BrokerTokenProviderDeps } from './brokerTokenProvider'
import { DEFAULT_BROKER_FETCH_TIMEOUT_MS } from './brokerTokenProvider'
import type { LiveOAuthPartition } from './manager'

/**
 * One entry of the batch request. Mirrors control-api's `GrantExistsQuery`.
 * `userId` addresses an `oauth-user` grant; `oauth-context` sends neither
 * coordinate (control-api keys the shared grant by the server's authoritative
 * `contextRef`, server-side — mcp-host transports no context identity).
 */
export interface GrantExistsQuery {
  mcpServerName: string
  userId?: string
  contextId?: string
}

/**
 * One entry of the response. control-api ECHOES the query coordinates so the
 * consumer correlates by tuple, not by array position; `exists` is the only
 * new field. Never a token, never the authoritative contextRef, never a key.
 */
export interface GrantExistsResult {
  mcpServerName: string
  userId?: string
  contextId?: string
  exists: boolean
}

/**
 * POST the batch grant-existence query to the gateway and return control-api's
 * `results`. Reuses the broker's refresh-on-401 (an idle pod's control JWT
 * expires; refresh ONCE and retry — bounded to one extra request). THROWS on
 * every failure mode (unconfigured gateway/token, non-200 incl. 403/5xx,
 * malformed body, network/timeout) so the sweep fails OPEN. Never logs or
 * returns a token.
 */
export async function checkGrantExistence(
  deps: BrokerTokenProviderDeps,
  queries: readonly GrantExistsQuery[]
): Promise<GrantExistsResult[]> {
  if (queries.length === 0) return []
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? DEFAULT_BROKER_FETCH_TIMEOUT_MS

  const gatewayUrl = deps.gatewayUrl()?.trim()
  if (!gatewayUrl) {
    throw new Error('mcp-oauth grant-existence: gateway URL not configured')
  }
  const controlToken = deps.controlToken()
  if (!controlToken) {
    throw new Error('mcp-oauth grant-existence: control token unavailable')
  }
  const payload = JSON.stringify({ queries })

  const post = async (bearer: string): Promise<Response> =>
    fetchImpl(`${gatewayUrl}/api/v1/mcp-oauth/grants/exists`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: payload,
      // A hung broker must not stall the eviction tick past its cadence.
      signal: AbortSignal.timeout(timeoutMs),
    })

  let res = await post(controlToken)

  // Same reactive recovery as brokerTokenProvider: the control JWT has a ~10 min
  // TTL and an idle pod reaches control-api with an expired bearer. Refresh ONCE
  // and retry; the "token actually changed" check bounds this to a single extra
  // request, so a refresh that fails cannot loop.
  if (res.status === 401 && deps.refreshControlToken) {
    let rotated: string | undefined
    try {
      await deps.refreshControlToken()
      rotated = deps.controlToken()
    } catch {
      // Fall through with the original 401; the throw below surfaces the failure
      // (and the sweep conserves). The cause is not swallowed silently — the
      // caller logs the thrown error.
    }
    if (rotated && rotated !== controlToken) {
      res = await post(rotated)
    }
  }

  if (res.status !== 200) {
    throw new Error(`mcp-oauth grant-existence returned ${res.status}`)
  }
  const data = (await res.json()) as { results?: unknown }
  if (!Array.isArray(data.results)) {
    throw new Error('mcp-oauth grant-existence returned a malformed body')
  }
  return data.results as GrantExistsResult[]
}

/** Stable coordinate key. `oauth-context` carries no userId → normalized to null. */
function coordKey(mcpServerName: string, userId?: string): string {
  return JSON.stringify([mcpServerName, userId ?? null])
}

/**
 * Build the batch query for the live OAuth partitions. Single source of the
 * coordinate convention (D4-adjacent): `oauth-user` sends its `userId`,
 * `oauth-context` sends only `mcpServerName`. Paired with
 * `selectRevokedPartitionKeys`, which reverses the SAME convention.
 */
export function buildGrantExistenceQueries(
  partitions: readonly LiveOAuthPartition[]
): GrantExistsQuery[] {
  return partitions.map(p => {
    const q: GrantExistsQuery = { mcpServerName: p.serverName }
    if (p.userId !== undefined) q.userId = p.userId
    return q
  })
}

/**
 * Correlate the batch results back to partition keys BY COORDINATE (not array
 * position — two per-user partitions of one server must stay distinguishable)
 * and select the keys whose grant is definitively absent. Only a strict
 * `exists === false` selects a key; true, missing, or a malformed entry
 * conserves (fail-closed on definitive revocation, fail-OPEN on everything
 * else). Returns the partition keys the sweep passes to
 * `manager.evictRevokedPartitions`.
 */
export function selectRevokedPartitionKeys(
  partitions: readonly LiveOAuthPartition[],
  results: readonly GrantExistsResult[]
): string[] {
  const byCoord = new Map<string, string>()
  for (const p of partitions) byCoord.set(coordKey(p.serverName, p.userId), p.key)
  const keys: string[] = []
  for (const r of results) {
    if (r.exists !== false) continue
    const key = byCoord.get(coordKey(r.mcpServerName, r.userId))
    if (key) keys.push(key)
  }
  return keys
}
