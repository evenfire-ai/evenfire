import { useSyncExternalStore } from 'react'
import { isCancelledError } from '@tanstack/react-query'
import type { Query, QueryCacheNotifyEvent, QueryClient } from '@tanstack/react-query'
import type { PermissionErrorItem } from './PermissionErrorDialog/types'

type FailureEntry = {
  projection: string | null
  token: symbol | null
  acknowledged: Set<symbol>
  attempt: {
    owner: string
    bindingKey: string
    token: symbol
    unknownRollback: boolean
    revertEventObserved: boolean
    retryFailureAdapter?: NonNullable<PermissionErrorItem['onRetryFailure']>
  } | null
  retryOrigin: { owner: string; bindingKey: string } | null
  lastObservedState: Query['state']
  rollbackState: Query['state'] | null
  rollbackUnknown: boolean
  retryFailure: boolean
  requestedToken: symbol | null
}

type QueryBinding = {
  bindingKey: string
  sessionScope: string | null
  sessionGeneration: number | null
  queries: Set<Query>
  errors: PermissionErrorItem[]
  complete: boolean
  active: boolean
}

type PermissionAuthorityRoute = {
  owner: string
  scope: string
  generation: number
  isAuthorityFailure: (error: unknown) => boolean
  handleAuthorityFailure: (error: unknown) => boolean
}

const entries = new WeakMap<Query, FailureEntry>()
const installedCaches = new WeakSet<object>()
const queryClients = new WeakMap<Query, QueryClient>()
const authorityRoutes = new WeakMap<Query, PermissionAuthorityRoute[]>()
const queryBindings = new Map<string, QueryBinding>()
const listeners = new Set<() => void>()
let snapshot = 0

function publish(): void {
  snapshot += 1
  for (const listener of listeners) listener()
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
      attempt: null,
      retryOrigin: null,
      lastObservedState: query.state,
      rollbackState: null,
      // An active Query may predate installation, so QueryCore's private revert state is unknown.
      rollbackUnknown: query.state.fetchStatus !== 'idle',
      retryFailure: false,
      requestedToken: null,
    }
    entries.set(query, entry)
  }
  return entry
}

function onQueryEvent(event: QueryCacheNotifyEvent, client?: QueryClient): void {
  if (event.type === 'added') {
    const query = event.query as Query
    if (client) queryClients.set(query, client)
    if (query.state.status === 'error') entryFor(query)
    return
  }
  if (event.type === 'removed') {
    const removedQuery = event.query as Query
    const entry = entries.get(removedQuery)
    if (entry) entry.attempt = null
    for (const [owner, binding] of queryBindings) {
      binding.queries.delete(removedQuery)
      binding.errors = binding.errors.filter(error => error.queryIdentity !== removedQuery)
      if (!binding.active && binding.queries.size === 0) queryBindings.delete(owner)
    }
    queryClients.delete(removedQuery)
    authorityRoutes.delete(removedQuery)
    entries.delete(removedQuery)
    publish()
    return
  }
  if (event.type !== 'updated') return

  const query = event.query as Query
  const entry = entryFor(query)
  if (event.action.type === 'setState' && event.action.state === query.resetState) {
    entry.projection = null
    entry.token = null
    entry.attempt = null
    entry.retryOrigin = null
    entry.rollbackState = null
    entry.rollbackUnknown = false
    entry.retryFailure = false
    entry.requestedToken = null
    entry.lastObservedState = query.state
    publish()
    return
  }

  if (event.action.type === 'fetch') {
    entry.rollbackState = entry.lastObservedState
    entry.rollbackUnknown = false
  } else if (
    event.action.type === 'setState' &&
    entry.attempt &&
    entry.rollbackState &&
    entry.rollbackState.data === undefined
  ) {
    const rollback = entry.rollbackState
    const state = query.state
    const restored =
      state.fetchStatus === 'idle' &&
      Object.keys(state).length === Object.keys(rollback).length &&
      Object.keys(rollback).every(key =>
        key === 'fetchStatus'
          ? state.fetchStatus === 'idle'
          : Object.is(state[key as keyof typeof state], rollback[key as keyof typeof rollback])
      )
    if (restored) {
      entry.attempt = null
      entry.rollbackState = null
      entry.rollbackUnknown = false
      entry.requestedToken = null
    }
  } else if (
    event.action.type === 'setState' &&
    event.action.state !== query.resetState &&
    entry.attempt?.unknownRollback &&
    query.state.fetchStatus === 'idle'
  ) {
    // Do not settle an unknown baseline from setState alone; the attempt promise must confirm revert.
    entry.attempt.revertEventObserved = true
  }
  if (
    event.action.type === 'error' ||
    (event.action.type === 'success' && event.action.manual !== true)
  ) {
    entry.rollbackUnknown = false
  }

  if (query.state.status === 'success') {
    const terminalSuccess = event.action.type === 'success' && event.action.manual !== true
    if (terminalSuccess && (entry.projection !== null || entry.token !== null || entry.attempt)) {
      entry.projection = null
      entry.token = null
      if (terminalSuccess) {
        entry.attempt = null
        entry.rollbackState = null
        entry.rollbackUnknown = false
      }
      entry.retryFailure = false
      entry.retryOrigin = null
      entry.requestedToken = null
      entry.lastObservedState = query.state
      publish()
    } else {
      entry.lastObservedState = query.state
    }
    return
  }

  if (event.action.type !== 'error' || query.state.status !== 'error') {
    entry.lastObservedState = query.state
    if (event.action.type === 'setState') publish()
    return
  }
  const authorityRoute = authorityRoutes
    .get(query)
    ?.find(route => route.isAuthorityFailure(query.state.error))
  if (authorityRoute) {
    authorityRoute.handleAuthorityFailure(query.state.error)
    entry.projection = null
    entry.token = null
    entry.attempt = null
    entry.retryOrigin = null
    entry.rollbackState = null
    entry.rollbackUnknown = false
    entry.retryFailure = false
    entry.requestedToken = null
    entry.lastObservedState = query.state
    publish()
    return
  }
  const projection = errorProjection(query.state.error)
  if (entry.token === null || entry.projection !== projection || entry.attempt) {
    const terminalAttempt = entry.attempt
    entry.projection = projection
    entry.token = Symbol('permission-failure')
    entry.retryFailure = Boolean(entry.attempt)
    if (terminalAttempt) {
      entry.retryOrigin = {
        owner: terminalAttempt.owner,
        bindingKey: terminalAttempt.bindingKey,
      }
      const owner = queryBindings.get(terminalAttempt.owner)
      if (
        terminalAttempt.owner !== 'unbound' &&
        (!owner?.active ||
          owner.bindingKey !== terminalAttempt.bindingKey ||
          !owner.queries.has(query) ||
          !queryClients.get(query)?.getQueryCache().getAll().includes(query))
      ) {
        entry.acknowledged.add(entry.token)
      }
      entry.attempt = null
      entry.rollbackState = null
      entry.rollbackUnknown = false
    }
    entry.requestedToken = null
    entry.lastObservedState = query.state
    if (terminalAttempt && terminalAttempt.owner !== 'unbound') {
      const owner = queryBindings.get(terminalAttempt.owner)
      if (
        owner?.active &&
        owner.bindingKey === terminalAttempt.bindingKey &&
        owner.queries.has(query) &&
        queryClients.get(query)?.getQueryCache().getAll().includes(query)
      ) {
        const adapter =
          terminalAttempt.retryFailureAdapter ??
          [...owner.errors].reverse().find(error => error.queryIdentity === query)?.onRetryFailure
        const disposition = adapter?.(query.state.error, {
          isOriginCurrent: () => {
            const liveOwner = queryBindings.get(terminalAttempt.owner)
            return Boolean(
              entries.get(query)?.token === entry.token &&
              liveOwner?.active &&
              liveOwner.bindingKey === terminalAttempt.bindingKey &&
              liveOwner.queries.has(query) &&
              queryClients.get(query)?.getQueryCache().getAll().includes(query)
            )
          },
        })
        if (disposition === 'stale') entry.acknowledged.add(entry.token)
      }
    }
    publish()
  } else {
    entry.lastObservedState = query.state
    publish()
  }
}

/** Install once per QueryCache before permission presenters render. */
export function installPermissionErrorTracking(client: QueryClient): void {
  const cache = client.getQueryCache()
  if (installedCaches.has(cache)) return
  installedCaches.add(cache)
  cache.subscribe(event => onQueryEvent(event, client))
  for (const query of cache.getAll()) {
    queryClients.set(query as Query, client)
    entryFor(query as Query)
  }
}

/** Publish a committed semantic producer binding; abandoned renders never call this API. */
export function commitPermissionQueryBinding(
  owner: string,
  bindingKey: string,
  queries: Iterable<Query>,
  options: {
    complete?: boolean
    sessionScope?: string | null
    sessionGeneration?: number | null
    authorityRoute?: Omit<PermissionAuthorityRoute, 'owner'>
  } = {}
): void {
  const sessionScope = options.sessionScope ?? options.authorityRoute?.scope ?? null
  const sessionGeneration = options.sessionGeneration ?? options.authorityRoute?.generation ?? null
  const nextQueries = new Set(queries)
  const previous = queryBindings.get(owner)
  if (previous) {
    if (
      previous.bindingKey === bindingKey &&
      previous.sessionScope === sessionScope &&
      previous.sessionGeneration === sessionGeneration &&
      options.complete === false
    ) {
      for (const query of previous.queries) nextQueries.add(query)
    }
  }
  const unchanged =
    previous?.bindingKey === bindingKey &&
    previous.sessionScope === sessionScope &&
    previous.sessionGeneration === sessionGeneration &&
    previous.active &&
    previous.queries.size === nextQueries.size &&
    [...nextQueries].every(query => previous.queries.has(query))
  queryBindings.set(owner, {
    bindingKey,
    sessionScope,
    sessionGeneration,
    queries: nextQueries,
    errors:
      previous?.bindingKey === bindingKey &&
      previous.sessionScope === sessionScope &&
      previous.sessionGeneration === sessionGeneration
        ? previous.errors
        : [],
    complete: options.complete !== false,
    active: true,
  })
  if (options.authorityRoute) {
    for (const query of nextQueries) {
      const routes = authorityRoutes.get(query) ?? []
      const route = { ...options.authorityRoute, owner }
      const retained = routes.filter(
        candidate =>
          candidate.owner !== owner ||
          candidate.scope !== route.scope ||
          candidate.generation !== route.generation
      )
      retained.push(route)
      authorityRoutes.set(query, retained)
    }
  }
  if (!unchanged) publish()
}

/** Commit ephemeral producer descriptors and the latest page adapter for this origin. */
export function commitPermissionErrorDescriptors(
  owner: string,
  bindingKey: string,
  errors: PermissionErrorItem[]
): void {
  const binding = queryBindings.get(owner)
  if (!binding || binding.bindingKey !== bindingKey) return
  const previousErrors = binding.errors
  const retained = previousErrors.filter(error => {
    const query = error.queryIdentity
    if (!query || errors.some(candidate => candidate.queryIdentity === query)) return false
    const entry = entries.get(query)
    return Boolean(
      binding.queries.has(query) &&
      queryClients.get(query)?.getQueryCache().getAll().includes(query) &&
      entry?.token &&
      query.state.status !== 'success' &&
      (!binding.complete || query.state.fetchStatus !== 'idle')
    )
  })
  const nextErrors = [...errors, ...retained]
  const changed =
    previousErrors.length !== nextErrors.length ||
    nextErrors.some(
      (error, index) =>
        previousErrors[index]?.id !== error.id ||
        previousErrors[index]?.message !== error.message ||
        previousErrors[index]?.queryIdentity !== error.queryIdentity ||
        previousErrors[index]?.errorUpdateCount !== error.errorUpdateCount
    )
  // A refetch temporarily removes page-level error descriptors while the
  // Query is fetching (and may report `pending` when it has no cached data).
  // Keep the committed producer descriptor for that same live owner/Query
  // episode until success/reset/removal ends the Common-owned token. A new
  // binding cannot inherit it because its committed Query set is different.
  binding.errors = nextErrors
  for (const error of errors) {
    if (error.queryIdentity) {
      binding.queries.add(error.queryIdentity)
      const attempt = entries.get(error.queryIdentity)?.attempt
      if (attempt?.owner === owner && attempt.bindingKey === bindingKey) {
        attempt.retryFailureAdapter = error.onRetryFailure
      }
    }
  }
  if (changed) publish()
}

/** Keep a binding active during a seed only when its committed session still matches. */
export function preservePermissionQueryBinding(
  owner: string,
  sessionScope: string | null,
  sessionGeneration: number | null
): boolean {
  const binding = queryBindings.get(owner)
  if (!binding) return false
  if (binding.sessionScope !== sessionScope || binding.sessionGeneration !== sessionGeneration) {
    if (binding.active) {
      binding.active = false
      publish()
    }
    return false
  }
  if (!binding.active) {
    binding.active = true
    publish()
  }
  return true
}

/** Presenter cleanup retains its dormant set so a same-binding remount is continuous. */
export function deactivatePermissionQueryBinding(owner: string): void {
  const binding = queryBindings.get(owner)
  if (!binding) return
  binding.active = false
  publish()
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

/** True only when the current Query failure token came from an admitted Retry. */
export function isPermissionRetryFailure(error: PermissionErrorItem): boolean {
  if (!error.queryIdentity) return false
  const token = error.token ?? permissionErrorToken(error)
  const entry = entries.get(error.queryIdentity)
  return Boolean(token && entry?.token === token && entry.retryFailure)
}

/** Silent Query cancellation is neutral while QueryCore starts the replacement fetch. */
export function isSilentPermissionRetryCancellation(error: unknown): boolean {
  return isCancelledError(error) && error.silent === true
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
  if (!admitted) return
  if (entry.attempt) return
  const token = error.token ?? permissionErrorToken(error)
  if (!token) return
  entry.attempt = {
    owner: 'unbound',
    bindingKey: '',
    token,
    unknownRollback: false,
    revertEventObserved: false,
  }
  if (!entry.retryOrigin) entry.retryOrigin = { owner: 'unbound', bindingKey: '' }
  entry.acknowledged.add(token)
  publish()
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

/** Return the committed owner projection; acknowledgement and Retry admission stay centralized. */
export function getPermissionErrorsForOwner(owner: string): {
  errors: PermissionErrorItem[]
  acknowledged: PermissionErrorItem[]
} {
  const binding = queryBindings.get(owner)
  if (!binding?.active) return { errors: [], acknowledged: [] }
  const errors: PermissionErrorItem[] = []
  const acknowledged: PermissionErrorItem[] = []
  for (const source of binding.errors) {
    const query = source.queryIdentity
    if (!query) {
      errors.push(source)
      continue
    }
    const client = queryClients.get(query)
    if (!client?.getQueryCache().getAll().includes(query)) continue
    const entry = entryFor(query)
    const token = entry.token
    if (!token) continue
    if (
      entry.retryFailure &&
      entry.retryOrigin &&
      (entry.retryOrigin.owner !== owner || entry.retryOrigin.bindingKey !== binding.bindingKey)
    )
      continue
    const currentQuery = queryBindings.get(owner)?.queries.has(query)
    if (!currentQuery) continue
    const item: PermissionErrorItem = { ...source, token }
    if (entry.acknowledged.has(token)) {
      acknowledged.push(item)
      if (entry.requestedToken !== token) continue
    }
    const originalRetry = source.retry
    if (originalRetry) {
      item.retry = context => {
        const current = queryBindings.get(owner)
        if (!current?.active || current.bindingKey !== binding.bindingKey)
          return { admitted: false }
        const retrySource = [...current.errors]
          .reverse()
          .find(candidate => candidate.queryIdentity === query)
        const retryAdapter = retrySource?.retry
        if (!retryAdapter) return { admitted: false }
        const retryFailureAdapter = retrySource.onRetryFailure
        let admitted = false
        const result = retryAdapter({
          onAdmitted: () => {
            const live = queryBindings.get(owner)
            const activeAttempt = entries.get(query)?.attempt
            if (
              !live?.active ||
              live.bindingKey !== binding.bindingKey ||
              !live.queries.has(query) ||
              entries.get(query)?.token !== token ||
              admitted ||
              (activeAttempt &&
                (activeAttempt.owner !== owner || activeAttempt.bindingKey !== binding.bindingKey))
            )
              return false
            admitted = true
            const liveEntry = entryFor(query)
            liveEntry.attempt = {
              owner,
              bindingKey: binding.bindingKey,
              token,
              unknownRollback: liveEntry.rollbackUnknown,
              revertEventObserved: false,
              retryFailureAdapter,
            }
            liveEntry.acknowledged.add(token)
            publish()
            return true
          },
          isOriginCurrent: () => {
            const live = queryBindings.get(owner)
            return Boolean(
              live?.active &&
              live.bindingKey === binding.bindingKey &&
              live.queries.has(query) &&
              entries.get(query)?.token === token
            )
          },
        })
        if (!admitted || !result.admitted) {
          return { admitted: false, completion: result.completion }
        }
        const admittedAttempt = entries.get(query)?.attempt
        const settleUnknownRollback = (error?: unknown, value?: unknown) => {
          const liveEntry = entries.get(query)
          const liveAttempt = liveEntry?.attempt
          if (
            !liveEntry ||
            !liveAttempt ||
            liveAttempt !== admittedAttempt ||
            !liveAttempt.unknownRollback ||
            !liveAttempt.revertEventObserved ||
            query.state.fetchStatus !== 'idle' ||
            !queryClients.get(query)?.getQueryCache().getAll().includes(query)
          )
            return
          if (error !== undefined && (!isCancelledError(error) || error.revert !== true)) return
          if (error === undefined && !Object.is(query.state.data, value)) return
          liveEntry.attempt = null
          liveEntry.rollbackState = null
          liveEntry.rollbackUnknown = false
          liveEntry.requestedToken = null
          publish()
        }
        if (result.completion) {
          void result.completion.then(
            value => settleUnknownRollback(undefined, value),
            error => settleUnknownRollback(error)
          )
        }
        return result
      }
    }
    errors.push(item)
  }
  return { errors, acknowledged }
}
