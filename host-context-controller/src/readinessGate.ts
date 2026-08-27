/** Closed-gate booleans for /ready 503 `reasons`. No CR names, counts, or secrets. */
export type ReadinessInventoryDetail = {
  stopped: boolean
  mcpServerCacheSynced: boolean
  contextCacheSynced: boolean
  hostCacheSynced: boolean
  safetyInventoryCertified: boolean
  contextRevisionAligned: boolean
  serverRevisionAligned: boolean
}

export type ReadinessReason =
  | 'controller_stopped'
  | 'mcp_watch_unsynced'
  | 'context_watch_unsynced'
  | 'host_watch_unsynced'
  | 'safety_pass_uncertified'
  | 'revocation_revision_mismatch'

export function readinessReasonsFromDetail(detail: ReadinessInventoryDetail): ReadinessReason[] {
  const reasons: ReadinessReason[] = []
  if (detail.stopped) reasons.push('controller_stopped')
  if (!detail.mcpServerCacheSynced) reasons.push('mcp_watch_unsynced')
  if (!detail.contextCacheSynced) reasons.push('context_watch_unsynced')
  if (!detail.hostCacheSynced) reasons.push('host_watch_unsynced')
  if (!detail.safetyInventoryCertified) reasons.push('safety_pass_uncertified')
  if (!detail.contextRevisionAligned || !detail.serverRevisionAligned) {
    reasons.push('revocation_revision_mismatch')
  }
  return reasons
}

/**
 * Resolve per-clause readiness detail for structured /ready 503 bodies.
 *
 * Production (McpServerWatcher present): expose the live inventory booleans.
 * Dev (no watcher): omit the detail fn so 503 bodies stay `{status, ready}`
 * and do not invent watch/safety clauses that do not exist.
 */
export function resolveReadinessDetailFn(
  watcher: { getReadinessInventoryDetail(): ReadinessInventoryDetail } | null
): (() => ReadinessInventoryDetail) | undefined {
  return watcher ? () => watcher.getReadinessInventoryDetail() : undefined
}

/**
 * Resolve the readiness-authority gate for the server from the provider.
 *
 * Production (McpServerWatcher present): readiness follows the live inventory
 * certification — /ready is 200 only once stale allows are revoked.
 *
 * Dev (DevMcpServerProvider — no watcher): there is NO NetworkPolicy inventory
 * to certify, so authority is unconditional. The ContextMapperServer default
 * for a missing gate is fail-closed (`() => false`), which is correct for a
 * caller that forgets to wire one — but in dev it would pin /ready (and every
 * data endpoint) at 503 forever. Dev must therefore pass an explicit
 * always-authoritative gate; this function is that single, named decision so
 * the affirmative literal never gets copy-pasted into a production path.
 */
export function resolveProviderAuthoritativeFn(
  watcher: { isReadinessInventoryAuthoritative(): boolean } | null
): () => boolean {
  return watcher ? () => watcher.isReadinessInventoryAuthoritative() : () => true
}

/**
 * Resolve the Host-inventory-authority gate the desktop route uses.
 *
 * Production (McpServerWatcher present): desktop status follows the live Host
 * inventory certification — a degraded Host lane 503s desktop rather than
 * answering a stale 200 'inactive'.
 *
 * Dev (DevMcpServerProvider — no watcher): there is NO Host inventory to
 * certify, exactly as there is no NetworkPolicy inventory for the provider
 * gate. The ContextMapperServer default for a missing gate is fail-closed
 * (`() => false`), which is correct for a caller that forgets to wire one — but
 * in dev it would pin every /api/v1/desktop/* response at 503 forever (R2-M1).
 * Dev must therefore mirror the provider gate and pass an explicit
 * always-authoritative gate; this function is that single, named decision so
 * the affirmative literal never gets copy-pasted into a production path.
 */
export function resolveHostAuthoritativeFn(
  watcher: { isHostInventoryAuthoritative(): boolean } | null
): () => boolean {
  return watcher ? () => watcher.isHostInventoryAuthoritative() : () => true
}

/**
 * Kubelet /ready authority: watch freshness only.
 *
 * Phase-2 certification (`safetyInventoryCertified`) and revocation-revision
 * alignment stay on the per-request gate. A stale allow must 503 data
 * endpoints without making kubelet evict the Pod.
 */
export function isProbeReadinessAuthoritative(detail: ReadinessInventoryDetail): boolean {
  return (
    !detail.stopped &&
    detail.mcpServerCacheSynced &&
    detail.contextCacheSynced &&
    detail.hostCacheSynced
  )
}

/**
 * Closed-gate reasons for the kubelet /ready probe.
 *
 * Never emits `safety_pass_uncertified` or `revocation_revision_mismatch` —
 * those belong to the per-request 6-clause gate.
 */
export function probeReadinessReasonsFromDetail(
  detail: ReadinessInventoryDetail
): ReadinessReason[] {
  const reasons: ReadinessReason[] = []
  if (detail.stopped) reasons.push('controller_stopped')
  if (!detail.mcpServerCacheSynced) reasons.push('mcp_watch_unsynced')
  if (!detail.contextCacheSynced) reasons.push('context_watch_unsynced')
  if (!detail.hostCacheSynced) reasons.push('host_watch_unsynced')
  return reasons
}

/**
 * Resolve the kubelet /ready probe gate from the watcher.
 *
 * Production (McpServerWatcher present): /ready follows watch freshness
 * (`isProbeReadinessAuthoritative` on the live inventory detail). MUST NOT
 * call `isReadinessInventoryAuthoritative` — that 6-clause predicate includes
 * phase-2 certification and would re-couple the probe to the safety pass.
 *
 * Dev (no watcher): same R3-B1 decision as the provider gate — authority is
 * unconditional so the server's fail-closed default cannot pin /ready at 503.
 */
export function resolveProbeAuthoritativeFn(
  watcher: { getReadinessInventoryDetail(): ReadinessInventoryDetail } | null
): () => boolean {
  return watcher
    ? () => isProbeReadinessAuthoritative(watcher.getReadinessInventoryDetail())
    : () => true
}
