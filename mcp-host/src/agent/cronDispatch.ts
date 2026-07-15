/**
 * Cron task dispatch wiring — bridges cron:triggered events into SessionProcessor.
 *
 * Issue #529: CronScheduler enqueues tasks into MessageQueue but only SessionProcessor
 * executes them. This module mirrors the channel path (messageHandler.ts) by calling
 * sessionProcessor.enqueue after each cron fire.
 */
import type { Attachment } from '../core/types'
import type { Task, TaskResponsePayload } from '../queue/types'
import { type SessionProcessor, resolveCronTaskSessionKey, serializeSessionKey } from '../session'
import type { CronScheduler } from './cronScheduler'
import type { CronJob } from './types'

export type PendingCronResult = {
  origin: NonNullable<CronJob['origin']>
  response: string
  attachments?: Attachment[]
  cronJobId: string
  cronJobName: string
  timestamp: Date
  // Cron tasks bypass the runtime approval gate (see taskExecutor.ts
  // `task.source !== 'cron'`), so the dispatch path always stores
  // `status: 'completed'`. The field is kept optional only for forward
  // compatibility of the wire contract with channel-reader's `pollCronResults`.
  // It never carries an approval payload — cron results cannot be `waiting_approval`.
  status?: 'completed'
  /**
   * Epoch ms of the first read via GET /cron/results (delivered-on-read,
   * stamped by main.ts getCronResults). The explicit ACK delete remains the
   * strong consumption signal; this stamp only stops a fetched-but-unACKed
   * result from pinning the stateless `pendingResults` idle gauge for the
   * full TTL (see runtime/resultDelivery.ts).
   */
  deliveredAt?: number
}

export interface CronDispatchDeps {
  sessionProcessor: SessionProcessor | null
  pendingCronResults: {
    set(id: string, entry: PendingCronResult): void
  }
  sanitizeAttachments: (attachments?: Attachment[]) => Attachment[] | undefined
  /**
   * Cron×stateless in-flight marker (fixes the drained-gauge race). A one-shot
   * cron task flips `conversation.activeTaskId = undefined` (completeTurn)
   * BEFORE its `responseCallback` populates `pendingCronResults`, so there is a
   * bounded window where BOTH the `activeTask` and `pendingResults` conditions
   * read false and the stateless heartbeat could report `drained` -> HCC
   * suspends -> the not-yet-stored result is lost. The marker is armed here at
   * trigger time (well before the flip) and pins `pendingResults` for the whole
   * window; it is cleared on the task's terminal lifecycle transition (which
   * fires AFTER the result is stored on success, or on failure where no result
   * is produced and pinning is correctly dropped). Optional so non-stateless
   * wirings and existing tests stay byte-identical.
   */
  cronResultsInFlight?: { add(id: string): void }
}

export function wireCronDispatch(cronScheduler: CronScheduler, deps: CronDispatchDeps): void {
  cronScheduler.on('cron:triggered', ({ job, task: cronTask }: { job: CronJob; task: Task }) => {
    if (job.origin) {
      // Arm the in-flight marker at trigger time -- synchronously, before the
      // task ever runs and therefore before completeTurn flips activeTaskId.
      // Guaranteed cleared on the terminal lifecycle transition (see main.ts).
      deps.cronResultsInFlight?.add(cronTask.id)
      // Capture origin once: CronJob.origin is never reassigned after creation,
      // but the callback runs later (async), so binding it to a const removes the
      // non-null assertions and is robust to any future mutation of the job object.
      const origin = job.origin
      cronTask.responseCallback = async (payload: TaskResponsePayload) => {
        const attachments = deps.sanitizeAttachments(payload.attachments)
        const response = payload.error
          ? `Error: ${payload.error.message}`
          : (payload.response ?? '')
        deps.pendingCronResults.set(cronTask.id, {
          origin,
          response,
          attachments,
          cronJobId: job.id,
          cronJobName: job.name,
          timestamp: new Date(),
          status: 'completed',
        })
        console.log(
          `[CronDispatch] Cron result stored for delivery: task=${cronTask.id}, job=${job.name}, channel=${origin.channelType}:${origin.channelId}`
        )
      }
    }

    // FIX (issue #529): route the cron task into SessionProcessor so it executes,
    // mirroring the channel path. Invariant I12 is satisfied: lifecycle.register
    // ran inside MessageQueue.enqueue before this event was emitted.
    //
    // INVARIANT: this session key MUST match the one TaskExecutor derives for the
    // same task (taskExecutor.ts uses resolveCronTaskSessionKey for source==='cron').
    // Both paths call resolveCronTaskSessionKey — keep them in sync, otherwise the
    // task would run under a different session than it was queued in.
    const sessionKey = serializeSessionKey(resolveCronTaskSessionKey(cronTask))
    if (deps.sessionProcessor) {
      deps.sessionProcessor.enqueue(sessionKey, cronTask)
    } else {
      // Issue #529 safety net: a missing SessionProcessor would silently orphan
      // the cron task — the exact regression this module fixes. The optional
      // chain used to swallow this with no trace. Surface it loudly instead.
      console.error(
        `[CronDispatch] sessionProcessor unavailable — cron task ${cronTask.id} (job=${job.name}) was NOT dispatched`
      )
    }
  })
}
