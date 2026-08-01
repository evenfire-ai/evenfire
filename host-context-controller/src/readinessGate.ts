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
