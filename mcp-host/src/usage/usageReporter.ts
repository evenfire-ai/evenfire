import { randomUUID } from 'node:crypto'
import {
  governedRunBatchSize,
  governedRunDroppedTotal,
  governedRunEnqueuedTotal,
  governedRunFlushesTotal,
  governedRunGapsTotal,
} from './governedRunMetrics'

/**
 * Per-event usage record posted to control-api. Field names mirror the
 * control-api `usage_events` table schema.
 */
export type LlmUsageEvent = {
  request_id: string
  ts: string
  run_id: string | null
  host_ref: string
  context_ref: string | null
  team_id: string | null
  provider: string
  model: string
  llm_secret_name: string | null
  source_kind: 'channel' | 'desktop' | 'workflow' | 'cron' | 'unknown' | 'plugin_workload_sdk'
  user_id: string | null
  sender: string | null
  channel_type: string | null
  recipe_name: string | null
  cron_job_id: string | null
  task_id: string | null
  iteration: number | null
  input_tokens: number
  output_tokens: number
  /**
   * T2.2 (P1-006) — Anthropic prompt-cache tokens. Optional because
   * non-Anthropic providers do not emit them; control-api persists them as 0
   * when absent. SDK field names map: `cache_read_input_tokens` →
   * `cache_read_tokens`, `cache_creation_input_tokens` → `cache_write_tokens`.
   */
  cache_read_tokens?: number
  cache_write_tokens?: number
  /**
   * Sanitized attribution for a Plugin Workload SDK promptBridge call. The
   * values are policy identities and bounded execution metadata only; raw
   * credentials, bearer tokens, and provider responses never enter this
   * event.
   */
  prompt_bridge_metadata?: {
    /** Server-issued Plugin Workload SDK invocation identity, when applicable. */
    invocation_id?: string
    target_ref: string
    credential_slot: string
    fallback_used: boolean
    attempt_count: number
    attempt_generation?: number
    provider_attempt_id?: string
    provider_attempt_index?: number
  }
}

export type UsageReporterOptions = {
  baseUrl: string
  /**
   * Returns the current mcp-host runtime access JWT. Called fresh on every
   * flush so refresh-on-401 mutations on the shared McpHostRuntimeAuth
   * propagate without the reporter holding a stale token.
   */
  getAccessToken: () => string
  /**
   * Optional refresh trigger. Called once per flush attempt that returned
   * 401, before the batch is re-queued — typically wired to the shared
   * runtime auth's refresh+recover path so the next tick uses a fresh
   * token. Periodic flushes from a quiet pod (no workflow approvals)
   * would otherwise never trigger a refresh and would 401 forever once
   * the original access token expires.
   */
  refreshOnUnauthorized?: () => Promise<void>
  flushIntervalMs?: number
  ringCapacity?: number
  fetchImpl?: typeof fetch
  now?: () => number
  randomJitter?: () => number
  onEnqueue?: (event: LlmUsageEvent) => void
}

export type GovernedRunEvent = {
  sourceEventId: string
  occurredAt: string
  eventType: 'run_start' | 'llm_call' | 'tool_call' | 'approval' | 'token_usage' | 'run_end'
  runId: string
  approvalRequestId?: string
  hostRef: string
  sessionId?: string | null
  origin: 'direct_chat' | 'channel_event' | 'api'
  payload?: {
    status?: string
    error_class?: string
    tool_name?: string
    tool_kind?: 'internal_tool' | 'mcp_server_tool' | 'workflow'
    tool_source_ref?: string
    model?: string
    attempt?: number
    count?: number
  }
}

export type GovernedRunReporterOptions = Pick<
  UsageReporterOptions,
  'baseUrl' | 'getAccessToken' | 'refreshOnUnauthorized' | 'fetchImpl'
> & {
  flushIntervalMs?: number
  capacity?: number
}

const DEFAULT_FLUSH_MS = 60_000
const DEFAULT_RING_CAPACITY = 1000
const MAX_BATCH_PER_REQUEST = 1000

function isRetryableUsageStatus(status: number): boolean {
  return status === 401 || status === 408 || status === 429 || status >= 500
}

function isPermanentUsageStatus(status: number): boolean {
  return status >= 400 && status < 500 && !isRetryableUsageStatus(status)
}

/**
 * Bounded ring buffer + 60 s flusher for LLM usage events.
 *
 * Behavior contract:
 * - enqueue() is non-blocking, constant-time. It never awaits I/O.
 * - On overflow we drop the **oldest** event, preserving recent traffic.
 * - The flush schedule jitters its first tick within [0, flushIntervalMs)
 *   so a fleet of restarts doesn't stampede control-api.
 * - drain() flushes the current buffer and is intended for SIGTERM.
 */
class BoundedRing<T> {
  private readonly entries: Array<T | undefined>
  private head = 0
  private size = 0

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error('ring capacity must be positive')
    this.entries = Array.from({ length: capacity })
  }

  get length(): number {
    return this.size
  }

  peek(): T | undefined {
    return this.size > 0 ? this.entries[this.head] : undefined
  }

  shift(): T | undefined {
    return this.take(1)[0]
  }

  pushDropOldest(value: T): boolean {
    let dropped = false
    if (this.size === this.capacity) {
      this.entries[this.head] = undefined
      this.head = (this.head + 1) % this.capacity
      this.size -= 1
      dropped = true
    }
    this.entries[(this.head + this.size) % this.capacity] = value
    this.size += 1
    return dropped
  }

  take(limit: number): T[] {
    const values: T[] = []
    while (values.length < limit && this.size > 0) {
      const value = this.entries[this.head]
      this.entries[this.head] = undefined
      this.head = (this.head + 1) % this.capacity
      this.size -= 1
      if (value !== undefined) values.push(value)
    }
    return values
  }

  prepend(values: readonly T[]): void {
    const existing = this.take(this.size)
    for (const value of [...values, ...existing].slice(0, this.capacity)) {
      this.pushDropOldest(value)
    }
  }
}

type BufferedGovernedRunEvent = {
  order: number
  event: GovernedRunEvent
}

type GovernedBufferAdmission = {
  accepted: boolean
  dropped?: BufferedGovernedRunEvent
}

const CRITICAL_GOVERNED_EVENT_TYPES = new Set<GovernedRunEvent['eventType']>([
  'run_start',
  'approval',
  'token_usage',
  'run_end',
])

function isCriticalGovernedEvent(event: GovernedRunEvent): boolean {
  if (CRITICAL_GOVERNED_EVENT_TYPES.has(event.eventType)) return true
  return ['failed', 'cancelled', 'denied', 'error'].includes(event.payload?.status ?? '')
}

function governedPriority(event: GovernedRunEvent): 'critical' | 'verbose' {
  return isCriticalGovernedEvent(event) ? 'critical' : 'verbose'
}

class GovernedRunBuffer {
  private readonly critical: BoundedRing<BufferedGovernedRunEvent>
  private readonly verbose: BoundedRing<BufferedGovernedRunEvent>
  private nextOrder = 0

  constructor(readonly capacity: number) {
    this.critical = new BoundedRing(capacity)
    this.verbose = new BoundedRing(capacity)
  }

  get length(): number {
    return this.critical.length + this.verbose.length
  }

  push(event: GovernedRunEvent): GovernedBufferAdmission {
    return this.pushEntry({ order: this.nextOrder++, event })
  }

  take(limit: number): BufferedGovernedRunEvent[] {
    const entries: BufferedGovernedRunEvent[] = []
    while (entries.length < limit && this.length > 0) {
      const critical = this.critical.peek()
      const verbose = this.verbose.peek()
      if (!verbose || (critical && critical.order < verbose.order)) {
        const entry = this.critical.shift()
        if (entry) entries.push(entry)
      } else {
        const entry = this.verbose.shift()
        if (entry) entries.push(entry)
      }
    }
    return entries
  }

  prepend(entries: readonly BufferedGovernedRunEvent[]): GovernedBufferAdmission[] {
    const current = this.take(this.length)
    const admissions: GovernedBufferAdmission[] = []
    for (const entry of [...entries, ...current].sort((a, b) => a.order - b.order)) {
      admissions.push(this.pushEntry(entry))
    }
    return admissions
  }

  private pushEntry(entry: BufferedGovernedRunEvent): GovernedBufferAdmission {
    const critical = isCriticalGovernedEvent(entry.event)
    let dropped: BufferedGovernedRunEvent | undefined
    if (this.length >= this.capacity) {
      if (this.verbose.length > 0) {
        dropped = this.verbose.shift()
      } else if (critical) {
        dropped = this.critical.shift()
      } else {
        return { accepted: false, dropped: entry }
      }
    }
    ;(critical ? this.critical : this.verbose).pushDropOldest(entry)
    return { accepted: true, ...(dropped ? { dropped } : {}) }
  }
}

export class UsageReporter {
  private readonly buffer: BoundedRing<LlmUsageEvent>
  private readonly capacity: number
  private readonly flushIntervalMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly url: string
  private readonly getAccessToken: () => string
  private readonly refreshOnUnauthorized: (() => Promise<void>) | undefined
  private readonly onEnqueue: ((event: LlmUsageEvent) => void) | undefined
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private droppedSinceLastFlush = 0
  private refreshInFlight: Promise<void> | null = null

  constructor(opts: UsageReporterOptions) {
    this.capacity = opts.ringCapacity ?? DEFAULT_RING_CAPACITY
    this.buffer = new BoundedRing(this.capacity)
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.now = opts.now ?? Date.now
    this.url = `${opts.baseUrl.replace(/\/+$/, '')}/api/v1/internal/usage/llm/events`
    this.getAccessToken = opts.getAccessToken
    this.refreshOnUnauthorized = opts.refreshOnUnauthorized
    this.onEnqueue = opts.onEnqueue
    const jitter = (opts.randomJitter ?? Math.random)()
    const initialDelay = Math.max(0, Math.floor(jitter * this.flushIntervalMs))
    this.timer = setTimeout(() => this.tick(), initialDelay)
  }

  enqueue(event: LlmUsageEvent): void {
    if (this.stopped) return
    if (this.buffer.pushDropOldest(event)) this.droppedSinceLastFlush++
    try {
      this.onEnqueue?.(event)
    } catch {
      // Trace projection is observational and cannot affect usage capture.
    }
  }

  /** Flushes whatever is currently in the buffer. Safe to call on shutdown. */
  async drain(): Promise<void> {
    await this.flushOnce()
  }

  /** Stop the periodic flusher. Does not flush — pair with drain() for graceful shutdown. */
  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Test-only: returns a snapshot of the current buffer length. */
  bufferSize(): number {
    return this.buffer.length
  }

  private tick(): void {
    if (this.stopped) return
    void this.flushOnce().finally(() => {
      if (this.stopped) return
      this.timer = setTimeout(() => this.tick(), this.flushIntervalMs)
    })
  }

  private async flushOnce(): Promise<void> {
    if (this.buffer.length === 0) return
    const droppedReport = this.droppedSinceLastFlush
    if (droppedReport > 0) {
      console.warn(
        `[UsageReporter] dropped ${droppedReport} oldest events to fit ring buffer (capacity=${this.capacity})`
      )
      this.droppedSinceLastFlush = 0
    }
    const batch = this.buffer.take(MAX_BATCH_PER_REQUEST)
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.getAccessToken()}`,
        },
        body: JSON.stringify({ events: batch }),
      })
      if (!res.ok) {
        if (isPermanentUsageStatus(res.status)) {
          await this.flushPermanentRejectionBatch(batch, res.status)
          return
        }
        // Re-queue the batch at the front so the next flush retries it.
        // The DB is idempotent on request_id, so a transient 5xx → retry
        // will not double-count.
        this.buffer.prepend(batch)
        console.warn(
          `[UsageReporter] flush rejected (status=${res.status}, count=${batch.length}); will retry on next tick`
        )
        // 401 specifically: the access token has likely expired. Trigger
        // a refresh on the shared auth so the *next* tick reads a fresh
        // token via getAccessToken(). Without this, a quiet pod (no
        // approvals) would 401 forever once its original token aged out.
        if (res.status === 401 && this.refreshOnUnauthorized) {
          await this.triggerRefresh()
        }
      }
    } catch (err) {
      this.buffer.prepend(batch)
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[UsageReporter] flush threw (count=${batch.length}, err=${msg}); will retry on next tick`
      )
    }
  }

  private async flushPermanentRejectionBatch(
    batch: LlmUsageEvent[],
    batchStatus: number
  ): Promise<void> {
    const retryable: LlmUsageEvent[] = []
    for (const event of batch) {
      try {
        const res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.getAccessToken()}`,
          },
          body: JSON.stringify({ events: [event] }),
        })
        if (res.ok) continue
        if (isRetryableUsageStatus(res.status)) {
          retryable.push(event)
          if (res.status === 401 && this.refreshOnUnauthorized) {
            await this.triggerRefresh()
          }
          continue
        }
        console.warn(
          `[UsageReporter] dropping permanently rejected event (batchStatus=${batchStatus}, status=${res.status}, request_id=${event.request_id})`
        )
      } catch (err) {
        retryable.push(event)
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[UsageReporter] isolated flush threw (request_id=${event.request_id}, err=${msg}); will retry on next tick`
        )
      }
    }
    if (retryable.length > 0) this.buffer.prepend(retryable)
  }

  private async triggerRefresh(): Promise<void> {
    if (!this.refreshOnUnauthorized) return
    if (this.refreshInFlight) {
      // Coalesce concurrent flush retries onto a single refresh attempt so
      // we don't burn refresh tokens (control-api revokes refresh JTIs on
      // first use).
      await this.refreshInFlight
      return
    }
    this.refreshInFlight = this.refreshOnUnauthorized()
      .then(() => {
        return undefined
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[UsageReporter] refresh-on-401 failed: ${msg}`)
      })
    try {
      await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
    }
  }
}

/** Bounded, best-effort governed run reporter. Enqueue never performs I/O. */
export class GovernedRunReporter {
  private readonly buffer: GovernedRunBuffer
  private readonly capacity: number
  private readonly flushIntervalMs: number
  private readonly fetchImpl: typeof fetch
  private readonly url: string
  private readonly getAccessToken: () => string
  private readonly refreshOnUnauthorized: (() => Promise<void>) | undefined
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushInFlight: Promise<void> | null = null
  private stopped = false

  constructor(options: GovernedRunReporterOptions) {
    this.capacity = options.capacity ?? 256
    this.buffer = new GovernedRunBuffer(this.capacity)
    this.flushIntervalMs = options.flushIntervalMs ?? 1_000
    this.fetchImpl = options.fetchImpl ?? fetch
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/api/v1/internal/tracing/agent-run-events`
    this.getAccessToken = options.getAccessToken
    this.refreshOnUnauthorized = options.refreshOnUnauthorized
    this.timer = setTimeout(() => this.tick(), this.flushIntervalMs)
    this.timer.unref?.()
  }

  enqueue(event: GovernedRunEvent): void {
    if (this.stopped) return
    const admission = this.buffer.push(event)
    if (admission.accepted) {
      governedRunEnqueuedTotal.inc({ type: event.eventType, priority: governedPriority(event) })
    }
    if (admission.dropped) this.recordDrop(admission.dropped.event, 'buffer_full')
  }

  async drain(): Promise<void> {
    await this.flushOnce()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  bufferSize(): number {
    return this.buffer.length
  }

  private tick(): void {
    if (this.stopped) return
    void this.flushOnce().finally(() => {
      if (this.stopped) return
      this.timer = setTimeout(() => this.tick(), this.flushIntervalMs)
      this.timer.unref?.()
    })
  }

  private async flushOnce(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight
    if (this.buffer.length === 0) return
    this.flushInFlight = this.flushBatch()
    try {
      await this.flushInFlight
    } finally {
      this.flushInFlight = null
    }
  }

  private async flushBatch(): Promise<void> {
    const batch = this.buffer.take(100)
    governedRunBatchSize.observe(batch.length)
    const retryable = await this.deliver(batch)
    if (retryable.length > 0) this.requeue(retryable)
  }

  private async deliver(
    entries: readonly BufferedGovernedRunEvent[]
  ): Promise<BufferedGovernedRunEvent[]> {
    try {
      let response = await this.post(entries.map(entry => entry.event))
      if (response.status === 401 && this.refreshOnUnauthorized) {
        await this.refreshOnUnauthorized().catch(() => undefined)
        response = await this.post(entries.map(entry => entry.event))
      }
      if (response.ok) {
        governedRunFlushesTotal.inc({ result: 'accepted' })
        return []
      }
      if (!this.isPermanentClientError(response.status)) {
        governedRunFlushesTotal.inc({ result: 'retryable' })
        return [...entries]
      }
      if (entries.length === 1) {
        governedRunFlushesTotal.inc({ result: 'rejected' })
        this.recordDrop(entries[0]!.event, 'permanent_rejection')
        console.warn(
          `[GovernedRunReporter] dropping rejected event (status=${response.status}, sourceEventId=${entries[0]!.event.sourceEventId})`
        )
        return []
      }
      const midpoint = Math.ceil(entries.length / 2)
      return [
        ...(await this.deliver(entries.slice(0, midpoint))),
        ...(await this.deliver(entries.slice(midpoint))),
      ]
    } catch {
      governedRunFlushesTotal.inc({ result: 'retryable' })
      return [...entries]
    }
  }

  private isPermanentClientError(status: number): boolean {
    return status >= 400 && status < 500 && ![401, 408, 425, 429].includes(status)
  }

  private post(events: readonly GovernedRunEvent[]): Promise<Response> {
    return this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.getAccessToken()}`,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(1_000),
    })
  }

  private requeue(events: readonly BufferedGovernedRunEvent[]): void {
    for (const admission of this.buffer.prepend(events)) {
      if (admission.dropped) this.recordDrop(admission.dropped.event, 'requeue_full')
    }
  }

  private recordDrop(event: GovernedRunEvent, reason: string): void {
    const priority = governedPriority(event)
    governedRunDroppedTotal.inc({ type: event.eventType, priority, reason })
    if (priority === 'critical') {
      governedRunGapsTotal.inc({ type: event.eventType, reason })
    }
  }
}

export function createGovernedRunReporter(
  enabled: boolean,
  options: GovernedRunReporterOptions
): GovernedRunReporter | null {
  if (!enabled) return null
  return new GovernedRunReporter(options)
}

/**
 * Generates a fresh `request_id` UUID for an LLM call. Exposed as a helper
 * so call sites can mint the id BEFORE calling the LLM (the spec's
 * idempotency anchor).
 */
export function newRequestId(): string {
  return randomUUID()
}
