import { describe, expect, it } from 'vitest'
import { assertCanonicalRuntimeConfig, parseStorageContract } from '../canonicalStoreBootGuard'

const binding = { hostUid: 'host-uid', pvcUid: 'pvc-uid' }
const floor = {
  stateDir: '/var/lib/clerum/state',
  binding,
  required: false,
  storageContract: 'legacy-floor' as const,
}

describe('admitted conversation store contracts', () => {
  it('requires the explicit discriminator and its matching required flag', () => {
    expect(parseStorageContract('legacy-floor', false)).toBe('legacy-floor')
    expect(parseStorageContract('canonical', true)).toBe('canonical')
    expect(parseStorageContract('', false)).toBeUndefined()
    expect(() => parseStorageContract('', true)).toThrow('RuntimeContractMissing')
    for (const [raw, required] of [
      ['canonical', false],
      ['legacy-floor', true],
      ['unknown', false],
    ] as const) {
      expect(() => parseStorageContract(raw, required)).toThrow('RuntimeContractMismatch')
    }
  })

  it('requires sqlite and the isolated state path before starting the legacy floor', () => {
    for (const mode of ['memory', 'dual'] as const) {
      expect(() =>
        assertCanonicalRuntimeConfig(mode, '/var/lib/clerum/state/state.db', floor)
      ).toThrow('RequiresSqlite')
    }
    expect(() => assertCanonicalRuntimeConfig('sqlite', '/workspace/state.db', floor)).toThrow(
      'DbPathMismatch'
    )
    expect(() =>
      assertCanonicalRuntimeConfig('sqlite', '/var/lib/clerum/state/state.db', {
        ...floor,
        legacyRoot: '/workspace',
      })
    ).toThrow('RootMountForbidden')
    expect(() =>
      assertCanonicalRuntimeConfig('sqlite', '/var/lib/clerum/state/state.db', floor)
    ).not.toThrow()
  })

  it('rejects contradictions even in direct programmatic runtime options', () => {
    expect(() =>
      assertCanonicalRuntimeConfig('sqlite', '/var/lib/clerum/state/state.db', {
        ...floor,
        required: true,
      })
    ).toThrow('RuntimeContractMismatch')
    expect(() =>
      assertCanonicalRuntimeConfig('sqlite', '/var/lib/clerum/state/state.db', {
        ...floor,
        storageContract: 'canonical',
      })
    ).toThrow('RuntimeContractMismatch')
  })
})
