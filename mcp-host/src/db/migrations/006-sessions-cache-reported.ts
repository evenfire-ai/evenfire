/**
 * Migration 006 — durable `cache_tokens_reported` flag on `sessions`.
 *
 * `cacheTokensReported` distinguishes "the model reports cache info" (Anthropic
 * sends cache_read/cache_write even on a miss → defined 0) from "the provider
 * doesn't expose cache" (OpenAI/zai/bailian → undefined). The desktop uses it to
 * decide whether to show the cache breakdown.
 *
 * Before this column it was a RAM-only flag derived on cold-load from
 * `cache_*_tokens > 0`, which was LOSSY: a session that reported cache but whose
 * lifetime cache totals stayed 0 (e.g. prompt-cache disabled, so Anthropic
 * returns 0/0) showed a 4-figure breakdown live but dropped to 2 figures after a
 * restart. Persisting the flag (sticky 1) removes that hot/cold divergence.
 *
 * 1-byte int (0/1), NOT NULL DEFAULT 0. Metadata-only ADD COLUMN.
 *
 * Backfill: ADD COLUMN sets every EXISTING row to the DEFAULT 0, which would
 * regress pre-existing sessions that already had cache traffic (they'd drop to a
 * 2-figure display until their next LLM call). So we seed the flag to 1 for any
 * session that provably saw cache (`cache_*_tokens > 0`) — the same signal the
 * old cold-load derive used. O(sessions), fast on SQLite. (Pre-existing Anthropic
 * sessions whose cache totals stayed exactly 0 can't be recovered — there's no
 * historical "reported" signal for them — but they were showing a 0/0 breakdown
 * anyway; new calls set the flag correctly via the sticky OR.)
 */
import type { Database } from 'better-sqlite3'

export const name = '006-sessions-cache-reported'

export function up(db: Database): void {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN cache_tokens_reported INTEGER NOT NULL DEFAULT 0;
    UPDATE sessions SET cache_tokens_reported = 1
      WHERE cache_read_tokens > 0 OR cache_write_tokens > 0;
  `)
}

export function down(db: Database): void {
  db.exec(`
    ALTER TABLE sessions DROP COLUMN cache_tokens_reported;
  `)
}
