/**
 * Migration 013 — per-turn guardrail-input-transparency column on `messages`.
 *
 * Mirrors 005 (per-turn token usage): a turn-level fact is attributed to a turn
 * by stamping it onto the turn's final/cancel assistant message row (see
 * `SqliteConversationStore.persistTurnComplete` / `persistTurnCancel`).
 * `reconstruct.ts` parses it back onto the in-memory `Turn.guardrailActivity`.
 *
 * The value is a JSON blob of `TurnGuardrailActivity` (counts + admin-authored
 * source ids only — never message content, spec §8). Nullable rather than
 * defaulted so "no guardrails ran" (NULL) and "no record" stay distinguishable;
 * quiet turns and unguarded hosts stamp NULL. Intermediate messages keep NULL.
 *
 * FTS safety: `messages_fts` sync triggers reference only `new.id` / `new.content`
 * (001-initial-schema), so adding a column to `messages` does not affect the index.
 */
import type { Database } from 'better-sqlite3'

export const name = '013-messages-guardrail-activity'

export function up(db: Database): void {
  db.exec(`ALTER TABLE messages ADD COLUMN guardrail_activity TEXT;`)
}

export function down(db: Database): void {
  // DROP COLUMN requires SQLite >= 3.35 (bundled with modern better-sqlite3).
  db.exec(`ALTER TABLE messages DROP COLUMN guardrail_activity;`)
}
