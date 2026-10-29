import { createEmbedOwnershipState, reduceEmbedOwnership } from './embedOwnership'
import type {
  EmbedEffect,
  EmbedEvent,
  EmbedOwnershipState,
  Launch,
  LaunchId,
  LaunchOutcome,
} from './embedOwnership.types'
import type {
  EmbedOpenRequest,
  EmbedOwnershipMachine,
  EmbedOwnershipMachineDeps,
  EmbedSlotMeasurer,
} from './embedOwnershipMachine.types'
import { setAppTabSavedRoutePath, setAppTabTitle } from './workspaceTabs'

/**
 * Runs `reduceEmbedOwnership` against the outside world. It owns no decision:
 * every choice is the reducer's; this only turns effects into calls and call
 * outcomes back into events.
 *
 * `sendOpen` and `close` are invoked synchronously while walking a transition's
 * effects, in their order, and only the promises they return are awaited. Main
 * serves opens and closes in arrival order, so deferring one of the two calls
 * would let a close overtake the open it is meant to undo and leave a view
 * nobody owns.
 */
export function createEmbedOwnershipMachine(
  deps: EmbedOwnershipMachineDeps
): EmbedOwnershipMachine {
  let state: EmbedOwnershipState = createEmbedOwnershipState()
  let disposed = false
  const listeners = new Set<() => void>()
  // Events raised while a transition's effects are still running wait here, so
  // each transition's effects all run before the next event is reduced.
  const queue: EmbedEvent[] = []
  let draining = false
  let measurer: EmbedSlotMeasurer | null = null
  const awaitingMeasurer: LaunchId[] = []
  // Kept after settling: the seam registers a launch, dispatches it and only
  // then asks for its promise, and a launch can settle inside that dispatch.
  const settleWaiters = new Map<
    LaunchId,
    { promise: Promise<LaunchOutcome>; resolve: (outcome: LaunchOutcome) => void }
  >()
  const unsettled = new Set<LaunchId>()

  function dispatch(event: EmbedEvent): void {
    if (disposed) return
    queue.push(event)
    if (draining) return
    draining = true
    const before = state
    try {
      while (queue.length > 0 && !disposed) {
        const next = queue.shift()!
        const previous = state
        const transition = reduceEmbedOwnership(previous, next)
        state = transition.state
        // An observer failing must not keep this transition's effects from running.
        try {
          deps.onTransition?.({
            event: next,
            previous,
            next: transition.state,
            effects: transition.effects,
          })
        } catch (error) {
          console.error('[embedOwnership] onTransition failed:', next.type, error)
        }
        for (const effect of transition.effects) runEffect(effect)
      }
    } finally {
      draining = false
      if (disposed) queue.length = 0
    }
    if (state !== before && !disposed) {
      for (const listener of [...listeners]) listener()
    }
  }

  function runEffect(effect: EmbedEffect): void {
    if (disposed) return
    // One failing effect must not keep the IPC effects after it from running.
    try {
      switch (effect.type) {
        case 'measure':
          requestMeasure(effect.launchId)
          return
        case 'sendOpen':
          sendOpen(effect.launch, effect.bounds, effect.routePath)
          return
        case 'close':
          sendClose(effect.launchId)
          return
        case 'persistRoute': {
          const routePath = effect.route.action === 'set' ? effect.route.routePath : undefined
          deps.updateTabs(tabs => setAppTabSavedRoutePath(tabs, effect.tabId, routePath))
          return
        }
        case 'setTitle':
          deps.updateTabs(tabs => setAppTabTitle(tabs, effect.tabId, effect.title))
          return
        case 'handoffReady':
          deps.onHandoffReady?.(effect.requestId)
          return
        case 'launchSettled':
          settle(effect.launchId, effect.outcome)
          return
      }
    } catch (error) {
      console.error('[embedOwnership] effect failed:', effect.type, error)
    }
  }

  function requestMeasure(launchId: LaunchId): void {
    if (measurer) startMeasure(launchId, measurer)
    else awaitingMeasurer.push(launchId)
  }

  function startMeasure(launchId: LaunchId, measure: EmbedSlotMeasurer): void {
    let pending: Promise<EmbedOpenRequest['bounds'] | null>
    try {
      pending = measure(launchId)
    } catch {
      pending = Promise.resolve(null)
    }
    pending.then(
      bounds => dispatch({ type: 'slotMeasured', launchId, bounds: bounds ?? null }),
      () => dispatch({ type: 'slotMeasured', launchId, bounds: null })
    )
  }

  function sendOpen(launch: Launch, bounds: EmbedOpenRequest['bounds'], routePath?: string): void {
    const recipe = parseAppRef(launch.appRef)
    if (!recipe) {
      // Main would refuse it anyway. Settled ahead of anything already queued:
      // an earlier queued event could otherwise sweep this launch and send main
      // a close for an open it never received.
      queue.unshift({
        type: 'openSettled',
        launchId: launch.launchId,
        outcome: { failed: `Invalid app reference: ${launch.appRef}` },
      })
      return
    }
    const request: EmbedOpenRequest = {
      launchId: launch.launchId,
      ...recipe,
      // From the trusted renderer's app list, never from the plugin: main shows it
      // in consent prompts and notification attribution as the app's name.
      ...(launch.app.label ? { title: launch.app.label } : {}),
      ...(launch.app.defaultPath ? { defaultPath: launch.app.defaultPath } : {}),
      // '' is the default route, which main expresses as no route at all.
      ...(routePath ? { routePath } : {}),
      bounds,
    }
    let pending: Promise<unknown>
    try {
      pending = deps.bridge.open(request)
    } catch (error) {
      // The open never left the renderer: settled like a refused app reference,
      // ahead of anything queued, so no close can follow it to main.
      queue.unshift({
        type: 'openSettled',
        launchId: launch.launchId,
        outcome: { failed: error instanceof Error ? error.message : String(error) },
      })
      return
    }
    pending.then(
      () => dispatch({ type: 'openSettled', launchId: launch.launchId, outcome: 'mounted' }),
      error =>
        dispatch({
          type: 'openSettled',
          launchId: launch.launchId,
          outcome: { failed: error instanceof Error ? error.message : String(error) },
        })
    )
  }

  function sendClose(launchId: LaunchId): void {
    let pending: Promise<unknown>
    try {
      pending = deps.bridge.close({ launchId })
    } catch (error) {
      pending = Promise.reject(error)
    }
    pending.then(undefined, () => dispatch({ type: 'closeFailed', launchId }))
  }

  function waiterFor(launchId: LaunchId) {
    const existing = settleWaiters.get(launchId)
    if (existing) return existing
    let resolve: (outcome: LaunchOutcome) => void = () => {}
    const promise = new Promise<LaunchOutcome>(r => (resolve = r))
    const waiter = { promise, resolve }
    settleWaiters.set(launchId, waiter)
    unsettled.add(launchId)
    return waiter
  }

  /** Only the first outcome counts; a launch settles once. */
  function settle(launchId: LaunchId, outcome: LaunchOutcome): void {
    const known = settleWaiters.has(launchId)
    if (known && !unsettled.has(launchId)) return
    waiterFor(launchId).resolve(outcome)
    unsettled.delete(launchId)
  }

  function registerWhenSettled(launchId: LaunchId): Promise<LaunchOutcome> {
    return waiterFor(launchId).promise
  }

  return {
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
    dispatch,
    projected: activeAppTabId => dispatch({ type: 'projected', activeAppTabId }),
    intent: launch => dispatch({ type: 'intent', launch }),
    relaunch: launch => dispatch({ type: 'relaunch', launch }),
    backToApps: () => dispatch({ type: 'backToApps' }),
    handoff: requestId => dispatch({ type: 'handoff', requestId }),
    onReleased: event =>
      dispatch({
        type: 'released',
        launchId: event.launchId,
        reason: event.reason,
        location: event.location,
      }),
    onTitleChanged: event =>
      dispatch({ type: 'titleChanged', launchId: event.launchId, title: event.title }),
    // Read at arrival: a failure of a view the user already left must not
    // surface on the launch that replaced it.
    onRefreshError: event => {
      if (disposed || event.launchId !== state.owner) return
      deps.onOwnerRefreshError?.(event)
    },
    onRefreshRecovered: event => {
      if (disposed || event.launchId !== state.owner) return
      deps.onOwnerRefreshRecovered?.(event)
    },
    registerMeasurer(next) {
      if (disposed) return () => {}
      measurer = next
      for (const launchId of awaitingMeasurer.splice(0)) startMeasure(launchId, next)
      return () => {
        if (measurer === next) measurer = null
      }
    },
    registerWhenSettled,
    whenSettled: launchId => settleWaiters.get(launchId)?.promise,
    pendingWhenSettled: () => unsettled.size,
    // Pending `whenSettled` promises are left unresolved: whoever awaits them
    // belongs to the renderer being torn down and must not act afterwards.
    dispose() {
      disposed = true
      listeners.clear()
      measurer = null
      awaitingMeasurer.length = 0
      queue.length = 0
    },
  }
}

function parseAppRef(appRef: string): { recipeNs: string; recipeName: string } | null {
  const slash = appRef.indexOf('/')
  if (slash <= 0) return null
  const recipeNs = appRef.slice(0, slash)
  const recipeName = appRef.slice(slash + 1)
  if (!recipeName || recipeName.includes('/')) return null
  return { recipeNs, recipeName }
}
