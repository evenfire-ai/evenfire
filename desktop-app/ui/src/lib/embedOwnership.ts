import type { SandboxUiRoute } from '../../../src/types'
import type {
  EmbedEffect,
  EmbedEvent,
  EmbedFailure,
  EmbedHandoff,
  EmbedOwnershipState,
  EmbedTransition,
  Launch,
  LaunchId,
  PersistedRoute,
  ViewRecord,
} from './embedOwnership.types'

/**
 * Who owns the embedded app view — pure algebra like `workspaceTabs.ts` (no I/O,
 * no clocks, no id generation), shaped as `(state, event) → { state, effects }`.
 * A transition that changes no field returns the input state by reference. Its
 * effects are `[]` unless the event still has something to report: a launch it
 * abandons (`launchSettled`), a handoff with no view to wait for
 * (`handoffReady`), or the owner's new title (`setTitle`).
 *
 * Main is the only authority on which view exists; the tab store is the only
 * authority on which tab is active (it arrives here as `projected`). This reducer
 * only decides which launch owns the active tab and what to ask main for.
 *
 * Every transition is followed by the level rules, in this order:
 *   sweep   — a record that is not the owner is dropped if main never saw it, or
 *             CAS-closed once if main still holds its view;
 *   advance — an owner waits until no other record of its tab is left, so it
 *             opens at the route its predecessor leaves behind;
 *   handoff — a handoff completes when none of the views it waits for remain;
 *   settle  — every launch that stops being pending in this transition without
 *             an explicit outcome is reported `abandoned`, so each launch settles
 *             exactly once.
 *
 * Effects come out as: the event's own effects, then sweep, advance, handoff and
 * settle effects. The interpreter runs IPC effects synchronously in this order;
 * `close` is only ever emitted for a record that already emitted `sendOpen`, and
 * the owner is never swept, so a `close` cannot overtake its own `sendOpen`.
 */

export function createEmbedOwnershipState(): EmbedOwnershipState {
  return {
    activeAppTabId: null,
    lastRoute: new Map(),
    owner: null,
    views: new Map(),
    handoffs: [],
    failure: null,
  }
}

const isPending = (v: ViewRecord): boolean =>
  v.phase === 'waiting' ||
  v.phase === 'measuring' ||
  v.phase === 'opening' ||
  v.phase === 'releasedOpening'

function pendingIds(state: EmbedOwnershipState): LaunchId[] {
  const ids: LaunchId[] = []
  for (const v of state.views.values()) if (isPending(v)) ids.push(v.launchId)
  return ids
}

function withView(state: EmbedOwnershipState, record: ViewRecord): EmbedOwnershipState {
  const views = new Map(state.views)
  views.set(record.launchId, record)
  return { ...state, views }
}

function withoutView(state: EmbedOwnershipState, launchId: LaunchId): EmbedOwnershipState {
  const views = new Map(state.views)
  views.delete(launchId)
  return { ...state, views }
}

function toLaunch(record: ViewRecord): Launch {
  const { phase: _phase, ...launch } = record
  return launch
}

function persistedRoute(location: SandboxUiRoute): PersistedRoute {
  return location.routePath === undefined
    ? { action: 'clear' }
    : { action: 'set', routePath: location.routePath }
}

/** `{}` in `lastRoute` is a persisted default route, not a missing entry. */
function openRoutePath(state: EmbedOwnershipState, record: ViewRecord): string | undefined {
  if (record.route.kind === 'tab' && state.lastRoute.has(record.tabId)) {
    return state.lastRoute.get(record.tabId)?.routePath
  }
  return record.route.routePath
}

/**
 * Nothing of the launch's tab is still alive in a non-closing phase. A released
 * view that lost ownership only waits for its rejection, so it is as good as
 * closing; while it is still the owner, its failure is about to show.
 */
function tabIsFree(state: EmbedOwnershipState, launch: Launch): boolean {
  for (const v of state.views.values()) {
    if (v.tabId !== launch.tabId || v.phase === 'closeRequested') continue
    if (v.phase === 'releasedOpening' && v.launchId !== state.owner) continue
    return false
  }
  return true
}

function takeOwnership(state: EmbedOwnershipState, launch: Launch): EmbedOwnershipState {
  return { ...withView(state, { ...launch, phase: 'waiting' }), owner: launch.launchId }
}

function retryFailedCloseBeforeLaunch(
  state: EmbedOwnershipState,
  launch: Launch
): RowResult | null {
  const retained = [...state.views.values()].find(
    view => view.tabId === launch.tabId && view.phase === 'closeFailed'
  )
  if (!retained) return null
  const closing = withView(state, { ...retained, phase: 'closeRequested' })
  return {
    state: takeOwnership(closing, launch),
    effects: [{ type: 'close', launchId: retained.launchId }],
  }
}

type RowResult = {
  state: EmbedOwnershipState
  effects: EmbedEffect[]
  /** Set by the rows that record a failure; everything else clears it on an ownership change. */
  failure?: EmbedFailure
  /** A handoff whose wait set is taken after the sweep. */
  handoffRequestId?: number
  /** The owner present when a handoff began, for a failed-close rollback. */
  handoffOwnerLaunchId?: LaunchId | null
}

function applyRow(state: EmbedOwnershipState, event: EmbedEvent): RowResult {
  const unchanged: RowResult = { state, effects: [] }
  switch (event.type) {
    case 'projected': {
      if (event.activeAppTabId === state.activeAppTabId) return unchanged
      const ownerTab = state.owner === null ? null : state.views.get(state.owner)?.tabId
      const retainedFailedClose = [...state.views.values()].find(
        view => view.tabId === event.activeAppTabId && view.phase === 'closeFailed'
      )
      return {
        state: {
          ...state,
          activeAppTabId: event.activeAppTabId,
          owner:
            ownerTab === event.activeAppTabId
              ? state.owner
              : (retainedFailedClose?.launchId ?? null),
        },
        effects: [],
      }
    }

    case 'intent': {
      const launch = event.launch
      if (launch.tabId !== state.activeAppTabId) return unchanged
      // A re-click while the tab's view is alive must not relaunch it.
      if (!tabIsFree(state, launch)) return unchanged
      return { state: takeOwnership(state, launch), effects: [] }
    }

    case 'relaunch': {
      if (event.launch.tabId !== state.activeAppTabId) return unchanged
      const retry = retryFailedCloseBeforeLaunch(state, event.launch)
      if (retry) return retry
      return { state: takeOwnership(state, event.launch), effects: [] }
    }

    case 'backToApps':
      return state.owner === null ? unchanged : { state: { ...state, owner: null }, effects: [] }

    case 'handoff': {
      let next = state.owner === null ? state : { ...state, owner: null }
      const effects: EmbedEffect[] = []
      for (const view of next.views.values()) {
        if (view.phase !== 'closeFailed') continue
        next = withView(next, { ...view, phase: 'closeRequested' })
        effects.push({ type: 'close', launchId: view.launchId })
      }
      return {
        state: next,
        effects,
        handoffRequestId: event.requestId,
        handoffOwnerLaunchId: state.owner,
      }
    }

    case 'slotMeasured': {
      const record = state.views.get(event.launchId)
      if (!record || record.phase !== 'measuring' || record.launchId !== state.owner) {
        return unchanged
      }
      if (event.bounds === null) {
        return {
          state: { ...withoutView(state, record.launchId), owner: null },
          effects: [{ type: 'launchSettled', launchId: record.launchId, outcome: 'failed' }],
          failure: { tabId: record.tabId, launchId: record.launchId, kind: 'slot' },
        }
      }
      const routePath = openRoutePath(state, record)
      return {
        state: withView(state, { ...record, phase: 'opening' }),
        effects: [
          {
            type: 'sendOpen',
            launch: toLaunch(record),
            bounds: event.bounds,
            ...(routePath === undefined ? {} : { routePath }),
          },
        ],
      }
    }

    case 'openSettled': {
      const record = state.views.get(event.launchId)
      if (!record) return unchanged
      if (event.outcome === 'mounted') {
        // Main never confirms a view it already released; should it, the launch
        // has no view left to own.
        if (record.phase === 'releasedOpening') {
          const dropped = withoutView(state, record.launchId)
          return {
            state: record.launchId === state.owner ? { ...dropped, owner: null } : dropped,
            effects: [],
          }
        }
        // A launch already being closed keeps waiting for its `released`.
        if (record.phase !== 'opening') return unchanged
        return {
          state: withView(state, { ...record, phase: 'mounted' }),
          effects: [{ type: 'launchSettled', launchId: record.launchId, outcome: 'mounted' }],
        }
      }
      const dropped = withoutView(state, record.launchId)
      if (record.launchId !== state.owner) return { state: dropped, effects: [] }
      return {
        state: { ...dropped, owner: null },
        effects: [{ type: 'launchSettled', launchId: record.launchId, outcome: 'failed' }],
        failure: {
          tabId: record.tabId,
          launchId: record.launchId,
          kind: 'open',
          message: event.outcome.failed,
        },
      }
    }

    case 'closeFailed': {
      const record = state.views.get(event.launchId)
      if (!record || record.phase !== 'closeRequested') return unchanged
      const failedHandoffs = state.handoffs.filter(handoff => handoff.waitFor.has(record.launchId))
      const failedRequestIds = new Set(failedHandoffs.map(handoff => handoff.requestId))
      const failedSuccessors = [...state.views.values()].filter(
        view =>
          view.tabId === record.tabId &&
          view.launchId !== record.launchId &&
          view.phase === 'waiting'
      )
      const waitingSuccessorOwnsTab = failedSuccessors.some(
        successor => successor.launchId === state.owner
      )
      let next: EmbedOwnershipState = {
        ...withView(state, { ...record, phase: 'closeFailed' }),
        handoffs: state.handoffs.filter(handoff => !failedRequestIds.has(handoff.requestId)),
      }
      // Keep the current replacement pending behind the possibly-live native
      // view. A later terminal release can advance it; a newer explicit launch
      // still supersedes it and retries closing the retained view first.
      for (const successor of failedSuccessors) {
        if (successor.launchId !== state.owner) next = withoutView(next, successor.launchId)
      }
      const ownsFailedHandoff = failedHandoffs.some(
        handoff => handoff.ownerLaunchId === record.launchId
      )
      if (
        state.activeAppTabId === record.tabId &&
        ownsFailedHandoff &&
        state.owner === null &&
        !waitingSuccessorOwnsTab
      ) {
        next = { ...next, owner: record.launchId }
      }
      const failedLaunch = failedSuccessors.find(successor => successor.launchId === state.owner)
      return {
        state: next,
        effects: [
          ...failedHandoffs.map(handoff => ({
            type: 'handoffFailed' as const,
            requestId: handoff.requestId,
          })),
        ],
        ...(failedLaunch
          ? {
              failure: {
                tabId: failedLaunch.tabId,
                launchId: failedLaunch.launchId,
                kind: 'open' as const,
                message: 'The current app could not be closed safely. Try launching again.',
              },
            }
          : {}),
      }
    }

    case 'released': {
      const record = state.views.get(event.launchId)
      // Main releases a view once; the record only waits for its open's rejection.
      if (!record || record.phase === 'releasedOpening') return unchanged
      // The owner keeps the launch until the rejection that follows, so the
      // failure it carries is reported instead of an abandoned launch.
      const heldForRejection = event.reason === 'open_failed' && record.phase === 'opening'
      let next = heldForRejection
        ? withView(state, { ...record, phase: 'releasedOpening' })
        : withoutView(state, record.launchId)
      const wasOwner = record.launchId === state.owner
      if (wasOwner && !heldForRejection) next = { ...next, owner: null }
      const effects: EmbedEffect[] = []
      if (event.location !== null) {
        const lastRoute = new Map(next.lastRoute)
        const route = persistedRoute(event.location)
        lastRoute.set(record.tabId, route.action === 'set' ? { routePath: route.routePath } : {})
        next = { ...next, lastRoute }
        effects.push({ type: 'persistRoute', tabId: record.tabId, route })
      }
      // A crash of the view the user is waiting on or looking at must leave the tab
      // something to show and a way back. Any other release (session end, a view
      // being closed) is not the app's fault and leaves the tab simply unowned,
      // except an open that failed, whose rejection reports it.
      const crashed =
        event.reason === 'crashed' &&
        wasOwner &&
        (record.phase === 'mounted' || record.phase === 'opening')
      if (!crashed) return { state: next, effects }
      // A crash before the mount is a failed launch, not an abandoned one: a deep
      // link waiting on it must retry instead of being dropped.
      if (record.phase === 'opening') {
        effects.push({ type: 'launchSettled', launchId: record.launchId, outcome: 'failed' })
      }
      return {
        state: next,
        effects,
        failure: { tabId: record.tabId, launchId: record.launchId, kind: 'crashed' },
      }
    }

    case 'titleChanged': {
      if (event.launchId !== state.owner) return unchanged
      const record = state.views.get(event.launchId)
      if (!record) return unchanged
      return {
        state,
        effects: [{ type: 'setTitle', tabId: record.tabId, title: event.title }],
      }
    }
  }
}

function sweep(state: EmbedOwnershipState, effects: EmbedEffect[]): EmbedOwnershipState {
  let next = state
  for (const v of state.views.values()) {
    if (v.launchId === state.owner) continue
    if (v.phase === 'waiting' || v.phase === 'measuring') {
      // Main never heard of it: closing it would race its own (unsent) open.
      next = withoutView(next, v.launchId)
    } else if (v.phase === 'opening' || v.phase === 'mounted') {
      next = withView(next, { ...v, phase: 'closeRequested' })
      effects.push({ type: 'close', launchId: v.launchId })
    }
    // `releasedOpening` stays until its rejection: main already let the view go.
  }
  return next
}

function advance(state: EmbedOwnershipState, effects: EmbedEffect[]): EmbedOwnershipState {
  if (state.owner === null) return state
  const owner = state.views.get(state.owner)
  if (!owner || owner.phase !== 'waiting') return state
  for (const v of state.views.values()) {
    if (v.tabId === owner.tabId && v.launchId !== owner.launchId) return state
  }
  effects.push({ type: 'measure', launchId: owner.launchId })
  return withView(state, { ...owner, phase: 'measuring' })
}

function completeHandoffs(state: EmbedOwnershipState, effects: EmbedEffect[]): EmbedOwnershipState {
  const remaining: EmbedHandoff[] = []
  for (const handoff of state.handoffs) {
    const blocked = [...handoff.waitFor].some(id => state.views.has(id))
    if (blocked) remaining.push(handoff)
    else effects.push({ type: 'handoffReady', requestId: handoff.requestId })
  }
  return remaining.length === state.handoffs.length ? state : { ...state, handoffs: remaining }
}

function settle(
  before: EmbedOwnershipState,
  after: EmbedOwnershipState,
  event: EmbedEvent,
  effects: EmbedEffect[]
): void {
  const entry = pendingIds(before)
  if (event.type === 'intent' || event.type === 'relaunch') entry.push(event.launch.launchId)
  const stillPending = new Set(pendingIds(after))
  const settled = new Set<LaunchId>()
  for (const e of effects) if (e.type === 'launchSettled') settled.add(e.launchId)
  for (const id of entry) {
    if (stillPending.has(id) || settled.has(id)) continue
    settled.add(id)
    effects.push({ type: 'launchSettled', launchId: id, outcome: 'abandoned' })
  }
}

/** Returns `previous` when `next` holds the very same field values. */
function reuseIfUnchanged(
  previous: EmbedOwnershipState,
  next: EmbedOwnershipState
): EmbedOwnershipState {
  return previous.activeAppTabId === next.activeAppTabId &&
    previous.lastRoute === next.lastRoute &&
    previous.owner === next.owner &&
    previous.views === next.views &&
    previous.handoffs === next.handoffs &&
    previous.failure === next.failure
    ? previous
    : next
}

export function reduceEmbedOwnership(
  state: EmbedOwnershipState,
  event: EmbedEvent
): EmbedTransition {
  const row = applyRow(state, event)
  let next = row.state
  const effects = row.effects

  if (row.failure) {
    next = { ...next, failure: row.failure }
  } else if (
    next.failure !== null &&
    (next.owner !== state.owner || next.activeAppTabId !== state.activeAppTabId)
  ) {
    next = { ...next, failure: null }
  }

  next = sweep(next, effects)
  if (row.handoffRequestId !== undefined) {
    // Taken after the sweep so it only names views main still has to release.
    const handoff: EmbedHandoff = {
      requestId: row.handoffRequestId,
      waitFor: new Set(next.views.keys()),
      ownerLaunchId: row.handoffOwnerLaunchId ?? null,
    }
    next = { ...next, handoffs: [...next.handoffs, handoff] }
  }
  next = advance(next, effects)
  next = completeHandoffs(next, effects)
  // A handoff added and completed in this same reduce leaves a fresh empty array;
  // keeping the old one lets reuseIfUnchanged return `previous` when nothing else moved.
  if (next.handoffs.length === 0 && state.handoffs.length === 0) {
    next = next.handoffs === state.handoffs ? next : { ...next, handoffs: state.handoffs }
  }
  settle(state, next, event, effects)

  return { state: reuseIfUnchanged(state, next), effects }
}
