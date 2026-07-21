/**
 * In-memory signal store for workflow runtime signals.
 *
 * Kept separate from the HTTP handlers so runtime signal state has a single
 * owner and can be consumed by both the reconciler and REST surface.
 */

export interface WorkflowSignal {
  type: 'cancel' | 'pause' | 'resume' | 'approval'
  requestId: string
  receivedAt: string
  payload?: Record<string, unknown>
}

const signalStore = new Map<string, WorkflowSignal[]>()
const lastAccessTime = new Map<string, number>()
const SIGNAL_STORE_MAX = 100
const MAX_RECIPES = 1000
const STALE_TTL_MS = 30 * 60 * 1000 // 30 minutes

function evictStaleRecipes(): void {
  // Always sweep TTL-expired entries regardless of store size.
  // Previously this was gated behind a size check, so stale entries
  // would accumulate indefinitely in a long-running WRC pod (< MAX_RECIPES case).
  const now = Date.now()
  for (const [name, lastAccess] of lastAccessTime) {
    if (now - lastAccess > STALE_TTL_MS) {
      signalStore.delete(name)
      lastAccessTime.delete(name)
    }
  }
  // Hard-cap: if still over limit after TTL sweep, evict oldest entries
  if (signalStore.size > MAX_RECIPES) {
    const entries = [...lastAccessTime.entries()].sort((a, b) => a[1] - b[1])
    for (const [name] of entries) {
      if (signalStore.size <= MAX_RECIPES) break
      signalStore.delete(name)
      lastAccessTime.delete(name)
    }
  }
}

// EFF-03 fix: gate eviction by interval to avoid O(n) scan on every enqueue.
let lastEvictionTime = 0
const EVICTION_INTERVAL_MS = 60_000

export function enqueueSignal(recipeName: string, signal: WorkflowSignal): void {
  const now = Date.now()
  if (now - lastEvictionTime > EVICTION_INTERVAL_MS) {
    evictStaleRecipes()
    lastEvictionTime = now
  }
  const signals = signalStore.get(recipeName) ?? []
  // Cap at SIGNAL_STORE_MAX per recipe to prevent unbounded memory growth (DoS)
  if (signals.length < SIGNAL_STORE_MAX) {
    signals.push(signal)
  }
  signalStore.set(recipeName, signals)
  lastAccessTime.set(recipeName, now)
}

export function drainSignals(recipeName: string): WorkflowSignal[] {
  const signals = signalStore.get(recipeName) ?? []
  signalStore.delete(recipeName)
  lastAccessTime.delete(recipeName)
  return signals
}
