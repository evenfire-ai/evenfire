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
}

type ExternalEgressReconcileOptions = ExternalEgressMutationOptions & {
  retry?: ExternalEgressRetryHandle
}

type ExternalEgressCoordinatorDependencies = {
  listServers: () => McpServerCRD[]
  getCurrentServer: (name: string) => McpServerCRD | undefined
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
  private readonly inFlight = new Map<string, Promise<void>>()
  private resyncInFlight: Promise<void> | null = null
  private resyncTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(private readonly dependencies: ExternalEgressCoordinatorDependencies) {}

  startPeriodicResync(intervalSec: number): void {
    if (this.stopped || intervalSec <= 0 || this.resyncTimer) return
    this.resyncTimer = setInterval(() => {
      void this.runResync()
    }, intervalSec * 1000)
    console.log(`[K8s] External egress periodic DNS resync enabled (every ${intervalSec}s)`)
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

  prepareStartupGates(servers: McpServerCRD[]): ExternalEgressStartupGates {
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
          if (this.stopped) return false
          let ready = false
          await this.dependencies.enqueue(selected, async () => {
            if (this.stopped) return
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
              await this.reconcile('MODIFIED', current)
              const latest = this.dependencies.getCurrentServer(selected.name)
              ready =
                !this.stopped &&
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
    if (this.stopped || (options.retry && !options.retry.isCurrent())) return undefined
    const key = this.key(server)
    let existing = this.inFlight.get(key)
    while (existing) {
      console.warn(`[K8s] Waiting for external egress reconcile for ${key}; already in flight`)
      await existing
      if (this.stopped || (options.retry && !options.retry.isCurrent())) return undefined
      existing = this.inFlight.get(key)
    }

    const completion = options.retry ?? this.currentRetryHandle(key)
    const run = this.dependencies.mutate(type, server, {
      deleteAllowed: options.deleteAllowed,
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
        if (this.stopped || this.retrySlots.get(key) !== slot) return
        // Do not capture intent before the limiter. Churn while capacity is
        // saturated is represented by one slot and resolved latest-wins here.
        const admittedIntent = this.retryIntents.get(key)
        if (!admittedIntent) return
        await this.dependencies.enqueue(admittedIntent.server, async () => {
          if (this.stopped || this.retrySlots.get(key) !== slot) return
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
      clearInterval(this.resyncTimer)
      this.resyncTimer = null
    }
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer)
    }
    this.retryTimers.clear()
    this.retryAttempts.clear()
    this.retryIntents.clear()
    this.retrySlots.clear()
    this.inFlight.clear()
  }

  private async runResyncCore(): Promise<void> {
    if (this.stopped) return
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
        while (!this.stopped) {
          const server = servers[index++]
          if (!server) return
          const key = this.key(server)
          if (this.inFlight.has(key)) {
            console.log(`[K8s] Skipping external egress resync for ${key}; reconcile in flight`)
            continue
          }
          const jitterMs = Math.floor(Math.random() * EXTERNAL_EGRESS_RESYNC_JITTER_MS)
          if (jitterMs > 0) await delay(jitterMs)
          if (this.stopped) return

          await this.dependencies.enqueue(server, async () => {
            if (this.stopped) return
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
              await this.reconcile('MODIFIED', current)
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
    if (this.stopped) return
    const handle = this.retryHandle(intent)
    if (!handle.isCurrent()) return

    const current = this.dependencies.getCurrentServer(intent.server.name)
    const type: ExternalEgressWatchEventType =
      current && current.namespace === intent.server.namespace ? 'MODIFIED' : 'DELETED'
    const server = type === 'DELETED' ? intent.server : current!
    await this.dependencies.replay(type, server, handle)
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
