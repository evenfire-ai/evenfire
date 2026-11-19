import { useSyncExternalStore } from 'react'
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query'
import { gfsAuthorityRetryPauseRemainingMs } from './gfsAuthorityQueryPolicy'

interface DeferredRead {
  queryHash: string
  queryKey: QueryKey
  blockedUntil: number
  timer: ReturnType<typeof setTimeout> | null
  dueDispatchScheduled: boolean
}

class DeferredReadStore {
  private readonly entries = new Map<string, DeferredRead>()
  private readonly joinedWatchQueries = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  constructor(private readonly client: QueryClient) {
    client.getQueryCache().subscribe(event => {
      if (event.type === 'removed') this.remove(event.query.queryHash)
      if (event.type === 'updated') this.onQueryUpdated(event.query, event.action.type)
      if (event.type === 'observerAdded') this.onObserverAdded(event.query)
      if (event.type === 'observerOptionsUpdated') this.onObserverAdded(event.query)
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): number => this.version

  isDeferred(queryHash: string): boolean {
    const entry = this.entries.get(queryHash)
    return Boolean(entry && Date.now() < entry.blockedUntil)
  }

  defer(query: Query): boolean {
    const remainingMs = gfsAuthorityRetryPauseRemainingMs(
      query.state.error,
      query.state.errorUpdatedAt
    )
    if (remainingMs <= 0) return false

    const blockedUntil = Date.now() + remainingMs
    const existing = this.entries.get(query.queryHash)
    if (existing && existing.blockedUntil >= blockedUntil) return true
    if (existing?.timer) clearTimeout(existing.timer)
    const timer = setTimeout(() => this.expire(query.queryHash), remainingMs)
    this.entries.set(query.queryHash, {
      queryHash: query.queryHash,
      queryKey: query.queryKey,
      blockedUntil,
      timer,
      dueDispatchScheduled: false,
    })
    this.notify()
    return true
  }

  reserveJoinedWatch(queryHash: string): void {
    this.joinedWatchQueries.add(queryHash)
  }

  private expire(queryHash: string): void {
    const entry = this.entries.get(queryHash)
    if (!entry) return
    const remainingMs = entry.blockedUntil - Date.now()
    if (remainingMs > 0) {
      entry.timer = setTimeout(() => this.expire(queryHash), remainingMs)
      return
    }
    this.releaseDeadline(entry)
  }

  releaseExpired(): void {
    const now = Date.now()
    for (const entry of this.entries.values()) {
      if (entry.timer && now >= entry.blockedUntil) this.releaseDeadline(entry)
    }
  }

  private releaseDeadline(entry: DeferredRead): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    this.notify()
    this.scheduleDueDispatch(entry)
  }

  private onObserverAdded(query: Query): void {
    const entry = this.entries.get(query.queryHash)
    if (entry && Date.now() >= entry.blockedUntil) this.scheduleDueDispatch(entry)
  }

  private scheduleDueDispatch(entry: DeferredRead): void {
    if (entry.dueDispatchScheduled) return
    entry.dueDispatchScheduled = true
    setTimeout(() => {
      entry.dueDispatchScheduled = false
      if (this.entries.get(entry.queryHash) !== entry || Date.now() < entry.blockedUntil) return
      const query = this.client.getQueryCache().find({ queryKey: entry.queryKey, exact: true })
      if (
        !query?.observers.some(observer => Boolean(observer.options.meta?.gfsDeferredReadEligible))
      )
        return
      // The due owner bypasses only its own enabled gate. The active Query
      // retains its query function, state updates, and authority error effects.
      // Errors stay visible in Query state and are handled by the mounted owner.
      void query.fetch(undefined, { cancelRefetch: false }).catch(() => {})
    }, 0)
  }

  private onQueryUpdated(query: Query, action: string): void {
    if (action !== 'success' && action !== 'error') return
    if (action === 'success') {
      this.remove(query.queryHash)
      this.joinedWatchQueries.delete(query.queryHash)
      return
    }
    if (this.joinedWatchQueries.delete(query.queryHash)) {
      if (!this.defer(query)) this.remove(query.queryHash)
      return
    }
    const entry = this.entries.get(query.queryHash)
    if (!entry) return
    const remainingMs = gfsAuthorityRetryPauseRemainingMs(
      query.state.error,
      query.state.errorUpdatedAt
    )
    if (remainingMs <= 0) {
      this.remove(query.queryHash)
      return
    }
    if (entry.timer) clearTimeout(entry.timer)
    entry.blockedUntil = Date.now() + remainingMs
    entry.timer = setTimeout(() => this.expire(query.queryHash), remainingMs)
    entry.dueDispatchScheduled = false
    this.notify()
  }

  private remove(queryHash: string): void {
    this.joinedWatchQueries.delete(queryHash)
    const entry = this.entries.get(queryHash)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this.entries.delete(queryHash)
    this.notify()
  }

  private notify(): void {
    this.version += 1
    this.listeners.forEach(listener => listener())
  }
}

const stores = new WeakMap<QueryClient, DeferredReadStore>()

function getStore(client: QueryClient): DeferredReadStore {
  let store = stores.get(client)
  if (!store) {
    store = new DeferredReadStore(client)
    stores.set(client, store)
  }
  return store
}

/** Subscribe a mounted surface so deadline expiry can re-evaluate its query options. */
export function useGfsDeferredReadGate(client: QueryClient): void {
  const store = getStore(client)
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/** Whether an exact cached Query is still inside a deferred watch 429 window. */
export function isGfsReadDeferred(client: QueryClient, queryKey: QueryKey): boolean {
  const query = client.getQueryCache().find({ queryKey, exact: true })
  return query ? getStore(client).isDeferred(query.queryHash) : false
}

/** Retain one watch obligation while the exact query's current 429 is active. */
export function deferGfsReadForRateLimit(client: QueryClient, query: Query): boolean {
  return getStore(client).defer(query)
}

/** Reserve a joined watch result so a published 429 is gated before await resumes. */
export function reserveGfsReadForWatchJoin(client: QueryClient, query: Query): void {
  getStore(client).reserveJoinedWatch(query.queryHash)
}

/** Release expired deadlines when a virtual clock advances in a real-code test. */
export function releaseExpiredGfsDeferredReads(client: QueryClient): void {
  getStore(client).releaseExpired()
}
