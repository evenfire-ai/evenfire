/**
 * Migration 007 — per-session model selection map (`model_selections`) on
 * `sessions` (R2).
 *
 * R2 lets a user pick the LLM model for their chat (within the Host's
 * provider). The selection is **session state**, persisted as a JSON map
 * `{ provider → model }` so it survives a pod restart and — with the map keyed
 * by provider — is forward-compatible with the fallback-model (R5.4) and the
 * future cross-provider selector (§8.1) without another migration.
 *
 * The pre-existing `model` column (migration 001, always NULL until now — the
 * INSERT plumbing existed but no caller passed a value, verified) starts
 * carrying the **effective model served** by the session's first task, so the
 * two columns split cleanly: `model` = telemetry (what was served),
 * `model_selections` = the user's saved choices (the source of truth on
 * resume). Nothing reads `model` today, so widening its write is non-breaking.
 *
 * TEXT holding JSON, nullable (NULL ⇔ no selection yet). Metadata-only ADD
 * COLUMN — no backfill needed: every existing row reads back NULL, which
 * `reconstruct.ts` maps to "no selection" → the resolver falls back to the
 * Host-configured model, i.e. today's behaviour.
 */
import type { Database } from 'better-sqlite3'

export const name = '007-sessions-model-selections'

export function up(db: Database): void {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN model_selections TEXT;
  `)
}

export function down(db: Database): void {
  // better-sqlite3 v11 ships SQLite 3.42+, where DROP COLUMN is supported.
  // No index or FTS trigger references model_selections, so the drop is safe.
  db.exec(`
    ALTER TABLE sessions DROP COLUMN model_selections;
  `)
}
