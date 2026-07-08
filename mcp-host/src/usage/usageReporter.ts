import { randomUUID } from 'node:crypto'

/**
 * Per-event usage record posted to control-api. Field names mirror the
 * control-api `usage_events` table schema.
 */
export type LlmUsageEvent = {
  request_id: string
  ts: string
  host_ref: string
  context_ref: string | null
  team_id: string | null
  provider: string
  model: string
  llm_secret_name: string | null
  source_kind: 'channel' | 'desktop' | 'workflow' | 'cron' | 'unknown'
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
}

const DEFAULT_FLUSH_MS = 60_000
const DEFAULT_RING_CAPACITY = 1000
const MAX_BATCH_PER_REQUEST = 1000

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
export class UsageReporter {
  private readonly buffer: LlmUsageEvent[] = []
  private readonly capacity: number
  private readonly flushIntervalMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly url: string
  private readonly getAccessToken: () => string
  private readonly refreshOnUnauthorized: (() => Promise<void>) | undefined
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private droppedSinceLastFlush = 0
  private refreshInFlight: Promise<void> | null = null

  constructor(opts: UsageReporterOptions) {
    this.capacity = opts.ringCapacity ?? DEFAULT_RING_CAPACITY
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.now = opts.now ?? Date.now
    this.url = `${opts.baseUrl.replace(/\/+$/, '')}/api/v1/internal/usage/llm/events`
    this.getAccessToken = opts.getAccessToken
    this.refreshOnUnauthorized = opts.refreshOnUnauthorized
    const jitter = (opts.randomJitter ?? Math.random)()
    const initialDelay = Math.max(0, Math.floor(jitter * this.flushIntervalMs))
    this.timer = setTimeout(() => this.tick(), initialDelay)
  }

  enqueue(event: LlmUsageEvent): void {
    if (this.stopped) return
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift()
      this.droppedSinceLastFlush++
    }
    this.buffer.push(event)
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
    const batch = this.buffer.splice(0, MAX_BATCH_PER_REQUEST)
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
        // Re-queue the batch at the front so the next flush retries it.
        // The DB is idempotent on request_id, so a transient 5xx → retry
        // will not double-count.
        this.buffer.unshift(...batch)
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
      this.buffer.unshift(...batch)
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[UsageReporter] flush threw (count=${batch.length}, err=${msg}); will retry on next tick`
      )
    }
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

/**
 * Generates a fresh `request_id` UUID for an LLM call. Exposed as a helper
 * so call sites can mint the id BEFORE calling the LLM (the spec's
 * idempotency anchor).
 */
export function newRequestId(): string {
  return randomUUID()
}
