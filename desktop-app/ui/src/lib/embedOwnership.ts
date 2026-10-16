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
 * Who owns the embedded app view — pure algebra, same contract as
 * `workspaceTabs.ts`: `(state, event) → { state, effects }`, no I/O, no clocks, no
 * id generation, and an unchanged state is returned by reference with `[]`.
 *
 * Main is the only authority on which view exists; the tab store is the only
 * authority on which tab is active (it arrives here as `projected`). This reducer
 * only decides which launch owns the active tab and what to ask main for.
 *
 * Every transition is followed by the level rules, in this order:
 *   sweep   — a record that is not the owner is dropped if main never saw it, or
 *             CAS-closed once if it did;
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
  v.phase === 'waiting' || v.phase === 'measuring' || v.phase === 'opening'

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

/** Nothing of the launch's tab is still alive in a non-closing phase. */
function tabIsFree(state: EmbedOwnershipState, launch: Launch): boolean {
  for (const v of state.views.values()) {
    if (v.tabId === launch.tabId && v.phase !== 'closeRequested') return false
  }
  return true
}

function takeOwnership(state: EmbedOwnershipState, launch: Launch): EmbedOwnershipState {
  return { ...withView(state, { ...launch, phase: 'waiting' }), owner: launch.launchId }
}

type RowResult = {
  state: EmbedOwnershipState
  effects: EmbedEffect[]
  /** Set by the rows that record a failure; everything else clears it on an ownership change. */
  failure?: EmbedFailure
  /** A handoff whose wait set is taken after the sweep. */
  handoffRequestId?: number
}

function applyRow(state: EmbedOwnershipState, event: EmbedEvent): RowResult {
  const unchanged: RowResult = { state, effects: [] }
  switch (event.type) {
    case 'projected': {
      if (event.activeAppTabId === state.activeAppTabId) return unchanged
      const ownerTab = state.owner === null ? null : state.views.get(state.owner)?.tabId
      return {
        state: {
          ...state,
          activeAppTabId: event.activeAppTabId,
          owner: ownerTab === event.activeAppTabId ? state.owner : null,
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
      return { state: takeOwnership(state, event.launch), effects: [] }
    }

    case 'backToApps':
      return state.owner === null ? unchanged : { state: { ...state, owner: null }, effects: [] }

    case 'handoff':
      return {
        state: state.owner === null ? state : { ...state, owner: null },
        effects: [],
        handoffRequestId: event.requestId,
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
      // Main could not confirm the close; treat the view as gone so the tab is not stuck.
      return { state: withoutView(state, record.launchId), effects: [] }
    }

    case 'released': {
      const record = state.views.get(event.launchId)
      if (!record) return unchanged
      let next = withoutView(state, record.launchId)
      const wasOwner = record.launchId === state.owner
      if (wasOwner) next = { ...next, owner: null }
      const effects: EmbedEffect[] = []
      if (event.location !== null) {
        const lastRoute = new Map(next.lastRoute)
        const route = persistedRoute(event.location)
        lastRoute.set(record.tabId, route.action === 'set' ? { routePath: route.routePath } : {})
        next = { ...next, lastRoute }
        effects.push({ type: 'persistRoute', tabId: record.tabId, route })
      }
      // Only a view the user was looking at counts as a crash; one still opening
      // settles as abandoned instead of showing "closed unexpectedly".
      const crashed = event.reason === 'crashed' && wasOwner && record.phase === 'mounted'
      return {
        state: next,
        effects,
        ...(crashed
          ? {
              failure: { tabId: record.tabId, launchId: record.launchId, kind: 'crashed' as const },
            }
          : {}),
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
    }
    next = { ...next, handoffs: [...next.handoffs, handoff] }
  }
  next = advance(next, effects)
  next = completeHandoffs(next, effects)
  if (next.handoffs.length === 0 && state.handoffs.length === 0) {
    next = next.handoffs === state.handoffs ? next : { ...next, handoffs: state.handoffs }
  }
  settle(state, next, event, effects)

  return { state: reuseIfUnchanged(state, next), effects }
}
