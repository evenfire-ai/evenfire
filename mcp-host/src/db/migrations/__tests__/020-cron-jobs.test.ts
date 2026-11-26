import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as migration from '../020-cron-jobs'
import { migrations } from '../index'

/** Declared columns from the cron_jobs CREATE TABLE, in order. */
const COLUMNS: Array<{ name: string; type: string; notnull: number }> = [
  { name: 'id', type: 'TEXT', notnull: 0 },
  { name: 'name', type: 'TEXT', notnull: 1 },
  { name: 'schedule', type: 'TEXT', notnull: 1 },
  { name: 'task', type: 'TEXT', notnull: 1 },
  { name: 'enabled', type: 'INTEGER', notnull: 1 },
  { name: 'next_run_at', type: 'REAL', notnull: 0 },
  { name: 'last_run_at', type: 'REAL', notnull: 0 },
  { name: 'created_at', type: 'REAL', notnull: 1 },
  { name: 'created_by', type: 'TEXT', notnull: 0 },
  { name: 'origin_channel_type', type: 'TEXT', notnull: 0 },
  { name: 'origin_channel_id', type: 'TEXT', notnull: 0 },
  { name: 'origin_sender', type: 'TEXT', notnull: 0 },
  { name: 'origin_thread_id', type: 'TEXT', notnull: 0 },
  { name: 'provider_medium', type: 'TEXT', notnull: 0 },
  { name: 'provider_user_id', type: 'TEXT', notnull: 0 },
  { name: 'provider_workspace_id', type: 'TEXT', notnull: 0 },
  { name: 'provider_channel_id', type: 'TEXT', notnull: 0 },
  { name: 'provider_channel_type', type: 'TEXT', notnull: 0 },
  { name: 'provider_target_host_ref', type: 'TEXT', notnull: 0 },
  { name: 'provider_target_namespace', type: 'TEXT', notnull: 0 },
  { name: 'provider_target_name', type: 'TEXT', notnull: 0 },
  { name: 'provider_bot_id', type: 'TEXT', notnull: 0 },
  { name: 'provider_bot_username', type: 'TEXT', notnull: 0 },
]

function cronColumns(
  db: Database.Database
): Array<{ name: string; type: string; notnull: number }> {
  return (
    db.prepare('PRAGMA table_info(cron_jobs)').all() as Array<{
      name: string
      type: string
      notnull: number
    }>
  ).map(column => ({ name: column.name, type: column.type, notnull: column.notnull }))
}

function tableExists(db: Database.Database): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cron_jobs'`)
      .get() !== undefined
  )
}

describe('migration 020 — cron_jobs', () => {
  it('is named 020-cron-jobs and is the last migration', () => {
    expect(migration.name).toBe('020-cron-jobs')
    expect(migrations.at(-1)?.name).toBe(migration.name)
  })

  it('creates cron_jobs, accepts a second up, and drops the table', () => {
    const db = new Database(':memory:')
    try {
      expect(tableExists(db)).toBe(false)

      migration.up(db)
      expect(tableExists(db)).toBe(true)
      expect(cronColumns(db)).toEqual(COLUMNS)
      expect(cronColumns(db).map(column => column.name)).not.toContain('provider_event_id')

      db.prepare(
        `INSERT INTO cron_jobs (
           id, name, schedule, task, enabled, next_run_at, last_run_at, created_at, created_by,
           origin_channel_type, origin_channel_id, origin_sender, origin_thread_id,
           provider_medium, provider_user_id, provider_workspace_id, provider_channel_id,
           provider_channel_type, provider_target_host_ref, provider_target_namespace,
           provider_target_name, provider_bot_id, provider_bot_username
         ) VALUES (
           'job-1', 'daily', '0 8 * * *', 'say hello', 1, 1, NULL, 1, 'alice',
           'teams', 'conversation-1', 'U1', '1710000000.000100',
           'teams', 'U1', 'T1', 'stable-channel',
           NULL, 'host-1', 'channels',
           'general', NULL, NULL
         )`
      ).run()
      expect(
        db
          .prepare(
            `SELECT origin_channel_id, origin_thread_id, provider_medium, provider_channel_id
             FROM cron_jobs WHERE id = ?`
          )
          .get('job-1')
      ).toEqual({
        origin_channel_id: 'conversation-1',
        origin_thread_id: '1710000000.000100',
        provider_medium: 'teams',
        provider_channel_id: 'stable-channel',
      })
      expect(() =>
        db
          .prepare(
            `INSERT INTO cron_jobs (id, schedule, task, enabled, created_at)
             VALUES ('job-2', '0 8 * * *', 'x', 1, 1)`
          )
          .run()
      ).toThrow()

      migration.up(db)
      expect(cronColumns(db)).toEqual(COLUMNS)
      expect((db.prepare('SELECT COUNT(*) AS n FROM cron_jobs').get() as { n: number }).n).toBe(1)

      migration.down(db)
      expect(tableExists(db)).toBe(false)
      migration.down(db)
    } finally {
      db.close()
    }
  })
})
