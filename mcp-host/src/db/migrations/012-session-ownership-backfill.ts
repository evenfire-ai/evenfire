/**
 * Migration 012 — repair legacy session ownership when persisted structured
 * columns prove the exact serialized session-key suffix.
 *
 * The user portion may itself contain `:`, so ownership is derived by removing
 * the complete structured suffix from the end. Rows with a real non-null
 * mismatch, missing channel type, or a non-matching suffix remain unchanged and
 * therefore fail closed at runtime.
 */
import type { Database } from 'better-sqlite3'

export const name = '012-session-ownership-backfill'

const structuredSuffix = `
  ':' || channel_type ||
  ':' || COALESCE(NULLIF(channel_id, ''), 'default') ||
  ':' || COALESCE(NULLIF(thread_id, ''), 'default')
`

export function up(db: Database): void {
  db.exec(`
    UPDATE sessions
       SET user_id = substr(
         session_key,
         1,
         length(session_key) - length(${structuredSuffix})
       )
     WHERE (user_id IS NULL OR trim(user_id) = '' OR user_id = session_key)
       AND channel_type IS NOT NULL
       AND trim(channel_type) <> ''
       AND length(session_key) > length(${structuredSuffix})
       AND substr(session_key, -length(${structuredSuffix})) = (${structuredSuffix})
       AND trim(substr(
         session_key,
         1,
         length(session_key) - length(${structuredSuffix})
       )) <> '';
  `)
}

export function down(_db: Database): void {
  // Forward-only data repair: reverting cannot distinguish repaired legacy rows
  // from rows that already stored the correct owner without risking data loss.
}
