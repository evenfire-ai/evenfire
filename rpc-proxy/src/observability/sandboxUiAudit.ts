/**
 * Sandbox-UI observability emit points.
 *
 * The longer-term plan is prom-client histograms + counters and a
 * control-api `audit_events` row per session mint. rpc-proxy doesn't have
 * prom-client or pino today, so v1 of these signals lives as JSON-line
 * `console.info` events. A future migration to prom-client + pino + an
 * audit POST swaps the emit-functions' bodies; call-sites stay put.
 *
 * Each emit logs a single JSON object so log shippers (cloud logging,
 * Loki, etc.) can index by `event` field for dashboards. None of the
 * payloads include the session cookie, the RPC JWT, or any other secret —
 * the user id (cookie.sub) is the highest-cardinality field we emit, and
 * it is already an opaque UUID.
 *
 * The future prom-client wiring would map:
 *   sandbox_ui_session_mint    → counter sandbox_ui_session_mint_total{outcome}
 *   sandbox_ui_view_request    → counter sandbox_ui_proxy_requests_total{ns,name,status}
 *                              + histogram sandbox_ui_proxy_request_duration_seconds
 *   sandbox_ui_registry_lookup → histogram sandbox_ui_registry_lookup_duration_seconds{cache_hit}
 */

export type SessionMintOutcome =
  | 'ok'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'not_ready'
  | 'misconfigured'
  | 'error'

export type RegistryOutcome =
  | 'ok'
  | 'not_found'
  | 'not_ready'
  | 'forbidden'
  | 'misconfigured'
  | 'error'

type EmitTarget = (line: string) => void

let target: EmitTarget = line => console.info(line)

/**
 * Test-only: redirect emit lines into a buffer instead of console.info.
 * Returns a restore function.
 */
export function _setSandboxUiAuditTarget(t: EmitTarget): () => void {
  const previous = target
  target = t
  return () => {
    target = previous
  }
}

function emit(event: string, payload: Record<string, unknown>): void {
  target(JSON.stringify({ event, ts: new Date().toISOString(), ...payload }))
}

export function emitSessionMint(payload: {
  outcome: SessionMintOutcome
  userId: string
  recipeNs: string
  recipeName: string
  reason?: string
}): void {
  emit('sandbox_ui_session_mint', payload as Record<string, unknown>)
}

export function emitViewRequest(payload: {
  userId: string
  recipeNs: string
  recipeName: string
  status: number
  path: string
  method: string
}): void {
  emit('sandbox_ui_view_request', payload as Record<string, unknown>)
}

export function emitRegistryLookup(payload: {
  recipeNs: string
  recipeName: string
  forUser?: string
  cacheHit: boolean
  kind: RegistryOutcome
  durationMs: number
}): void {
  emit('sandbox_ui_registry_lookup', payload as Record<string, unknown>)
}
