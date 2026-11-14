/**
 * Retries the allowlist ConfigMap publication of a catalog sync whose rows
 * already committed but whose publish failed. Only the publication is retried,
 * never the run: the rows are durable, and `materializeIfChanged()` re-reads
 * Postgres under the publish lock, so a retry can never publish an older state
 * and is a no-op when the CM already matches.
 *
 * Without it, a failed publish stays unrepaired until the next sync run (a cron
 * tick, 24 h apart when the cron is on, or a manual sync), a boot or an admin
 * mutation, while control-api already accepts the new models and mcp-host still
 * rejects them.
 *
 * The state is per process and in memory: a replica that dies with a retry
 * pending loses it, and the next sync, boot or mutation converges instead.
 */
import { safeErrorLogMessage, safeErrorLogStack } from '../http/errorHandler.js'
import { rootLogger } from '../observability/logger.js'
import { llmAllowlistConfigMapWriteFailuresTotal } from '../observability/metrics.js'
import type { AllowedModelsConfigMapPublisher } from './llmAllowedModelsConfigMap.js'

const log = rootLogger.child({ service: 'llm_allowlist_publish_retry' })

export const ALLOWLIST_PUBLISH_RETRY_BASE_DELAY_MS = 30_000
export const ALLOWLIST_PUBLISH_RETRY_MAX_DELAY_MS = 60 * 60 * 1000

export interface AllowlistPublishRetryOptions {
  baseDelayMs?: number
  maxDelayMs?: number
}

/**
 * Publications are numbered when they START. A failed publication leaves its
 * number owed; a successful one settles every owed number strictly below its
 * own. That ordering is what makes "another publish succeeded, cancel the
 * retry" safe: a publication that started earlier ran after its own commit, and
 * the later one read Postgres under the lock after it started, so it saw that
 * commit. A failure numbered at or above a success may belong to a commit the
 * success did not read, so it stays owed.
 */
export class AllowlistPublishRetry {
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private sequence = 0
  private maxSucceeded = 0
  private owed: number | null = null
  private failures = 0
  private publisher: AllowedModelsConfigMapPublisher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight = false
  private stopped = false

  constructor(options: AllowlistPublishRetryOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? ALLOWLIST_PUBLISH_RETRY_BASE_DELAY_MS
    this.maxDelayMs = options.maxDelayMs ?? ALLOWLIST_PUBLISH_RETRY_MAX_DELAY_MS
  }

  /** Number a publication; call immediately before starting it. */
  begin(): number {
    this.sequence += 1
    return this.sequence
  }

  /** The publication numbered `ticket` failed after the run committed. */
  failed(ticket: number, publisher: AllowedModelsConfigMapPublisher): void {
    this.publisher = publisher
    this.markOwed(ticket)
    this.arm()
  }

  /** The publication numbered `ticket` succeeded (written or already equal). */
  succeeded(ticket: number): void {
    this.maxSucceeded = Math.max(this.maxSucceeded, ticket)
    if (this.owed !== null && this.owed < ticket) {
      this.owed = null
      this.failures = 0
      this.clearTimer()
    }
  }

  // A failure that settles AFTER a later-numbered success is already covered by
  // it (that success read Postgres after this one started), so it owes nothing.
  private markOwed(ticket: number): void {
    if (ticket < this.maxSucceeded) return
    this.owed = Math.max(this.owed ?? 0, ticket)
  }

  /** True while a publication is owed (pending timer or retry in flight). */
  isPending(): boolean {
    return this.owed !== null
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  // A retry in flight re-arms on completion if anything is still owed, so arming
  // is a no-op while one runs or a timer is already pending.
  private arm(): void {
    if (this.stopped || this.inFlight || this.timer || this.owed === null) return
    const delay = Math.min(this.baseDelayMs * 2 ** this.failures, this.maxDelayMs)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.fire()
    }, delay)
    this.timer.unref?.()
    log.warn(
      { event: 'llm_allowlist_publish_retry_scheduled', delayMs: delay, failures: this.failures },
      'llm allowed-models ConfigMap publish retry scheduled'
    )
  }

  private async fire(): Promise<void> {
    const publisher = this.publisher
    if (this.stopped || !publisher || this.owed === null) return
    this.inFlight = true
    const ticket = this.begin()
    try {
      const outcome = await publisher.materializeIfChanged()
      this.succeeded(ticket)
      log.info(
        { event: 'llm_allowlist_publish_retry_succeeded', outcome },
        'llm allowed-models ConfigMap publish retry succeeded'
      )
    } catch (err) {
      llmAllowlistConfigMapWriteFailuresTotal.inc({ phase: 'sync_retry' })
      if (ticket >= this.maxSucceeded) this.failures += 1
      this.markOwed(ticket)
      log.error(
        {
          event: 'llm_allowlist_publish_retry_failed',
          failures: this.failures,
          err: safeErrorLogMessage(err),
          stack: safeErrorLogStack(err),
        },
        'llm allowed-models ConfigMap publish retry failed'
      )
    } finally {
      this.inFlight = false
      this.arm()
    }
  }
}

/** The process-wide instance shared by the cron and the on-demand sync route. */
export const llmAllowlistPublishRetry = new AllowlistPublishRetry()

export function stopLlmAllowlistPublishRetry(): void {
  llmAllowlistPublishRetry.stop()
}
