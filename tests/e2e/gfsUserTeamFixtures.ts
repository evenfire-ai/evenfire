import {
  type E2EDelegateVisibility,
  UUID_RE,
  firstDataLine,
  runControlPostgresSql,
  splitSqlRow,
  sqlLiteral,
} from './gfsFixtureCore'
import { E2E_TEST_EMAIL } from './testUser'

export function getE2EUserId(email = E2E_TEST_EMAIL): string {
  const id = firstDataLine(
    runControlPostgresSql(
      `SELECT id::text FROM users WHERE lower(email) = lower(${sqlLiteral(email)}) LIMIT 1;`
    )
  )
  if (!UUID_RE.test(id)) {
    throw new Error(`seeded E2E user not found for ${email}`)
  }
  return id
}

export function getE2EUserTeamId(email = E2E_TEST_EMAIL): string {
  const id = firstDataLine(
    runControlPostgresSql(`
      SELECT tm.team_id::text
        FROM team_members tm
        JOIN users u ON u.id = tm.user_id
       WHERE lower(u.email) = lower(${sqlLiteral(email)})
         AND tm.status = 'active'
       ORDER BY tm.created_at ASC
       LIMIT 1;
    `)
  )
  if (!UUID_RE.test(id)) {
    throw new Error(`seeded E2E user team not found for ${email}`)
  }
  return id
}

export function seedE2EUserTeam(email: string, name: string): { id: string; name: string } {
  if (!/^e2e-gfs-[a-z0-9-]+$/.test(name)) {
    throw new Error(`refusing to create non-E2E team "${name}"`)
  }
  const row = firstDataLine(
    runControlPostgresSql(`
      WITH target_user AS (
        SELECT id
          FROM users
         WHERE lower(email) = lower(${sqlLiteral(email)})
         LIMIT 1
      ),
      created_team AS (
        INSERT INTO teams (name)
        SELECT ${sqlLiteral(name)}
          FROM target_user
        RETURNING id, name
      ),
      membership AS (
        INSERT INTO team_members (team_id, user_id, role, status)
        SELECT created_team.id, target_user.id, 'member', 'active'
          FROM created_team, target_user
        ON CONFLICT (team_id, user_id)
        DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = now()
        RETURNING team_id
      )
      SELECT created_team.id::text || '|' || created_team.name
        FROM created_team
        JOIN membership ON membership.team_id = created_team.id;
    `)
  )
  const [id, ...nameParts] = splitSqlRow(row)
  const persistedName = nameParts.join('|')
  if (!UUID_RE.test(id) || persistedName !== name) {
    throw new Error(`failed to seed unique E2E team ${name} for ${email}`)
  }
  return { id, name: persistedName }
}

export function cleanupE2EUserTeam(teamId: string): void {
  if (!UUID_RE.test(teamId)) return
  runControlPostgresSql(`
    DELETE FROM teams
     WHERE id = ${sqlLiteral(teamId)}::uuid
       AND name LIKE 'e2e-gfs-%';
  `)
}

export function addE2EUserToTeam(email: string, teamId: string): void {
  if (!UUID_RE.test(teamId)) {
    throw new Error(`invalid E2E team id: ${teamId}`)
  }
  const row = firstDataLine(
    runControlPostgresSql(`
      WITH target_team AS (
        SELECT id
          FROM teams
         WHERE id = ${sqlLiteral(teamId)}::uuid
           AND name LIKE 'e2e-gfs-%'
         LIMIT 1
      ),
      target_user AS (
        SELECT id
          FROM users
         WHERE lower(email) = lower(${sqlLiteral(email)})
         LIMIT 1
      ),
      membership AS (
        INSERT INTO team_members (team_id, user_id, role, status)
        SELECT target_team.id, target_user.id, 'member', 'active'
          FROM target_team, target_user
        ON CONFLICT (team_id, user_id)
        DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = now()
        RETURNING team_id
      )
      SELECT team_id::text FROM membership;
    `)
  )
  if (row !== teamId) {
    throw new Error(`failed to add ${email} to E2E team ${teamId}`)
  }
}

export function ensureE2EDelegateVisibleToOwner(input: {
  ownerEmail: string
  delegateEmail: string
}): E2EDelegateVisibility {
  const row = firstDataLine(
    runControlPostgresSql(`
      WITH owner_team AS (
        SELECT tm.team_id
          FROM team_members tm
          JOIN users u ON u.id = tm.user_id
         WHERE lower(u.email) = lower(${sqlLiteral(input.ownerEmail)})
           AND tm.status = 'active'
         ORDER BY tm.created_at ASC, tm.team_id ASC
         LIMIT 1
      ),
      delegate_user AS (
        SELECT id AS user_id
          FROM users
         WHERE lower(email) = lower(${sqlLiteral(input.delegateEmail)})
         LIMIT 1
      ),
      previous AS (
        SELECT tm.status
          FROM team_members tm
          JOIN owner_team ot ON ot.team_id = tm.team_id
          JOIN delegate_user du ON du.user_id = tm.user_id
      ),
      upsert AS (
        INSERT INTO team_members(team_id, user_id, role, status)
        SELECT ot.team_id, du.user_id, 'member', 'active'
          FROM owner_team ot CROSS JOIN delegate_user du
        ON CONFLICT (team_id, user_id)
        DO UPDATE SET status = 'active', updated_at = now()
        RETURNING team_id, user_id
      )
      SELECT upsert.team_id::text,
             upsert.user_id::text,
             coalesce((SELECT status FROM previous LIMIT 1), '')
        FROM upsert;
    `)
  )
  const [ownerTeamId, delegateUserId, previousStatusRaw] = splitSqlRow(row)
  if (!UUID_RE.test(ownerTeamId) || !UUID_RE.test(delegateUserId)) {
    throw new Error(`failed to make ${input.delegateEmail} visible to ${input.ownerEmail}: ${row}`)
  }
  return {
    ownerTeamId,
    delegateUserId,
    previousStatus: previousStatusRaw || null,
  }
}

export function cleanupE2EDelegateVisibility(visibility: E2EDelegateVisibility | null): void {
  if (!visibility) return
  if (!UUID_RE.test(visibility.ownerTeamId) || !UUID_RE.test(visibility.delegateUserId)) {
    throw new Error('refusing to clean unsafe E2E delegate visibility row')
  }
  if (visibility.previousStatus === null) {
    runControlPostgresSql(`
      DELETE FROM team_members
       WHERE team_id = ${sqlLiteral(visibility.ownerTeamId)}
         AND user_id = ${sqlLiteral(visibility.delegateUserId)};
    `)
    return
  }
  runControlPostgresSql(`
    UPDATE team_members
       SET status = ${sqlLiteral(visibility.previousStatus)}, updated_at = now()
     WHERE team_id = ${sqlLiteral(visibility.ownerTeamId)}
       AND user_id = ${sqlLiteral(visibility.delegateUserId)};
  `)
}
