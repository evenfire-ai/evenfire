/**
 * No-timeout client for durable cron rows.
 *
 * `timeoutMs` is null on every send, so a cron write waits for the worker
 * acknowledgement instead of the sync persist timeout. The stall watchdog
 * still bounds a hung worker.
 */
import type { CronClaimArgs, CronJobRecord } from '../db/cronJobs'
import type { WorkerOp } from '../db/worker/protocol'

export type { CronClaimArgs, CronJobRecord } from '../db/cronJobs'

export interface CronDurableStore {
  load(): Promise<CronJobRecord[]>
  insert(row: CronJobRecord): Promise<void>
  delete(id: string): Promise<void>
  read(id: string): Promise<CronJobRecord | null>
  claim(args: CronClaimArgs): Promise<{ changes: number }>
  setSchedule(id: string, enabled: boolean, nextRunAt: number | null): Promise<void>
  setLastRun(id: string, lastRunAt: number): Promise<void>
}

export interface CronDurableQueue {
  send<T = unknown>(op: WorkerOp, timeoutMs: null): Promise<T>
}

export function createCronDurableStore(queue: CronDurableQueue): CronDurableStore {
  return {
    load() {
      return queue.send<CronJobRecord[]>({ kind: 'load_cron_jobs' }, null)
    },
    async insert(row) {
      await queue.send({ kind: 'insert_cron_job', row }, null)
    },
    async delete(id) {
      await queue.send({ kind: 'delete_cron_job', id }, null)
    },
    read(id) {
      return queue.send<CronJobRecord | null>({ kind: 'read_cron_job', id }, null)
    },
    claim(args) {
      return queue.send<{ changes: number }>({ kind: 'claim_cron_job', ...args }, null)
    },
    async setSchedule(id, enabled, nextRunAt) {
      await queue.send({ kind: 'set_cron_schedule', id, enabled, nextRunAt }, null)
    },
    async setLastRun(id, lastRunAt) {
      await queue.send({ kind: 'set_cron_last_run', id, lastRunAt }, null)
    },
  }
}
