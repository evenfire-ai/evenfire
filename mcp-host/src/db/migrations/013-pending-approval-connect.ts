/**
 * Migration 013 — durable `connect_required` suspension fields (spec §U5).
 *
 * A reactive OAuth-consent suspension (`reason='connect_required'`) must survive
 * a cold restart WITHOUT degrading into a generic approval. These nullable
 * columns carry the discriminator + the oauth server to connect so
 * `reconstructPendingApproval` rebuilds the right kind of suspension. NULL for
 * every existing/legacy row and for the default HITL gate (absent reason ⇒
 * 'approval_required').
 */
import type { Database } from 'better-sqlite3'

export const name = '013-pending-approval-connect'

function hasColumn(db: Database, column: string): boolean {
  const columns = db.prepare('PRAGMA table_info(pending_approvals)').all() as Array<{
    name: string
  }>
  return columns.some(entry => entry.name === column)
}

export function up(db: Database): void {
  if (!hasColumn(db, 'reason')) {
    db.exec('ALTER TABLE pending_approvals ADD COLUMN reason TEXT;')
  }
  if (!hasColumn(db, 'mcp_server_name')) {
    db.exec('ALTER TABLE pending_approvals ADD COLUMN mcp_server_name TEXT;')
  }
}

export function down(db: Database): void {
  if (hasColumn(db, 'mcp_server_name')) {
    db.exec('ALTER TABLE pending_approvals DROP COLUMN mcp_server_name;')
  }
  if (hasColumn(db, 'reason')) {
    db.exec('ALTER TABLE pending_approvals DROP COLUMN reason;')
  }
}
