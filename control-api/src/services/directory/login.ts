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

async function findPendingInvitationMembership(
  db: {
    query: (
      text: string,
      values?: unknown[]
    ) => Promise<{ rows: unknown[]; rowCount: number | null }>
  },
  email: string
) {
  return db.query(
    `SELECT COALESCE(it.team_id, i.team_id) AS team_id,
            COALESCE(it.role, i.role) AS role,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN invitation_teams it ON it.invitation_id = i.id
       JOIN teams t ON t.id = COALESCE(it.team_id, i.team_id)
      WHERE LOWER(i.email) = LOWER($1)
        AND COALESCE(it.team_id, i.team_id) IS NOT NULL
        AND i.status = 'pending'
        AND i.expires_at > NOW()
      ORDER BY i.created_at DESC
      LIMIT 1`,
    [email]
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

    let membership = await findFirstActiveMembership(db, user.id)

    if ((membership.rowCount ?? 0) === 0) {
      membership = await findPendingInvitationMembership(db, input.email)
    }

    return {
      isNewUser,
      user,
      membership: ((membership.rows[0] as MembershipRow | undefined) ||
        teamlessMemberMembership()) as MembershipRow,
    }
  })
}

export async function identityProviderLoginData(input: {
  provider: 'microsoft'
  connectionId: string
  externalSubject: string
  email: string
  userPrincipalName: string
  displayName: string
  invitationId?: string | null
}) {
  return withTransaction(async db => {
    const connection = await db.query(
      `SELECT 1
         FROM identity_provider_connections
        WHERE id = $1
          AND provider = $2
          AND status = 'connected'
          AND allow_member_login = TRUE
          AND (client_secret_expires_at IS NULL OR client_secret_expires_at > NOW())
        LIMIT 1`,
      [input.connectionId, input.provider]
    )
    if ((connection.rowCount ?? 0) === 0) return null

    const existingIdentity = await db.query(
      `SELECT ipi.user_id, u.email, u.name, u.picture
         FROM identity_provider_identities ipi
         JOIN users u ON u.id = ipi.user_id
        WHERE ipi.connection_id = $1
          AND ipi.external_subject = $2
        LIMIT 1`,
      [input.connectionId, input.externalSubject]
    )

    let user = existingIdentity.rows[0] as
      | { user_id: string; email: string; name: string | null; picture: string | null }
      | undefined

    if (!user) {
      const invitationId = String(input.invitationId || '').trim()
      if (!invitationId) return null
      const invitation = await db.query(
        `SELECT i.accepted_user_id, i.email, i.identity_provider_upn
           FROM invitations i
          WHERE i.id = $1
            AND i.status = 'accepted'
            AND i.identity_provider = $2
            AND i.identity_provider_connection_id = $3
            AND (i.identity_provider_subject IS NULL OR i.identity_provider_subject = $4)
          LIMIT 1
          FOR UPDATE`,
        [invitationId, input.provider, input.connectionId, input.externalSubject]
      )
      const invitationRow = invitation.rows[0] as
        | { accepted_user_id: string | null; email: string; identity_provider_upn: string | null }
        | undefined
      if (!invitationRow?.accepted_user_id) return null
      const expectedNames = new Set(
        [invitationRow.email, invitationRow.identity_provider_upn]
          .map(value =>
            String(value || '')
              .trim()
              .toLowerCase()
          )
          .filter(Boolean)
      )
      const actualNames = [input.email, input.userPrincipalName]
        .map(value => value.trim().toLowerCase())
        .filter(Boolean)
      if (!actualNames.some(value => expectedNames.has(value))) return null
      if (
        invitationRow.identity_provider_upn &&
        !actualNames.includes(invitationRow.identity_provider_upn.trim().toLowerCase())
      ) {
        return null
      }

      const userResult = await db.query(
        `UPDATE users
            SET name = COALESCE(NULLIF($2, ''), name),
                updated_at = NOW()
          WHERE id = $1
        RETURNING id AS user_id, email, name, picture`,
        [invitationRow.accepted_user_id, input.displayName]
      )
      user = userResult.rows[0] as {
        user_id: string
        email: string
        name: string | null
        picture: string | null
      }
      const identityLink = await db.query(
        `INSERT INTO identity_provider_identities(
           provider, connection_id, user_id, external_subject, email,
           user_principal_name, display_name, last_login_at
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (connection_id, external_subject)
         DO UPDATE SET email = EXCLUDED.email,
                       user_principal_name = EXCLUDED.user_principal_name,
                       display_name = EXCLUDED.display_name,
                       last_login_at = NOW()
         WHERE identity_provider_identities.user_id = EXCLUDED.user_id
         RETURNING user_id`,
        [
          input.provider,
          input.connectionId,
          user.user_id,
          input.externalSubject,
          input.email.trim().toLowerCase(),
          input.userPrincipalName.trim().toLowerCase(),
          input.displayName,
        ]
      )
      if ((identityLink.rowCount ?? 0) !== 1) {
        throw Object.assign(new Error('Microsoft identity is already linked to another member'), {
          status: 409,
        })
      }
      await db.query(
        `UPDATE invitations
            SET identity_provider_linked_at = NOW()
          WHERE id = $1`,
        [invitationId]
      )
    } else {
      await db.query(
        `UPDATE identity_provider_identities
            SET email = $3,
                user_principal_name = $4,
                display_name = $5,
                last_login_at = NOW()
          WHERE connection_id = $1
            AND external_subject = $2`,
        [
          input.connectionId,
          input.externalSubject,
          input.email.trim().toLowerCase(),
          input.userPrincipalName.trim().toLowerCase(),
          input.displayName,
        ]
      )
    }

    const membership = await findFirstActiveMembership(db, user.user_id)
    return {
      user: {
        id: user.user_id,
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
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
