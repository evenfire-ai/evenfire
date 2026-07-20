import {
  governedTraceDroppedTotal,
  governedTraceEnqueuedTotal,
  governedTraceFlushesTotal,
  governedTraceGapsTotal,
  governedTraceRetriesTotal,
} from './metrics'
import { signInternalControlJwt } from './utils/internalControlSigner'

const DEFAULT_CONTROL_API_BASE_URL = 'http://control-api.control-plane.svc.cluster.local:8090'
const DEFAULT_CAPACITY = 64
const DEFAULT_RETRY_LIMIT = 2
const DEFAULT_TIMEOUT_MS = 1_000
const DEFAULT_DRAIN_TIMEOUT_MS = 1_000

export type WorkflowLifecycleProjection = {
  sourceEventId: string
  occurredAt: string
  runId: string
  eventType: 'run_start' | 'run_end'
  payload: { phase: string }
}

export type WorkflowInfrastructureTelemetryProjection = {
  sourceEventId: string
  occurredAt: string
  telemetryType: 'reconcile_outcome' | 'lifecycle_transition' | 'controller_error'
  runId: string
  payload: {
    phase?: string
    status?: string
    transition?: string
    error_class?: string
  }
}

export function createGovernedTraceReporter(enabled: boolean): GovernedTraceReporter | null {
  if (!enabled) return null
  return new BoundedGovernedTraceReporter()
}

export interface GovernedTraceReporter {
  enqueueWorkflowLifecycle(projection: WorkflowLifecycleProjection): void
  enqueueInfrastructureTelemetry(projection: WorkflowInfrastructureTelemetryProjection): void
  stopAndDrain(timeoutMs?: number): Promise<{ drained: boolean; dropped: number }>
}

type ReporterDependencies = {
  baseUrl?: string
  signToken?: () => string
  fetchFn?: typeof fetch
  capacity?: number
  retryLimit?: number
  timeoutMs?: number
  random?: () => number
}

type BufferedProjection =
  | { family: 'agent_run'; projection: WorkflowLifecycleProjection; attempts: number }
  | {
      family: 'infrastructure_telemetry'
      projection: WorkflowInfrastructureTelemetryProjection
      attempts: number
    }

/**
 * Bounded, best-effort WRC reporter. Its enqueue methods are deliberately
 * synchronous O(1): signing, serialization, HTTP, and retries happen only
 * after the caller has returned from the DB/status transition.
 */
export class BoundedGovernedTraceReporter implements GovernedTraceReporter {
  private readonly capacity: number
  private readonly entries: Array<BufferedProjection | undefined>
  private readonly retryLimit: number
  private readonly timeoutMs: number
  private readonly baseUrl: string
  private readonly signToken: () => string
  private readonly fetchFn: typeof fetch
  private readonly random: () => number
  private head = 0
  private size = 0
  private flushInFlight = false
  private scheduled = false
  private retryScheduled = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private drainTimedOut = false
  private drainWaiters: Array<() => void> = []

  constructor(deps: ReporterDependencies = {}) {
    this.capacity = deps.capacity ?? DEFAULT_CAPACITY
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) {
      throw new Error('governed trace reporter capacity must be a positive integer')
    }
    this.entries = Array.from({ length: this.capacity })
    this.retryLimit = deps.retryLimit ?? DEFAULT_RETRY_LIMIT
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.baseUrl = (
      deps.baseUrl ??
      process.env.CONTROL_API_BASE_URL ??
      DEFAULT_CONTROL_API_BASE_URL
    ).replace(/\/$/, '')
    this.signToken = deps.signToken ?? signInternalControlJwt
    this.fetchFn = deps.fetchFn ?? fetch
    this.random = deps.random ?? Math.random
  }

  enqueueWorkflowLifecycle(projection: WorkflowLifecycleProjection): void {
    this.enqueue({ family: 'agent_run', projection, attempts: 0 }, projection.eventType)
  }

  enqueueInfrastructureTelemetry(projection: WorkflowInfrastructureTelemetryProjection): void {
    this.enqueue(
      { family: 'infrastructure_telemetry', projection, attempts: 0 },
      projection.telemetryType
    )
  }

  private enqueue(entry: BufferedProjection, type: string): void {
    if (this.stopped) {
      this.recordGap(entry, type, 'reporter_stopped')
      return
    }
    if (this.size === this.capacity) {
      this.recordGap(entry, type, 'buffer_full')
      return
    }
    this.entries[(this.head + this.size) % this.capacity] = entry
    this.size += 1
    governedTraceEnqueuedTotal.inc({ family: entry.family, type })
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.size === 0 || this.scheduled || this.flushInFlight || this.retryScheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      void this.flush()
      this.notifyDrainWaiters()
    })
  }

  private dequeue(): BufferedProjection | undefined {
    if (this.size === 0) return undefined
    const entry = this.entries[this.head]
    this.entries[this.head] = undefined
    this.head = (this.head + 1) % this.capacity
    this.size -= 1
    return entry
  }

  private requeue(entry: BufferedProjection): void {
    if (this.size === this.capacity) {
      this.recordGap(entry, this.typeOf(entry), 'requeue_full')
      return
    }
    this.entries[(this.head + this.size) % this.capacity] = entry
    this.size += 1
  }

  private async flush(): Promise<void> {
    if (this.flushInFlight) return
    this.flushInFlight = true
    try {
      const entry = this.dequeue()
      if (!entry) return
      try {
        await this.submit(entry)
        governedTraceFlushesTotal.inc({ family: entry.family, result: 'accepted' })
      } catch {
        if (this.drainTimedOut) {
          this.recordGap(entry, this.typeOf(entry), 'shutdown_timeout')
          return
        }
        if (entry.attempts >= this.retryLimit) {
          governedTraceFlushesTotal.inc({ family: entry.family, result: 'exhausted' })
          this.recordGap(entry, this.typeOf(entry), 'retry_exhausted')
        } else {
          entry.attempts += 1
          governedTraceRetriesTotal.inc({
            family: entry.family,
            type: this.typeOf(entry),
          })
          this.requeue(entry)
          this.retryScheduled = true
          const delayMs = 25 * 2 ** (entry.attempts - 1) + Math.floor(this.random() * 25)
          const timer = setTimeout(() => {
            this.retryScheduled = false
            this.retryTimer = null
            void this.flush()
            this.notifyDrainWaiters()
          }, delayMs)
          this.retryTimer = timer
          timer.unref?.()
        }
      }
    } finally {
      this.flushInFlight = false
      this.scheduleFlush()
      this.notifyDrainWaiters()
    }
  }

  async stopAndDrain(
    timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS
  ): Promise<{ drained: boolean; dropped: number }> {
    this.stopped = true
    if (this.isIdle()) return { drained: true, dropped: 0 }

    const boundedTimeoutMs = Math.max(0, timeoutMs)
    const drained = await new Promise<boolean>(resolve => {
      let timer: ReturnType<typeof setTimeout>
      const onStateChange = () => {
        if (!this.isIdle()) return
        clearTimeout(timer)
        this.removeDrainWaiter(onStateChange)
        resolve(true)
      }

      timer = setTimeout(() => {
        this.removeDrainWaiter(onStateChange)
        resolve(false)
      }, boundedTimeoutMs)
      timer.unref?.()

      this.drainWaiters.push(onStateChange)
      onStateChange()
    })

    if (drained) return { drained: true, dropped: 0 }
    this.drainTimedOut = true
    return { drained: false, dropped: this.dropBufferedEntries('shutdown_timeout') }
  }

  private isIdle(): boolean {
    return this.size === 0 && !this.scheduled && !this.flushInFlight && !this.retryScheduled
  }

  private notifyDrainWaiters(): void {
    if (this.drainWaiters.length === 0) return
    for (const waiter of [...this.drainWaiters]) waiter()
  }

  private removeDrainWaiter(waiter: () => void): void {
    this.drainWaiters = this.drainWaiters.filter(candidate => candidate !== waiter)
  }

  private dropBufferedEntries(reason: string): number {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
      this.retryScheduled = false
    }
    let dropped = 0
    while (this.size > 0) {
      const entry = this.dequeue()
      if (!entry) continue
      this.recordGap(entry, this.typeOf(entry), reason)
      dropped += 1
    }
    this.notifyDrainWaiters()
    return dropped
  }

  private typeOf(entry: BufferedProjection): string {
    return entry.family === 'agent_run'
      ? entry.projection.eventType
      : entry.projection.telemetryType
  }

  private recordGap(entry: BufferedProjection, type: string, reason: string): void {
    governedTraceDroppedTotal.inc({ family: entry.family, type, reason })
    governedTraceGapsTotal.inc({ family: entry.family, type, reason })
  }

  private async submit(entry: BufferedProjection): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const isLifecycle = entry.family === 'agent_run'
      const event =
        entry.family === 'agent_run'
          ? {
              sourceEventId: entry.projection.sourceEventId,
              occurredAt: entry.projection.occurredAt,
              eventType: entry.projection.eventType,
              runId: entry.projection.runId,
              payload: entry.projection.payload,
            }
          : {
              sourceEventId: entry.projection.sourceEventId,
              occurredAt: entry.projection.occurredAt,
              telemetryType: entry.projection.telemetryType,
              workflowRunLookupReference: { runId: entry.projection.runId },
              payload: entry.projection.payload,
            }
      const response = await this.fetchFn(
        `${this.baseUrl}/api/v1/internal/tracing/${
          isLifecycle ? 'agent-run-events' : 'infrastructure-telemetry-events'
        }`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.signToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ events: [event] }),
          signal: controller.signal,
        }
      )
      if (!response.ok) throw new Error(`governed trace submit failed with ${response.status}`)
    } finally {
      clearTimeout(timeout)
    }
  }
}
