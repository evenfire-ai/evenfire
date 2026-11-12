/**
 * Record of successful `memory_write` calls (migration 018, `memory_writes`).
 *
 * The tool builds one {@link MemoryWriteEntry} after a write succeeded and
 * hands it to the {@link MemoryWriteLog} port. In a Host with a session
 * database the port is {@link SqliteMemoryWriteLog}; without one the tool is
 * built without a port and records nothing.
 *
 * A rejected `record` does not mean the row is absent: on the persist queue's
 * sync timeout the insert was already posted to the worker and can still land.
 */
import { Counter } from 'prom-client'
import type { PersistQueue } from '../core/conversation/persistence/persistQueue'

export interface MemoryWriteEntry {
  userKey: string
  scope: 'collective' | 'user'
  /** Relative to the scope's root: the Host base for `collective`, the user folder for `user`. */
  relativePath: string
  mode: 'append' | 'replace'
  /** sha256 (hex) of the full content the write left in the file. */
  contentSha256: string
  /** Seconds since the epoch. */
  writtenAt: number
}

export interface MemoryWriteLog {
  record(entry: MemoryWriteEntry): Promise<void>
}

/**
 * Memory writes that succeeded but whose record failed (the persist queue
 * rejected: worker error, worker exit or sync timeout). Served by the existing
 * /metrics endpoint through the prom-client global register.
 */
export const memoryWriteRecordFailuresTotal = new Counter({
  name: 'clerum_memory_write_record_failures_total',
  help: 'Successful memory writes whose record in the session database failed.',
  labelNames: ['scope'] as const,
})

export class SqliteMemoryWriteLog implements MemoryWriteLog {
  constructor(private readonly persistQueue: Pick<PersistQueue, 'enqueueSync'>) {}

  async record(entry: MemoryWriteEntry): Promise<void> {
    await this.persistQueue.enqueueSync({
      kind: 'insert_memory_write',
      payload: {
        user_key: entry.userKey,
        scope: entry.scope,
        relative_path: entry.relativePath,
        mode: entry.mode,
        content_sha256: entry.contentSha256,
        written_at: entry.writtenAt,
      },
    })
  }
}
