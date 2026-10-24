import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createEmbedOwnershipState, reduceEmbedOwnership } from '../embedOwnership'
import type { EmbedEvent, EmbedOwnershipState, Launch } from '../embedOwnership.types'
import { embedViewState } from '../embedOwnershipView'

const TAB = 'app-tab'
const FIRST = 'launch-first'
const NEXT = 'launch-next'
const BOUNDS = { x: 0, y: 32, width: 800, height: 600, dpr: 1 }

function launch(launchId: string): Launch {
  return {
    launchId,
    tabId: TAB,
    appRef: `team/app-${launchId}`,
    route: { kind: 'tab' },
    app: { label: launchId, defaultPath: '/' },
  }
}

function apply(state: EmbedOwnershipState, event: EmbedEvent): EmbedOwnershipState {
  return reduceEmbedOwnership(state, event).state
}

function mountedFirstLaunch(): EmbedOwnershipState {
  let state = createEmbedOwnershipState()
  state = apply(state, { type: 'projected', activeAppTabId: TAB })
  state = apply(state, { type: 'intent', launch: launch(FIRST) })
  state = apply(state, { type: 'slotMeasured', launchId: FIRST, bounds: BOUNDS })
  return apply(state, { type: 'openSettled', launchId: FIRST, outcome: 'mounted' })
}

describe('embed close recovery against the owner-directed single-live-view model', () => {
  it('retries a failed handoff and retires its exact view after terminal release', () => {
    let state = mountedFirstLaunch()
    let transition = reduceEmbedOwnership(state, { type: 'handoff', requestId: 1 })
    expect(transition.effects).toContainEqual({ type: 'close', launchId: FIRST })
    state = transition.state
    state = apply(state, { type: 'closeFailed', launchId: FIRST })

    // The exact failed view remains visible and owned until a later handoff can retry it.
    expect(state.views.get(FIRST)?.phase).toBe('closeFailed')
    expect(state.owner).toBe(FIRST)
    expect(embedViewState(state)).toMatchObject({ kind: 'mounted', launch: { launchId: FIRST } })

    transition = reduceEmbedOwnership(state, { type: 'handoff', requestId: 2 })
    expect(transition.effects).toContainEqual({ type: 'close', launchId: FIRST })
    state = transition.state
    transition = reduceEmbedOwnership(state, {
      type: 'released',
      launchId: FIRST,
      reason: 'closed',
      location: null,
    })
    expect(transition.state.views.has(FIRST)).toBe(false)
    expect(transition.state.owner).toBeNull()
    expect(transition.effects).toContainEqual({ type: 'handoffReady', requestId: 2 })
  })

  it('advances the pending replacement only after a matching terminal release', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('closed', 'crashed', 'session', 'renderer_replaced') as fc.Arbitrary<
          'closed' | 'crashed' | 'session' | 'renderer_replaced'
        >,
        reason => {
          let state = mountedFirstLaunch()
          state = apply(state, { type: 'relaunch', launch: launch(NEXT) })
          state = apply(state, { type: 'closeFailed', launchId: FIRST })

          // The independent model first preserves the live owner, then permits
          // the newest waiting launch after main identifies that exact release.
          state = apply(state, { type: 'released', launchId: FIRST, reason, location: null })
          expect(state.views.has(FIRST)).toBe(false)
          expect(state.views.get(NEXT)?.phase).toBe('measuring')
          expect(state.owner).toBe(NEXT)
        }
      ),
      { numRuns: 4 }
    )
  })
})
