/**
 * Issue #1016 — per-reconcile recording context. A full reconcile records which
 * DNS-dependent blocks it ran, which denied-Secret set its ownership gate
 * enforced, and whether a repair is pending. AsyncLocalStorage keeps concurrent
 * reconciles of different recipes isolated; code outside reconcile() (the egress
 * lane, the T1 out-of-reconcile credential refresh) sees no context and records nothing.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface ReconcileContext {
  dnsBlocks: Set<'recipe_egress' | 'runtime_http_egress'>
  enforcedOwnership?: string
  repairPending: boolean
  /** The pass returned `staleRecipeResult` (recipe deleting or gone). */
  stale: boolean
}

const storage = new AsyncLocalStorage<ReconcileContext>()

export async function runInReconcileContext<T>(
  fn: () => Promise<T>
): Promise<{ value: T; ctx: ReconcileContext }> {
  const ctx: ReconcileContext = { dnsBlocks: new Set(), repairPending: false, stale: false }
  const value = await storage.run(ctx, fn)
  return { value, ctx }
}

export function noteDnsBlock(block: 'recipe_egress' | 'runtime_http_egress'): void {
  storage.getStore()?.dnsBlocks.add(block)
}

export function noteEnforcedOwnership(signature: string): void {
  const ctx = storage.getStore()
  if (ctx) ctx.enforcedOwnership = signature
}

export function noteRepairPending(): void {
  const ctx = storage.getStore()
  if (ctx) ctx.repairPending = true
}

/** Issue #1016 — the pass found the recipe deleting or gone; it settles nothing. */
export function noteStale(): void {
  const ctx = storage.getStore()
  if (ctx) ctx.stale = true
}

/** Issue #1016 — canonical denied-set signature: sorted, '|'-joined; '' when none. */
export function ownershipSignature(deniedPairs: readonly string[]): string {
  return [...deniedPairs].sort().join('|')
}
