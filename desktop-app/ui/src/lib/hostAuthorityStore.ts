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
  /** The kind of the current hold, or undefined when the Host is not held. */
  holdKind: (agentRef: string) => HostAuthorityHoldKind | undefined
  /**
   * The epoch at which the current hold episode began, or undefined when the
   * Host is not held. A repeated hold and an upgrade keep it; only a release
   * or reset ends the episode, so the next hold starts a new one.
   */
  heldSince: (agentRef: string) => number | undefined
  /**
   * Returns true only when the hold state changed (unheld→held or
   * uncertain→revoked). A repeated hold of the same kind still advances the
   * epoch so an in-flight verification is invalidated, but returns false.
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
  const holds = new Map<string, { kind: HostAuthorityHoldKind; epoch: number; since: number }>()

  return {
    isBlocked: agentRef => holds.has(agentRef),
    getEpoch: agentRef => epochByAgent.get(agentRef) ?? 0,
    heldAtEpoch: agentRef => holds.get(agentRef)?.epoch,
    holdKind: agentRef => holds.get(agentRef)?.kind,
    heldSince: agentRef => holds.get(agentRef)?.since,
    hold: (agentRef, kind) => {
      const current = holds.get(agentRef)
      if (current?.kind === 'revoked' && kind === 'uncertain') return false
      epoch += 1
      holds.set(agentRef, { kind, epoch, since: current?.since ?? epoch })
      epochByAgent.set(agentRef, epoch)
      return current?.kind !== kind
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
