import { describe, expect, it } from 'vitest'
import { createHostAuthorityStore } from '../hostAuthorityStore'

describe('createHostAuthorityStore', () => {
  it('keeps Host X authority unchanged when Host Y is held', () => {
    const store = createHostAuthorityStore()
    const hostXEpoch = store.getEpoch('host-x')

    expect(store.hold('host-y', 'revoked')).toBe(true)

    expect(store.getEpoch('host-x')).toBe(hostXEpoch)
    expect(store.getEpoch('host-y')).not.toBe(hostXEpoch)
    expect(store.isBlocked('host-y')).toBe(true)
    expect(store.isBlocked('host-x')).toBe(false)
  })

  it('never downgrades a confirmed revocation to an uncertain hold', () => {
    const store = createHostAuthorityStore()
    store.hold('host-y', 'revoked')
    const heldAt = store.heldAtEpoch('host-y')

    expect(store.hold('host-y', 'uncertain')).toBe(false)
    expect(store.heldAtEpoch('host-y')).toBe(heldAt)
  })

  it('refuses a stale release and moves the epoch on a valid one', () => {
    const store = createHostAuthorityStore()
    store.hold('host-y', 'uncertain')
    const firstHold = store.heldAtEpoch('host-y')
    if (firstHold === undefined) throw new Error('host-y must be held')
    store.hold('host-y', 'revoked')

    expect(store.release('host-y', firstHold)).toBe(false)
    expect(store.isBlocked('host-y')).toBe(true)

    const currentHold = store.heldAtEpoch('host-y')
    if (currentHold === undefined) throw new Error('host-y must still be held')
    const beforeRelease = store.getEpoch('host-y')
    expect(store.release('host-y', currentHold)).toBe(true)
    expect(store.isBlocked('host-y')).toBe(false)
    expect(store.getEpoch('host-y')).not.toBe(beforeRelease)
  })

  it('reset clears every hold and changes the epoch of a previously held Host', () => {
    const store = createHostAuthorityStore()
    store.hold('host-y', 'revoked')
    const heldEpoch = store.getEpoch('host-y')

    store.reset()

    expect(store.isBlocked('host-y')).toBe(false)
    expect(store.getEpoch('host-y')).not.toBe(heldEpoch)
  })
})
