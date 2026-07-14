import { pool, withTransaction } from '../../db.js'
import type { AdminDeleteUserResult } from './types.js'
import { normalizeChannels } from './types.js'

type AdminUserRow = {
  id: string
  email: string
  name?: string | null
  picture?: string | null
  display_name?: string | null
  control_admin_id?: string | null
  active_team_count: string | number
  teams?: unknown
  password_pending_from_accepted_invitation?: unknown
}

function mapAdminUserRow(row: AdminUserRow) {
  return {
    id: String(row.id),
    email: String(row.email),
    name: (row.name ?? null) as string | null,
    picture: (row.picture ?? null) as string | null,
    displayName: (row.display_name ?? null) as string | null,
    controlAdminId: (row.control_admin_id ?? null) as string | null,
    activeTeamCount: Number(row.active_team_count || 0),
    teams: (Array.isArray(row.teams) ? row.teams : []).map(teamValue => {
      const team =
        teamValue && typeof teamValue === 'object' ? (teamValue as Record<string, unknown>) : {}
      return {
        id: String(team.id || ''),
        name: String(team.name || ''),
        role: String(team.role || 'member'),
      }
    }),
    passwordPendingFromAcceptedInvitation: Boolean(row.password_pending_from_accepted_invitation),
  }
}

const ADMIN_USER_SELECT = `SELECT u.id,
            u.email,
            u.name,
            u.picture,
            p.display_name,
            ca.id AS control_admin_id,
            COUNT(DISTINCT CASE WHEN tm.status = 'active' THEN tm.team_id END) AS active_team_count,
            COALESCE(
              jsonb_agg(
                DISTINCT jsonb_build_object('id', t.id, 'name', t.name, 'role', tm.role)
              ) FILTER (WHERE tm.status = 'active' AND t.id IS NOT NULL),
              '[]'::jsonb
            ) AS teams,
            EXISTS (
              SELECT 1
                FROM invitations i
               WHERE i.status = 'accepted'
                 AND (
                   i.accepted_user_id = u.id
                   OR LOWER(i.email) = LOWER(u.email)
                 )
                 AND u.password_hash IS NULL
            ) AS password_pending_from_accepted_invitation
       FROM users u
  LEFT JOIN profiles p ON p.user_id = u.id
  LEFT JOIN control_admin_users ca ON lower(ca.email) = lower(u.email)
  LEFT JOIN team_members tm ON tm.user_id = u.id
  LEFT JOIN teams t ON t.id = tm.team_id`

const ADMIN_USER_GROUP_ORDER = `GROUP BY u.id, u.email, u.name, u.picture, p.display_name, ca.id
  ORDER BY u.email ASC`

export async function createAdminUser(email: string, name: string) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) throw new Error('email is required')

  return withTransaction(async db => {
    const userResult = await db.query(
      `INSERT INTO users(email, name)
       VALUES ($1, $2)
       RETURNING id, email, name, picture`,
      [normalizedEmail, name.trim() || null]
    )
    const user = userResult.rows[0] as {
      id: string
      email: string
      name: string | null
      picture: string | null
    }

    await db.query(
      `INSERT INTO profiles(user_id, display_name)
       VALUES($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id, name.trim() || null]
    )

    return user
  })
}

export async function listUsers(searchQuery = '') {
  const query = searchQuery.trim()
  const result = await pool.query(
    `${ADMIN_USER_SELECT}
      WHERE (
        $1 = ''
        OR u.email ILIKE $2
        OR COALESCE(u.name, '') ILIKE $2
        OR COALESCE(p.display_name, '') ILIKE $2
        OR u.id::text = $1
      )
   ${ADMIN_USER_GROUP_ORDER}
      LIMIT 100`,
    [query, `%${query}%`]
  )
  return result.rows.map(row => mapAdminUserRow(row as AdminUserRow))
}

export async function getAdminUserContext(userId: string) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.picture, p.display_name, p.channels
       FROM users u
  LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id = $1
      LIMIT 1`,
    [userId]
  )

  const row = result.rows[0] as
    | {
        id: string
        email: string
        name: string | null
        picture: string | null
        display_name: string | null
        channels: unknown
      }
    | undefined

  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    displayName: row.display_name || null,
    channels: normalizeChannels(row.channels),
  }
}

export async function updateAdminUserContext(
  userId: string,
  email: string,
  name: string | undefined,
  channelsInput: unknown
) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) {
    throw new Error('email is required')
  }
  const channels = normalizeChannels(channelsInput)
  const hasName = typeof name === 'string'
  const normalizedName = hasName ? (name || '').trim() : null
  const nextName = hasName ? normalizedName || null : null

  return withTransaction(async db => {
    const userResult = await db.query(
      `UPDATE users
          SET email = $2,
              name = CASE WHEN $3 THEN $4 ELSE name END,
              updated_at = NOW()
        WHERE id = $1
    RETURNING id`,
      [userId, normalizedEmail, hasName, nextName]
    )
    if ((userResult.rowCount ?? 0) === 0) {
      return null
    }

    await db.query(
      `INSERT INTO profiles(user_id, display_name, channels)
       VALUES($1, CASE WHEN $3 THEN $4 ELSE NULL END, $2::jsonb)
       ON CONFLICT (user_id)
       DO UPDATE SET
         channels = EXCLUDED.channels,
         display_name = CASE WHEN $3 THEN EXCLUDED.display_name ELSE profiles.display_name END,
         updated_at = NOW()`,
      [userId, JSON.stringify(channels), hasName, nextName]
    )

    return getAdminUserContext(userId)
  })
}

/**
 * Hard-delete a user account. Teams are retained even when this delete leaves them with zero
 * active members. Memberships are removed via CASCADE when the user row is deleted.
 */
export async function adminDeleteUser(userId: string): Promise<AdminDeleteUserResult> {
  return withTransaction(async db => {
    const exists = await db.query(`SELECT 1 FROM users WHERE id = $1 LIMIT 1`, [userId])
    if ((exists.rowCount ?? 0) === 0) {
      return { error: 'not_found' }
    }

    await db.query(
      `UPDATE workflow_approval_medium_accounts
          SET disabled_at = COALESCE(disabled_at, NOW()),
              updated_at = NOW()
        WHERE user_id = $1
          AND disabled_at IS NULL`,
      [userId]
    )
    await db.query(
      `UPDATE workflow_approval_medium_challenges
          SET consumed_at = COALESCE(consumed_at, NOW()),
              expires_at = LEAST(expires_at, NOW())
        WHERE user_id = $1
          AND consumed_at IS NULL`,
      [userId]
    )

    const del = await db.query(`DELETE FROM users WHERE id = $1 RETURNING id`, [userId])
    if ((del.rowCount ?? 0) === 0) {
      return { error: 'not_found' }
    }
    return { ok: true, id: userId }
  })
}
