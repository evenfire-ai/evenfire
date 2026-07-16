/**
 * gfs subject resolution (spec community.md §Subjects).
 *
 * gfs separates PRINCIPALS — identities that authenticate and carry a token
 * `sub` (`user`, `host`) — from GROUPS & ROLES — grant targets only that never
 * authenticate (`operator`, `team`, `context`) and resolve to principals at
 * check time. This module owns both directions:
 *
 *  - resolvePrincipalSubjects: principal → the canonical subject-keys it
 *    satisfies (itself + its groups). A grant whose subject key is in this set
 *    authorizes the principal. This is the load-bearing authorization path.
 *  - resolveSubjectMembers: a grant/share target subject → the identities it
 *    reaches (operator → admins, team → members, user → itself).
 *
 * `operator`/`team` are group subjects and can never be a Principal here — the
 * Principal type admits only `user`/`host`, so they can never appear as a token
 * `sub`.
 */

/** Minimal query surface — a pg client/pool satisfies this; tests inject a fake. */
export interface SubjectsDb {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

export type GfsSubjectType = 'operator' | 'user' | 'team' | 'host' | 'context'
export interface GfsSubject {
  type: GfsSubjectType
  id?: string
}

/** Canonical `type:id` key (group/operator subjects carry no own id → `operator:`). */
export function subjectKey(subject: GfsSubject): string {
  return `${subject.type}:${subject.id ?? ''}`
}

/** The only identities that authenticate and carry a token `sub`. */
export type Principal = { type: 'user' | 'host'; id: string }

/**
 * Check-time resolution: every canonical subject-key a principal satisfies —
 * itself plus each group it belongs to. A user belongs to every team it is an
 * ACTIVE member of (soft-deleted memberships are excluded — deny-by-default).
 * A host's context bindings are resolved in P3 once `context` is a first-class
 * grantee. A user principal (a `users.id`) is never a cluster operator (that is
 * a separate `control_admin_users` pool, authenticated as an operator directly),
 * so `operator:` is never added here.
 */
export async function resolvePrincipalSubjects(
  db: SubjectsDb,
  principal: Principal
): Promise<Set<string>> {
  const keys = new Set<string>([subjectKey(principal)])
  if (principal.type === 'user') {
    const res = await db.query(
      `SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'active'`,
      [principal.id]
    )
    for (const row of res.rows as { team_id: unknown }[]) {
      keys.add(`team:${String(row.team_id)}`)
    }
  }
  return keys
}

/** True iff `adminId` is an active cluster operator (`control_admin_users`). */
export async function isOperatorId(db: SubjectsDb, adminId: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM control_admin_users WHERE id = $1 AND status = 'active' LIMIT 1`,
    [adminId]
  )
  return res.rows.length > 0
}

/**
 * Grant-target resolution: the identities a grant/share subject reaches (spec
 * §Subjects "Resolves to"). `operator` → all active admins (control_admin_users
 * ids); `team` → its active members (users ids); `user` → itself; `host`/
 * `context` are not user-valued in v1. Note the operator branch returns ids from
 * the control-admin pool, not the users pool.
 */
export async function resolveSubjectMembers(
  db: SubjectsDb,
  subject: GfsSubject
): Promise<string[]> {
  switch (subject.type) {
    case 'operator': {
      const res = await db.query(`SELECT id FROM control_admin_users WHERE status = 'active'`)
      return (res.rows as { id: unknown }[]).map(r => String(r.id))
    }
    case 'team': {
      if (!subject.id) return []
      const res = await db.query(
        `SELECT user_id FROM team_members WHERE team_id = $1 AND status = 'active'`,
        [subject.id]
      )
      return (res.rows as { user_id: unknown }[]).map(r => String(r.user_id))
    }
    case 'user':
      return subject.id ? [subject.id] : []
    default:
      return []
  }
}
