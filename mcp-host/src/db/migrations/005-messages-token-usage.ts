/**
 * Migration 005 — per-turn token usage columns on `messages`.
 *
 * The session-level token totals (`sessions.*_tokens`) capture the cumulative
 * usage; these columns let us attribute usage to a single turn by stamping the
 * turn's total onto its final assistant message row (see
 * `SqliteConversationStore.persistTurnComplete` / `persistTurnCancel`).
 * `reconstruct.ts` sums them per `turn_number` back onto the in-memory `Turn`.
 *
 * Nullable (NOT `DEFAULT 0`): a message that carries no usage stays NULL, which
 * lets the reconstruct distinguish "no usage recorded for this turn" from a
 * genuine zero. Intermediate messages (user / tool / mid-loop assistant) keep
 * NULL; only the final/cancel assistant message of a turn is stamped.
 *
 * FTS safety: `messages_fts` is an external-content FTS5 table whose sync
 * triggers reference only `new.id` / `new.content` (001-initial-schema), so
 * adding columns to `messages` does not affect the index or the triggers.
 */
import type { Database } from 'better-sqlite3'

export const name = '005-messages-token-usage'

export function up(db: Database): void {
  db.exec(`
    ALTER TABLE messages ADD COLUMN input_tokens INTEGER;
    ALTER TABLE messages ADD COLUMN output_tokens INTEGER;
    ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER;
    ALTER TABLE messages ADD COLUMN cache_write_tokens INTEGER;
  `)
}

export function down(db: Database): void {
  // DROP COLUMN requires SQLite >= 3.35 (bundled with modern better-sqlite3).
  db.exec(`
    ALTER TABLE messages DROP COLUMN input_tokens;
    ALTER TABLE messages DROP COLUMN output_tokens;
    ALTER TABLE messages DROP COLUMN cache_read_tokens;
    ALTER TABLE messages DROP COLUMN cache_write_tokens;
  `)
}
