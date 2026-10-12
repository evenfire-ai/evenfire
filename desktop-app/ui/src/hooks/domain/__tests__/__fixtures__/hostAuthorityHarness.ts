import { useRef, useState } from 'react'
import {
  type HostAuthorityHoldKind,
  type HostAuthorityStore,
  createHostAuthorityStore,
} from '../../../../lib/hostAuthorityStore'

/**
 * Host authority for controller tests, built on the SAME store factory
 * `useAppController` uses (R2-M5). A stub such as `getHostAuthorityEpoch = () =>
 * 0` makes every epoch comparison vacuous, so a regression in the production
 * epoch path could never turn a controller test red.
 *
 * The callbacks are stable for the mount, like the production `useCallback`s,
 * and a hold or release bumps `revision` exactly as `useAppController` does.
 */
export interface HarnessHostAuthority {
  store: HostAuthorityStore
  revision: number
  onHostAccessRevoked: (agentRef: string) => void
  onHostAuthorityUncertain: (agentRef: string) => void
  isHostAccessBlocked: (agentRef: string) => boolean
  getHostAuthorityEpoch: (agentRef: string) => number
  /** Release a hold the way a successful `verifyHostAccess` does. */
  release: (agentRef: string) => void
}

export type HostAuthorityListener = (agentRef: string, kind: HostAuthorityHoldKind) => void

export function useHarnessHostAuthority(listener?: HostAuthorityListener): HarnessHostAuthority {
  const [revision, setRevision] = useState(0)
  const listenerRef = useRef(listener)
  listenerRef.current = listener
  const [stable] = useState(() => {
    const store = createHostAuthorityStore()
    const bump = () => setRevision(value => value + 1)
    const hold = (agentRef: string, kind: HostAuthorityHoldKind) => {
      listenerRef.current?.(agentRef, kind)
      if (store.hold(agentRef, kind)) bump()
    }
    return {
      store,
      onHostAccessRevoked: (agentRef: string) => hold(agentRef, 'revoked'),
      onHostAuthorityUncertain: (agentRef: string) => hold(agentRef, 'uncertain'),
      isHostAccessBlocked: (agentRef: string) => store.isBlocked(agentRef),
      getHostAuthorityEpoch: (agentRef: string) => store.getEpoch(agentRef),
      release: (agentRef: string) => {
        const heldAtEpoch = store.heldAtEpoch(agentRef)
        if (heldAtEpoch === undefined) throw new Error(`${agentRef} is not held`)
        if (!store.release(agentRef, heldAtEpoch)) throw new Error(`${agentRef} hold moved`)
        bump()
      },
    }
  })
  return { ...stable, revision }
}
