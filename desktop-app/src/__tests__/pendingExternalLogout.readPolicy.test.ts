import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type PendingExternalLogoutIntent,
  pendingExternalLogoutMarkersMatch,
} from '../pendingExternalLogout.js'

describe('shared exact marker ownership', () => {
  const intent = fc.constantFrom<PendingExternalLogoutIntent>(
    { intent: 'logout-pending' },
    { intent: 'keytar-cleanup-pending', credentialSource: 'active-keytar' },
    { intent: 'keytar-cleanup-pending', credentialSource: 'safe-storage' }
  )
  const marker = fc.record({ intent, revision: fc.option(fc.uuid(), { nil: null }) })

  it('is reflexive and symmetric without treating revisionless records as wildcards', () => {
    fc.assert(
      fc.property(marker, marker, (left, right) => {
        expect(pendingExternalLogoutMarkersMatch(left, left)).toBe(true)
        expect(pendingExternalLogoutMarkersMatch(left, right)).toBe(
          pendingExternalLogoutMarkersMatch(right, left)
        )
        const sameSource =
          left.intent.intent === 'logout-pending'
            ? right.intent.intent === 'logout-pending'
            : right.intent.intent === 'keytar-cleanup-pending' &&
              left.intent.credentialSource === right.intent.credentialSource
        expect(pendingExternalLogoutMarkersMatch(left, right)).toBe(
          sameSource && left.revision === right.revision
        )
        expect(pendingExternalLogoutMarkersMatch(null, left)).toBe(false)
        expect(
          pendingExternalLogoutMarkersMatch({ ...left, revision: `new-${left.revision}` }, left)
        ).toBe(false)
      }),
      { numRuns: 20000 }
    )
  })
})
