import { describe, expect, it, vi } from 'vitest'
import type { Bounds, Launch, LaunchId, TabId } from '../embedOwnership.types'
import { createEmbedOwnershipMachine } from '../embedOwnershipMachine'
import type {
  EmbedOpenRequest,
  EmbedOwnershipMachineDeps,
  EmbedSlotMeasurer,
} from '../embedOwnershipMachine.types'
import { createWorkspaceTabsState, openAppTab } from '../workspaceTabs'
import type { WorkspaceTabsState } from '../workspaceTabs.types'

// Interpreter only: the reducer is the real one and the bridge stands at the
// IPC boundary. Main's side of the contract (what `released` carries, when an
// open resolves) is certified against the real AppService in
// src/__tests__/embedOwnership.property.test.ts.

const BOUNDS: Bounds = { x: 0, y: 40, width: 800, height: 600 }
const TAB_A: TabId = 'ws-tab-2'
const TAB_B: TabId = 'ws-tab-3'

type Deferred = { promise: Promise<unknown>; resolve(): void; reject(error: Error): void }

function deferred(): Deferred {
  let resolve: () => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<unknown>((res, rej) => {
    resolve = () => res(undefined)
    reject = rej
  })
  return { promise, resolve, reject }
}

function launch(launchId: LaunchId, tabId: TabId = TAB_A, overrides: Partial<Launch> = {}): Launch {
  return {
    launchId,
    tabId,
    appRef: 'sandbox-recipes/alpha',
    route: { kind: 'explicit', routePath: `/r/${launchId}` },
    app: { label: 'Alpha', defaultPath: '/home' },
    ...overrides,
  }
}

function harness(overrides: Partial<EmbedOwnershipMachineDeps> = {}) {
  const log: string[] = []
  const opens = new Map<LaunchId, Deferred>()
  const closes = new Map<LaunchId, Deferred>()
  let tabs: WorkspaceTabsState = openAppTab(
    openAppTab(createWorkspaceTabsState('chat-tab-1'), {
      id: TAB_A,
      appRef: 'sandbox-recipes/alpha',
      title: 'Alpha',
    }),
    { id: TAB_B, appRef: 'sandbox-recipes/beta', title: 'Beta' }
  )
  const bridge = {
    open: vi.fn((request: EmbedOpenRequest) => {
      log.push(`open:${request.launchId}`)
      const d = deferred()
      opens.set(request.launchId, d)
      return d.promise
    }),
    close: vi.fn(({ launchId }: { launchId: LaunchId }) => {
      log.push(`close:${launchId}`)
      const d = deferred()
      closes.set(launchId, d)
      return d.promise
    }),
  }
  const updateTabs = vi.fn((updater: (state: WorkspaceTabsState) => WorkspaceTabsState) => {
    tabs = updater(tabs)
  })
  const machine = createEmbedOwnershipMachine({ bridge, updateTabs, ...overrides })
  return {
    machine,
    bridge,
    log,
    opens,
    closes,
    updateTabs,
    tabs: () => tabs,
  }
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** A measurer that answers immediately. */
const measured: EmbedSlotMeasurer = async () => BOUNDS

async function mountedOwner(h: ReturnType<typeof harness>, l: Launch) {
  h.machine.registerMeasurer(measured)
  h.machine.projected(l.tabId)
  h.machine.intent(l)
  await flush()
  h.opens.get(l.launchId)!.resolve()
  await flush()
  expect(h.machine.getSnapshot().views.get(l.launchId)?.phase).toBe('mounted')
}

describe('embed ownership machine — external store', () => {
  it('keeps the same snapshot and notifies nobody when a transition changes nothing', () => {
    const h = harness()
    const listener = vi.fn()
    h.machine.subscribe(listener)
    h.machine.projected(TAB_A)
    const snapshot = h.machine.getSnapshot()
    expect(listener).toHaveBeenCalledTimes(1)

    h.machine.projected(TAB_A)

    expect(h.machine.getSnapshot()).toBe(snapshot)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops notifying a listener once it unsubscribes', () => {
    const h = harness()
    const listener = vi.fn()
    const unsubscribe = h.machine.subscribe(listener)
    unsubscribe()
    h.machine.projected(TAB_A)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('embed ownership machine — IPC ordering', () => {
  it('invokes the close of a launch in the same tick as its open when both come out back to back', () => {
    const h = harness()
    const l = launch('l-1')
    h.machine.projected(TAB_A)
    h.machine.intent(l)
    expect(h.machine.getSnapshot().views.get('l-1')?.phase).toBe('measuring')

    // The slot answers and, before any await, the user leaves the tab.
    h.machine.dispatch({ type: 'slotMeasured', launchId: 'l-1', bounds: BOUNDS })
    h.machine.projected(TAB_B)

    expect(h.log).toEqual(['open:l-1', 'close:l-1'])
  })

  it('sends a close while the open it undoes is still in flight', () => {
    const h = harness()
    h.machine.projected(TAB_A)
    h.machine.intent(launch('l-1'))
    h.machine.dispatch({ type: 'slotMeasured', launchId: 'l-1', bounds: BOUNDS })
    expect(h.bridge.open).toHaveBeenCalledTimes(1)

    h.machine.backToApps()

    expect(h.bridge.close).toHaveBeenCalledWith({ launchId: 'l-1' })
    expect(h.log).toEqual(['open:l-1', 'close:l-1'])
  })

  it('sweeps an owner whose slot measurement is still pending during handoff', async () => {
    let resolveMeasurement!: (bounds: Bounds | null) => void
    const pendingMeasurement = new Promise<Bounds | null>(resolve => {
      resolveMeasurement = resolve
    })
    const onHandoffReady = vi.fn()
    const h = harness({ onHandoffReady })
    h.machine.registerMeasurer(() => pendingMeasurement)
    h.machine.projected(TAB_A)
    const settled = h.machine.registerWhenSettled('l-1')
    h.machine.intent(launch('l-1'))
    await flush()
    expect(h.machine.getSnapshot().views.get('l-1')?.phase).toBe('measuring')

    h.machine.handoff(7)
    await flush()

    expect(onHandoffReady).toHaveBeenCalledWith(7)
    expect(h.machine.getSnapshot().owner).toBeNull()
    expect(h.machine.getSnapshot().views.has('l-1')).toBe(false)
    await expect(settled).resolves.toBe('abandoned')
    expect(h.bridge.open).not.toHaveBeenCalled()
    expect(h.bridge.close).not.toHaveBeenCalled()

    resolveMeasurement(BOUNDS)
    await flush()
    expect(h.bridge.open).not.toHaveBeenCalled()
    expect(h.machine.getSnapshot().views.has('l-1')).toBe(false)
  })
})

describe('embed ownership machine — open request', () => {
  it('settles an open the bridge throws on at once, so no close follows it to main', () => {
    const h = harness()
    h.bridge.open.mockImplementationOnce((request: EmbedOpenRequest) => {
      h.log.push(`open-threw:${request.launchId}`)
      throw new Error('bridge unavailable')
    })
    h.machine.projected(TAB_A)
    const settled = h.machine.registerWhenSettled('l-0')
    h.machine.intent(launch('l-0'))

    // The slot answers and, in the same tick, the user leaves the tab.
    h.machine.dispatch({ type: 'slotMeasured', launchId: 'l-0', bounds: BOUNDS })
    h.machine.projected(TAB_B)

    expect(h.log).toEqual(['open-threw:l-0'])
    expect(h.machine.pendingWhenSettled()).toBe(0)
    return expect(settled).resolves.toBe('failed')
  })

  it('builds the open from the launch, the measured bounds and the route the reducer chose', async () => {
    const h = harness()
    h.machine.registerMeasurer(measured)
    h.machine.projected(TAB_A)
    h.machine.intent(launch('l-1'))
    await flush()

    expect(h.bridge.open).toHaveBeenCalledWith({
      launchId: 'l-1',
      recipeNs: 'sandbox-recipes',
      recipeName: 'alpha',
      title: 'Alpha',
      defaultPath: '/home',
      routePath: '/r/l-1',
      bounds: BOUNDS,
    })
  })

  it('never sends an empty route: the default route is sent as no route', async () => {
    const h = harness()
    h.machine.registerMeasurer(measured)
    h.machine.projected(TAB_A)
    h.machine.intent(launch('l-1', TAB_A, { route: { kind: 'explicit', routePath: '' } }))
    await flush()

    expect(h.bridge.open).toHaveBeenCalledTimes(1)
    expect(h.bridge.open.mock.calls[0]![0]).not.toHaveProperty('routePath')
  })

  it('fails a launch whose app reference names no recipe without calling main', async () => {
    const h = harness()
    h.machine.registerMeasurer(measured)
    h.machine.projected(TAB_A)
    const l = launch('l-1', TAB_A, { appRef: 'sandbox-recipes/a/b' })
    const settled = h.machine.registerWhenSettled('l-1')
    h.machine.intent(l)
    await flush()

    expect(h.bridge.open).not.toHaveBeenCalled()
    await expect(settled).resolves.toBe('failed')
    expect(h.machine.getSnapshot().failure).toMatchObject({ launchId: 'l-1', kind: 'open' })
  })

  it('settles mounted when main resolves the open, failed with its message when it rejects', async () => {
    const h = harness()
    h.machine.registerMeasurer(measured)
    h.machine.projected(TAB_A)
    const first = h.machine.registerWhenSettled('l-1')
    h.machine.intent(launch('l-1'))
    await flush()
    h.opens.get('l-1')!.resolve()
    await expect(first).resolves.toBe('mounted')

    const second = h.machine.registerWhenSettled('l-2')
    h.machine.relaunch(launch('l-2'))
    h.machine.onReleased({ launchId: 'l-1', reason: 'closed', location: { routePath: '/r/l-1' } })
    await flush()
    h.opens.get('l-2')!.reject(new Error('mint refused'))
    await expect(second).resolves.toBe('failed')
    expect(h.machine.getSnapshot().failure).toEqual({
      tabId: TAB_A,
      launchId: 'l-2',
      kind: 'open',
      message: 'mint refused',
    })
  })

  it('retains a view whose close main rejected', async () => {
    const h = harness()
    await mountedOwner(h, launch('l-1'))
    h.machine.backToApps()
    expect(h.machine.getSnapshot().views.get('l-1')?.phase).toBe('closeRequested')

    h.closes.get('l-1')!.reject(new Error('ipc down'))
    await flush()

    expect(h.machine.getSnapshot().views.get('l-1')?.phase).toBe('closeFailed')
    expect(h.machine.getSnapshot().owner).toBeNull()
  })

  it('retries a retained close failure before a later explicit relaunch', async () => {
    const h = harness()
    await mountedOwner(h, launch('l-1'))

    h.machine.backToApps()
    h.closes.get('l-1')!.reject(new Error('first close rejected'))
    await flush()
    expect(h.machine.getSnapshot().views.get('l-1')?.phase).toBe('closeFailed')

    const replacement = h.machine.registerWhenSettled('l-2')
    h.machine.relaunch(launch('l-2'))
    await flush()

    expect(h.bridge.close).toHaveBeenCalledTimes(2)
    expect(h.machine.getSnapshot().views.get('l-1')?.phase).toBe('closeRequested')
    h.closes.get('l-1')!.resolve()
    h.machine.onReleased({
      launchId: 'l-1',
      reason: 'closed',
      location: { routePath: '/r/l-1' },
    })
    await flush()
    expect(h.bridge.open).toHaveBeenCalledWith(expect.objectContaining({ launchId: 'l-2' }))
    h.opens.get('l-2')!.resolve()

    await expect(replacement).resolves.toBe('mounted')
    expect(h.machine.getSnapshot().owner).toBe('l-2')
    expect(h.machine.getSnapshot().views.has('l-1')).toBe(false)
  })
})

describe('embed ownership machine — slot measurement', () => {
  it('waits for a registered measurer before measuring', async () => {
    const h = harness()
    h.machine.projected(TAB_A)
    h.machine.intent(launch('l-1'))
    await flush()
    expect(h.bridge.open).not.toHaveBeenCalled()

    const measurer = vi.fn(measured)
    h.machine.registerMeasurer(measurer)
    await flush()

    expect(measurer).toHaveBeenCalledWith('l-1')
    expect(h.bridge.open).toHaveBeenCalledTimes(1)
  })

  it('fails the launch on the slot when the measurer rejects', async () => {
    const h = harness()
    h.machine.registerMeasurer(async () => {
      throw new Error('no frame')
    })
    h.machine.projected(TAB_A)
    h.machine.intent(launch('l-1'))
    await flush()

    expect(h.bridge.open).not.toHaveBeenCalled()
    expect(h.machine.getSnapshot().failure).toMatchObject({ launchId: 'l-1', kind: 'slot' })
  })

  it('stops using a measurer once it unregisters', async () => {
    const h = harness()
    const measurer = vi.fn(measured)
    h.machine.registerMeasurer(measurer)()
    h.machine.projected(TAB_A)
    h.machine.intent(launch('l-1'))
    await flush()
    expect(measurer).not.toHaveBeenCalled()
  })
})

describe('embed ownership machine — tab store writes', () => {
  it('persists the route a released view reports on its own tab', async () => {
    const h = harness()
    await mountedOwner(h, launch('l-1'))
    h.machine.backToApps()

    h.machine.onReleased({ launchId: 'l-1', reason: 'closed', location: { routePath: '/inbox' } })

    expect(h.tabs().tabs.find(tab => tab.id === TAB_A)?.app?.savedRoutePath).toBe('/inbox')
  })

  it('clears the saved route when the view reports the default route', async () => {
    const h = harness()
    await mountedOwner(h, launch('l-1'))
    h.machine.onReleased({ launchId: 'l-1', reason: 'closed', location: { routePath: '/x' } })
    h.machine.relaunch(launch('l-2'))
    await flush()
    h.opens.get('l-2')!.resolve()
    await flush()
    h.machine.backToApps()

    h.machine.onReleased({ launchId: 'l-2', reason: 'closed', location: {} })

    const tab = h.tabs().tabs.find(t => t.id === TAB_A)
    expect(tab?.app).toEqual({ appRef: 'sandbox-recipes/alpha' })
  })

  it('leaves the store untouched when the tab is gone', async () => {
    const h = harness()
    await mountedOwner(h, launch('l-1', 'ws-tab-gone'))
    const before = h.tabs()
    h.machine.backToApps()

    h.machine.onReleased({ launchId: 'l-1', reason: 'closed', location: { routePath: '/inbox' } })

    expect(h.updateTabs).toHaveBeenCalled()
    expect(h.tabs()).toBe(before)
  })

  it("renames the owner's tab after its title and ignores titles of other launches", async () => {
    const h = harness()
    await mountedOwner(h, launch('l-1'))

    h.machine.onTitleChanged({ launchId: 'l-1', title: 'Alpha Inbox' })
    h.machine.onTitleChanged({ launchId: 'l-stale', title: 'Stale' })

    expect(h.tabs().tabs.find(tab => tab.id === TAB_A)?.title).toBe('Alpha Inbox')
  })

  it('keeps running the IPC effects of a transition when a store write throws', async () => {
    const h = harness()
    await mountedOwner(h, launch('l-1'))
    h.machine.relaunch(launch('l-2'))
    h.machine.onReleased({ launchId: 'l-1', reason: 'closed', location: { routePath: '/x' } })
    await flush()
    h.opens.get('l-2')!.resolve()
    await flush()
    h.updateTabs.mockImplementation(() => {
      throw new Error('store gone')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    // l-3 replaces l-2: the sweep closes l-2 in the same transition.
    h.machine.relaunch(launch('l-3'))
    h.machine.onReleased({ launchId: 'l-2', reason: 'closed', location: { routePath: '/y' } })

    expect(h.bridge.close).toHaveBeenCalledWith({ launchId: 'l-2' })
    expect(h.machine.getSnapshot().views.get('l-3')?.phase).toBe('measuring')
    error.mockRestore()
  })
})

describe('embed ownership machine — transition observer', () => {
  it('still opens, notifies and settles a launch when onTransition throws', async () => {
    const h = harness({
      onTransition: () => {
        throw new Error('observer broke')
      },
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const listener = vi.fn()
    h.machine.subscribe(listener)
    // A caller that survives the throw must still see the launch go through.
    const survive = (dispatch: () => void) => {
      try {
        dispatch()
      } catch {
        // asserted through the observable outcome below
      }
    }
    h.machine.registerMeasurer(measured)
    survive(() => h.machine.projected(TAB_A))
    const settled = h.machine.registerWhenSettled('l-1')
    survive(() => h.machine.intent(launch('l-1')))
    await flush()

    expect(h.bridge.open).toHaveBeenCalledWith(expect.objectContaining({ launchId: 'l-1' }))
    expect(listener).toHaveBeenCalled()
    h.opens.get('l-1')!.resolve()
    await expect(settled).resolves.toBe('mounted')
    error.mockRestore()
  })
})

describe('embed ownership machine — notifications', () => {
  it("reports only the owner's refresh failures", async () => {
    const onOwnerRefreshError = vi.fn()
    const h = harness({ onOwnerRefreshError })
    await mountedOwner(h, launch('l-1'))

    h.machine.onRefreshError({ launchId: 'l-old', message: 'stale' })
    h.machine.onRefreshError({ launchId: 'l-1', message: 'live' })

    expect(onOwnerRefreshError).toHaveBeenCalledTimes(1)
    expect(onOwnerRefreshError).toHaveBeenCalledWith({ launchId: 'l-1', message: 'live' })
  })

  it("reports only the owner's refresh recoveries", async () => {
    const onOwnerRefreshRecovered = vi.fn()
    const h = harness({ onOwnerRefreshRecovered })
    await mountedOwner(h, launch('l-1'))

    h.machine.onRefreshRecovered({ launchId: 'l-old' })
    h.machine.onRefreshRecovered({ launchId: 'l-1' })

    expect(onOwnerRefreshRecovered).toHaveBeenCalledTimes(1)
    expect(onOwnerRefreshRecovered).toHaveBeenCalledWith({ launchId: 'l-1' })
  })

  // Main keeps refreshing a view until its close is dequeued, so a recovery of
  // the replaced launch can follow the close the relaunch sent.
  it('drops a recovery of a relaunched view, sent before or after its close reached main', async () => {
    const onOwnerRefreshRecovered = vi.fn()
    const h = harness({ onOwnerRefreshRecovered })
    await mountedOwner(h, launch('l-1'))

    h.machine.relaunch(launch('l-2'))
    expect(h.bridge.close).toHaveBeenCalledWith({ launchId: 'l-1' })
    h.machine.onRefreshRecovered({ launchId: 'l-1' })
    h.closes.get('l-1')!.resolve()
    await flush()
    h.machine.onRefreshRecovered({ launchId: 'l-1' })

    expect(h.machine.getSnapshot().owner).toBe('l-2')
    expect(onOwnerRefreshRecovered).not.toHaveBeenCalled()
  })

  it('drops a recovery once its launch left the embed, and every recovery after dispose', async () => {
    const onOwnerRefreshRecovered = vi.fn()
    const h = harness({ onOwnerRefreshRecovered })
    await mountedOwner(h, launch('l-1'))
    h.machine.backToApps()
    h.machine.onRefreshRecovered({ launchId: 'l-1' })

    const disposed = harness({ onOwnerRefreshRecovered })
    await mountedOwner(disposed, launch('l-2'))
    disposed.machine.dispose()
    disposed.machine.onRefreshRecovered({ launchId: 'l-2' })

    expect(onOwnerRefreshRecovered).not.toHaveBeenCalled()
  })

  it('announces a handoff once the views it waits for are gone', async () => {
    const onHandoffReady = vi.fn()
    const h = harness({ onHandoffReady })
    await mountedOwner(h, launch('l-1'))

    h.machine.handoff(7)
    expect(onHandoffReady).not.toHaveBeenCalled()
    h.machine.onReleased({ launchId: 'l-1', reason: 'closed', location: null })

    expect(onHandoffReady).toHaveBeenCalledWith(7)
  })

  it('fails a handoff and retains the owner when its close is rejected', async () => {
    const onHandoffReady = vi.fn()
    const onHandoffFailed = vi.fn()
    const h = harness({ onHandoffReady, onHandoffFailed })
    await mountedOwner(h, launch('l-1'))

    h.machine.handoff(8)
    h.closes.get('l-1')!.reject(new Error('close rejected'))
    await flush()

    expect(onHandoffReady).not.toHaveBeenCalled()
    expect(onHandoffFailed).toHaveBeenCalledWith(8)
    expect(h.machine.getSnapshot().owner).toBe('l-1')
    expect(h.machine.getSnapshot().views.get('l-1')?.phase).toBe('closeFailed')
  })

  it('resolves a launch that never got its tab as abandoned, in the same dispatch', async () => {
    const h = harness()
    h.machine.projected(TAB_B)
    const settled = h.machine.registerWhenSettled('l-1')

    h.machine.intent(launch('l-1', TAB_A))

    expect(h.machine.pendingWhenSettled()).toBe(0)
    await expect(settled).resolves.toBe('abandoned')
  })

  // The seam registers, dispatches, and only then reads `whenSettled`: a launch
  // that settles inside that dispatch must still hand out its outcome.
  it('hands out the outcome of a launch abandoned in its own dispatch for an inactive tab', async () => {
    const h = harness()
    h.machine.projected(TAB_B)
    h.machine.registerWhenSettled('l-1')
    h.machine.intent(launch('l-1', TAB_A))

    await expect(h.machine.whenSettled('l-1')).resolves.toBe('abandoned')
  })

  it('hands out the outcome of a re-click abandoned in its own dispatch', async () => {
    const h = harness()
    await mountedOwner(h, launch('l-1'))
    h.machine.registerWhenSettled('l-2')
    h.machine.intent(launch('l-2'))

    await expect(h.machine.whenSettled('l-2')).resolves.toBe('abandoned')
    expect(h.machine.getSnapshot().owner).toBe('l-1')
  })

  it('returns the same settled promise when a launch is registered again', async () => {
    const h = harness()
    h.machine.projected(TAB_B)
    const first = h.machine.registerWhenSettled('l-1')
    h.machine.intent(launch('l-1', TAB_A))

    expect(h.machine.registerWhenSettled('l-1')).toBe(first)
    await expect(h.machine.registerWhenSettled('l-1')).resolves.toBe('abandoned')
    expect(h.machine.pendingWhenSettled()).toBe(0)
  })

  it('hands out the pending promise of a registered launch until it settles, and after', async () => {
    const h = harness()
    h.machine.registerMeasurer(measured)
    h.machine.projected(TAB_A)
    const registered = h.machine.registerWhenSettled('l-1')
    h.machine.intent(launch('l-1'))

    expect(h.machine.whenSettled('l-1')).toBe(registered)
    expect(h.machine.pendingWhenSettled()).toBe(1)
    await flush()
    h.opens.get('l-1')!.resolve()
    await expect(registered).resolves.toBe('mounted')
    expect(h.machine.whenSettled('l-1')).toBe(registered)
    expect(h.machine.pendingWhenSettled()).toBe(0)
  })
})

describe('embed ownership machine — re-entrant dispatch', () => {
  it('finishes the effects of a transition before reducing what its callbacks dispatch', () => {
    const seenAtNestedIntent: number[] = []
    let machine: ReturnType<typeof harness>['machine'] | null = null
    const h = harness({
      // A deep-link continuation: once the handoff is ready it activates its
      // target tab and launches it, synchronously, from inside the effect.
      onHandoffReady: () => {
        machine!.projected(TAB_B)
        machine!.intent(launch('l-2', TAB_B))
      },
      onTransition: ({ event }) => {
        if (event.type === 'intent' && event.launch.launchId === 'l-2') {
          seenAtNestedIntent.push(machine!.pendingWhenSettled())
        }
      },
    })
    machine = h.machine
    h.machine.projected(TAB_A)
    h.machine.registerWhenSettled('l-1')
    // No measurer yet: l-1 stays in the slot measurement.
    h.machine.intent(launch('l-1'))

    // The handoff drops l-1 (never sent to main), is ready at once, and settles
    // l-1 as abandoned after announcing the handoff.
    h.machine.handoff(7)

    expect(seenAtNestedIntent).toEqual([0])
    expect(h.machine.getSnapshot().owner).toBe('l-2')
    expect(h.log).toEqual([])
  })

  it('settles an open it refuses ahead of events already queued, so no close goes out for it', async () => {
    let machine: ReturnType<typeof harness>['machine'] | null = null
    let reenter = false
    const h = harness({
      // A store write that synchronously commits and dispatches, as a layout
      // effect could: the slot answers and the user leaves the tab.
      updateTabs: () => {
        if (!reenter) return
        reenter = false
        machine!.dispatch({ type: 'slotMeasured', launchId: 'l-bad', bounds: BOUNDS })
        machine!.projected(TAB_B)
      },
    })
    machine = h.machine
    await mountedOwner(h, launch('l-0'))
    h.machine.relaunch(launch('l-bad', TAB_A, { appRef: 'not-a-recipe' }))
    reenter = true

    h.machine.onReleased({ launchId: 'l-0', reason: 'closed', location: { routePath: '/x' } })

    expect(h.bridge.close.mock.calls.map(([request]) => request.launchId)).toEqual(['l-0'])
    expect(h.bridge.open.mock.calls.map(([request]) => request.launchId)).toEqual(['l-0'])
    expect(h.machine.getSnapshot().views.size).toBe(0)
  })

  it('settles an open the bridge throws on ahead of events already queued, so no close goes out for it', async () => {
    let machine: ReturnType<typeof harness>['machine'] | null = null
    let reenter = false
    const h = harness({
      updateTabs: () => {
        if (!reenter) return
        reenter = false
        machine!.dispatch({ type: 'slotMeasured', launchId: 'l-1', bounds: BOUNDS })
        machine!.projected(TAB_B)
      },
    })
    machine = h.machine
    await mountedOwner(h, launch('l-0'))
    h.bridge.open.mockImplementationOnce((request: EmbedOpenRequest) => {
      h.log.push(`open-threw:${request.launchId}`)
      throw new Error('bridge unavailable')
    })
    const settled = h.machine.registerWhenSettled('l-1')
    h.machine.relaunch(launch('l-1'))
    reenter = true

    h.machine.onReleased({ launchId: 'l-0', reason: 'closed', location: { routePath: '/x' } })

    expect(h.log).toEqual(['open:l-0', 'close:l-0', 'open-threw:l-1'])
    expect(h.machine.getSnapshot().views.size).toBe(0)
    expect(h.machine.pendingWhenSettled()).toBe(0)
    await expect(settled).resolves.toBe('failed')
  })
})

describe('embed ownership machine — dispose', () => {
  it('ignores events, measurements and IPC outcomes that arrive after dispose', async () => {
    const h = harness()
    let answerSlot: (bounds: Bounds) => void = () => {}
    h.machine.registerMeasurer(() => new Promise<Bounds>(resolve => (answerSlot = resolve)))
    h.machine.projected(TAB_A)
    h.machine.intent(launch('l-1'))
    h.machine.dispatch({ type: 'slotMeasured', launchId: 'l-1', bounds: BOUNDS })
    const listener = vi.fn()
    h.machine.subscribe(listener)
    const snapshot = h.machine.getSnapshot()
    const tabs = h.tabs()

    h.machine.dispose()
    answerSlot(BOUNDS)
    h.opens.get('l-1')!.resolve()
    h.machine.onReleased({ launchId: 'l-1', reason: 'closed', location: { routePath: '/x' } })
    h.machine.onTitleChanged({ launchId: 'l-1', title: 'Late' })
    h.machine.onRefreshError({ launchId: 'l-1', message: 'late' })
    h.machine.projected(TAB_B)
    await flush()

    expect(h.machine.getSnapshot()).toBe(snapshot)
    expect(listener).not.toHaveBeenCalled()
    expect(h.updateTabs).not.toHaveBeenCalled()
    expect(h.tabs()).toBe(tabs)
    expect(h.bridge.close).not.toHaveBeenCalled()
  })

  it('tolerates a rejected open and close after dispose', async () => {
    const h = harness()
    await mountedOwner(h, launch('l-1'))
    h.machine.relaunch(launch('l-2'))
    h.machine.dispose()

    h.closes.get('l-1')!.reject(new Error('late'))
    await flush()

    expect(h.machine.getSnapshot().views.get('l-1')?.phase).toBe('closeRequested')
  })
})
