/**
 * Workflow-runs archive cron (DB-first reaper).
 *
 * Source: STAGE-4 DB-first plan (serene-sauteeing-jellyfish.md, Fase 3).
 *
 * Cadence: every `intervalMs` (default 15 min, per plan).
 * Concurrency: the underlying service acquires a cluster-wide
 * `pg_try_advisory_lock(hashtext('workflow-runs-archive-v1'))` — if another
 * control-api replica is already sweeping, this tick is a no-op.
 *
 * Timer handles are `unref()`'d so they do not keep the Node process alive on
 * shutdown, matching the pattern in `userApprovalRequestArchiveCron.ts`.
 */
import type { K8sGateway } from '../k8s.js'
import { rootLogger } from '../observability/logger.js'
import { archiveTerminalRuns } from './workflowRunsArchiveService.js'

let intervalHandle: ReturnType<typeof setInterval> | null = null
let firstRunHandle: ReturnType<typeof setTimeout> | null = null

/** First-run jitter so 3 replicas don't all wake at the same instant on deploy. */
const FIRST_RUN_JITTER_MS = 30_000

export interface StartWorkflowRunsArchiveParams {
  gateway: K8sGateway
  intervalMs: number
  graceMs: number
  batchSize: number
}

export function startWorkflowRunsArchiveCron(params: StartWorkflowRunsArchiveParams): void {
  if (intervalHandle || firstRunHandle) return

  const run = (): void => {
    archiveTerminalRuns(params.gateway, {
      graceMs: params.graceMs,
      batchSize: params.batchSize,
    }).catch(err => {
      // Service already emitted the error counter + log — swallow here so the
      // interval keeps ticking on the next window.
      rootLogger.warn(
        {
          event: 'workflow_runs_archive_cron_error',
          err: err instanceof Error ? err.message : String(err),
        },
        'workflow-runs archive cron iteration failed'
      )
    })
  }

  const firstDelay = Math.floor(Math.random() * FIRST_RUN_JITTER_MS)
  rootLogger.info(
    {
      event: 'workflow_runs_archive_cron_started',
      intervalMs: params.intervalMs,
      graceMs: params.graceMs,
      batchSize: params.batchSize,
      firstRunInMs: firstDelay,
    },
    'workflow-runs archive cron started'
  )

  firstRunHandle = setTimeout(() => {
    run()
    intervalHandle = setInterval(run, params.intervalMs)
    intervalHandle.unref()
  }, firstDelay)
  firstRunHandle.unref()
}

export function stopWorkflowRunsArchiveCron(): void {
  if (firstRunHandle) {
    clearTimeout(firstRunHandle)
    firstRunHandle = null
  }
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}
