/**
 * Per-Host authority state for the renderer: which Hosts are held after an
 * authorization failure, and an epoch per Host that changes whenever that
 * Host's authority changes.
 *
 * Catalog and transcript reads snapshot `getEpoch(agentRef)` before an await
 * and discard the result when it moved. The epoch is per Host on purpose: a
 * revocation of Host Y must never invalidate an in-flight read of Host X, so
 * an agent that never changed authority reads as epoch 0, never as a global
 * counter.
 *
 * `useAppController` owns the production instance; the controller test
 * harnesses build theirs from this same factory so the epoch path under test
 * is the production one.
 */

export type HostAuthorityHoldKind = 'revoked' | 'uncertain'

export interface HostAuthorityStore {
  isBlocked: (agentRef: string) => boolean
  getEpoch: (agentRef: string) => number
  /** The epoch at which the Host was held, or undefined when it is not held. */
  heldAtEpoch: (agentRef: string) => number | undefined
  /**
   * Hold the Host. Returns false when nothing changed: a confirmed revocation
   * is never downgraded to an uncertain hold.
   */
  hold: (agentRef: string, kind: HostAuthorityHoldKind) => boolean
  /**
   * Release a hold after a successful verification. Returns false when the
   * hold changed since `heldAtEpoch` was read (the verification is stale).
   */
  release: (agentRef: string, heldAtEpoch: number) => boolean
  /** Forget every hold and epoch (a new authority scope). */
  reset: () => void
}

export function createHostAuthorityStore(): HostAuthorityStore {
  let epoch = 0
  const epochByAgent = new Map<string, number>()
  const holds = new Map<string, { kind: HostAuthorityHoldKind; epoch: number }>()

  return {
    isBlocked: agentRef => holds.has(agentRef),
    getEpoch: agentRef => epochByAgent.get(agentRef) ?? 0,
    heldAtEpoch: agentRef => holds.get(agentRef)?.epoch,
    hold: (agentRef, kind) => {
      if (holds.get(agentRef)?.kind === 'revoked' && kind === 'uncertain') return false
      epoch += 1
      holds.set(agentRef, { kind, epoch })
      epochByAgent.set(agentRef, epoch)
      return true
    },
    release: (agentRef, heldAtEpoch) => {
      if (holds.get(agentRef)?.epoch !== heldAtEpoch) return false
      holds.delete(agentRef)
      epoch += 1
      epochByAgent.set(agentRef, epoch)
      return true
    },
    reset: () => {
      holds.clear()
      epoch += 1
      epochByAgent.clear()
    },
  }
}
