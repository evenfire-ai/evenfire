import { useSyncExternalStore } from 'react'
import type { Query, QueryCacheNotifyEvent, QueryClient } from '@tanstack/react-query'
import type { PermissionErrorItem } from './PermissionErrorDialog/types'

type FailureEntry = {
  projection: string | null
  token: symbol | null
  acknowledged: Set<symbol>
  retryPending: boolean
  requestedToken: symbol | null
}

type QueryBinding = {
  bindingKey: string
  queries: Set<Query>
  active: boolean
}

const entries = new WeakMap<Query, FailureEntry>()
const installedCaches = new WeakSet<object>()
const queryBindings = new Map<string, QueryBinding>()
const pendingDepartures = new Set<Query>()
const listeners = new Set<() => void>()
let snapshot = 0
let bindingReconcileQueued = false

function publish(): void {
  snapshot += 1
  for (const listener of listeners) listener()
}

function reconcilePermissionQueryBindings(): void {
  bindingReconcileQueued = false
  for (const query of pendingDepartures) {
    if ([...queryBindings.values()].some(binding => binding.active && binding.queries.has(query))) {
      continue
    }
    const entry = entries.get(query)
    if (!entry?.token) continue
    entry.token = Symbol('permission-binding-failure')
    entry.requestedToken = null
    publish()
  }
  pendingDepartures.clear()
}

function scheduleBindingReconciliation(): void {
  if (bindingReconcileQueued) return
  bindingReconcileQueued = true
  queueMicrotask(reconcilePermissionQueryBindings)
}

function errorProjection(error: unknown): string {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; httpStatus?: unknown; status?: unknown }
    return JSON.stringify([
      error.name,
      error.message,
      typeof candidate.code === 'string' ? candidate.code : null,
      typeof candidate.httpStatus === 'number' ? candidate.httpStatus : null,
      typeof candidate.status === 'number' ? candidate.status : null,
    ])
  }
  return JSON.stringify(['unknown', String(error)])
}

function entryFor(query: Query): FailureEntry {
  let entry = entries.get(query)
  if (!entry) {
    const failed = query.state.status === 'error'
    entry = {
      projection: failed ? errorProjection(query.state.error) : null,
      token: failed ? Symbol('permission-failure') : null,
      acknowledged: new Set(),
      retryPending: false,
      requestedToken: null,
    }
    entries.set(query, entry)
  }
  return entry
}

function onQueryEvent(event: QueryCacheNotifyEvent): void {
  if (event.type === 'added') {
    const query = event.query as Query
    if (query.state.status === 'error') entryFor(query)
    return
  }
  if (event.type === 'removed') {
    entries.delete(event.query as Query)
    publish()
    return
  }
  if (event.type !== 'updated') return

  const query = event.query as Query
  const entry = entryFor(query)
  if (event.action.type === 'setState' && event.action.state === query.resetState) {
    entry.projection = null
    entry.token = null
    entry.retryPending = false
    entry.requestedToken = null
    publish()
    return
  }

  if (query.state.status === 'success') {
    if (entry.projection !== null || entry.token !== null || entry.retryPending) {
      entry.projection = null
      entry.token = null
      entry.retryPending = false
      entry.requestedToken = null
      publish()
    }
    return
  }

  if (event.action.type !== 'error' || query.state.status !== 'error') return
  const projection = errorProjection(query.state.error)
  if (entry.token === null || entry.projection !== projection || entry.retryPending) {
    entry.projection = projection
    entry.token = Symbol('permission-failure')
    entry.retryPending = false
    entry.requestedToken = null
    publish()
  } else {
    publish()
  }
}

/** Install once per QueryCache before permission presenters render. */
export function installPermissionErrorTracking(client: QueryClient): void {
  const cache = client.getQueryCache()
  if (installedCaches.has(cache)) return
  installedCaches.add(cache)
  cache.subscribe(onQueryEvent)
  for (const query of cache.getAll()) entryFor(query as Query)
}

/** Publish a committed semantic producer binding; abandoned renders never call this API. */
export function commitPermissionQueryBinding(
  owner: string,
  bindingKey: string,
  queries: Iterable<Query>,
  options: { complete?: boolean } = {}
): void {
  const nextQueries = new Set(queries)
  const previous = queryBindings.get(owner)
  if (previous) {
    if (previous.bindingKey === bindingKey && options.complete === false) {
      for (const query of previous.queries) nextQueries.add(query)
    }
    for (const query of previous.queries) {
      if (!nextQueries.has(query)) pendingDepartures.add(query)
    }
  }
  queryBindings.set(owner, { bindingKey, queries: nextQueries, active: true })
  scheduleBindingReconciliation()
}

/** Keep the last committed binding active while a persisted location seed resolves. */
export function preservePermissionQueryBinding(owner: string): void {
  const binding = queryBindings.get(owner)
  if (binding) binding.active = true
}

/** Presenter cleanup retains its dormant set so a same-binding remount is continuous. */
export function deactivatePermissionQueryBinding(owner: string): void {
  const binding = queryBindings.get(owner)
  if (!binding) return
  binding.active = false
  scheduleBindingReconciliation()
}

/** Stable external-store contract used by Files and Preview presentations. */
export function subscribePermissionErrorAcknowledgements(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getPermissionErrorAcknowledgementSnapshot(): number {
  return snapshot
}

export function usePermissionErrorAcknowledgementSnapshot(): number {
  return useSyncExternalStore(
    subscribePermissionErrorAcknowledgements,
    getPermissionErrorAcknowledgementSnapshot,
    getPermissionErrorAcknowledgementSnapshot
  )
}

export function permissionErrorToken(error: PermissionErrorItem): symbol | undefined {
  if (!error.queryIdentity) return undefined
  const query = error.queryIdentity
  const entry = entryFor(query)
  if (query.state.status === 'error' && entry.token === null) {
    entry.projection = errorProjection(query.state.error)
    entry.token = Symbol('permission-failure')
  }
  return entry.token ?? undefined
}

export function isPermissionErrorAcknowledged(error: PermissionErrorItem): boolean {
  if (!error.queryIdentity) return false
  const token = error.token ?? permissionErrorToken(error)
  return token ? entryFor(error.queryIdentity).acknowledged.has(token) : false
}

export function acknowledgePermissionErrors(errors: PermissionErrorItem[]): void {
  let changed = false
  for (const error of errors) {
    if (!error.queryIdentity) continue
    const token = error.token ?? permissionErrorToken(error)
    if (!token) continue
    const acknowledged = entryFor(error.queryIdentity).acknowledged
    if (!acknowledged.has(token)) {
      acknowledged.add(token)
      changed = true
    }
  }
  if (changed) publish()
}

/** Mark only an admitted user Retry as capable of producing a new same-error token. */
export function recordPermissionRetry(error: PermissionErrorItem, admitted: boolean): void {
  if (!error.queryIdentity) return
  const entry = entryFor(error.queryIdentity)
  if (admitted) entry.retryPending = true
}

export function isPermissionErrorRecoveryRequested(error: PermissionErrorItem): boolean {
  if (!error.queryIdentity) return false
  const token = error.token ?? permissionErrorToken(error)
  return Boolean(token && entryFor(error.queryIdentity).requestedToken === token)
}

export function requestPermissionErrorRecovery(error: PermissionErrorItem): void {
  if (!error.queryIdentity) return
  const token = error.token ?? permissionErrorToken(error)
  if (!token) return
  const entry = entryFor(error.queryIdentity)
  if (entry.token !== token || entry.requestedToken === token) return
  entry.requestedToken = token
  publish()
}

export function clearPermissionErrorRecovery(errors: PermissionErrorItem[]): void {
  let changed = false
  for (const error of errors) {
    if (!error.queryIdentity) continue
    const token = error.token ?? permissionErrorToken(error)
    const entry = entryFor(error.queryIdentity)
    if (token && entry.requestedToken === token) {
      entry.requestedToken = null
      changed = true
    }
  }
  if (changed) publish()
}
