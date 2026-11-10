import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { Query, QueryClient, QueryKey, QueryPersister } from '@tanstack/react-query'
import { assertGfsAuthorityRetryAllowed } from '@lib/gfsAuthorityQueryPolicy'

type QueryOperationKind = 'full' | 'forward'
type BindingKind = 'root' | 'controller-child' | 'composer-child'
type BindingPhase = 'pending' | 'validated' | 'failed' | 'retired'

type Operation = {
  query: Query
  ordinal: number
  kind: QueryOperationKind
  promise: Promise<unknown> | undefined
  startedAtBind: Set<Binding>
  rawResult?: object
  error?: unknown
  outcome: 'pending' | 'success' | 'failure' | 'retired'
  forwardOwners?: Set<string>
  attributed: boolean
}

type BindingSnapshot = {
  phase: BindingPhase
  error: unknown | null
  busy: boolean
  retrying: boolean
}

type Binding = {
  id: number
  kind: BindingKind
  query: Query
  live: boolean
  ordinal: number
  eligibleAfterOrdinal?: number
  joinedOperation: Operation | null
  autoOpportunity: 'available' | 'reserved' | 'consumed' | 'retired'
  snapshot: BindingSnapshot
  listeners: Set<() => void>
}

type QueryRecord = {
  query: Query
  ordinal: number
  lastFullSuccessOrdinal: number
  active: Operation | null
  bindings: Set<Binding>
  resultOperations: WeakMap<object, Operation>
  errorOperations: WeakMap<object, Operation>
  queuedForward: Map<string, () => Promise<unknown>>
  forwardOwners: Set<string>
  forwardListeners: Map<string, Set<() => void>>
}

type ClientRecord = {
  queryClient: QueryClient
  records: Map<Query, QueryRecord>
  nextOrdinal: number
  nextBindingId: number
  unsubscribe: () => void
}

const clients = new WeakMap<QueryClient, ClientRecord>()
const policies = new WeakMap<QueryClient, ReturnType<typeof createPolicy>>()

function isGfsQuery(query: Query): boolean {
  return query.queryKey[0] === 'desktop-app' && query.queryKey[1] === 'gfs'
}

function notify(binding: Binding) {
  for (const listener of [...binding.listeners]) listener()
}

function setSnapshot(binding: Binding, next: BindingSnapshot) {
  if (
    binding.snapshot.phase === next.phase &&
    binding.snapshot.error === next.error &&
    binding.snapshot.busy === next.busy &&
    binding.snapshot.retrying === next.retrying
  ) {
    return
  }
  binding.snapshot = next
  notify(binding)
}

function notifyForwardOwner(record: QueryRecord, ownerId: string) {
  for (const listener of [...(record.forwardListeners.get(ownerId) ?? [])]) listener()
}

function queryIsCurrent(client: ClientRecord, query: Query): boolean {
  return client.queryClient.getQueryCache().getAll().includes(query)
}

function dispatchAutomaticFull(client: ClientRecord, binding: Binding) {
  const query = binding.query
  if (
    !binding.live ||
    binding.autoOpportunity !== 'available' ||
    !queryIsCurrent(client, query) ||
    query.state.fetchStatus === 'paused'
  ) {
    return
  }

  const record = client.records.get(query)
  if (!record) return
  const active = record.active
  if (active?.outcome === 'pending') {
    if (
      active.kind === 'full' &&
      (active.startedAtBind.has(binding) || active.ordinal > binding.ordinal)
    ) {
      binding.autoOpportunity = 'consumed'
      return
    }
    binding.joinedOperation = active
    return
  }
  if (query.state.fetchStatus !== 'idle') {
    binding.joinedOperation = active ?? null
    return
  }

  // Reserve before refetchQueries can synchronously notify QueryCache observers.
  // The persister entry consumes this opportunity when the actual full starts.
  binding.autoOpportunity = 'reserved'
  binding.snapshot = {
    ...binding.snapshot,
    phase: 'pending',
    busy: true,
  }
  notify(binding)
  void client.queryClient.refetchQueries(
    { exact: true, queryKey: query.queryKey, type: 'active' },
    { cancelRefetch: false, throwOnError: false }
  )
}

function settleOperation(
  client: ClientRecord,
  operation: Operation,
  outcome: 'success' | 'failure'
) {
  operation.outcome = outcome
  const record = client.records.get(operation.query)
  if (!record || !queryIsCurrent(client, operation.query)) return
  if (operation.kind === 'forward') {
    for (const ownerId of operation.forwardOwners ?? []) {
      record.forwardOwners.delete(ownerId)
      notifyForwardOwner(record, ownerId)
    }
  }

  for (const binding of [...record.bindings]) {
    if (!binding.live || binding.joinedOperation !== operation) continue
    binding.joinedOperation = null
    if (binding.snapshot.retrying) {
      setSnapshot(binding, { ...binding.snapshot, retrying: false })
    }
    if (
      (binding.kind === 'composer-child' || binding.kind === 'controller-child') &&
      binding.autoOpportunity === 'available'
    ) {
      // An ineligible pre-bind query operation has settled. Give the live
      // child binding one bounded post-bind full evaluation.
      queueMicrotask(() => {
        if (binding.live && binding.autoOpportunity === 'available') {
          dispatchAutomaticFull(client, binding)
        }
      })
    }
  }
}

function clientRecord(queryClient: QueryClient): ClientRecord {
  const existing = clients.get(queryClient)
  if (existing) return existing

  const record: ClientRecord = {
    queryClient,
    records: new Map(),
    nextOrdinal: 0,
    nextBindingId: 0,
    unsubscribe: () => undefined,
  }

  record.unsubscribe = queryClient.getQueryCache().subscribe(event => {
    const query = event.query
    if (!isGfsQuery(query)) return
    const queryRecord = record.records.get(query)

    if (event.type === 'removed') {
      if (!queryRecord) return
      for (const binding of queryRecord.bindings) {
        binding.live = false
        binding.autoOpportunity = 'retired'
        setSnapshot(binding, { phase: 'retired', error: null, busy: false, retrying: false })
      }
      queryRecord.active && (queryRecord.active.outcome = 'retired')
      for (const ownerId of queryRecord.queuedForward.keys())
        notifyForwardOwner(queryRecord, ownerId)
      queryRecord.queuedForward.clear()
      for (const ownerId of queryRecord.forwardOwners) notifyForwardOwner(queryRecord, ownerId)
      queryRecord.forwardOwners.clear()
      record.records.delete(query)
      return
    }

    if (event.type === 'added') {
      if (!queryRecord) ensureQueryRecord(record, query)
      return
    }
    if (!queryRecord || event.type !== 'updated') return
    const action = event.action
    if (action.type === 'invalidate') {
      // Composer child rows are a projection of a permission-derived parent
      // snapshot. Retire that projection synchronously on every exact Query
      // invalidation, including when a forward page settled just before the
      // event. A later full success releases the binding again.
      for (const binding of queryRecord.bindings) {
        if (binding.live && binding.kind === 'composer-child') {
          binding.joinedOperation = null
          binding.autoOpportunity = 'available'
          setSnapshot(binding, {
            phase: 'pending',
            error: null,
            busy: true,
            retrying: false,
          })
        }
      }
      return
    }
    if (action.type === 'setState' && action.state.data === undefined) {
      // QueryClient.resetQueries clears the cached discovery before it starts
      // its normal refetch. Treat that cache reset as a new freshness debt so
      // a previously validated binding cannot keep rendering the cleared or
      // pre-reset snapshot during the transition.
      for (const binding of queryRecord.bindings) {
        if (!binding.live) continue
        binding.joinedOperation = null
        binding.autoOpportunity = 'available'
        setSnapshot(binding, {
          phase: 'pending',
          error: null,
          busy: query.state.fetchStatus !== 'idle',
          retrying: false,
        })
      }
      return
    }
    if (action.type === 'fetch') {
      const existing = queryRecord.active
      const supersededComposerForward =
        existing?.outcome === 'pending' && existing.kind === 'forward'
      const promise = query.promise
      if (!existing || existing.outcome !== 'pending' || existing.promise !== promise) {
        if (existing?.outcome === 'pending') existing.outcome = 'retired'
        const fetchMeta = query.state.fetchMeta as
          | { fetchMore?: { direction?: string } }
          | null
          | undefined
        const operation: Operation = {
          query,
          ordinal: ++record.nextOrdinal,
          kind: fetchMeta?.fetchMore?.direction === 'forward' ? 'forward' : 'full',
          promise,
          startedAtBind: new Set(),
          outcome: 'pending',
          attributed: false,
          forwardOwners:
            fetchMeta?.fetchMore?.direction === 'forward'
              ? new Set(queryRecord.forwardOwners)
              : undefined,
        }
        if (operation.kind === 'full') {
          // A full replacement supersedes any active forward-page loading
          // ownership. Requests made during this full enter queuedForward and
          // remain eligible for the existing post-full drain.
          for (const ownerId of queryRecord.forwardOwners) {
            queryRecord.forwardOwners.delete(ownerId)
            notifyForwardOwner(queryRecord, ownerId)
          }
          if (supersededComposerForward) {
            // Composer must not keep projecting a page whose forward operation
            // was superseded by a full replacement. Other GFS consumers retain
            // their existing coordinator behavior.
            for (const binding of queryRecord.bindings) {
              if (binding.live && binding.kind === 'composer-child') {
                binding.joinedOperation = operation
                setSnapshot(binding, {
                  phase: 'pending',
                  error: null,
                  busy: true,
                  retrying: false,
                })
              }
            }
          }
        }
        if (operation.kind === 'forward') {
          for (const ownerId of queryRecord.queuedForward.keys()) {
            operation.forwardOwners?.add(ownerId)
            queryRecord.forwardOwners.add(ownerId)
            notifyForwardOwner(queryRecord, ownerId)
          }
          queryRecord.queuedForward.clear()
        }
        queryRecord.active = operation
        queryRecord.ordinal = operation.ordinal
        if (operation.kind === 'full') {
          for (const binding of queryRecord.bindings) {
            if (
              binding.live &&
              binding.eligibleAfterOrdinal !== undefined &&
              operation.ordinal > binding.eligibleAfterOrdinal
            ) {
              operation.startedAtBind.add(binding)
              binding.autoOpportunity = 'consumed'
            }
          }
        }
        for (const binding of queryRecord.bindings) {
          if (binding.live && binding.joinedOperation === existing) {
            binding.joinedOperation = operation
          }
        }
        if (promise) {
          void promise.then(
            () => settleOperation(record, operation, 'success'),
            () => settleOperation(record, operation, 'failure')
          )
        }
      }
      for (const binding of queryRecord.bindings) {
        if (binding.live) {
          setSnapshot(binding, {
            phase: binding.snapshot.phase === 'validated' ? 'validated' : 'pending',
            error: binding.snapshot.error,
            busy: true,
            retrying: binding.snapshot.retrying,
          })
        }
      }
      return
    }

    if (action.type === 'success') {
      if (action.manual === true) return
      const data = action.data
      const operation =
        data && typeof data === 'object'
          ? queryRecord.resultOperations.get(data as object)
          : undefined
      if (!operation || operation !== queryRecord.active || operation.query !== query) {
        const active = queryRecord.active
        if (active?.query === query && !active.attributed && active.promise) {
          // Legacy producers such as the FilesPage warmer remain unwrapped:
          // their completion may trigger Composer's bounded fresh evaluation,
          // but it can never validate a binding itself.
          return
        }
        return
      }
      queryRecord.resultOperations.delete(data as object)
      operation.outcome = 'success'
      if (operation.kind === 'full') {
        queryRecord.lastFullSuccessOrdinal = operation.ordinal
      }
      if (operation.kind === 'forward') {
        for (const ownerId of operation.forwardOwners ?? []) {
          queryRecord.forwardOwners.delete(ownerId)
          notifyForwardOwner(queryRecord, ownerId)
        }
      }
      for (const binding of queryRecord.bindings) {
        if (!binding.live) continue
        const eligible =
          operation.kind === 'full' &&
          (operation.startedAtBind.has(binding) || operation.ordinal > binding.ordinal)
        if (eligible) {
          binding.joinedOperation = null
          binding.autoOpportunity = 'consumed'
          setSnapshot(binding, { phase: 'validated', error: null, busy: false, retrying: false })
        } else if (operation.kind === 'forward' && binding.snapshot.phase === 'validated') {
          setSnapshot(binding, { ...binding.snapshot, busy: false })
        }
      }
      if (operation.kind === 'full') scheduleForwardDrain(record, queryRecord)
      return
    }

    if (action.type === 'error') {
      const error = action.error
      const operation =
        error && typeof error === 'object'
          ? queryRecord.errorOperations.get(error as object)
          : undefined
      if (!operation || operation !== queryRecord.active || operation.query !== query) return
      queryRecord.errorOperations.delete(error as object)
      operation.outcome = 'failure'
      if (operation.kind === 'forward') {
        for (const ownerId of operation.forwardOwners ?? []) {
          queryRecord.forwardOwners.delete(ownerId)
          notifyForwardOwner(queryRecord, ownerId)
        }
      }
      if (operation.kind === 'full') {
        for (const ownerId of queryRecord.queuedForward.keys())
          notifyForwardOwner(queryRecord, ownerId)
        queryRecord.queuedForward.clear()
        for (const ownerId of queryRecord.forwardOwners) notifyForwardOwner(queryRecord, ownerId)
        queryRecord.forwardOwners.clear()
      }
      for (const binding of queryRecord.bindings) {
        if (!binding.live) continue
        if (
          operation.kind === 'full' &&
          (operation.startedAtBind.has(binding) || operation.ordinal > binding.ordinal)
        ) {
          binding.joinedOperation = null
          binding.autoOpportunity = 'consumed'
          setSnapshot(binding, {
            phase: binding.snapshot.phase === 'validated' ? 'validated' : 'failed',
            error,
            busy: false,
            retrying: false,
          })
        } else if (binding.joinedOperation === operation) {
          setSnapshot(binding, {
            phase: 'pending',
            error: binding.snapshot.error,
            busy: false,
            retrying: false,
          })
        }
      }
    }
  })

  clients.set(queryClient, record)
  return record
}

function ensureQueryRecord(client: ClientRecord, query: Query): QueryRecord {
  let record = client.records.get(query)
  if (!record) {
    record = {
      query,
      ordinal: 0,
      lastFullSuccessOrdinal: 0,
      active: null,
      bindings: new Set(),
      resultOperations: new WeakMap(),
      errorOperations: new WeakMap(),
      queuedForward: new Map(),
      forwardOwners: new Set(),
      forwardListeners: new Map(),
    }
    client.records.set(query, record)
  }
  return record
}

function scheduleForwardDrain(client: ClientRecord, record: QueryRecord) {
  queueMicrotask(() => {
    if (
      !queryIsCurrent(client, record.query) ||
      record.query.state.fetchStatus !== 'idle' ||
      record.queuedForward.size === 0
    ) {
      return
    }
    const queued = [...record.queuedForward.entries()]
    const [first] = queued
    if (!first) return
    record.queuedForward.clear()
    for (const [ownerId] of queued) {
      record.forwardOwners.add(ownerId)
      notifyForwardOwner(record, ownerId)
    }
    const [, start] = first
    void start()
  })
}

/**
 * Scoped TanStack hooks for the existing GFS QueryClient. The persister wraps
 * one complete infinite-query aggregate and preserves its raw result identity;
 * it does not persist or duplicate page data.
 */
function createPolicy(queryClient: QueryClient) {
  const persister: QueryPersister<unknown, QueryKey> = (queryFn, context, query) => {
    const client = clientRecord(queryClient)
    const currentQuery = query as Query
    const record = ensureQueryRecord(client, currentQuery)
    const fetchMeta = currentQuery.state.fetchMeta as
      | { fetchMore?: { direction?: string } }
      | null
      | undefined
    const kind: QueryOperationKind =
      fetchMeta?.fetchMore?.direction === 'forward' ? 'forward' : 'full'
    const operation: Operation = {
      query: currentQuery,
      ordinal: ++client.nextOrdinal,
      kind,
      promise: currentQuery.promise,
      startedAtBind: new Set(),
      outcome: 'pending',
      attributed: true,
    }
    if (kind === 'forward') operation.forwardOwners = new Set(record.forwardOwners)

    for (const binding of record.bindings) {
      if (!binding.live) continue
      if (
        kind === 'full' &&
        binding.eligibleAfterOrdinal !== undefined &&
        operation.ordinal > binding.eligibleAfterOrdinal
      ) {
        operation.startedAtBind.add(binding)
        binding.autoOpportunity = 'consumed'
      }
      if (binding.autoOpportunity === 'reserved' && kind === 'full') {
        binding.autoOpportunity = 'consumed'
      }
      if (binding.kind === 'root' && kind === 'full' && binding.joinedOperation === operation) {
        operation.startedAtBind.add(binding)
      }
      if (kind === 'full' && operation.ordinal > binding.ordinal) {
        binding.autoOpportunity = 'consumed'
      }
    }

    const previous = record.active
    if (previous?.outcome === 'pending' && previous.promise === operation.promise) {
      for (const binding of record.bindings) {
        if (binding.joinedOperation === previous) binding.joinedOperation = operation
        if (previous.startedAtBind.has(binding)) operation.startedAtBind.add(binding)
      }
    }
    if (previous && previous !== operation && previous.outcome === 'pending') {
      previous.outcome = 'retired'
    }
    record.ordinal = operation.ordinal
    record.active = operation

    if (operation.promise) {
      if (operation.promise) {
        void operation.promise.then(
          () => settleOperation(client, operation, 'success'),
          () => settleOperation(client, operation, 'failure')
        )
      }
    }

    let result: Promise<unknown>
    try {
      result = Promise.resolve(queryFn(context))
    } catch (error) {
      result = Promise.reject(error)
    }
    return result.then(
      value => {
        if (value && typeof value === 'object') {
          operation.rawResult = value
          record.resultOperations.set(value as object, operation)
        }
        return value
      },
      error => {
        operation.error = error
        if (error && typeof error === 'object')
          record.errorOperations.set(error as object, operation)
        throw error
      }
    )
  }

  return {
    // InfiniteQuery's public option types describe the per-page context while
    // Query Core invokes this public persister with the aggregate fetchFn.
    // This pass-through preserves that function and its exact result identity.
    persister: persister as never,
    // TanStack Query defaults a query with a persister to `offlineFirst`.
    // These GFS listings previously inherited the desktop `online` behavior;
    // keep pause/resume semantics unchanged while wrapping the producer.
    networkMode: 'online' as const,
    structuralSharing: (_previous: unknown, incoming: unknown) => incoming,
  }
}

export function gfsInfiniteQueryPolicy(queryClient: QueryClient) {
  const existing = policies.get(queryClient)
  if (existing) return existing
  const policy = createPolicy(queryClient)
  policies.set(queryClient, policy)
  return policy
}

/** Capture the operation boundary before useInfiniteQuery can mount/refetch this observer. */
export function captureGfsQueryOperationBaseline(queryClient: QueryClient): number {
  return clientRecord(queryClient).nextOrdinal
}

/** Presentation gate for a failed full listing; a failed forward page remains resumable. */
export function isGfsFullQueryFailure(queryClient: QueryClient, queryKey: QueryKey): boolean {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true })
  if (!query || query.state.status !== 'error') return false
  const fetchMeta = query.state.fetchMeta as
    | { fetchMore?: { direction?: string } }
    | null
    | undefined
  return fetchMeta?.fetchMore?.direction !== 'forward'
}

export function requestGfsForwardPage(
  queryClient: QueryClient,
  queryKey: QueryKey,
  ownerId: string,
  fetchNextPage: () => Promise<unknown>
): void {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true })
  if (!query) return
  const client = clientRecord(queryClient)
  const record = ensureQueryRecord(client, query)
  const active = record.active
  if (active?.outcome === 'pending' && active.kind === 'full') {
    record.queuedForward.set(ownerId, fetchNextPage)
    notifyForwardOwner(record, ownerId)
    return
  }
  if (active?.outcome === 'pending' && active.kind === 'forward') {
    active.forwardOwners?.add(ownerId)
    record.forwardOwners.add(ownerId)
    notifyForwardOwner(record, ownerId)
    return
  }
  if (query.state.fetchStatus !== 'idle') {
    record.queuedForward.set(ownerId, fetchNextPage)
    notifyForwardOwner(record, ownerId)
    return
  }
  record.forwardOwners.add(ownerId)
  notifyForwardOwner(record, ownerId)
  void fetchNextPage().catch(() => undefined)
}

export function retireGfsForwardOwner(
  queryClient: QueryClient,
  queryKey: QueryKey,
  ownerId: string
): void {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true })
  if (!query) return
  const record = clients.get(queryClient)?.records.get(query)
  if (!record) return
  record.queuedForward.delete(ownerId)
  record.forwardOwners.delete(ownerId)
  record.active?.forwardOwners?.delete(ownerId)
  notifyForwardOwner(record, ownerId)
}

export function useGfsForwardPending(
  queryClient: QueryClient,
  queryKey: QueryKey,
  ownerId: string
): boolean {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true })
  return useSyncExternalStore(
    listener => {
      if (!query) return () => undefined
      const client = clientRecord(queryClient)
      const record = ensureQueryRecord(client, query)
      let listeners = record.forwardListeners.get(ownerId)
      if (!listeners) {
        listeners = new Set()
        record.forwardListeners.set(ownerId, listeners)
      }
      listeners.add(listener)
      return () => {
        listeners?.delete(listener)
        if (listeners?.size === 0) record.forwardListeners.delete(ownerId)
      }
    },
    () => {
      if (!query) return false
      const record = clients.get(queryClient)?.records.get(query)
      return Boolean(record?.forwardOwners.has(ownerId) || record?.queuedForward.has(ownerId))
    },
    () => false
  )
}

export function useGfsQueryBinding(
  queryClient: QueryClient,
  queryKey: QueryKey,
  kind: BindingKind,
  enabled: boolean,
  bindingIdentity?: string | number,
  eligibleAfterOrdinal?: number
): BindingSnapshot & {
  retry: () => void
  isCurrentSnapshot: (revision: number | null, data: unknown) => boolean
} {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true })
  const queryHash = query?.queryHash ?? ''
  const binding = useMemo<Binding | null>(
    () =>
      query && enabled
        ? {
            id: 0,
            kind,
            query,
            live: false,
            ordinal: 0,
            eligibleAfterOrdinal,
            joinedOperation: null,
            autoOpportunity: 'available',
            snapshot: {
              phase: 'pending',
              error: null,
              busy: Boolean(query.state.fetchStatus !== 'idle'),
              retrying: false,
            },
            listeners: new Set(),
          }
        : null,
    [bindingIdentity, enabled, kind, query, queryHash]
  )

  useLayoutEffect(() => {
    if (!binding) return
    const client = clientRecord(queryClient)
    binding.id = ++client.nextBindingId
    const record = ensureQueryRecord(client, binding.query)
    binding.live = true
    binding.ordinal = client.nextOrdinal
    const pendingPromise = binding.query.promise
    if (
      binding.query.state.fetchStatus !== 'idle' &&
      pendingPromise &&
      record.active?.promise !== pendingPromise
    ) {
      const fetchMeta = binding.query.state.fetchMeta as
        | { fetchMore?: { direction?: string } }
        | null
        | undefined
      const operation: Operation = {
        query: binding.query,
        ordinal: ++client.nextOrdinal,
        kind: fetchMeta?.fetchMore?.direction === 'forward' ? 'forward' : 'full',
        promise: pendingPromise,
        startedAtBind: new Set(),
        outcome: 'pending',
        attributed: false,
      }
      record.active = operation
      record.ordinal = operation.ordinal
      void pendingPromise.then(
        () => settleOperation(client, operation, 'success'),
        () => settleOperation(client, operation, 'failure')
      )
    }
    binding.joinedOperation = record.active?.outcome === 'pending' ? record.active : null
    if (
      binding.kind === 'root' &&
      binding.joinedOperation?.kind === 'full' &&
      binding.joinedOperation.attributed
    ) {
      binding.joinedOperation.startedAtBind.add(binding)
    }
    if (
      binding.joinedOperation?.kind === 'full' &&
      eligibleAfterOrdinal !== undefined &&
      binding.joinedOperation.ordinal > eligibleAfterOrdinal
    ) {
      // The useInfiniteQuery observer may start its mount refetch after render
      // but before this layout binding attaches. The pre-observer ordinal proves
      // that this full began inside the same mount boundary and can satisfy it.
      binding.joinedOperation.startedAtBind.add(binding)
      binding.autoOpportunity = 'consumed'
    }
    record.bindings.add(binding)

    // A full that began while the binding was committed consumes the child
    // automatic opportunity at dispatch; a forward or pre-bind full does not.
    if (
      binding.kind === 'composer-child' &&
      record.active?.kind === 'full' &&
      record.active.ordinal > binding.ordinal
    ) {
      binding.autoOpportunity = 'consumed'
    }

    if (record.active?.outcome === 'pending') {
      setSnapshot(binding, {
        phase: 'pending',
        error: null,
        busy: true,
        retrying: false,
      })
    } else if (
      binding.query.state.data !== undefined &&
      eligibleAfterOrdinal !== undefined &&
      record.lastFullSuccessOrdinal > eligibleAfterOrdinal
    ) {
      // A mount full can settle between the observer subscription and this
      // layout binding. Its completion is current for the pre-observer boundary.
      binding.autoOpportunity = 'consumed'
      setSnapshot(binding, { phase: 'validated', error: null, busy: false, retrying: false })
    } else if (binding.query.state.data !== undefined && eligibleAfterOrdinal !== undefined) {
      // QueryObserver can start a cached `refetchOnMount: 'always'` operation
      // before this layout binding attaches. If that producer already settled,
      // its result predates this binding and cannot release its freshness debt.
      // Re-resolve after commit and let Query share any mount fetch that has
      // started in the meantime.
      queueMicrotask(() => {
        if (
          binding.live &&
          binding.autoOpportunity === 'available' &&
          binding.query.state.fetchStatus === 'idle'
        ) {
          dispatchAutomaticFull(client, binding)
        }
      })
    }

    return () => {
      binding.live = false
      binding.autoOpportunity = 'retired'
      binding.joinedOperation = null
      record.bindings.delete(binding)
      setSnapshot(binding, { phase: 'retired', error: null, busy: false, retrying: false })
    }
  }, [binding, eligibleAfterOrdinal, queryClient])

  const emptySnapshot: BindingSnapshot = {
    phase: enabled ? 'pending' : 'retired',
    error: null,
    busy: false,
    retrying: false,
  }
  const snapshot = useSyncExternalStore(
    listener => {
      binding?.listeners.add(listener)
      return () => binding?.listeners.delete(listener)
    },
    () => binding?.snapshot ?? emptySnapshot,
    () => emptySnapshot
  )

  const retry = () => {
    const client = clients.get(queryClient)
    if (!client || !binding?.live || !queryIsCurrent(client, binding.query)) return
    assertGfsAuthorityRetryAllowed(queryClient, binding.query.queryKey)
    binding.joinedOperation =
      client.records.get(binding.query)?.active?.outcome === 'pending'
        ? (client.records.get(binding.query)?.active ?? null)
        : null
    setSnapshot(binding, { ...binding.snapshot, retrying: true })
    binding.autoOpportunity = 'consumed'
    void queryClient.refetchQueries(
      { exact: true, queryKey: binding.query.queryKey, type: 'active' },
      { cancelRefetch: false, throwOnError: false }
    )
  }

  const isCurrentSnapshot = (revision: number | null, data: unknown) => {
    const client = clients.get(queryClient)
    const queryState = binding?.query.state
    const fetchMeta = queryState?.fetchMeta as
      | { fetchMore?: { direction?: string } }
      | null
      | undefined
    const onlyForwardInFlight =
      queryState?.fetchStatus === 'fetching' && fetchMeta?.fetchMore?.direction === 'forward'
    return Boolean(
      client &&
      binding?.live &&
      binding.snapshot.phase === 'validated' &&
      revision !== null &&
      queryState?.dataUpdatedAt === revision &&
      (queryState?.fetchStatus === 'idle' || onlyForwardInFlight) &&
      queryState.status === 'success' &&
      !queryState.isInvalidated &&
      queryState.data === data &&
      queryIsCurrent(client, binding.query)
    )
  }

  return { ...snapshot, retry, isCurrentSnapshot }
}
