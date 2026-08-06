import { type DbClient, pool, withTransaction } from '../../db.js'
import { rootLogger } from '../../observability/logger.js'
import {
  type ControlApiPermissionChange,
  appendControlApiPermissionEventsInTransaction,
} from '../tracing/controlApiPermissionEvents.js'
import type { InvitationTeamAssignment } from './membership.js'
import { TeamNameConflictError, createTeamWithDb } from './teams.js'
import { type TeamRole, normalizeTeamRoleInput } from './types.js'

const logger = rootLogger.child({ module: 'admin-provisioning' })

/**
 * Ensure the user administers a team and that the default agent/context grants exist at
 * both team and user level. Idempotent: reuses an existing owned team and uses
 * ON CONFLICT DO NOTHING for grants. Runs inside the caller's transaction (`db`).
 * Returns the team id.
 */
export async function ensureDefaultTeamAndGrants(
  db: Pick<DbClient, 'query'>,
  userId: string,
  displayName: string,
  agentNames: string[],
  contextIds: string[]
): Promise<string> {
  const owned = await db.query(
    `SELECT t.id
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = $1
        AND tm.status = 'active'
        AND tm.role = 'admin'
      ORDER BY t.created_at ASC
      LIMIT 1`,
    [userId]
  )
  let teamId = (owned.rows[0] as { id: string } | undefined)?.id
  if (!teamId) {
    const preferredName = `${displayName} team`
    try {
      teamId = (await createTeamWithDb(db, preferredName)).id
    } catch (error) {
      if (!(error instanceof TeamNameConflictError)) throw error
      const fallbackName = `${preferredName} ${userId.slice(0, 8)}`
      try {
        teamId = (await createTeamWithDb(db, fallbackName)).id
      } catch (fallbackError) {
        if (!(fallbackError instanceof TeamNameConflictError)) throw fallbackError
        const existing = await db.query(
          `SELECT id FROM teams WHERE LOWER(BTRIM(name)) = LOWER(BTRIM($1)) LIMIT 1`,
          [fallbackName]
        )
        teamId = (existing.rows[0] as { id?: string } | undefined)?.id
        if (!teamId) throw fallbackError
      }
    }
    await db.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES($1, $2, 'admin', 'active')
       ON CONFLICT (team_id, user_id)
       DO UPDATE SET role = 'admin', status = 'active', updated_at = NOW()`,
      [teamId, userId]
    )
  }

  if (agentNames.length === 0 && contextIds.length === 0) {
    logger.warn(
      { userId, teamId },
      'no default agent/context grants configured; desktop workspace will have an empty catalog'
    )
  }

  for (const agentName of agentNames) {
    await db.query(
      `INSERT INTO team_agents(team_id, agent_name) VALUES($1, $2) ON CONFLICT DO NOTHING`,
      [teamId, agentName]
    )
    await db.query(
      `INSERT INTO user_agents(user_id, agent_name) VALUES($1, $2) ON CONFLICT DO NOTHING`,
      [userId, agentName]
    )
  }
  for (const contextId of contextIds) {
    await db.query(
      `INSERT INTO team_contexts(team_id, context_id) VALUES($1, $2) ON CONFLICT DO NOTHING`,
      [teamId, contextId]
    )
    await db.query(
      `INSERT INTO user_contexts(user_id, context_id) VALUES($1, $2) ON CONFLICT DO NOTHING`,
      [userId, contextId]
    )
  }

  return teamId
}

/**
 * Provision a desktop identity for an admin email, idempotently, in one
 * transaction: ensure the users row, optionally set its password to the
 * supplied bcrypt hash (`seedPassword`, default true — one credential across
 * Control UI + desktop), then ensure a default team and grants. Safe to re-run.
 */
export async function provisionAdminDesktopWorkspace(input: {
  email: string
  displayName: string
  passwordHash: string
  agentNames: string[]
  contextIds: string[]
  /** When false, skip writing users.password_hash — the desktop password then
   *  comes only from the invitation flow (managed installs). Defaults to
   *  true: the Control-UI human first-run keeps one credential for both apps. */
  seedPassword?: boolean
}): Promise<void> {
  const email = input.email.trim().toLowerCase()
  const name = input.displayName.trim() || null
  const teamLabel = input.displayName.trim() || email
  await withTransaction(async db => {
    const existing = await db.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [email])
    let userId = (existing.rows[0] as { id: string } | undefined)?.id
    if (!userId) {
      const inserted = await db.query(
        `INSERT INTO users(email, name) VALUES($1, $2) RETURNING id`,
        [email, name]
      )
      userId = (inserted.rows[0] as { id: string }).id
    }

    await db.query(
      `INSERT INTO profiles(user_id, display_name) VALUES($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, name]
    )

    if (input.seedPassword !== false) {
      await db.query(
        `UPDATE users SET password_hash = $2, password_set_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [userId, input.passwordHash]
      )
    }

    await ensureDefaultTeamAndGrants(db, userId, teamLabel, input.agentNames, input.contextIds)
  })
}

export async function findMemberByEmail(
  email: string
): Promise<{ id: string; email: string } | null> {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return null
  const result = await pool.query(
    `SELECT id, email FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [normalizedEmail]
  )
  return (result.rows[0] as { id: string; email: string } | undefined) || null
}

export async function provisionMemberFromAdmin(input: {
  adminId: string
  operatorSub: string
  teamAssignments: readonly InvitationTeamAssignment[]
  seedPassword: boolean
}): Promise<
  | {
      created: boolean
      user: { id: string; email: string; name: string | null }
    }
  | { error: 'admin_not_found' | 'admin_email_required' }
> {
  const assignments = new Map<string, TeamRole>()
  for (const assignment of input.teamAssignments || []) {
    const teamId = String(assignment.teamId || '').trim()
    const role = normalizeTeamRoleInput(assignment.role) || 'member'
    if (teamId) assignments.set(teamId, role)
  }

  return withTransaction(async db => {
    const adminResult = await db.query(
      `SELECT id, username, email, password_hash
         FROM control_admin_users
        WHERE id = $1
          AND status = 'active'
        LIMIT 1`,
      [input.adminId]
    )
    const admin = adminResult.rows[0] as
      | { id: string; username: string; email: string | null; password_hash: string }
      | undefined
    if (!admin) return { error: 'admin_not_found' as const }
    if (!admin.email) return { error: 'admin_email_required' as const }

    const existing = await db.query(
      `SELECT id, email, name
         FROM users
        WHERE lower(email) = lower($1)
        LIMIT 1`,
      [admin.email]
    )
    let created = false
    let user = existing.rows[0] as { id: string; email: string; name: string | null } | undefined
    if (!user) {
      const inserted = await db.query(
        `INSERT INTO users(email, name)
         VALUES($1, $2)
         RETURNING id, email, name`,
        [admin.email.trim().toLowerCase(), admin.username]
      )
      user = inserted.rows[0] as { id: string; email: string; name: string | null }
      created = true
    }

    const changes: ControlApiPermissionChange[] = created
      ? [
          {
            action: 'grant' as const,
            resourceClass: 'platform_user_access',
            resourceRef: `platform_user:${user.id}`,
            subject: { kind: 'user' as const, id: user.id },
            status: 'account_created',
          },
        ]
      : []

    await db.query(
      `INSERT INTO profiles(user_id, display_name)
       VALUES($1, $2)
       ON CONFLICT (user_id) DO UPDATE
          SET display_name = COALESCE(profiles.display_name, EXCLUDED.display_name),
              updated_at = NOW()`,
      [user.id, user.name || admin.username]
    )

    if (input.seedPassword) {
      await db.query(
        `UPDATE users
            SET password_hash = $2,
                password_set_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [user.id, admin.password_hash]
      )
    }

    if (assignments.size > 0) {
      const teamIds = Array.from(assignments.keys())
      const previousMemberships = await db.query(
        `SELECT team_id::text AS team_id, role, status
           FROM team_members
          WHERE user_id = $1
            AND team_id = ANY($2::uuid[])
          FOR UPDATE`,
        [user.id, teamIds]
      )
      const previousByTeamId = new Map(
        (
          previousMemberships.rows as Array<{
            team_id: string
            role: TeamRole
            status: string
          }>
        ).map(row => [row.team_id, row])
      )

      await db.query(
        `INSERT INTO team_members(team_id, user_id, role, status)
         SELECT item.team_id::uuid, $2::uuid, item.role, 'active'
           FROM jsonb_to_recordset($1::jsonb) AS item(team_id text, role text)
         ON CONFLICT (team_id, user_id)
         DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = NOW()`,
        [
          JSON.stringify(
            Array.from(assignments.entries()).map(([team_id, role]) => ({ team_id, role }))
          ),
          user.id,
        ]
      )

      for (const [teamId, role] of assignments) {
        const previous = previousByTeamId.get(teamId)
        if (previous?.status === 'active' && previous.role !== role) {
          changes.push({
            action: 'revoke',
            resourceClass: 'team_membership',
            resourceRef: `team_membership:${teamId}:role:${previous.role}`,
            subject: { kind: 'user', id: user.id },
            teamId,
            status: 'role_replaced',
          })
        }
        if (!previous || previous.status !== 'active' || previous.role !== role) {
          changes.push({
            action: 'grant',
            resourceClass: 'team_membership',
            resourceRef: `team_membership:${teamId}:role:${role}`,
            subject: { kind: 'user', id: user.id },
            teamId,
            status: previous?.status === 'active' ? 'role_assigned' : 'membership_activated',
          })
        }
      }
    }

    await appendControlApiPermissionEventsInTransaction(db, {
      operatorSub: input.operatorSub,
      operatorKind: 'control_admin',
      changes,
    })

    return { created, user }
  })
}
