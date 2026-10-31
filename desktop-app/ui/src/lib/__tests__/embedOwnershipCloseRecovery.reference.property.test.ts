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

  function rejectedHandoffOwner(): EmbedOwnershipState {
    let state = mountedFirstLaunch()
    state = apply(state, { type: 'handoff', requestId: 1 })
    return apply(state, { type: 'closeFailed', launchId: FIRST })
  }

  it.each([
    ['active-tab reselect', (state: EmbedOwnershipState) => state],
    [
      'leave and return to the same tab',
      (state: EmbedOwnershipState) =>
        apply(apply(state, { type: 'projected', activeAppTabId: null }), {
          type: 'projected',
          activeAppTabId: TAB,
        }),
    ],
  ] as const)('%s preserves a retained close-failed view on intent', (_name, prepare) => {
    const state = prepare(rejectedHandoffOwner())
    expect(state.owner).toBe(FIRST)
    expect(state.views.get(FIRST)?.phase).toBe('closeFailed')

    const transition = reduceEmbedOwnership(state, { type: 'intent', launch: launch(NEXT) })

    expect(transition.state).toBe(state)
    expect(transition.effects).toEqual([
      { type: 'launchSettled', launchId: NEXT, outcome: 'abandoned' },
    ])
    expect(transition.effects).not.toContainEqual(expect.objectContaining({ type: 'close' }))
  })

  it('retries the retained close only for an explicit relaunch and waits for release', () => {
    const state = rejectedHandoffOwner()
    const relaunch = reduceEmbedOwnership(state, { type: 'relaunch', launch: launch(NEXT) })

    expect(relaunch.effects).toEqual([{ type: 'close', launchId: FIRST }])
    expect(relaunch.state.views.get(FIRST)?.phase).toBe('closeRequested')
    expect(relaunch.state.views.get(NEXT)?.phase).toBe('waiting')
    expect(relaunch.state.owner).toBe(NEXT)

    const released = reduceEmbedOwnership(relaunch.state, {
      type: 'released',
      launchId: FIRST,
      reason: 'closed',
      location: { routePath: '/tickets/live' },
    })
    expect(released.state.views.has(FIRST)).toBe(false)
    expect(released.state.views.get(NEXT)?.phase).toBe('measuring')
    expect(released.state.owner).toBe(NEXT)
    expect(released.effects).toEqual([
      { type: 'persistRoute', tabId: TAB, route: { action: 'set', routePath: '/tickets/live' } },
      { type: 'measure', launchId: NEXT },
    ])
  })
})
