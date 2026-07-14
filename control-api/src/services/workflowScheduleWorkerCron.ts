/**
 * Workflow schedule worker cron (DB-backed scheduler).
 *
 * Source: STAGE-4 DB-first plan (serene-sauteeing-jellyfish.md, Fase 5).
 *
 * Cadence: every `intervalMs` (default 10s). Lower than the archive cron
 * because schedule granularity is per-minute at worst — 10s keeps worst-case
 * firing latency ≤10s.
 *
 * Concurrency: the underlying service acquires a cluster-wide
 * `pg_try_advisory_lock(hashtext('wrc-schedule-worker-v1'))` — if another
 * control-api replica is already sweeping, this tick is a no-op.
 *
 * Timer handles are `unref()`'d so they do not keep the Node process alive on
 * shutdown, matching the pattern in `workflowRunsArchiveCron.ts`.
 */
import { rootLogger } from '../observability/logger.js'
import { processMaturedSchedules } from './workflowScheduleWorkerService.js'

let intervalHandle: ReturnType<typeof setInterval> | null = null
let firstRunHandle: ReturnType<typeof setTimeout> | null = null

/** First-run jitter so 3 replicas don't all wake at the same instant on deploy. */
const FIRST_RUN_JITTER_MS = 5_000

export interface StartWorkflowScheduleWorkerParams {
  intervalMs: number
  batchSize: number
}

export function startWorkflowScheduleWorker(params: StartWorkflowScheduleWorkerParams): void {
  if (intervalHandle || firstRunHandle) return

  const run = (): void => {
    processMaturedSchedules({ batchSize: params.batchSize }).catch(err => {
      // Service already emitted the error counter + log — swallow here so the
      // interval keeps ticking on the next window.
      rootLogger.warn(
        {
          event: 'workflow_schedule_worker_cron_error',
          err: err instanceof Error ? err.message : String(err),
        },
        'schedule worker cron iteration failed'
      )
    })
  }

  const firstDelay = Math.floor(Math.random() * FIRST_RUN_JITTER_MS)
  rootLogger.info(
    {
      event: 'workflow_schedule_worker_cron_started',
      intervalMs: params.intervalMs,
      batchSize: params.batchSize,
      firstRunInMs: firstDelay,
    },
    'schedule worker cron started'
  )

  firstRunHandle = setTimeout(() => {
    run()
    intervalHandle = setInterval(run, params.intervalMs)
    intervalHandle.unref()
  }, firstDelay)
  firstRunHandle.unref()
}

export function stopWorkflowScheduleWorker(): void {
  if (firstRunHandle) {
    clearTimeout(firstRunHandle)
    firstRunHandle = null
  }
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}
