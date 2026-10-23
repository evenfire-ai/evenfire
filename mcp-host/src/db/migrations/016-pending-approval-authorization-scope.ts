import type { Database } from 'better-sqlite3'

export const name = '016-pending-approval-authorization-scope'

function hasColumn(db: Database): boolean {
  return (db.prepare('PRAGMA table_info(pending_approvals)').all() as Array<{ name: string }>).some(
    row => row.name === 'authorization_scope'
  )
}

export function up(db: Database): void {
  if (!hasColumn(db)) {
    // Existing NULL rows intentionally remain exact-scope: their original
    // turn-wide expansion cannot be proven after the fact.
    db.exec('ALTER TABLE pending_approvals ADD COLUMN authorization_scope TEXT;')
  }
}

export function down(db: Database): void {
  if (hasColumn(db)) db.exec('ALTER TABLE pending_approvals DROP COLUMN authorization_scope;')
}
