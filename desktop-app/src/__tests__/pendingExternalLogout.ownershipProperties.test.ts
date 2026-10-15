import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { pendingExternalLogoutOwnership } from '../pendingExternalLogout.js'

const priorMarker = fc.oneof(
  fc.record({
    revision: fc.option(fc.uuid(), { nil: null }),
    intent: fc.constant({ intent: 'logout-pending' as const }),
  }),
  fc.record({
    revision: fc.option(fc.uuid(), { nil: null }),
    intent: fc.record({
      intent: fc.constant('keytar-cleanup-pending' as const),
      credentialSource: fc.constantFrom('active-keytar' as const, 'safe-storage' as const),
    }),
  })
)
const memoryOnlyMarker = fc.record({
  revision: fc.uuid(),
  intent: fc.record({
    intent: fc.constant('memory-only-session' as const),
    volatileSessionId: fc.uuid(),
  }),
})
const marker = fc.oneof(priorMarker, memoryOnlyMarker)
const optionalMarker = fc.option(marker, { nil: null })
const persistentMarker = fc.oneof(fc.constant(null), priorMarker)

describe('marker ownership observation invariants', () => {
  it('never grants ownership after runtime supersession for any observation', () => {
    fc.assert(
      fc.property(optionalMarker, fc.array(optionalMarker), (current, expected) => {
        expect(
          pendingExternalLogoutOwnership({ status: 'observed', marker: current }, expected, false)
        ).toEqual({ status: 'superseded' })
        for (const status of ['transient', 'invalid'] as const) {
          expect(
            pendingExternalLogoutOwnership({ status, error: new Error('fixture') }, expected, false)
          ).toEqual({ status: 'superseded' })
        }
      }),
      { numRuns: 10000 }
    )
  })

  it('preserves uncertainty rather than interpreting it as absent or superseded', () => {
    fc.assert(
      fc.property(fc.array(optionalMarker), expected => {
        for (const status of ['transient', 'invalid'] as const) {
          const observation = { status, error: new Error('fixture') }
          expect(pendingExternalLogoutOwnership(observation, expected, true)).toBe(observation)
        }
      }),
      { numRuns: 10000 }
    )
  })

  it('owns exactly an observed revision/source and composes alternative owned revisions', () => {
    fc.assert(
      fc.property(optionalMarker, optionalMarker, optionalMarker, (a, b, current) => {
        const observation = { status: 'observed' as const, marker: current }
        const singleA = pendingExternalLogoutOwnership(observation, [a], true)
        const singleB = pendingExternalLogoutOwnership(observation, [b], true)
        const combined = pendingExternalLogoutOwnership(observation, [a, b], true)
        expect(combined.status === 'owned').toBe(
          singleA.status === 'owned' || singleB.status === 'owned'
        )
        expect(pendingExternalLogoutOwnership(observation, [current], true).status).toBe('owned')
        expect(pendingExternalLogoutOwnership(observation, [a, a], true)).toEqual(singleA)
        if (a && current && a.revision !== current.revision)
          expect(singleA.status).toBe('superseded')
      }),
      { numRuns: 10000 }
    )
  })

  it('never aliases LP, CP-K, CP-S, M or absence even when revisions are equal', () => {
    fc.assert(
      fc.property(fc.uuid(), revision => {
        const sources = [
          null,
          { revision, intent: { intent: 'logout-pending' as const } },
          {
            revision,
            intent: {
              intent: 'keytar-cleanup-pending' as const,
              credentialSource: 'active-keytar' as const,
            },
          },
          {
            revision,
            intent: {
              intent: 'keytar-cleanup-pending' as const,
              credentialSource: 'safe-storage' as const,
            },
          },
          {
            revision,
            intent: {
              intent: 'memory-only-session' as const,
              volatileSessionId: '00000000-0000-4000-8000-000000000000',
            },
          },
        ]
        for (let current = 0; current < sources.length; current += 1)
          for (let expected = 0; expected < sources.length; expected += 1)
            expect(
              pendingExternalLogoutOwnership(
                { status: 'observed', marker: sources[current] },
                [sources[expected]],
                true
              ).status === 'owned'
            ).toBe(current === expected)
      }),
      { numRuns: 10000 }
    )
  })

  it('denies every prior persistent source while the M restart fence owns the revision', () => {
    fc.assert(
      fc.property(
        memoryOnlyMarker,
        fc.array(persistentMarker, { maxLength: 8 }),
        (current, prior) => {
          expect(
            pendingExternalLogoutOwnership({ status: 'observed', marker: current }, prior, true)
          ).toEqual({ status: 'superseded' })
          expect(
            pendingExternalLogoutOwnership({ status: 'observed', marker: current }, [current], true)
          ).toEqual({ status: 'owned', marker: current })
        }
      ),
      { numRuns: 10000 }
    )
  })

  it('prevents stale producers from owning a newer M marker revision', () => {
    fc.assert(
      fc.property(memoryOnlyMarker, stale => {
        const nextRevision = stale.revision.endsWith('f')
          ? `${stale.revision.slice(0, -1)}e`
          : `${stale.revision.slice(0, -1)}f`
        const newer = { ...stale, revision: nextRevision }
        const observation = { status: 'observed' as const, marker: newer }

        expect(pendingExternalLogoutOwnership(observation, [stale], true)).toEqual({
          status: 'superseded',
        })
        expect(pendingExternalLogoutOwnership(observation, [newer], true)).toEqual({
          status: 'owned',
          marker: newer,
        })
      }),
      { numRuns: 10000 }
    )
  })
})
