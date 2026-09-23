import type { Database } from 'better-sqlite3'

export const name = '014-pending-approval-task-budget'
function hasColumn(db: Database): boolean {
  return (db.prepare('PRAGMA table_info(pending_approvals)').all() as Array<{ name: string }>).some(
    row => row.name === 'task_budget'
  )
}
export function up(db: Database): void {
  if (!hasColumn(db)) {
    // Only rows present at migration are eligible for explicit fresh-budget approval.
    db.exec(
      "ALTER TABLE pending_approvals ADD COLUMN task_budget TEXT; UPDATE pending_approvals SET task_budget = 'legacy';"
    )
  }
}
export function down(db: Database): void {
  if (hasColumn(db)) db.exec('ALTER TABLE pending_approvals DROP COLUMN task_budget;')
}
