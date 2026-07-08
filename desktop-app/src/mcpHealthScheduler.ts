/**
 * McpHealthScheduler — per-hostRef poll loop for MCP server health.
 *
 * Owns the timer lifecycle for polling `GET /rpc/hosts/:hostRef/status`.
 * All time-sensitive inputs (clock, timer, fetch) are injected so the
 * state machine can be exercised with synchronous tests (spec §6).
 *
 * Not a React concern — the UI wraps it in a hook and provides the
 * fetcher + subscribe callback.
 */
import { FAST_POLL_INTERVAL_MS, POLL_INTERVAL_MS, STALE_AFTER_MS } from './mcpServerHealth'
import type { HostRuntimeStatus } from './types'

export interface SchedulerDeps {
  /** Monotonic-ish clock. Test fakes advance it manually. */
  now(): number
  /**
   * Fetch a host status snapshot. Must resolve (never reject) for tests —
   * thrown errors are captured and surfaced in `lastErrorByHostRef`.
   */
  fetchStatus(hostRef: string): Promise<HostRuntimeStatus | null>
  /** setTimeout stand-in that returns a cancel callback. */
  setTimer(fn: () => void, ms: number): () => void
}

export interface SchedulerSnapshot {
  /** Most recent status per polled host. `null` = fetch succeeded but
   *  returned null; `undefined` = no successful fetch yet. */
  statusByHostRef: ReadonlyMap<string, HostRuntimeStatus | null>
  /** Most recent error per host (cleared on next success). */
  lastErrorByHostRef: ReadonlyMap<string, unknown>
  /** The nominal interval used for the next scheduled tick, before any
   *  per-host rate-limit backoff or deterministic jitter is applied. */
  nextIntervalMs: number
  /** True when `pause()` has been called without a subsequent `resume()`. */
  paused: boolean
}

type HostState = {
  /** Cancel function for the currently armed timer, if any. */
  cancelTimer: (() => void) | null
  /** In-flight fetch promise, to dedupe concurrent refresh requests. */
  inflight: Promise<void> | null
  /** Latest successful fetch. */
  lastStatus: HostRuntimeStatus | null | undefined
  /** Latest error (null once the next fetch succeeds). */
  lastError: unknown
  /** Rate-limit backoff override for this host, reset on the next success. */
  rateLimitBackoffMs: number | null
}

type Subscriber = (snap: SchedulerSnapshot) => void

/**
 * Returns true iff the given status payload has at least one row with
 * state=`connecting`. Used to trigger fast-polling until first-connect
 * settles (spec: cold-open latency fix).
 */
function hasConnectingInStatus(status: HostRuntimeStatus | null | undefined): boolean {
  if (!status?.mcpServers) return false
  for (const row of status.mcpServers) {
    if (row.state === 'connecting') return true
  }
  return false
}

function getErrorStatus(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status
    if (typeof status === 'number' && Number.isFinite(status)) return status
    if (typeof status === 'string' && status.trim()) {
      const parsed = Number(status)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  if (error instanceof Error) {
    const match = error.message.match(/\b429\b/)
    if (match) return 429
  }
  return null
}

function nextRateLimitBackoffMs(currentBackoffMs: number | null, baseIntervalMs: number): number {
  const startingPoint = currentBackoffMs ?? baseIntervalMs
  return Math.min(Math.max(baseIntervalMs, startingPoint * 2), POLL_INTERVAL_MS)
}

function stableJitterOffsetMs(hostRef: string, intervalMs: number): number {
  let hash = 0
  for (let i = 0; i < hostRef.length; i += 1) {
    hash = (hash * 31 + hostRef.charCodeAt(i)) >>> 0
  }
  const percentOffset = (hash % 21) - 10
  return Math.round((intervalMs * percentOffset) / 100)
}

export class McpHealthScheduler {
  private readonly deps: SchedulerDeps
  private readonly hosts = new Map<string, HostState>()
  private readonly subscribers = new Set<Subscriber>()
  private paused = false
  private disposed = false

  constructor(deps: SchedulerDeps) {
    this.deps = deps
  }

  /**
   * Replace the set of hosts being polled. Hosts added here start polling
   * immediately; hosts removed have their timers cancelled and state dropped.
   * Idempotent — repeated calls with the same set are no-ops.
   */
  setActiveHostRefs(hostRefs: readonly string[]): void {
    if (this.disposed) return
    const target = new Set(hostRefs.filter(r => r.trim()))

    // Remove hosts no longer active.
    for (const ref of [...this.hosts.keys()]) {
      if (!target.has(ref)) {
        this.dropHost(ref)
      }
    }

    // Add new hosts.
    for (const ref of target) {
      if (!this.hosts.has(ref)) {
        this.hosts.set(ref, {
          cancelTimer: null,
          inflight: null,
          lastStatus: undefined,
          lastError: null,
          rateLimitBackoffMs: null,
        })
        if (!this.paused) this.kick(ref)
      }
    }

    this.notify()
  }

  /**
   * Stop all polling. In-flight fetches still resolve but do not schedule
   * next ticks. Use on window blur / tab hidden (spec §6.2).
   */
  pause(): void {
    if (this.disposed || this.paused) return
    this.paused = true
    for (const [, state] of this.hosts) this.cancelTimer(state)
    this.notify()
  }

  /**
   * Resume polling. Each active host gets an immediate refresh kick-off.
   */
  resume(): void {
    if (this.disposed || !this.paused) return
    this.paused = false
    for (const ref of this.hosts.keys()) this.kick(ref)
    this.notify()
  }

  /**
   * Trigger an out-of-band refresh. With no argument, every active host is
   * refreshed (use on focus). With a hostRef, only that one (use on agent
   * selection or tool-error).
   *
   * Deduplicates — if a fetch is already in flight for the host, returns
   * that promise instead of starting a new one.
   */
  refresh(hostRef?: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (hostRef === undefined) {
      return Promise.all([...this.hosts.keys()].map(ref => this.kick(ref))).then(() => undefined)
    }
    if (!this.hosts.has(hostRef)) return Promise.resolve()
    // Return the underlying kick() promise directly so repeated refresh() calls
    // during an in-flight fetch share the same promise (deduplication contract).
    return this.kick(hostRef)
  }

  /** Subscribe to snapshot updates. Returns an unsubscribe callback. */
  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb)
    // Emit the current snapshot synchronously so callers get immediate state.
    cb(this.snapshot())
    return () => {
      this.subscribers.delete(cb)
    }
  }

  /** Return a snapshot of the current scheduler state. */
  snapshot(): SchedulerSnapshot {
    const statusByHostRef = new Map<string, HostRuntimeStatus | null>()
    const lastErrorByHostRef = new Map<string, unknown>()
    for (const [ref, s] of this.hosts) {
      if (s.lastStatus !== undefined) statusByHostRef.set(ref, s.lastStatus)
      if (s.lastError !== null) lastErrorByHostRef.set(ref, s.lastError)
    }
    return {
      statusByHostRef,
      lastErrorByHostRef,
      nextIntervalMs: this.pickIntervalMs(),
      paused: this.paused,
    }
  }

  /**
   * Release every timer and drop state. After dispose the scheduler is inert.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [, state] of this.hosts) this.cancelTimer(state)
    this.hosts.clear()
    this.subscribers.clear()
  }

  // ─────────────────────────────────────────────────────────── internal ───

  /**
   * Kick off a fetch for `hostRef` and arm the next timer when it resolves.
   * Dedupes with existing in-flight fetches so repeated refresh() calls
   * collapse into a single request.
   */
  private kick(hostRef: string): Promise<void> {
    const state = this.hosts.get(hostRef)
    if (!state || this.disposed) return Promise.resolve()
    if (state.inflight) return state.inflight

    // Clear any pending timer — we're fetching now.
    this.cancelTimer(state)

    const p = this.deps
      .fetchStatus(hostRef)
      .then(
        status => {
          const s = this.hosts.get(hostRef)
          if (!s) return
          s.lastStatus = status
          s.lastError = null
          s.rateLimitBackoffMs = null
        },
        (error: unknown) => {
          const s = this.hosts.get(hostRef)
          if (!s) return
          s.lastError = error
          if (getErrorStatus(error) === 429) {
            s.rateLimitBackoffMs = nextRateLimitBackoffMs(
              s.rateLimitBackoffMs,
              this.pickIntervalMs()
            )
          }
        }
      )
      .finally(() => {
        const s = this.hosts.get(hostRef)
        if (!s) return
        s.inflight = null
        if (!this.paused && !this.disposed) this.armTimer(hostRef)
        this.notify()
      })

    state.inflight = p
    return p
  }

  private armTimer(hostRef: string): void {
    const state = this.hosts.get(hostRef)
    if (!state) return
    this.cancelTimer(state)
    let ms = state.rateLimitBackoffMs
      ? Math.max(this.pickIntervalMs(), state.rateLimitBackoffMs)
      : this.pickIntervalMs()
    if (this.hosts.size > 1) {
      ms = Math.max(1, ms + stableJitterOffsetMs(hostRef, ms))
    }
    state.cancelTimer = this.deps.setTimer(() => {
      void this.kick(hostRef)
    }, ms)
  }

  private cancelTimer(state: HostState): void {
    if (state.cancelTimer) {
      state.cancelTimer()
      state.cancelTimer = null
    }
  }

  private dropHost(hostRef: string): void {
    const state = this.hosts.get(hostRef)
    if (!state) return
    this.cancelTimer(state)
    this.hosts.delete(hostRef)
  }

  /**
   * Interval for the NEXT tick: fast while any host has a `connecting` row
   * in its latest snapshot OR when any host has no snapshot yet (cold open).
   * Stale snapshots (older than STALE_AFTER_MS) are treated as
   * "still unknown" and also warrant a fast poll.
   */
  private pickIntervalMs(): number {
    const nowMs = this.deps.now()
    let anyConnecting = false
    let anyColdOrStale = false
    for (const state of this.hosts.values()) {
      if (state.lastStatus === undefined) {
        anyColdOrStale = true
        continue
      }
      if (state.lastStatus === null) continue
      if (hasConnectingInStatus(state.lastStatus)) {
        anyConnecting = true
        break
      }
      const obs = Date.parse(state.lastStatus.observedAt)
      if (!Number.isFinite(obs) || nowMs - obs > STALE_AFTER_MS) {
        anyColdOrStale = true
      }
    }
    if (anyConnecting || anyColdOrStale) return FAST_POLL_INTERVAL_MS
    return POLL_INTERVAL_MS
  }

  private notify(): void {
    if (this.subscribers.size === 0) return
    const snap = this.snapshot()
    for (const cb of this.subscribers) cb(snap)
  }
}
