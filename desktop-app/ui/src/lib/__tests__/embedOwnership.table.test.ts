import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createEmbedOwnershipState, reduceEmbedOwnership } from '../embedOwnership'
import type {
  Bounds,
  EmbedEffect,
  EmbedEvent,
  EmbedOwnershipState,
  Launch,
  LaunchId,
  TabId,
  ViewPhase,
} from '../embedOwnership.types'

// Every fixture state is produced by the reducer itself from an event sequence:
// no hand-built `EmbedOwnershipState`, so a state the reducer cannot reach never
// appears here.

const BOUNDS: Bounds = { x: 0, y: 40, width: 800, height: 600, dpr: 2 }
const T1: TabId = 'ws-tab-1'
const T2: TabId = 'ws-tab-2'

function launch(
  launchId: LaunchId,
  tabId: TabId,
  route: Launch['route'] = { kind: 'tab' },
  app: Launch['app'] = { label: 'App', defaultPath: '/' }
): Launch {
  return { launchId, tabId, appRef: 'ns/app', route, app }
}

const ev = {
  projected: (activeAppTabId: TabId | null): EmbedEvent => ({ type: 'projected', activeAppTabId }),
  intent: (l: Launch): EmbedEvent => ({ type: 'intent', launch: l }),
  relaunch: (l: Launch): EmbedEvent => ({ type: 'relaunch', launch: l }),
  backToApps: (): EmbedEvent => ({ type: 'backToApps' }),
  handoff: (requestId: number): EmbedEvent => ({ type: 'handoff', requestId }),
  measured: (launchId: LaunchId, bounds: Bounds | null = BOUNDS): EmbedEvent => ({
    type: 'slotMeasured',
    launchId,
    bounds,
  }),
  mounted: (launchId: LaunchId): EmbedEvent => ({
    type: 'openSettled',
    launchId,
    outcome: 'mounted',
  }),
  openFailed: (launchId: LaunchId, failed = 'boom'): EmbedEvent => ({
    type: 'openSettled',
    launchId,
    outcome: { failed },
  }),
  closeFailed: (launchId: LaunchId): EmbedEvent => ({ type: 'closeFailed', launchId }),
  released: (
    launchId: LaunchId,
    reason: Extract<EmbedEvent, { type: 'released' }>['reason'] = 'replaced',
    location: { routePath?: string } | null = null
  ): EmbedEvent => ({ type: 'released', launchId, reason, location }),
  title: (launchId: LaunchId, title = 'Title'): EmbedEvent => ({
    type: 'titleChanged',
    launchId,
    title,
  }),
}

type Run = { state: EmbedOwnershipState; effects: EmbedEffect[] }

function run(events: EmbedEvent[], from: EmbedOwnershipState = createEmbedOwnershipState()): Run {
  let state = from
  const effects: EmbedEffect[] = []
  for (const event of events) {
    const next = reduceEmbedOwnership(state, event)
    state = next.state
    effects.push(...next.effects)
  }
  return { state, effects }
}

const stateOf = (events: EmbedEvent[]) => run(events).state

const A = 'launch-a'
const B = 'launch-b'
const C = 'launch-c'
const LA = launch(A, T1)
const LB = launch(B, T1)

// ---- fixtures, all driven through the reducer --------------------------------

/** A is the owner of T1, measuring. */
const measuringSeq = [ev.projected(T1), ev.intent(LA)]
/** A is the owner of T1, opening. */
const openingSeq = [...measuringSeq, ev.measured(A)]
/** A is the owner of T1, mounted. */
const mountedSeq = [...openingSeq, ev.mounted(A)]
/** A (T1) closeRequested after mount; no owner. */
const closeRequestedSeq = [...mountedSeq, ev.backToApps()]
/** B is the owner of T1, waiting for A (closeRequested). */
const waitingSeq = [...mountedSeq, ev.relaunch(LB)]
/** A is the owner of T1; main released its view and has yet to reject its open. */
const releasedOpeningSeq = [...openingSeq, ev.released(A, 'open_failed', { routePath: '/r' })]

const phaseOf = (s: EmbedOwnershipState, id: LaunchId): ViewPhase | undefined =>
  s.views.get(id)?.phase

function expectNoop(s: EmbedOwnershipState, event: EmbedEvent) {
  const out = reduceEmbedOwnership(s, event)
  expect(out.state).toBe(s)
  expect(out.effects).toEqual([])
}

describe('fixtures reach the phase they claim', () => {
  it('each sequence lands in its phase', () => {
    expect(phaseOf(stateOf(measuringSeq), A)).toBe('measuring')
    expect(phaseOf(stateOf(openingSeq), A)).toBe('opening')
    expect(phaseOf(stateOf(mountedSeq), A)).toBe('mounted')
    const cr = stateOf(closeRequestedSeq)
    expect(phaseOf(cr, A)).toBe('closeRequested')
    expect(cr.owner).toBeNull()
    const w = stateOf(waitingSeq)
    expect(phaseOf(w, B)).toBe('waiting')
    expect(w.owner).toBe(B)
    const ro = stateOf(releasedOpeningSeq)
    expect(phaseOf(ro, A)).toBe('releasedOpening')
    expect(ro.owner).toBe(A)
  })
})

// ---- one test per row --------------------------------------------------------

describe('decision table rows', () => {
  it('P1: projected of the current tab is a no-op by reference', () => {
    expectNoop(stateOf(mountedSeq), ev.projected(T1))
    expectNoop(createEmbedOwnershipState(), ev.projected(null))
  })

  it('P2: projected of another tab drops the owner and closes its view', () => {
    const s = stateOf(mountedSeq)
    const out = reduceEmbedOwnership(s, ev.projected(T2))
    expect(out.state.activeAppTabId).toBe(T2)
    expect(out.state.owner).toBeNull()
    expect(phaseOf(out.state, A)).toBe('closeRequested')
    expect(out.effects).toEqual([{ type: 'close', launchId: A }])
  })

  it('P2: projected to no app tab', () => {
    const out = reduceEmbedOwnership(stateOf(mountedSeq), ev.projected(null))
    expect(out.state.activeAppTabId).toBeNull()
    expect(out.state.owner).toBeNull()
    expect(out.effects).toEqual([{ type: 'close', launchId: A }])
  })

  it('I1a: intent on the active tab with no live record takes ownership and measures', () => {
    const s = stateOf([ev.projected(T1)])
    const out = reduceEmbedOwnership(s, ev.intent(LA))
    expect(out.state.owner).toBe(A)
    expect(out.state.views.get(A)).toEqual({ ...LA, phase: 'measuring' })
    expect(out.effects).toEqual([{ type: 'measure', launchId: A }])
  })

  it('I1a: a closing record of the tab does not block; the owner waits for it', () => {
    const s = stateOf(closeRequestedSeq)
    const out = reduceEmbedOwnership(s, ev.intent(LB))
    expect(out.state.owner).toBe(B)
    expect(phaseOf(out.state, B)).toBe('waiting')
    expect(out.effects).toEqual([])
  })

  it('I1b: intent with a live record of the tab is abandoned and changes nothing', () => {
    for (const seq of [measuringSeq, openingSeq, mountedSeq, waitingSeq]) {
      const s = stateOf(seq)
      const L = launch(C, T1)
      const out = reduceEmbedOwnership(s, ev.intent(L))
      expect(out.state).toBe(s)
      expect(out.effects).toEqual([{ type: 'launchSettled', launchId: C, outcome: 'abandoned' }])
    }
  })

  it('I1c: intent for a tab that is not the active one is abandoned', () => {
    for (const seq of [[], [ev.projected(T2)], mountedSeq]) {
      const s = stateOf(seq)
      const out = reduceEmbedOwnership(s, ev.intent(launch(C, T1 === s.activeAppTabId ? T2 : T1)))
      expect(out.state).toBe(s)
      expect(out.effects).toEqual([{ type: 'launchSettled', launchId: C, outcome: 'abandoned' }])
    }
  })

  it('I2a: relaunch with a mounted owner closes it and waits for its location', () => {
    const s = stateOf(mountedSeq)
    const out = reduceEmbedOwnership(s, ev.relaunch(LB))
    expect(out.state.owner).toBe(B)
    expect(phaseOf(out.state, B)).toBe('waiting')
    expect(phaseOf(out.state, A)).toBe('closeRequested')
    expect(out.effects).toEqual([{ type: 'close', launchId: A }])

    // The predecessor's final location becomes the route of the new launch.
    const released = reduceEmbedOwnership(
      out.state,
      ev.released(A, 'replaced', { routePath: '/live' })
    )
    expect(released.effects).toEqual([
      { type: 'persistRoute', tabId: T1, route: { action: 'set', routePath: '/live' } },
      { type: 'measure', launchId: B },
    ])
    const opened = reduceEmbedOwnership(released.state, ev.measured(B))
    expect(opened.effects).toEqual([
      { type: 'sendOpen', launch: LB, bounds: BOUNDS, routePath: '/live' },
    ])
  })

  it('I2a: relaunch with an opening owner closes it and abandons it', () => {
    const out = reduceEmbedOwnership(stateOf(openingSeq), ev.relaunch(LB))
    expect(out.state.owner).toBe(B)
    expect(phaseOf(out.state, B)).toBe('waiting')
    expect(phaseOf(out.state, A)).toBe('closeRequested')
    expect(out.effects).toEqual([
      { type: 'close', launchId: A },
      { type: 'launchSettled', launchId: A, outcome: 'abandoned' },
    ])
  })

  it('I2a: relaunch with a measuring owner drops it without IPC and measures at once', () => {
    const out = reduceEmbedOwnership(stateOf(measuringSeq), ev.relaunch(LB))
    expect(out.state.owner).toBe(B)
    expect(out.state.views.has(A)).toBe(false)
    expect(phaseOf(out.state, B)).toBe('measuring')
    expect(out.effects).toEqual([
      { type: 'measure', launchId: B },
      { type: 'launchSettled', launchId: A, outcome: 'abandoned' },
    ])
  })

  it('I2a: relaunch with a waiting owner replaces it and keeps waiting', () => {
    const out = reduceEmbedOwnership(stateOf(waitingSeq), ev.relaunch(launch(C, T1)))
    expect(out.state.owner).toBe(C)
    expect(out.state.views.has(B)).toBe(false)
    expect(phaseOf(out.state, C)).toBe('waiting')
    expect(out.effects).toEqual([{ type: 'launchSettled', launchId: B, outcome: 'abandoned' }])
  })

  it('I2a: relaunch without owner behaves like a fresh launch', () => {
    const s = stateOf([ev.projected(T1)])
    const out = reduceEmbedOwnership(s, ev.relaunch(LA))
    expect(out.state.owner).toBe(A)
    expect(phaseOf(out.state, A)).toBe('measuring')
    expect(out.effects).toEqual([{ type: 'measure', launchId: A }])
  })

  it('I2b: relaunch for a tab that is not active is abandoned', () => {
    const s = stateOf(mountedSeq)
    const out = reduceEmbedOwnership(s, ev.relaunch(launch(C, T2)))
    expect(out.state).toBe(s)
    expect(out.effects).toEqual([{ type: 'launchSettled', launchId: C, outcome: 'abandoned' }])
  })

  it('B1: backToApps with an owner releases ownership and closes the view', () => {
    const out = reduceEmbedOwnership(stateOf(mountedSeq), ev.backToApps())
    expect(out.state.owner).toBeNull()
    expect(out.state.activeAppTabId).toBe(T1)
    expect(phaseOf(out.state, A)).toBe('closeRequested')
    expect(out.effects).toEqual([{ type: 'close', launchId: A }])
  })

  it('H1: handoff waits for every view main still holds', () => {
    const out = reduceEmbedOwnership(stateOf(mountedSeq), ev.handoff(7))
    expect(out.state.owner).toBeNull()
    expect(out.state.handoffs).toEqual([{ requestId: 7, waitFor: new Set([A]), ownerLaunchId: A }])
    expect(out.effects).toEqual([{ type: 'close', launchId: A }])
    const done = reduceEmbedOwnership(out.state, ev.released(A))
    expect(done.state.handoffs).toEqual([])
    expect(done.effects).toEqual([{ type: 'handoffReady', requestId: 7 }])
  })

  it('H1: handoff with nothing in main is ready at once', () => {
    const s = stateOf([ev.projected(T1)])
    const out = reduceEmbedOwnership(s, ev.handoff(3))
    expect(out.state).toBe(s)
    expect(out.effects).toEqual([{ type: 'handoffReady', requestId: 3 }])
  })

  it('H1: waitFor only holds views that reached main (pre-IPC owner is dropped first)', () => {
    // A (T1) closeRequested, then B owns T2 and is measuring.
    const s = stateOf([...closeRequestedSeq, ev.projected(T2), ev.intent(launch(B, T2))])
    expect(phaseOf(s, B)).toBe('measuring')
    const out = reduceEmbedOwnership(s, ev.handoff(9))
    expect(out.state.views.has(B)).toBe(false)
    expect(out.state.handoffs).toEqual([{ requestId: 9, waitFor: new Set([A]), ownerLaunchId: B }])
    expect(out.effects).toEqual([{ type: 'launchSettled', launchId: B, outcome: 'abandoned' }])
  })

  it('M1: measured slot opens the owner at the launch route', () => {
    const L = launch(A, T1, { kind: 'tab', routePath: '/saved' })
    const out = run([ev.projected(T1), ev.intent(L), ev.measured(A)])
    expect(phaseOf(out.state, A)).toBe('opening')
    expect(out.effects.at(-1)).toEqual({
      type: 'sendOpen',
      launch: L,
      bounds: BOUNDS,
      routePath: '/saved',
    })
  })

  it('M1: a tab launch prefers the route the reducer last persisted for the tab', () => {
    const s = stateOf([
      ...mountedSeq,
      ev.backToApps(),
      ev.released(A, 'closed', { routePath: '/fresh' }),
    ])
    const L = launch(B, T1, { kind: 'tab', routePath: '/stale' })
    const out = run([ev.intent(L), ev.measured(B)], s)
    expect(out.effects.at(-1)).toEqual({
      type: 'sendOpen',
      launch: L,
      bounds: BOUNDS,
      routePath: '/fresh',
    })
  })

  it('M1: a persisted default route wins over the launch route (no fallback)', () => {
    const s = stateOf([...mountedSeq, ev.backToApps(), ev.released(A, 'closed', {})])
    const L = launch(B, T1, { kind: 'tab', routePath: '/stale' })
    const out = run([ev.intent(L), ev.measured(B)], s)
    const open = out.effects.at(-1)
    expect(open).toEqual({ type: 'sendOpen', launch: L, bounds: BOUNDS })
    expect(open && 'routePath' in open).toBe(false)
  })

  it('M1: an explicit launch ignores the persisted route', () => {
    const s = stateOf([
      ...mountedSeq,
      ev.backToApps(),
      ev.released(A, 'closed', { routePath: '/fresh' }),
    ])
    const L = launch(B, T1, { kind: 'explicit', routePath: '/deep' })
    const out = run([ev.intent(L), ev.measured(B)], s)
    expect(out.effects.at(-1)).toEqual({
      type: 'sendOpen',
      launch: L,
      bounds: BOUNDS,
      routePath: '/deep',
    })
    const L2 = launch(C, T1, { kind: 'explicit' })
    const out2 = run([ev.intent(L2), ev.measured(C)], s)
    expect(out2.effects.at(-1)).toEqual({ type: 'sendOpen', launch: L2, bounds: BOUNDS })
  })

  it('M2: no slot fails the owner before any IPC', () => {
    const out = reduceEmbedOwnership(stateOf(measuringSeq), ev.measured(A, null))
    expect(out.state.owner).toBeNull()
    expect(out.state.views.size).toBe(0)
    expect(out.state.failure).toEqual({ tabId: T1, launchId: A, kind: 'slot' })
    expect(out.effects).toEqual([{ type: 'launchSettled', launchId: A, outcome: 'failed' }])
  })

  it('M3: a measurement for an unknown or non-measuring launch is ignored', () => {
    expectNoop(stateOf(measuringSeq), ev.measured(C))
    expectNoop(stateOf(openingSeq), ev.measured(A))
    expectNoop(stateOf(openingSeq), ev.measured(A, null))
    expectNoop(stateOf(waitingSeq), ev.measured(B))
  })

  it('O1: main confirms an opening owner', () => {
    const out = reduceEmbedOwnership(stateOf(openingSeq), ev.mounted(A))
    expect(phaseOf(out.state, A)).toBe('mounted')
    expect(out.state.owner).toBe(A)
    expect(out.effects).toEqual([{ type: 'launchSettled', launchId: A, outcome: 'mounted' }])
  })

  it('O2: an open that resolves after the user left waits for released', () => {
    const s = stateOf([...openingSeq, ev.backToApps()])
    expect(phaseOf(s, A)).toBe('closeRequested')
    expectNoop(s, ev.mounted(A))
  })

  it('O3: a failed open of the owner records the failure', () => {
    const out = reduceEmbedOwnership(stateOf(openingSeq), ev.openFailed(A, 'nope'))
    expect(out.state.owner).toBeNull()
    expect(out.state.views.size).toBe(0)
    expect(out.state.failure).toEqual({ tabId: T1, launchId: A, kind: 'open', message: 'nope' })
    expect(out.effects).toEqual([{ type: 'launchSettled', launchId: A, outcome: 'failed' }])
  })

  it('O3: a failed open of a closing launch only drops the record', () => {
    const s = stateOf([...openingSeq, ev.backToApps()])
    const out = reduceEmbedOwnership(s, ev.openFailed(A))
    expect(out.state.views.size).toBe(0)
    expect(out.state.failure).toBeNull()
    expect(out.effects).toEqual([])
  })

  it('O3: a failed open of a closing launch unblocks the waiting owner', () => {
    const s = stateOf([...openingSeq, ev.relaunch(LB)])
    const out = reduceEmbedOwnership(s, ev.openFailed(A))
    expect(phaseOf(out.state, B)).toBe('measuring')
    expect(out.effects).toEqual([{ type: 'measure', launchId: B }])
  })

  it('O4: openSettled for an unknown launch is ignored', () => {
    expectNoop(stateOf(mountedSeq), ev.mounted(C))
    expectNoop(stateOf(mountedSeq), ev.openFailed(C))
  })

  it('R1a: the mounted owner crashing leaves a crash failure and no persisted route', () => {
    const out = reduceEmbedOwnership(stateOf(mountedSeq), ev.released(A, 'crashed', null))
    expect(out.state.owner).toBeNull()
    expect(out.state.views.size).toBe(0)
    expect(out.state.failure).toEqual({ tabId: T1, launchId: A, kind: 'crashed' })
    expect(out.state.lastRoute.size).toBe(0)
    expect(out.effects).toEqual([])
  })

  it('R1b: a closing view releasing persists its location', () => {
    const s = stateOf(closeRequestedSeq)
    const out = reduceEmbedOwnership(s, ev.released(A, 'closed', { routePath: '/x' }))
    expect(out.state.views.size).toBe(0)
    expect(out.state.lastRoute.get(T1)).toEqual({ routePath: '/x' })
    expect(out.effects).toEqual([
      { type: 'persistRoute', tabId: T1, route: { action: 'set', routePath: '/x' } },
    ])
  })

  it('R1b: an empty location clears the route', () => {
    const out = reduceEmbedOwnership(stateOf(closeRequestedSeq), ev.released(A, 'closed', {}))
    expect(out.state.lastRoute.get(T1)).toEqual({})
    expect(out.effects).toEqual([{ type: 'persistRoute', tabId: T1, route: { action: 'clear' } }])
  })

  it('R1b: a null location preserves the last route and persists nothing', () => {
    const s = stateOf([...closeRequestedSeq, ev.released(A, 'closed', { routePath: '/kept' })])
    const next = run([ev.intent(LB), ev.measured(B), ev.mounted(B), ev.backToApps()], s).state
    const out = reduceEmbedOwnership(next, ev.released(B, 'closed', null))
    expect(out.state.lastRoute).toBe(next.lastRoute)
    expect(out.state.lastRoute.get(T1)).toEqual({ routePath: '/kept' })
    expect(out.effects).toEqual([])
  })

  it('R1b: the mounted owner released for a non-crash reason drops ownership without failure', () => {
    for (const reason of ['session', 'parent_closed', 'renderer_replaced', 'closed'] as const) {
      const out = reduceEmbedOwnership(
        stateOf(mountedSeq),
        ev.released(A, reason, { routePath: '/r' })
      )
      expect(out.state.owner).toBeNull()
      expect(out.state.failure).toBeNull()
      expect(out.effects).toEqual([
        { type: 'persistRoute', tabId: T1, route: { action: 'set', routePath: '/r' } },
      ])
    }
  })

  it('R1b: the opening owner released for a non-crash reason settles as abandoned', () => {
    const out = reduceEmbedOwnership(stateOf(openingSeq), ev.released(A, 'session', null))
    expect(out.state.owner).toBeNull()
    expect(out.state.views.size).toBe(0)
    expect(out.state.failure).toBeNull()
    expect(out.effects).toEqual([{ type: 'launchSettled', launchId: A, outcome: 'abandoned' }])
    // The late rejection of that open is then a duplicate.
    expectNoop(out.state, ev.openFailed(A))
  })

  it('R1c: the opening owner released because its open failed keeps the launch for its rejection', () => {
    const out = reduceEmbedOwnership(
      stateOf(openingSeq),
      ev.released(A, 'open_failed', { routePath: '/r' })
    )
    expect(out.state.owner).toBe(A)
    expect(phaseOf(out.state, A)).toBe('releasedOpening')
    expect(out.state.failure).toBeNull()
    expect(out.state.lastRoute.get(T1)).toEqual({ routePath: '/r' })
    expect(out.effects).toEqual([
      { type: 'persistRoute', tabId: T1, route: { action: 'set', routePath: '/r' } },
    ])
  })

  it('R1c: the rejection that follows fails the launch with its message', () => {
    const out = reduceEmbedOwnership(stateOf(releasedOpeningSeq), ev.openFailed(A, 'attach failed'))
    expect(out.state.owner).toBeNull()
    expect(out.state.views.size).toBe(0)
    expect(out.state.failure).toEqual({
      tabId: T1,
      launchId: A,
      kind: 'open',
      message: 'attach failed',
    })
    expect(out.effects).toEqual([{ type: 'launchSettled', launchId: A, outcome: 'failed' }])
  })

  it('R1c: a rejection that arrives before the release fails the launch; the release is late', () => {
    const s = stateOf([...openingSeq, ev.openFailed(A, 'attach failed')])
    expect(s.failure).toMatchObject({ launchId: A, message: 'attach failed' })
    expectNoop(s, ev.released(A, 'open_failed', { routePath: '/r' }))
  })

  it('R1c: a second release of the released view changes nothing', () => {
    const s = stateOf(releasedOpeningSeq)
    expectNoop(s, ev.released(A, 'open_failed', { routePath: '/r' }))
    expectNoop(s, ev.released(A, 'crashed', null))
  })

  it('R1c: a relaunch before the rejection closes nothing and waits for it', () => {
    const s = stateOf([...releasedOpeningSeq, ev.relaunch(LB)])
    expect(s.owner).toBe(B)
    expect(phaseOf(s, A)).toBe('releasedOpening')
    expect(phaseOf(s, B)).toBe('waiting')
    const out = reduceEmbedOwnership(s, ev.openFailed(A))
    expect(out.state.failure).toBeNull()
    expect(phaseOf(out.state, B)).toBe('measuring')
    expect(out.effects).toEqual([
      { type: 'measure', launchId: B },
      { type: 'launchSettled', launchId: A, outcome: 'abandoned' },
    ])
    expect(
      run([...releasedOpeningSeq, ev.relaunch(LB), ev.openFailed(A)]).effects
    ).not.toContainEqual(expect.objectContaining({ type: 'close' }))
  })

  it('R1c: leaving the tab before the rejection closes nothing and abandons the launch', () => {
    const s = stateOf([...releasedOpeningSeq, ev.projected(T2)])
    expect(s.owner).toBeNull()
    expect(phaseOf(s, A)).toBe('releasedOpening')
    const out = reduceEmbedOwnership(s, ev.openFailed(A))
    expect(out.state.views.size).toBe(0)
    expect(out.state.failure).toBeNull()
    expect(out.effects).toEqual([{ type: 'launchSettled', launchId: A, outcome: 'abandoned' }])
    expect(run([...releasedOpeningSeq, ev.projected(T2)]).effects).not.toContainEqual(
      expect.objectContaining({ type: 'close' })
    )
  })

  it('R1c: a handoff before the rejection waits for it', () => {
    const s = stateOf([...releasedOpeningSeq, ev.handoff(7)])
    expect([...s.handoffs[0]!.waitFor]).toEqual([A])
    const out = reduceEmbedOwnership(s, ev.openFailed(A))
    expect(out.state.handoffs).toEqual([])
    expect(out.effects).toContainEqual({ type: 'handoffReady', requestId: 7 })
  })

  it('R1c: a re-click before the rejection changes nothing', () => {
    const s = stateOf(releasedOpeningSeq)
    const out = reduceEmbedOwnership(s, ev.intent(launch(C, T1)))
    expect(out.state).toBe(s)
    expect(out.effects).toEqual([{ type: 'launchSettled', launchId: C, outcome: 'abandoned' }])
  })

  it('R1c: coming back to the tab before the rejection launches again once it lands', () => {
    const s = stateOf([...releasedOpeningSeq, ev.projected(T2), ev.projected(T1), ev.intent(LB)])
    expect(s.owner).toBe(B)
    expect(phaseOf(s, B)).toBe('waiting')
    const out = reduceEmbedOwnership(s, ev.openFailed(A))
    expect(out.state.owner).toBe(B)
    expect(phaseOf(out.state, B)).toBe('measuring')
    expect(out.effects).toEqual([
      { type: 'measure', launchId: B },
      { type: 'launchSettled', launchId: A, outcome: 'abandoned' },
    ])
  })

  it('R1c: a mount confirmation for the released view drops it as abandoned', () => {
    const out = reduceEmbedOwnership(stateOf(releasedOpeningSeq), ev.mounted(A))
    expect(out.state.owner).toBeNull()
    expect(out.state.views.size).toBe(0)
    expect(out.effects).toEqual([{ type: 'launchSettled', launchId: A, outcome: 'abandoned' }])
  })

  it('R1c: a closing view released because its open failed is just gone', () => {
    const s = stateOf([...openingSeq, ev.backToApps()])
    const out = reduceEmbedOwnership(s, ev.released(A, 'open_failed', { routePath: '/r' }))
    expect(out.state.views.size).toBe(0)
    expect(out.state.failure).toBeNull()
    expect(out.effects).toEqual([
      { type: 'persistRoute', tabId: T1, route: { action: 'set', routePath: '/r' } },
    ])
  })

  it('R1b: a crash of a closing view is not a crash failure', () => {
    const out = reduceEmbedOwnership(stateOf(closeRequestedSeq), ev.released(A, 'crashed', null))
    expect(out.state.failure).toBeNull()
    expect(out.state.views.size).toBe(0)
  })

  it('R1a: a crash of the owner while it opens is a crash failure and a failed launch', () => {
    const out = reduceEmbedOwnership(stateOf(openingSeq), ev.released(A, 'crashed', null))
    expect(out.state.owner).toBeNull()
    expect(out.state.views.size).toBe(0)
    expect(out.state.failure).toEqual({ tabId: T1, launchId: A, kind: 'crashed' })
    expect(out.state.lastRoute.size).toBe(0)
    expect(out.effects).toEqual([{ type: 'launchSettled', launchId: A, outcome: 'failed' }])
    // The late rejection of that open is then a duplicate.
    expectNoop(out.state, ev.openFailed(A))
  })

  it('R2: released for an unknown launch is ignored', () => {
    expectNoop(stateOf(mountedSeq), ev.released(C, 'replaced', { routePath: '/x' }))
    expectNoop(stateOf(mountedSeq), ev.released(C, 'crashed', null))
  })

  it('X1: a failed CAS close retains the closing record', () => {
    const s = stateOf([...mountedSeq, ev.relaunch(LB)])
    const out = reduceEmbedOwnership(s, ev.closeFailed(A))
    expect(phaseOf(out.state, A)).toBe('closeFailed')
    expect(phaseOf(out.state, B)).toBe('waiting')
    expect(out.state.owner).toBe(B)
    expect(out.effects).toEqual([])
  })

  it('T1: a title from the owner updates its tab', () => {
    const s = stateOf(mountedSeq)
    const out = reduceEmbedOwnership(s, ev.title(A, 'Hello'))
    expect(out.state).toBe(s)
    expect(out.effects).toEqual([{ type: 'setTitle', tabId: T1, title: 'Hello' }])
  })

  it('T2: a title from anything but the owner is ignored', () => {
    expectNoop(stateOf(closeRequestedSeq), ev.title(A))
    expectNoop(stateOf(mountedSeq), ev.title(C))
  })
})

// ---- totality ------------------------------------------------------------------

describe('totality: every unlisted (event, condition) pair is a no-op by reference', () => {
  type Fixture = { name: string; seq: EmbedEvent[]; target: LaunchId }
  const fixtures: Fixture[] = [
    { name: 'absent', seq: mountedSeq, target: C },
    { name: 'absent, empty state', seq: [], target: C },
    { name: 'waiting owner', seq: waitingSeq, target: B },
    { name: 'measuring owner', seq: measuringSeq, target: A },
    { name: 'opening owner', seq: openingSeq, target: A },
    { name: 'mounted owner', seq: mountedSeq, target: A },
    { name: 'closeRequested', seq: closeRequestedSeq, target: A },
    { name: 'closeRequested behind waiting owner', seq: waitingSeq, target: A },
    { name: 'releasedOpening owner', seq: releasedOpeningSeq, target: A },
  ]

  const targetedEvents: Array<{ key: string; make: (id: LaunchId) => EmbedEvent }> = [
    { key: 'slotMeasured(bounds)', make: id => ev.measured(id) },
    { key: 'slotMeasured(null)', make: id => ev.measured(id, null) },
    { key: 'openSettled(mounted)', make: id => ev.mounted(id) },
    { key: 'openSettled(failed)', make: id => ev.openFailed(id) },
    { key: 'closeFailed', make: id => ev.closeFailed(id) },
    { key: 'released(replaced,loc)', make: id => ev.released(id, 'replaced', { routePath: '/q' }) },
    { key: 'released(crashed,null)', make: id => ev.released(id, 'crashed', null) },
    {
      key: 'released(open_failed,loc)',
      make: id => ev.released(id, 'open_failed', { routePath: '/q' }),
    },
    { key: 'titleChanged', make: id => ev.title(id) },
  ]

  // The rows that are NOT no-ops for each (phase, event). Anything not listed must
  // leave the state object untouched and emit nothing.
  const effectful: Record<string, string[]> = {
    absent: [],
    'absent, empty state': [],
    'waiting owner': [
      'openSettled(failed)',
      'released(replaced,loc)',
      'released(crashed,null)',
      'released(open_failed,loc)',
      'titleChanged',
    ],
    'measuring owner': [
      'slotMeasured(bounds)',
      'slotMeasured(null)',
      'openSettled(failed)',
      'released(replaced,loc)',
      'released(crashed,null)',
      'released(open_failed,loc)',
      'titleChanged',
    ],
    'opening owner': [
      'openSettled(mounted)',
      'openSettled(failed)',
      'released(replaced,loc)',
      'released(crashed,null)',
      'released(open_failed,loc)',
      'titleChanged',
    ],
    'mounted owner': [
      'openSettled(failed)',
      'released(replaced,loc)',
      'released(crashed,null)',
      'released(open_failed,loc)',
      'titleChanged',
    ],
    closeRequested: [
      'openSettled(failed)',
      'closeFailed',
      'released(replaced,loc)',
      'released(crashed,null)',
      'released(open_failed,loc)',
    ],
    'closeRequested behind waiting owner': [
      'openSettled(failed)',
      'closeFailed',
      'released(replaced,loc)',
      'released(crashed,null)',
      'released(open_failed,loc)',
    ],
    'releasedOpening owner': ['openSettled(mounted)', 'openSettled(failed)', 'titleChanged'],
  }

  for (const fx of fixtures) {
    for (const te of targetedEvents) {
      const expectEffect = effectful[fx.name]!.includes(te.key)
      it(`${fx.name} × ${te.key} → ${expectEffect ? 'transition' : 'no-op'}`, () => {
        const s = stateOf(fx.seq)
        const out = reduceEmbedOwnership(s, te.make(fx.target))
        if (expectEffect) {
          expect(out.state !== s || out.effects.length > 0).toBe(true)
        } else {
          expect(out.state).toBe(s)
          expect(out.effects).toEqual([])
        }
      })
    }
  }

  it('backToApps without owner is a no-op in every ownerless state', () => {
    for (const seq of [
      [],
      [ev.projected(T1)],
      closeRequestedSeq,
      [...measuringSeq, ev.measured(A, null)],
    ]) {
      expectNoop(stateOf(seq), ev.backToApps())
    }
  })

  it('repeating a reality event a second time is a no-op', () => {
    const reality: Array<[EmbedEvent[], EmbedEvent]> = [
      [openingSeq, ev.mounted(A)],
      [openingSeq, ev.openFailed(A)],
      [closeRequestedSeq, ev.released(A, 'closed', { routePath: '/x' })],
      [mountedSeq, ev.released(A, 'crashed', null)],
      [openingSeq, ev.released(A, 'open_failed', { routePath: '/r' })],
      [releasedOpeningSeq, ev.openFailed(A)],
      [closeRequestedSeq, ev.closeFailed(A)],
      [measuringSeq, ev.measured(A)],
      [measuringSeq, ev.measured(A, null)],
      [mountedSeq, ev.projected(T2)],
    ]
    for (const [seq, event] of reality) {
      const once = run([...seq, event]).state
      expectNoop(once, event)
    }
  })
})

// ---- level rules ---------------------------------------------------------------

describe('level rules', () => {
  it('R-sweep: a pre-IPC record that loses ownership is dropped without close', () => {
    const out = reduceEmbedOwnership(stateOf(measuringSeq), ev.projected(T2))
    expect(out.state.views.size).toBe(0)
    expect(out.effects).toEqual([{ type: 'launchSettled', launchId: A, outcome: 'abandoned' }])
    const waiting = reduceEmbedOwnership(stateOf(waitingSeq), ev.projected(T2))
    expect(waiting.state.views.has(B)).toBe(false)
    expect(phaseOf(waiting.state, A)).toBe('closeRequested')
    expect(waiting.effects).toEqual([{ type: 'launchSettled', launchId: B, outcome: 'abandoned' }])
  })

  it('R-sweep: a record that reached main and loses ownership is CAS-closed once', () => {
    const out = reduceEmbedOwnership(stateOf(openingSeq), ev.projected(T2))
    expect(phaseOf(out.state, A)).toBe('closeRequested')
    expect(out.effects).toEqual([
      { type: 'close', launchId: A },
      { type: 'launchSettled', launchId: A, outcome: 'abandoned' },
    ])
    // Already closing: no second close on later transitions.
    const again = reduceEmbedOwnership(out.state, ev.projected(T1))
    expect(again.effects).toEqual([])
  })

  it('R-advance: the owner waits only for records of its own tab', () => {
    // A (T1) is closing; B owns T2 and must not wait for A.
    const s = stateOf(closeRequestedSeq)
    const out = run([ev.projected(T2), ev.intent(launch(B, T2))], s)
    expect(phaseOf(out.state, B)).toBe('measuring')
    expect(out.effects).toEqual([{ type: 'measure', launchId: B }])
  })

  it('R-advance: the waiting owner advances once its predecessor is gone', () => {
    const s = stateOf(waitingSeq)
    expect(phaseOf(s, B)).toBe('waiting')
    const out = reduceEmbedOwnership(s, ev.released(A, 'replaced', null))
    expect(phaseOf(out.state, B)).toBe('measuring')
    expect(out.effects).toEqual([{ type: 'measure', launchId: B }])
  })

  it('R-handoff: a handoff stays until every view it waits for is gone', () => {
    // Two closing views (T1 and T2), then a handoff.
    const s = stateOf([
      ...mountedSeq,
      ev.projected(T2),
      ev.intent(launch(B, T2)),
      ev.measured(B),
      ev.mounted(B),
      ev.handoff(1),
    ])
    expect(s.handoffs).toEqual([{ requestId: 1, waitFor: new Set([A, B]), ownerLaunchId: B }])
    const first = reduceEmbedOwnership(s, ev.released(A))
    expect(first.state.handoffs).toEqual([
      { requestId: 1, waitFor: new Set([A, B]), ownerLaunchId: B },
    ])
    expect(first.effects).toEqual([])
    const second = reduceEmbedOwnership(first.state, ev.closeFailed(B))
    expect(second.state.handoffs).toEqual([])
    expect(second.state.views.has(B)).toBe(true)
    expect(second.state.owner).toBe(B)
    expect(second.effects).toEqual([{ type: 'handoffFailed', requestId: 1 }])
  })

  it('R-handoff: a later launch does not hold an earlier handoff', () => {
    const s = stateOf([...mountedSeq, ev.handoff(1)])
    // A new owner appears while the handoff waits for A.
    const s2 = run([ev.intent(LB)], s).state
    expect(s2.owner).toBe(B)
    const out = reduceEmbedOwnership(s2, ev.released(A))
    expect(out.state.handoffs).toEqual([])
    expect(out.effects).toEqual([
      { type: 'measure', launchId: B },
      { type: 'handoffReady', requestId: 1 },
    ])
  })

  it('R-settle: an owner that leaves pending without its own outcome is abandoned', () => {
    const out = reduceEmbedOwnership(stateOf(openingSeq), ev.backToApps())
    expect(out.effects).toEqual([
      { type: 'close', launchId: A },
      { type: 'launchSettled', launchId: A, outcome: 'abandoned' },
    ])
  })

  it('R-settle: an explicit outcome is not followed by abandoned', () => {
    const failed = reduceEmbedOwnership(stateOf(measuringSeq), ev.measured(A, null))
    expect(failed.effects).toEqual([{ type: 'launchSettled', launchId: A, outcome: 'failed' }])
    const mounted = reduceEmbedOwnership(stateOf(openingSeq), ev.mounted(A))
    expect(mounted.effects).toEqual([{ type: 'launchSettled', launchId: A, outcome: 'mounted' }])
  })
})

// ---- failure clearing ------------------------------------------------------------

describe('failure lifecycle', () => {
  const slotFailedSeq = [...measuringSeq, ev.measured(A, null)]
  const openFailedSeq = [...openingSeq, ev.openFailed(A)]
  const crashedSeq = [...mountedSeq, ev.released(A, 'crashed', null)]

  for (const [name, seq] of [
    ['slot', slotFailedSeq],
    ['open', openFailedSeq],
    ['crashed', crashedSeq],
  ] as const) {
    it(`${name} failure is cleared when the active tab changes`, () => {
      const s = stateOf(seq)
      expect(s.failure?.kind).toBe(name)
      expect(reduceEmbedOwnership(s, ev.projected(T2)).state.failure).toBeNull()
      expect(reduceEmbedOwnership(s, ev.projected(null)).state.failure).toBeNull()
    })

    it(`${name} failure is cleared by a new intent on the tab`, () => {
      const out = reduceEmbedOwnership(stateOf(seq), ev.intent(launch(C, T1)))
      expect(out.state.owner).toBe(C)
      expect(out.state.failure).toBeNull()
    })

    it(`${name} failure is cleared by a relaunch on the tab`, () => {
      const out = reduceEmbedOwnership(stateOf(seq), ev.relaunch(launch(C, T1)))
      expect(out.state.owner).toBe(C)
      expect(out.state.failure).toBeNull()
    })

    it(`${name} failure survives transitions that change neither tab nor owner`, () => {
      const s = stateOf(seq)
      expect(reduceEmbedOwnership(s, ev.handoff(5)).state.failure).toEqual(s.failure)
      expectNoop(s, ev.backToApps())
      expect(reduceEmbedOwnership(s, ev.intent(launch(C, T2))).state).toBe(s)
      expect(reduceEmbedOwnership(s, ev.relaunch(launch(C, T2))).state).toBe(s)
    })
  }

  it('failure survives a closing view of another tab releasing', () => {
    const cross = stateOf([
      ev.projected(T2),
      ev.intent(launch(C, T2)),
      ev.measured(C),
      ev.mounted(C),
      ev.projected(T1),
      ev.intent(LA),
      ev.measured(A, null),
    ])
    expect(cross.failure?.kind).toBe('slot')
    expect(phaseOf(cross, C)).toBe('closeRequested')
    const out = reduceEmbedOwnership(cross, ev.released(C, 'closed', { routePath: '/c' }))
    expect(out.state.failure).toEqual(cross.failure)
  })

  it('handoff with an owner clears the failure only when it drops an owner', () => {
    const s = stateOf(mountedSeq)
    expect(reduceEmbedOwnership(s, ev.handoff(1)).state.failure).toBeNull()
  })

  it('backToApps with owner keeps failure cleared', () => {
    expect(reduceEmbedOwnership(stateOf(mountedSeq), ev.backToApps()).state.failure).toBeNull()
  })
})

// ---- effect order --------------------------------------------------------------

describe('effect ordering', () => {
  it('own effects first, then sweep, advance, handoff, settle', () => {
    // released of the predecessor (own: persistRoute) unblocks the waiting owner
    // (advance: measure) and the handoff that waited for it (handoffReady).
    const s = stateOf([...mountedSeq, ev.handoff(4), ev.intent(LB)])
    const out = reduceEmbedOwnership(s, ev.released(A, 'replaced', { routePath: '/p' }))
    expect(out.effects).toEqual([
      { type: 'persistRoute', tabId: T1, route: { action: 'set', routePath: '/p' } },
      { type: 'measure', launchId: B },
      { type: 'handoffReady', requestId: 4 },
    ])
  })

  it('a close is never emitted for a launch whose open was not emitted earlier', () => {
    fc.assert(
      fc.property(eventSequence(), events => {
        const opened = new Set<LaunchId>()
        let state = createEmbedOwnershipState()
        for (const event of events) {
          const out = reduceEmbedOwnership(state, event)
          for (const effect of out.effects) {
            if (effect.type === 'sendOpen') opened.add(effect.launch.launchId)
            if (effect.type === 'close') expect(opened.has(effect.launchId)).toBe(true)
          }
          state = out.state
        }
      }),
      { numRuns: 500 }
    )
  })
})

// ---- R-settle across all rows ----------------------------------------------------

const PENDING: ReadonlySet<ViewPhase> = new Set([
  'waiting',
  'measuring',
  'opening',
  'releasedOpening',
])
const pendingIds = (s: EmbedOwnershipState) =>
  new Set([...s.views.values()].filter(v => PENDING.has(v.phase)).map(v => v.launchId))

/** Checks I-settle and the structural invariants over a sequence; returns settle counts. */
function walk(events: EmbedEvent[]) {
  const settled = new Map<LaunchId, number>()
  const introduced = new Set<LaunchId>()
  let state = createEmbedOwnershipState()
  for (const event of events) {
    const before = pendingIds(state)
    if (event.type === 'intent' || event.type === 'relaunch') introduced.add(event.launch.launchId)
    const out = reduceEmbedOwnership(state, event)
    const after = pendingIds(out.state)
    const settledNow = new Set<LaunchId>()
    for (const effect of out.effects) {
      if (effect.type !== 'launchSettled') continue
      expect(settledNow.has(effect.launchId)).toBe(false)
      settledNow.add(effect.launchId)
      settled.set(effect.launchId, (settled.get(effect.launchId) ?? 0) + 1)
    }
    const entry = new Set(before)
    if (event.type === 'intent' || event.type === 'relaunch') entry.add(event.launch.launchId)
    for (const id of entry) {
      // leaves pending ⇔ settles in this very transition
      expect(settledNow.has(id)).toBe(!after.has(id))
    }
    for (const id of settledNow) expect(entry.has(id)).toBe(true)
    // owner ∈ views with the projected tab
    if (out.state.owner !== null) {
      expect(out.state.views.get(out.state.owner)?.tabId).toBe(out.state.activeAppTabId)
    }
    // at most one record in a main phase per tab
    const mainPerTab = new Map<TabId, number>()
    for (const v of out.state.views.values()) {
      if (v.phase === 'waiting' || v.phase === 'measuring') {
        expect(v.launchId).toBe(out.state.owner)
        continue
      }
      mainPerTab.set(v.tabId, (mainPerTab.get(v.tabId) ?? 0) + 1)
    }
    for (const n of mainPerTab.values()) expect(n).toBeLessThanOrEqual(1)
    // failure implies no owner
    if (out.state.failure !== null) expect(out.state.owner).toBeNull()
    state = out.state
  }
  for (const id of introduced) {
    expect(settled.get(id) ?? 0).toBe(pendingIds(state).has(id) ? 0 : 1)
  }
  return { state, settled }
}

const TABS: TabId[] = [T1, T2]
const IDS: LaunchId[] = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5']

function eventSequence() {
  const id = fc.constantFrom(...IDS)
  const tab = fc.constantFrom(...TABS)
  const route = fc.record({
    kind: fc.constantFrom<'tab' | 'explicit'>('tab', 'explicit'),
    routePath: fc.option(fc.constantFrom('/a', '/b'), { nil: undefined }),
  })
  const loc = fc.option(
    fc.oneof(fc.constant({}), fc.record({ routePath: fc.constantFrom('/x', '/y') })),
    { nil: null }
  )
  const reason = fc.constantFrom(
    'replaced' as const,
    'closed' as const,
    'crashed' as const,
    'parent_closed' as const,
    'session' as const,
    'renderer_replaced' as const,
    'open_failed' as const
  )
  const ev1: fc.Arbitrary<EmbedEvent> = fc.oneof(
    fc.option(tab, { nil: null }).map(ev.projected),
    fc.tuple(id, tab, route).map(([i, t, r]) => ev.intent(launch(i, t, r))),
    fc.tuple(id, tab, route).map(([i, t, r]) => ev.relaunch(launch(i, t, r))),
    fc.constant(ev.backToApps()),
    fc.nat(5).map(ev.handoff),
    fc.tuple(id, fc.boolean()).map(([i, ok]) => ev.measured(i, ok ? BOUNDS : null)),
    id.map(ev.mounted),
    id.map(i => ev.openFailed(i)),
    id.map(ev.closeFailed),
    fc.tuple(id, reason, loc).map(([i, r, l]) => ev.released(i, r, l)),
    id.map(i => ev.title(i))
  )
  // Launch ids are unique per gesture in production: drop repeated intents.
  return fc.array(ev1, { maxLength: 40 }).map(events => {
    const seen = new Set<LaunchId>()
    return events.filter(e => {
      if (e.type !== 'intent' && e.type !== 'relaunch') return true
      if (seen.has(e.launch.launchId)) return false
      seen.add(e.launch.launchId)
      return true
    })
  })
}

describe('R-settle walks every row', () => {
  const rowSequences: Record<string, EmbedEvent[]> = {
    P1: [...mountedSeq, ev.projected(T1)],
    P2: [...openingSeq, ev.projected(T2)],
    I1a: measuringSeq,
    I1b: [...mountedSeq, ev.intent(launch(C, T1))],
    I1c: [...mountedSeq, ev.intent(launch(C, T2))],
    I2a: [...openingSeq, ev.relaunch(LB), ev.released(A), ev.measured(B), ev.mounted(B)],
    I2b: [...mountedSeq, ev.relaunch(launch(C, T2))],
    B1: [...openingSeq, ev.backToApps()],
    H1: [...measuringSeq, ev.handoff(1)],
    M1: openingSeq,
    M2: [...measuringSeq, ev.measured(A, null)],
    M3: [...openingSeq, ev.measured(A)],
    O1: mountedSeq,
    O2: [...openingSeq, ev.backToApps(), ev.mounted(A), ev.released(A)],
    O3: [...openingSeq, ev.openFailed(A)],
    O4: [...mountedSeq, ev.mounted(C)],
    R1a: [...mountedSeq, ev.released(A, 'crashed', null)],
    'R1a (opening)': [...openingSeq, ev.released(A, 'crashed', null)],
    R1b: [...openingSeq, ev.released(A, 'session', null)],
    R1c: [...releasedOpeningSeq, ev.openFailed(A)],
    'R1c (relaunch)': [...releasedOpeningSeq, ev.relaunch(LB), ev.openFailed(A), ev.measured(B)],
    'R1c (left)': [...releasedOpeningSeq, ev.projected(T2), ev.openFailed(A)],
    'R1c (back)': [
      ...releasedOpeningSeq,
      ev.projected(T2),
      ev.projected(T1),
      ev.intent(LB),
      ev.openFailed(A),
      ev.measured(B),
    ],
    'R1c (mounted)': [...releasedOpeningSeq, ev.mounted(A)],
    R2: [...closeRequestedSeq, ev.released(A), ev.released(A)],
    X1: [...closeRequestedSeq, ev.closeFailed(A)],
    T1: [...mountedSeq, ev.title(A)],
    T2: [...closeRequestedSeq, ev.title(A)],
  }

  for (const [row, seq] of Object.entries(rowSequences)) {
    it(`${row}: no launch leaves pending without exactly one launchSettled`, () => {
      walk(seq)
    })
  }

  it('random sequences keep I-settle, owner, I-tab and failure invariants', () => {
    fc.assert(
      fc.property(eventSequence(), events => {
        walk(events)
      }),
      { numRuns: 2000 }
    )
  })
})
