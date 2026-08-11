import bcrypt from 'bcryptjs'
import { withTransaction } from '../../db.js'
import type { TeamRole } from './types.js'

type MembershipRow = {
  team_id: string | null
  role: TeamRole
  team_name: string | null
}

async function findFirstActiveMembership(
  db: {
    query: (
      text: string,
      values?: unknown[]
    ) => Promise<{ rows: unknown[]; rowCount: number | null }>
  },
  userId: string
) {
  return db.query(
    `SELECT tm.team_id, tm.role, t.name AS team_name
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
  LEFT JOIN LATERAL (
         SELECT MAX(i.accepted_at) AS accepted_at
           FROM invitations i
      LEFT JOIN invitation_teams it ON it.invitation_id = i.id
           JOIN users u ON u.id = tm.user_id
          WHERE (i.team_id = tm.team_id OR it.team_id = tm.team_id)
            AND i.status = 'accepted'
            AND (i.accepted_user_id = tm.user_id OR LOWER(i.email) = LOWER(u.email))
       ) accepted_invitation ON TRUE
      WHERE tm.user_id = $1
        AND tm.status = 'active'
   ORDER BY
         CASE WHEN accepted_invitation.accepted_at IS NULL THEN 1 ELSE 0 END,
         accepted_invitation.accepted_at DESC NULLS LAST,
         tm.created_at ASC
      LIMIT 1`,
    [userId]
  )
}

async function healAcceptedInvitationMemberships(
  db: {
    query: (
      text: string,
      values?: unknown[]
    ) => Promise<{ rows: unknown[]; rowCount: number | null }>
  },
  userId: string,
  email: string
) {
  await db.query(
    `INSERT INTO team_members(team_id, user_id, role, status)
       SELECT assignment.team_id, $1, assignment.role, 'active'
         FROM (
          SELECT DISTINCT ON (COALESCE(it.team_id, i.team_id))
                 COALESCE(it.team_id, i.team_id) AS team_id,
                 COALESCE(it.role, i.role) AS role,
                 i.accepted_at,
                 i.created_at
            FROM invitations i
       LEFT JOIN invitation_teams it ON it.invitation_id = i.id
        WHERE LOWER(i.email) = LOWER($2)
          AND COALESCE(it.team_id, i.team_id) IS NOT NULL
          AND i.status = 'accepted'
        ORDER BY COALESCE(it.team_id, i.team_id), i.accepted_at DESC NULLS LAST, i.created_at DESC
         ) assignment
       ON CONFLICT (team_id, user_id) DO UPDATE SET
         role = EXCLUDED.role,
         status = 'active',
         updated_at = NOW()
       WHERE team_members.status <> 'deleted'`,
    [userId, email]
  )
}

async function linkAcceptedInvitationsToUser(
  db: {
    query: (
      text: string,
      values?: unknown[]
    ) => Promise<{ rows: unknown[]; rowCount: number | null }>
  },
  userId: string,
  email: string
) {
  await db.query(
    `UPDATE invitations
        SET accepted_user_id = COALESCE(accepted_user_id, $2)
      WHERE LOWER(email) = LOWER($1)
        AND status = 'accepted'`,
    [email, userId]
  )
}

function teamlessMemberMembership(): MembershipRow {
  return {
    team_id: null,
    role: 'member',
    team_name: null,
  }
}

export async function googleLoginData(input: { email: string; name?: string; picture?: string }) {
  return withTransaction(async db => {
    const existing = await db.query(
      `SELECT id, email, name, picture
         FROM users
        WHERE email = $1`,
      [input.email]
    )

    const isNewUser = (existing.rowCount ?? 0) === 0
    const userResult = isNewUser
      ? await db.query(
          `INSERT INTO users(email, name, picture)
           VALUES($1, $2, $3)
           RETURNING id, email, name, picture`,
          [input.email, input.name || null, input.picture || null]
        )
      : await db.query(
          `UPDATE users
              SET name = COALESCE($2, name),
                  picture = COALESCE($3, picture),
                  updated_at = NOW()
            WHERE email = $1
          RETURNING id, email, name, picture`,
          [input.email, input.name || null, input.picture || null]
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
      [user.id, input.name || null]
    )

    await healAcceptedInvitationMemberships(db, user.id, input.email)
    await linkAcceptedInvitationsToUser(db, user.id, input.email)

    const membership = await findFirstActiveMembership(db, user.id)

    return {
      isNewUser,
      user,
      membership: ((membership.rows[0] as MembershipRow | undefined) ||
        teamlessMemberMembership()) as MembershipRow,
    }
  })
}

export async function passwordLoginData(input: { email: string; password: string }) {
  return withTransaction(async db => {
    const result = await db.query(
      `SELECT id, email, name, picture, password_hash
         FROM users
        WHERE email = $1
        LIMIT 1`,
      [input.email.trim().toLowerCase()]
    )
    if ((result.rowCount ?? 0) === 0) {
      return null
    }

    const user = result.rows[0] as {
      id: string
      email: string
      name: string | null
      picture: string | null
      password_hash: string | null
    }
    if (!user.password_hash) {
      return { error: 'password_not_set' as const }
    }

    const matches = await bcrypt.compare(input.password, user.password_hash)
    if (!matches) {
      return null
    }

    let membership = await findFirstActiveMembership(db, user.id)
    if ((membership.rowCount ?? 0) === 0) {
      await healAcceptedInvitationMemberships(db, user.id, user.email)
      await linkAcceptedInvitationsToUser(db, user.id, user.email)
      membership = await findFirstActiveMembership(db, user.id)
    }

    if ((membership.rowCount ?? 0) === 0) {
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          picture: user.picture,
        },
        membership: teamlessMemberMembership(),
        credentialHash: user.password_hash,
      }
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
      membership: membership.rows[0] as MembershipRow,
      credentialHash: user.password_hash,
    }
  })
}

export async function verifyUserPassword(input: {
  userId: string
  email: string
  password: string
}): Promise<boolean> {
  const result = await withTransaction(async db =>
    db.query(
      `SELECT password_hash
         FROM users
        WHERE id = $1
          AND email = $2
        LIMIT 1`,
      [input.userId.trim(), input.email.trim().toLowerCase()]
    )
  )

  const row = result.rows[0] as { password_hash: string | null } | undefined
  if (!row?.password_hash) {
    return false
  }
  return bcrypt.compare(input.password, row.password_hash)
}
