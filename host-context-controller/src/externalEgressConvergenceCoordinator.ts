import { externalEgressRetriesAtCap } from './metrics'
import type { McpServerCRD } from './types'

const EXTERNAL_EGRESS_RETRY_DELAYS_MS = [5000, 15000, 30000] as const
const EXTERNAL_EGRESS_MAX_CONCURRENCY = 10
const EXTERNAL_EGRESS_RESYNC_JITTER_MS = 5000

export type ExternalEgressWatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED'

export type ExternalEgressRetryHandle = {
  isCurrent: () => boolean
  complete: () => void
}

type ExternalEgressRetryIntent = {
  sequence: number
  type: ExternalEgressWatchEventType
  server: McpServerCRD
}

type ExternalEgressMutationOptions = {
  deleteAllowed?: () => Promise<boolean>
  isCurrent: () => boolean
}

type ExternalEgressReconcileOptions = {
  deleteAllowed?: () => Promise<boolean>
  retry?: ExternalEgressRetryHandle
  isCurrent?: () => boolean
}

type ExternalEgressCoordinatorDependencies = {
  listServers: () => McpServerCRD[]
  getCurrentServer: (name: string) => McpServerCRD | undefined
  inventoryAuthoritative: () => boolean
  sameDesiredRevision: (left: McpServerCRD, right: McpServerCRD) => boolean
  enqueue: (server: McpServerCRD, work: () => Promise<void>) => Promise<void>
  mutate: (
    type: ExternalEgressWatchEventType,
    server: McpServerCRD,
    options: ExternalEgressMutationOptions
  ) => Promise<void>
  replay: (
    type: ExternalEgressWatchEventType,
    server: McpServerCRD,
    retry: ExternalEgressRetryHandle
  ) => Promise<void>
  // Smallest DNS TTL (ms) observed across external-egress resolutions, or
  // Infinity if none. startPeriodicResync reads it to advance the next resync to
  // <= TTL/2 (H2, issue #299).
  externalEgressRefreshMinTtlMs: () => number
}

export type ExternalEgressStartupGates = {
  waitFor: (server: Pick<McpServerCRD, 'name' | 'namespace'>) => Promise<boolean>
}

class AsyncConcurrencyLimiter {
  private active = 0
  private readonly waiters: Array<(admitted: boolean) => void> = []
  private closed = false

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.closed) return undefined
    if (this.active >= this.limit) {
      const admitted = await new Promise<boolean>(resolve => this.waiters.push(resolve))
      if (!admitted) return undefined
    } else {
      this.active += 1
    }
    try {
      return await work()
    } finally {
      this.release()
    }
  }

  cancelPending(): void {
    if (this.closed) return
    this.closed = true
    for (const resume of this.waiters.splice(0)) {
      resume(false)
    }
  }

  private release(): void {
    this.active -= 1
    if (this.closed) return
    const resume = this.waiters.shift()
    if (!resume) return
    // Transfer the released permit before waking the waiter. Reserving it here
    // prevents a new caller from entering between wake-up and its microtask.
    this.active += 1
    resume(true)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * External-egress resync delay (ms), H2 (issue #299). The configured interval is
 * the backstop; a finite observed DNS TTL advances the delay to <= TTL/2 so a
 * rotating low-TTL host is sampled every rotation. The floor is the hard lower
 * bound to avoid a hot-loop. Pure and unit-testable; consumed by
 * {@link ExternalEgressConvergenceCoordinator.startPeriodicResync}.
 */
export function externalEgressResyncDelayMs(
  intervalSec: number,
  floorSec: number,
  minObservedTtlMs = Infinity
): number {
  const floorMs = floorSec * 1000
  const configuredMs = intervalSec * 1000
  const ttlAwareMs = Number.isFinite(minObservedTtlMs)
    ? Math.min(configuredMs, minObservedTtlMs / 2)
    : configuredMs
  return Math.max(ttlAwareMs, floorMs)
}

/**
 * Owns temporal coordination for external-egress convergence. Kubernetes
 * authority and mutations remain behind callbacks supplied by the watcher.
 */
export class ExternalEgressConvergenceCoordinator {
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retryAttempts = new Map<string, number>()
  private readonly retryIntents = new Map<string, ExternalEgressRetryIntent>()
  private retrySequence = 0
  private readonly retryLimiter = new AsyncConcurrencyLimiter(EXTERNAL_EGRESS_MAX_CONCURRENCY)
  private readonly retrySlots = new Map<string, object>()
  // Keys whose retry backoff is currently pinned at the capped (maximum) delay.
  // Its size drives the externalEgressRetriesAtCap gauge (R3-M4/R2-L1) so a
  // binding stuck retrying forever is observable, not silently denied.
  private readonly retriesAtCap = new Set<string>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private resyncInFlight: Promise<void> | null = null
  private resyncTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly dependencies: ExternalEgressCoordinatorDependencies) {}

  startPeriodicResync(intervalSec: number, floorSec: number): void {
    if (this.stopped || intervalSec <= 0 || this.resyncTimer) return
    // Self-rescheduling (not a fixed setInterval) so the delay can advance to
    // <= observed TTL/2 (H2, issue #299), and rescheduling AFTER each pass
    // completes guarantees no overlapping resyncs. runResync still dedupes any
    // in-flight pass; the floor is the hard lower bound against a hot-loop.
    const scheduleNext = (): void => {
      if (this.stopped) return
      const delayMs = externalEgressResyncDelayMs(
        intervalSec,
        floorSec,
        this.dependencies.externalEgressRefreshMinTtlMs()
      )
      this.resyncTimer = setTimeout(() => {
        // Re-arm FIRST (.finally) so a rejected pass still schedules its
        // successor — the "re-arms after completion" property must survive a
        // failure. Then .catch logs and absorbs the rejection so a rejecting
        // pass (or a throwing scheduleNext) never becomes an unhandledRejection,
        // which crashes the process on modern Node and would silently kill the
        // periodic resync loop (reopening the #299 DNS-drift window).
        void this.runResync()
          .finally(scheduleNext)
          .catch(error =>
            console.error('[K8s] External egress periodic resync pass failed:', error)
          )
      }, delayMs)
      this.resyncTimer.unref?.()
    }
    scheduleNext()
    console.log(
      `[K8s] External egress periodic DNS resync enabled (every ${intervalSec}s, advancing to <= TTL/2)`
    )
  }

  runResync(): Promise<void> {
    if (this.resyncInFlight) return this.resyncInFlight
    const run = this.runResyncCore()
    this.resyncInFlight = run
    const settle = () => {
      if (this.resyncInFlight === run) this.resyncInFlight = null
    }
    void run.then(settle, settle)
    return run
  }

  prepareStartupGates(
    servers: McpServerCRD[],
    isCurrent: () => boolean = this.dependencies.inventoryAuthoritative
  ): ExternalEgressStartupGates {
    const gates = new Map<string, Promise<boolean>>()
    const selectedServers = servers
      .filter(server => (server.spec.egressBindings?.length ?? 0) > 0)
      .sort((left, right) => this.key(left).localeCompare(this.key(right)))

    if (selectedServers.length > 0) {
      console.log(
        `[K8s] Reconciling external egress before startup runtime reconciliation for ` +
          `${selectedServers.length} McpServer(s)`
      )
    }

    // Startup admission is intentionally independent from retry and periodic
    // resync capacity, so a saturated recovery lane cannot head-of-line block
    // initial runtime gates for unrelated servers.
    const limiter = new AsyncConcurrencyLimiter(EXTERNAL_EGRESS_MAX_CONCURRENCY)
    for (const selected of selectedServers) {
      const key = this.key(selected)
      const gate = limiter
        .run(async () => {
          if (this.stopped || !isCurrent()) return false
          let ready = false
          await this.dependencies.enqueue(selected, async () => {
            if (this.stopped || !isCurrent()) return
            const current = this.dependencies.getCurrentServer(selected.name)
            if (
              !current ||
              current.namespace !== selected.namespace ||
              !this.dependencies.sameDesiredRevision(selected, current)
            ) {
              return
            }
            try {
              // Startup is an egress-only gate. Any pre-existing retry intent is
              // completed only by its full replay, never by this mutation.
              await this.reconcile('MODIFIED', current, { isCurrent })
              const latest = this.dependencies.getCurrentServer(selected.name)
              ready =
                !this.stopped &&
                isCurrent() &&
                latest !== undefined &&
                latest.namespace === selected.namespace &&
                this.dependencies.sameDesiredRevision(selected, latest)
            } catch (error) {
              console.error(
                `[K8s] Initial external egress reconciliation failed for ${key}; ` +
                  'runtime reconciliation will stay blocked until retry succeeds:',
                error
              )
              this.scheduleRetry('MODIFIED', current)
            }
          })
          return ready
        })
        .then(result => result ?? false)
      // Side-attach a logger so a rejection is never *unhandled* (which crashes
      // the process on modern Node) if fullReconcile aborts before waitFor
      // awaits this gate. This does NOT swallow the failure: gates.set stores
      // the original `gate`, so the awaited path in fullReconcile still rejects
      // and fails the pass loudly — this only covers the unawaited case.
      gate.catch(error => {
        console.error(
          `[K8s] External egress startup gate for ${key} rejected before it was awaited:`,
          error
        )
      })
      gates.set(key, gate)
    }

    return {
      waitFor: server => gates.get(this.key(server)) ?? Promise.resolve(true),
    }
  }

  async reconcile(
    type: ExternalEgressWatchEventType,
    server: McpServerCRD,
    options: ExternalEgressReconcileOptions = {}
  ): Promise<ExternalEgressRetryHandle | undefined> {
    if (!this.reconcileIsCurrent(type, server, options)) return undefined
    const key = this.key(server)
    let existing = this.inFlight.get(key)
    while (existing) {
      console.warn(`[K8s] Waiting for external egress reconcile for ${key}; already in flight`)
      await existing
      if (!this.reconcileIsCurrent(type, server, options)) return undefined
      existing = this.inFlight.get(key)
    }

    if (!this.reconcileIsCurrent(type, server, options)) return undefined
    const completion = options.retry ?? this.currentRetryHandle(key)
    const run = this.dependencies.mutate(type, server, {
      deleteAllowed: options.deleteAllowed,
      isCurrent: () => this.reconcileIsCurrent(type, server, options),
    })
    this.inFlight.set(key, run)
    try {
      await run
      return completion
    } finally {
      if (this.inFlight.get(key) === run) {
        this.inFlight.delete(key)
      }
    }
  }

  scheduleRetry(type: string, server: McpServerCRD): void {
    if (!this.isWatchEventType(type) || this.stopped) return

    const cached = this.dependencies.getCurrentServer(server.name)
    const retryType: ExternalEgressWatchEventType =
      cached && cached.namespace === server.namespace
        ? type === 'ADDED' && this.dependencies.sameDesiredRevision(server, cached)
          ? 'ADDED'
          : 'MODIFIED'
        : 'DELETED'
    const retryServer = cached && cached.namespace === server.namespace ? cached : server
    const key = this.key(server)
    const previousIntent = this.retryIntents.get(key)
    if (previousIntent && !this.sameRetryTarget(previousIntent, retryType, retryServer)) {
      this.retryAttempts.delete(key)
      // A new target restarts the backoff ladder, so the key is no longer capped.
      this.clearRetryAtCap(key)
    }

    const intent: ExternalEgressRetryIntent = {
      sequence: ++this.retrySequence,
      type: retryType,
      server: retryServer,
    }
    this.retryIntents.set(key, intent)
    // A timer or queued/active slot already owning the key consumes the newest
    // intent when it next enters the retry and per-server lanes.
    if (this.retryTimers.has(key) || this.retrySlots.has(key)) return
    this.armRetryTimer(key)
  }

  private armRetryTimer(key: string): void {
    if (
      this.stopped ||
      this.retryTimers.has(key) ||
      this.retrySlots.has(key) ||
      !this.retryIntents.has(key)
    ) {
      return
    }
    const attempt = Math.min(
      (this.retryAttempts.get(key) ?? 0) + 1,
      EXTERNAL_EGRESS_RETRY_DELAYS_MS.length
    )
    const delayMs = EXTERNAL_EGRESS_RETRY_DELAYS_MS[attempt - 1]
    this.retryAttempts.set(key, attempt)
    const capped = attempt === EXTERNAL_EGRESS_RETRY_DELAYS_MS.length
    if (capped) this.markRetryAtCap(key)
    console.warn(
      `[K8s] Scheduling external egress retry ${attempt}/${EXTERNAL_EGRESS_RETRY_DELAYS_MS.length}` +
        `${capped ? ' (capped)' : ''} ` +
        `for McpServer "${this.retryIntents.get(key)!.server.name}" in ${delayMs}ms`
    )

    const timer = setTimeout(() => {
      if (this.retryTimers.get(key) !== timer) return
      this.retryTimers.delete(key)
      this.queueRetry(key)
    }, delayMs)
    this.retryTimers.set(key, timer)
  }

  private queueRetry(key: string): void {
    if (this.stopped || !this.retryIntents.has(key)) return
    if (this.retrySlots.has(key)) {
      // A timer can overlap work admitted through another lane. The durable
      // slot owns the latest intent and rearms it on exit if it remains live.
      return
    }

    const slot = {}
    this.retrySlots.set(key, slot)
    void this.retryLimiter
      .run(async () => {
        if (
          this.stopped ||
          this.retrySlots.get(key) !== slot ||
          !this.dependencies.inventoryAuthoritative()
        ) {
          return
        }
        // Do not capture intent before the limiter. Churn while capacity is
        // saturated is represented by one slot and resolved latest-wins here.
        const admittedIntent = this.retryIntents.get(key)
        if (!admittedIntent) return
        await this.dependencies.enqueue(admittedIntent.server, async () => {
          if (
            this.stopped ||
            this.retrySlots.get(key) !== slot ||
            !this.dependencies.inventoryAuthoritative()
          ) {
            return
          }
          // The keyed queue may also wait. Resolve the intent again so only the
          // latest desired revision or absence is replayed.
          const currentIntent = this.retryIntents.get(key)
          if (!currentIntent) return
          await this.replayIntent(currentIntent)
        })
      })
      .catch(error => {
        if (!this.stopped) {
          console.error(`[K8s] External egress retry execution failed for ${key}:`, error)
        }
      })
      .finally(() => {
        if (this.retrySlots.get(key) !== slot) return
        this.retrySlots.delete(key)
        // A replay may schedule its successor while still active, or a newer
        // intent may arrive after this slot selected work. Rearm only after the
        // key leaves the slot so one key never accumulates limiter backlog.
        if (!this.stopped && this.retryIntents.has(key) && !this.retryTimers.has(key)) {
          this.armRetryTimer(key)
        }
      })
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.retryLimiter.cancelPending()
    if (this.resyncTimer) {
      clearTimeout(this.resyncTimer)
      this.resyncTimer = null
    }
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer)
    }
    this.retryTimers.clear()
    this.retryAttempts.clear()
    this.retryIntents.clear()
    this.retrySlots.clear()
    if (this.retriesAtCap.size > 0) {
      this.retriesAtCap.clear()
      externalEgressRetriesAtCap.set(0)
    }
    this.inFlight.clear()
  }

  private async runResyncCore(): Promise<void> {
    if (this.stopped || !this.dependencies.inventoryAuthoritative()) return
    const servers = this.dependencies
      .listServers()
      .filter(server => (server.spec.egressBindings?.length ?? 0) > 0)
      .sort((left, right) => this.key(left).localeCompare(this.key(right)))
    if (servers.length === 0) return

    console.log(`[K8s] Periodic external egress DNS resync: ${servers.length} McpServer(s)`)
    let index = 0
    const workers = Array.from(
      { length: Math.min(EXTERNAL_EGRESS_MAX_CONCURRENCY, servers.length) },
      async () => {
        while (!this.stopped && this.dependencies.inventoryAuthoritative()) {
          const server = servers[index++]
          if (!server) return
          const key = this.key(server)
          if (this.inFlight.has(key)) {
            console.log(`[K8s] Skipping external egress resync for ${key}; reconcile in flight`)
            continue
          }
          const jitterMs = Math.floor(Math.random() * EXTERNAL_EGRESS_RESYNC_JITTER_MS)
          if (jitterMs > 0) await delay(jitterMs)
          if (this.stopped || !this.dependencies.inventoryAuthoritative()) return

          await this.dependencies.enqueue(server, async () => {
            if (this.stopped || !this.dependencies.inventoryAuthoritative()) return
            // The fleet snapshot selects work only. Desired state is resolved
            // after jitter and after entering the per-server FIFO lane.
            const current = this.dependencies.getCurrentServer(server.name)
            if (
              !current ||
              current.namespace !== server.namespace ||
              (current.spec.egressBindings?.length ?? 0) === 0
            ) {
              return
            }
            try {
              const retryIntent = this.retryIntents.get(key)
              if (retryIntent) {
                await this.replayIntent(retryIntent)
                return
              }
              // Periodic refresh is egress-only and therefore cannot complete
              // a retry intent that may appear while the mutation is running.
              await this.reconcile('MODIFIED', current, {
                isCurrent: this.dependencies.inventoryAuthoritative,
              })
            } catch (error) {
              console.error(`[K8s] External egress periodic resync failed for ${key}:`, error)
              this.scheduleRetry('MODIFIED', current)
            }
          })
        }
      }
    )
    await Promise.all(workers)
  }

  private async replayIntent(intent: ExternalEgressRetryIntent): Promise<void> {
    if (this.stopped || !this.dependencies.inventoryAuthoritative()) return
    const handle = this.retryHandle(intent)
    if (!handle.isCurrent()) return

    const current = this.dependencies.getCurrentServer(intent.server.name)
    const type: ExternalEgressWatchEventType =
      current && current.namespace === intent.server.namespace ? 'MODIFIED' : 'DELETED'
    const server = type === 'DELETED' ? intent.server : current!
    await this.dependencies.replay(type, server, handle)
  }

  private reconcileIsCurrent(
    type: ExternalEgressWatchEventType,
    server: McpServerCRD,
    options: ExternalEgressReconcileOptions
  ): boolean {
    const callerIsCurrent =
      !this.stopped &&
      (!options.retry || options.retry.isCurrent()) &&
      (!options.isCurrent || options.isCurrent())
    if (!callerIsCurrent || type === 'DELETED') return callerIsCurrent

    const current = this.dependencies.getCurrentServer(server.name)
    return (
      current !== undefined &&
      current.namespace === server.namespace &&
      this.dependencies.sameDesiredRevision(server, current)
    )
  }

  private currentRetryHandle(key: string): ExternalEgressRetryHandle | undefined {
    const intent = this.retryIntents.get(key)
    return intent ? this.retryHandle(intent) : undefined
  }

  private retryHandle(intent: ExternalEgressRetryIntent): ExternalEgressRetryHandle {
    return {
      isCurrent: () =>
        !this.stopped &&
        this.retryIntents.get(this.key(intent.server))?.sequence === intent.sequence,
      complete: () => {
        if (this.retryIntents.get(this.key(intent.server))?.sequence !== intent.sequence) return
        this.clearRetry(intent.server)
      },
    }
  }

  private clearRetry(server: Pick<McpServerCRD, 'name' | 'namespace'>): void {
    const key = this.key(server)
    const timer = this.retryTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.retryTimers.delete(key)
    }
    this.retryAttempts.delete(key)
    this.retryIntents.delete(key)
    this.clearRetryAtCap(key)
  }

  private markRetryAtCap(key: string): void {
    if (this.retriesAtCap.has(key)) return
    this.retriesAtCap.add(key)
    externalEgressRetriesAtCap.set(this.retriesAtCap.size)
  }

  private clearRetryAtCap(key: string): void {
    if (!this.retriesAtCap.delete(key)) return
    externalEgressRetriesAtCap.set(this.retriesAtCap.size)
  }

  private sameRetryTarget(
    previous: ExternalEgressRetryIntent,
    type: ExternalEgressWatchEventType,
    server: McpServerCRD
  ): boolean {
    const previousPresent = previous.type !== 'DELETED'
    const nextPresent = type !== 'DELETED'
    return (
      previousPresent === nextPresent &&
      this.dependencies.sameDesiredRevision(previous.server, server)
    )
  }

  private key(server: Pick<McpServerCRD, 'name' | 'namespace'>): string {
    return `${server.namespace}/${server.name}`
  }

  private isWatchEventType(type: string): type is ExternalEgressWatchEventType {
    return type === 'ADDED' || type === 'MODIFIED' || type === 'DELETED'
  }
}
