import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  HistoricalSessionCredentialRequiresLoginError,
  type SessionCredentialSourceKind,
  type SessionCredentialSourceObservation,
  SessionCredentialSourceObservationError,
  digestSessionAuthoritySource,
  legacySessionCredentialSourceRef,
  planSessionCredentialSourceRead,
  sessionCredentialSourceReadOrder,
} from '../sessionCredentialSource.js'

const sourceKinds: SessionCredentialSourceKind[] = [
  'keytar',
  'safe-storage',
  'historical-plaintext',
]
const observationStatuses = ['absent', 'unavailable', 'present', 'failed'] as const

const validIdentity = {
  sourceKind: 'keytar' as const,
  sourceRef: '123e4567-e89b-42d3-a456-426614174000',
  envKey: 'development-123456789abc',
  accountId: 'account-fixture',
}

describe('session credential source primitives', () => {
  it('keeps the secure-provider read order and gates historical plaintext by mode', () => {
    fc.assert(
      fc.property(fc.boolean(), allowHistoricalPlaintext => {
        expect(sessionCredentialSourceReadOrder(allowHistoricalPlaintext)).toEqual(
          allowHistoricalPlaintext
            ? ['keytar', 'safe-storage', 'historical-plaintext']
            : ['keytar', 'safe-storage']
        )
      }),
      { numRuns: 500 }
    )
  })

  it('never treats an uncertain higher-precedence read as absence or fallback permission', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('keytar' as const, 'safe-storage' as const),
        fc.string(),
        fc.boolean(),
        (source, message, allowHistoricalPlaintext) => {
          const error = Object.assign(new Error(message), { code: 'EIO' })
          const plan = planSessionCredentialSourceRead(
            { source, status: 'failed', error, fallbackReadFailure: true },
            { allowIsolatedDevelopmentPlaintext: allowHistoricalPlaintext }
          )

          expect(plan.kind).toBe('reject')
          expect(plan.kind === 'reject' && plan.error).toBeInstanceOf(
            SessionCredentialSourceObservationError
          )
          expect(
            plan.kind === 'reject' && (plan.error as SessionCredentialSourceObservationError).source
          ).toBe(source)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('applies observation outcomes without inventing a credential source', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...sourceKinds),
        fc.constantFrom(...observationStatuses),
        fc.boolean(),
        (source, status, allowHistoricalPlaintext) => {
          let observation: SessionCredentialSourceObservation
          if (status === 'present') {
            observation = { source, status, token: 'fixture-session-token', authority: {} }
          } else if (status === 'failed') {
            observation = {
              source,
              status,
              error: new Error('fixture read failure'),
              fallbackReadFailure: false,
            }
          } else if (status === 'unavailable') {
            observation = { source, status, reason: 'provider-unqualified' }
          } else {
            observation = { source, status }
          }

          const plan = planSessionCredentialSourceRead(observation, {
            allowIsolatedDevelopmentPlaintext: allowHistoricalPlaintext,
          })

          if (status === 'present' && source === 'historical-plaintext') {
            expect(plan.kind).toBe(allowHistoricalPlaintext ? 'select' : 'reject')
            if (!allowHistoricalPlaintext && plan.kind === 'reject')
              expect(plan.error).toBeInstanceOf(HistoricalSessionCredentialRequiresLoginError)
          } else if (status === 'present') {
            expect(plan).toEqual({ kind: 'select' })
          } else if (status === 'absent' || status === 'unavailable') {
            expect(plan).toEqual({ kind: 'continue' })
          } else if (source === 'historical-plaintext') {
            expect(plan.kind).toBe('reject')
          } else {
            expect(plan.kind).toBe('reject')
          }
        }
      ),
      { numRuns: 750 }
    )
  })

  it('derives a stable, location-bound identity for a legacy source', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.option(fc.integer({ min: 1, max: 2 ** 31 - 1 }), { nil: null }),
        fc.string({ minLength: 1 }),
        (storageRoot, dev, ino, uid, account) => {
          const args = [
            storageRoot,
            { dev, ino, uid },
            validIdentity.envKey,
            'keytar' as const,
            { kind: 'keytar-account' as const, account },
          ] as const
          const first = legacySessionCredentialSourceRef(...args)

          expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
          expect(legacySessionCredentialSourceRef(...args)).toBe(first)
          expect(
            legacySessionCredentialSourceRef(
              storageRoot,
              { dev, ino, uid },
              validIdentity.envKey,
              'keytar',
              { kind: 'keytar-account', account: `${account}-other` }
            )
          ).not.toBe(first)
          expect(
            legacySessionCredentialSourceRef(
              `${storageRoot}-other`,
              { dev, ino, uid },
              validIdentity.envKey,
              'keytar',
              { kind: 'keytar-account', account }
            )
          ).not.toBe(first)
          expect(
            legacySessionCredentialSourceRef(
              storageRoot,
              { dev: dev + 1, ino, uid },
              validIdentity.envKey,
              'keytar',
              { kind: 'keytar-account', account }
            )
          ).not.toBe(first)
          expect(
            legacySessionCredentialSourceRef(
              storageRoot,
              { dev, ino: ino + 1, uid },
              validIdentity.envKey,
              'keytar',
              { kind: 'keytar-account', account }
            )
          ).not.toBe(first)
          expect(
            legacySessionCredentialSourceRef(
              storageRoot,
              { dev, ino, uid: uid === null ? 1 : uid + 1 },
              validIdentity.envKey,
              'keytar',
              { kind: 'keytar-account', account }
            )
          ).not.toBe(first)
          expect(
            legacySessionCredentialSourceRef(
              storageRoot,
              { dev, ino, uid },
              'staging-abcdef123456',
              'keytar',
              { kind: 'keytar-account', account }
            )
          ).not.toBe(first)
          expect(
            legacySessionCredentialSourceRef(
              storageRoot,
              { dev, ino, uid },
              validIdentity.envKey,
              'safe-storage',
              { kind: 'keytar-account', account }
            )
          ).not.toBe(first)
          expect(
            legacySessionCredentialSourceRef(
              storageRoot,
              { dev, ino, uid },
              validIdentity.envKey,
              'safe-storage',
              { kind: 'safe-storage-file', envKey: validIdentity.envKey }
            )
          ).not.toBe(first)
          expect(
            legacySessionCredentialSourceRef(
              storageRoot,
              { dev, ino, uid },
              validIdentity.envKey,
              'safe-storage',
              { kind: 'safe-storage-file', envKey: 'staging-abcdef123456' }
            )
          ).not.toBe(
            legacySessionCredentialSourceRef(
              storageRoot,
              { dev, ino, uid },
              validIdentity.envKey,
              'safe-storage',
              { kind: 'safe-storage-file', envKey: validIdentity.envKey }
            )
          )
          expect(
            legacySessionCredentialSourceRef(
              storageRoot,
              { dev, ino, uid },
              validIdentity.envKey,
              'historical-plaintext',
              { kind: 'plaintext-file', envKey: validIdentity.envKey }
            )
          ).not.toBe(first)
          expect(
            legacySessionCredentialSourceRef(
              storageRoot,
              { dev, ino, uid },
              validIdentity.envKey,
              'historical-plaintext',
              { kind: 'plaintext-file', envKey: 'staging-abcdef123456' }
            )
          ).not.toBe(
            legacySessionCredentialSourceRef(
              storageRoot,
              { dev, ino, uid },
              validIdentity.envKey,
              'historical-plaintext',
              { kind: 'plaintext-file', envKey: validIdentity.envKey }
            )
          )
        }
      ),
      { numRuns: 300 }
    )
  })

  it('binds the source digest to identity and exact stored bytes', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (storedValue, replacement) => {
        const digest = digestSessionAuthoritySource(validIdentity, storedValue)

        expect(digest).toMatch(/^[0-9a-f]{64}$/)
        expect(digestSessionAuthoritySource(validIdentity, storedValue)).toBe(digest)
        expect(digestSessionAuthoritySource(validIdentity, Buffer.from(storedValue))).toBe(digest)
        if (replacement !== storedValue)
          expect(digestSessionAuthoritySource(validIdentity, replacement)).not.toBe(digest)
        expect(
          digestSessionAuthoritySource(
            { ...validIdentity, accountId: 'other-account' },
            storedValue
          )
        ).not.toBe(digest)
        expect(
          digestSessionAuthoritySource(
            { ...validIdentity, sourceKind: 'safe-storage' },
            storedValue
          )
        ).not.toBe(digest)
        expect(
          digestSessionAuthoritySource(
            { ...validIdentity, sourceRef: '123e4567-e89b-42d3-a456-426614174001' },
            storedValue
          )
        ).not.toBe(digest)
        expect(
          digestSessionAuthoritySource(
            { ...validIdentity, envKey: 'staging-abcdef123456' },
            storedValue
          )
        ).not.toBe(digest)
      }),
      { numRuns: 300 }
    )
  })
})
