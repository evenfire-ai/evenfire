import { describe, expect, it } from 'vitest'
import { type GfsMountIntent, decideMountStatus, resolveMount } from './contextGfsMount'

/**
 * P3-S03 — Context gfs mount, intent-not-authority. A mount is wired only if the
 * Context identity already holds every requested scope; insufficient scope ⇒
 * PendingMount (no escalation from editing the CRD).
 */

const intent = (scopes: string[]): GfsMountIntent => ({ drive: 'main', target: 'res-1', scopes })

describe('decideMountStatus (intent-not-authority)', () => {
  it('mounts when every requested scope is held', () => {
    expect(decideMountStatus(intent(['gfs.read']), new Set(['gfs.read']))).toBe('Mounted')
    expect(
      decideMountStatus(intent(['gfs.read', 'gfs.write']), new Set(['gfs.read', 'gfs.write']))
    ).toBe('Mounted')
  })

  it('is PendingMount when a requested scope is NOT held (no escalation)', () => {
    // requests write, but the identity only holds read → must not mount.
    expect(decideMountStatus(intent(['gfs.read', 'gfs.write']), new Set(['gfs.read']))).toBe(
      'PendingMount'
    )
    expect(decideMountStatus(intent(['gfs.read']), new Set())).toBe('PendingMount')
  })

  it('treats an empty request as PendingMount (intent is not authority)', () => {
    expect(decideMountStatus(intent([]), new Set(['gfs.read']))).toBe('PendingMount')
  })
})

describe('resolveMount', () => {
  it('confirms held scopes via the confirmer, then decides', async () => {
    const confirmer = { heldScopes: async () => new Set(['gfs.read']) }
    expect(await resolveMount(confirmer, intent(['gfs.read']))).toBe('Mounted')
    expect(await resolveMount(confirmer, intent(['gfs.read', 'gfs.write']))).toBe('PendingMount')
  })
})
