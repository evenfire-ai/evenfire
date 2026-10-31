import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { canCompleteGfsResourceNavigation } from '../gfsResourceNavigationIntent'

type UserAction =
  | { kind: 'select-owner' }
  | { kind: 'select-other' }
  | { kind: 'close-owner' }
  | { kind: 'change-principal' }

const userAction = fc.constantFrom<UserAction>(
  { kind: 'select-owner' },
  { kind: 'select-other' },
  { kind: 'close-owner' },
  { kind: 'change-principal' }
)

describe('GFS async navigation against the user-intent reference model', () => {
  it('lets completion apply only when no newer action displaced its owner or principal', () => {
    fc.assert(
      fc.property(fc.array(userAction, { maxLength: 30 }), actions => {
        let currentIntent = 10
        let currentPrincipal = 4
        let currentUserAction = 20
        let activeTabId: string | null = 'files-owner'
        let ownerExists = true
        let ownerIsFiles = true

        for (const action of actions) {
          switch (action.kind) {
            case 'select-owner':
              currentIntent += 1
              currentUserAction += 1
              activeTabId = 'files-owner'
              break
            case 'select-other':
              currentIntent += 1
              currentUserAction += 1
              activeTabId = 'settings-tab'
              break
            case 'close-owner':
              currentIntent += 1
              currentUserAction += 1
              ownerExists = false
              activeTabId = 'settings-tab'
              break
            case 'change-principal':
              currentIntent += 1
              currentPrincipal += 1
              currentUserAction += 1
              activeTabId = 'files-owner'
              break
          }
        }

        // This oracle describes events, not the helper's boolean expression:
        // every later user action invalidates the old completion, even when
        // the user returns to the original tab before the async result arrives.
        const referenceAllowsCompletion =
          actions.length === 0 && ownerExists && ownerIsFiles && activeTabId === 'files-owner'

        const request = {
          id: 1,
          uri: 'gfs://main/0123456789abcdef0123456789abcdef',
          ownerTabId: 'files-owner',
          intentSequence: 10,
          principalGeneration: 4,
          userNavigationGenerationAtActivation: 20,
          createDestination: false,
        }
        const context = {
          intentSequence: currentIntent,
          principalGeneration: currentPrincipal,
          userNavigationGeneration: currentUserAction,
          activeTabId,
          tabs: ownerExists && ownerIsFiles ? [{ id: 'files-owner', kind: 'files' as const }] : [],
        }

        expect(canCompleteGfsResourceNavigation(request, context)).toBe(referenceAllowsCompletion)
      }),
      { numRuns: 1000 }
    )
  })
})
