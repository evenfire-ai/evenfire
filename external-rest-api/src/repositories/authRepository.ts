import { DbClient } from './dbClient.js'

type AuthUserRow = {
  id: string
  email: string
  name: string | null
  picture: string | null
}

type MembershipRow = {
  team_id: string
  role: string
  team_name: string
}

type TeamRow = {
  id: string
  name: string
}

export async function findUserByEmail(db: DbClient, email: string): Promise<AuthUserRow | null> {
  const result = await db.query(
    `SELECT id, email, name, picture
       FROM users
      WHERE email = $1`,
    [email]
  )
  return (result.rows[0] as AuthUserRow | undefined) || null
}

export async function createUser(
  db: DbClient,
  email: string,
  name?: string,
  picture?: string
): Promise<AuthUserRow> {
  const result = await db.query(
    `INSERT INTO users(email, name, picture)
     VALUES ($1, $2, $3)
     RETURNING id, email, name, picture`,
    [email, name || null, picture || null]
  )
  return result.rows[0] as AuthUserRow
}

export async function updateUser(
  db: DbClient,
  email: string,
  name?: string,
  picture?: string
): Promise<AuthUserRow> {
  const result = await db.query(
    `UPDATE users
        SET name = COALESCE($2, name),
            picture = COALESCE($3, picture),
            updated_at = NOW()
      WHERE email = $1
    RETURNING id, email, name, picture`,
    [email, name || null, picture || null]
  )
  return result.rows[0] as AuthUserRow
}

export async function upsertDevUser(
  db: DbClient,
  email: string,
  name: string
): Promise<AuthUserRow> {
  const result = await db.query(
    `INSERT INTO users(email, name)
     VALUES ($1, $2)
     ON CONFLICT(email) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
     RETURNING id, email, name, picture`,
    [email, name]
  )
  return result.rows[0] as AuthUserRow
}

export async function ensureProfile(
  db: DbClient,
  userId: string,
  displayName?: string
): Promise<void> {
  await db.query(
    `INSERT INTO profiles(user_id, display_name)
     VALUES($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, displayName || null]
  )
}

export async function activatePendingInvitationsForEmail(
  db: DbClient,
  userId: string,
  email: string
): Promise<void> {
  await db.query(
    `INSERT INTO team_members(team_id, user_id, role, status)
     SELECT i.team_id, $1, i.role, 'active'
       FROM invitations i
      WHERE i.email = $2
        AND i.status = 'pending'
     ON CONFLICT (team_id, user_id) DO UPDATE SET
       role = EXCLUDED.role,
       status = 'active',
       updated_at = NOW()`,
    [userId, email]
  )
}

export async function markPendingInvitationsAcceptedByEmail(
  db: DbClient,
  email: string
): Promise<void> {
  await db.query(
    `UPDATE invitations
        SET status = 'accepted',
            accepted_at = NOW()
      WHERE email = $1
        AND status = 'pending'`,
    [email]
  )
}

export async function findFirstActiveMembership(
  db: DbClient,
  userId: string
): Promise<MembershipRow | null> {
  const result = await db.query(
    `SELECT tm.team_id, tm.role, t.name AS team_name
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = $1
        AND tm.status = 'active'
   ORDER BY tm.created_at ASC
      LIMIT 1`,
    [userId]
  )
  return (result.rows[0] as MembershipRow | undefined) || null
}

export async function createTeam(db: DbClient, name: string): Promise<TeamRow> {
  const result = await db.query(`INSERT INTO teams(name) VALUES($1) RETURNING id, name`, [name])
  return result.rows[0] as TeamRow
}

export async function addAdminMembership(
  db: DbClient,
  teamId: string,
  userId: string
): Promise<void> {
  await db.query(
    `INSERT INTO team_members(team_id, user_id, role, status)
     VALUES($1, $2, 'admin', 'active')`,
    [teamId, userId]
  )
}

export async function findMembershipByTeam(
  db: DbClient,
  userId: string,
  teamId: string
): Promise<MembershipRow | null> {
  const result = await db.query(
    `SELECT tm.team_id, tm.role, t.name AS team_name
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = $1
        AND tm.team_id = $2
        AND tm.status = 'active'
      LIMIT 1`,
    [userId, teamId]
  )
  return (result.rows[0] as MembershipRow | undefined) || null
}
