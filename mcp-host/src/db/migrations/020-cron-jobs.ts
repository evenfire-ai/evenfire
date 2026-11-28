/**
 * Migration 020 — durable cron jobs (`cron_jobs`).
 *
 * The scheduler loads this table before it arms timers. Provider columns
 * rebuild a ProviderIdentity and do not include providerEventId. Origin and
 * provider invariants are checked on load, not by this table. No index: boot
 * reads the whole table.
 */
import type { Database } from 'better-sqlite3'

export const name = '020-cron-jobs'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      schedule              TEXT NOT NULL,
      task                  TEXT NOT NULL,
      enabled               INTEGER NOT NULL,
      next_run_at           REAL,
      last_run_at           REAL,
      created_at            REAL NOT NULL,
      created_by            TEXT,
      origin_channel_type   TEXT,
      origin_channel_id     TEXT,
      origin_sender         TEXT,
      origin_thread_id      TEXT,
      provider_medium       TEXT,
      provider_user_id      TEXT,
      provider_workspace_id TEXT,
      provider_channel_id   TEXT,
      provider_channel_type TEXT,
      provider_target_host_ref TEXT,
      provider_target_namespace TEXT,
      provider_target_name  TEXT,
      provider_bot_id       TEXT,
      provider_bot_username TEXT
    );
  `)
}

export function down(db: Database): void {
  db.exec('DROP TABLE IF EXISTS cron_jobs;')
}
