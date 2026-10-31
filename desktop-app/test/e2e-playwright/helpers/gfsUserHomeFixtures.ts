/**
 * Named PRECONDITIONS and business-signal READS for the per-user home journeys
 * (#1168). Nothing here performs a behaviour under test: homes and owner grants
 * are never seeded (the journeys consume automatic provisioning), and every
 * grant/share under test is created or removed through the Desktop UI.
 *
 * Credentials: each test user gets a password generated at runtime and kept
 * only in memory for the test that created it. It is never written to a file,
 * log, trace, screenshot or report; only its bcrypt hash reaches the database,
 * through the same bcrypt path the operator-parity fixtures use.
 */
import { expect } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import {
  GFS_E2E_DRIVE,
  UUID_RE,
  firstDataLine,
  runControlPostgresSql,
  splitSqlRow,
  sqlLiteral,
} from '../../../../tests/e2e/gfsFixtureCore'
import type { ManagedGfsAgent } from './gfsAgentDiscovery'
import { bcryptHash } from './gfsDesktopOperatorParityFixtures'

export interface HomeTestUser {
  id: string
  email: string
  /** Visible name; chosen so the home naming policy maps it to itself. */
  name: string
  /** Runtime-generated, in-memory only. Never log or persist. */
  readonly password: string
}

export interface HomeRow {
  state: 'pending' | 'ready' | 'conflict' | 'retired'
  drive: string | null
  storageUsername: string | null
  resourceId: string | null
  conflictCode: string | null
}

export interface AccessRow {
  id: string
  relation: 'grant' | 'share'
  subjectType: string
  subjectId: string
  permissions: string[]
  inherit: boolean
}

const HOME_READY_TIMEOUT_MS = 150_000

function parsePermissions(raw: string): string[] {
  return raw
    .replace(/^\{|\}$/g, '')
    .split(',')
    .filter(Boolean)
    .sort()
}

export class UserHomeFixtures {
  private readonly users: HomeTestUser[] = []
  private readonly teams: string[] = []
  private readonly agentLinks: Array<{ userId: string; agentName: string }> = []

  constructor(readonly runTag: string) {
    if (!/^[a-z0-9]{6,16}$/.test(runTag)) throw new Error(`invalid run tag ${runTag}`)
  }

  /**
   * Creates an active user. The enrollment trigger creates its pending home;
   * the reconciler provisions it. `label` must be lowercase [a-z0-9-] so the
   * naming policy (NFC, lowercase, [a-z0-9._-]) leaves `name` unchanged and the
   * expected path is `/Users/<name>` without importing the policy.
   */
  createUser(label: string): HomeTestUser {
    if (!/^[a-z0-9-]{1,20}$/.test(label)) throw new Error(`invalid user label ${label}`)
    const name = `e2e-home-${label}-${this.runTag}`
    const email = `${name}@example.invalid`
    const password = `Gfs!${randomBytes(24).toString('base64url')}`
    const hash = bcryptHash(password)
    const row = firstDataLine(
      runControlPostgresSql(`
        WITH created AS (
          INSERT INTO users(email, name, password_hash, password_set_at)
          VALUES(${sqlLiteral(email)}, ${sqlLiteral(name)}, ${sqlLiteral(hash)}, now())
          RETURNING id
        ), profile AS (
          INSERT INTO profiles(user_id, display_name)
          SELECT id, ${sqlLiteral(name)} FROM created
          RETURNING user_id
        )
        SELECT profile.user_id::text FROM profile;
      `)
    )
    if (!UUID_RE.test(row)) throw new Error(`[USER-HOME-E2E] user ${name} could not be created`)
    const user: HomeTestUser = { id: row, email, name, password }
    this.users.push(user)
    return user
  }

  /** One team with every given user as an active member (first one admin). */
  createTeam(label: string, members: HomeTestUser[]): string {
    const teamName = `e2e-home-team-${label}-${this.runTag}`
    const teamId = firstDataLine(
      runControlPostgresSql(
        `INSERT INTO teams(name) VALUES(${sqlLiteral(teamName)}) RETURNING id::text;`
      )
    )
    if (!UUID_RE.test(teamId)) throw new Error(`[USER-HOME-E2E] team ${teamName} not created`)
    this.teams.push(teamId)
    for (const [index, member] of members.entries()) {
      runControlPostgresSql(`
        INSERT INTO team_members(team_id, user_id, role, status)
        VALUES(${sqlLiteral(teamId)}::uuid, ${sqlLiteral(member.id)}::uuid,
               ${sqlLiteral(index === 0 ? 'admin' : 'member')}, 'active');
      `)
    }
    return teamId
  }

  /**
   * Adds `member` to the one team `owner` already belongs to, without creating
   * a team. Removing `member` in cleanup removes the membership (FK cascade).
   */
  joinOnlyTeamOf(owner: HomeTestUser, member: HomeTestUser): string {
    const teamIds = runControlPostgresSql(`
      SELECT team_id::text FROM team_members
       WHERE user_id = ${sqlLiteral(owner.id)}::uuid AND status = 'active';
    `)
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
    if (teamIds.length !== 1 || !UUID_RE.test(teamIds[0])) {
      throw new Error(
        `[USER-HOME-E2E] ${owner.name} must belong to exactly one team, found ${teamIds.length}`
      )
    }
    runControlPostgresSql(`
      INSERT INTO team_members(team_id, user_id, role, status)
      VALUES(${sqlLiteral(teamIds[0])}::uuid, ${sqlLiteral(member.id)}::uuid, 'member', 'active');
    `)
    return teamIds[0]
  }

  /**
   * Named precondition: a direct share row `sharer` made to `recipient`. No UI
   * creates share rows (Desktop and Control UI write grants; shares arrive
   * through the share APIs), so a journey that acts on an existing share seeds
   * one. Removing `recipient` in cleanup removes it with the user's shares.
   */
  seedShare(
    drive: string,
    resourceId: string,
    sharer: HomeTestUser,
    recipient: HomeTestUser,
    permissions: string[]
  ): string {
    if (!permissions.every(bit => /^[a-z_]+$/.test(bit))) throw new Error('invalid share bits')
    const id = firstDataLine(
      runControlPostgresSql(`
        INSERT INTO gfs_shares(drive, resource_id, subject_type, subject_id, permissions,
                               include_descendants, created_by)
        VALUES(${sqlLiteral(drive)}, ${sqlLiteral(resourceId)}::uuid, 'user',
               ${sqlLiteral(recipient.id)}, ARRAY[${permissions.map(sqlLiteral).join(', ')}]::text[],
               true, ${sqlLiteral(`user:${sharer.id}`)})
        RETURNING id::text;
      `)
    )
    if (!UUID_RE.test(id)) throw new Error('[USER-HOME-E2E] seeded share was not created')
    return id
  }

  /** Makes `agent` one of `user`'s own agents (direct user_agents association). */
  associateAgent(user: HomeTestUser, agent: ManagedGfsAgent): void {
    runControlPostgresSql(`
      INSERT INTO user_agents(user_id, agent_name)
      VALUES(${sqlLiteral(user.id)}::uuid, ${sqlLiteral(agent.name)})
      ON CONFLICT DO NOTHING;
    `)
    this.agentLinks.push({ userId: user.id, agentName: agent.name })
  }

  readHome(userId: string): HomeRow | null {
    const out = runControlPostgresSql(`
      SELECT state, coalesce(drive, ''), coalesce(storage_username, ''),
             coalesce(resource_id::text, ''), coalesce(conflict_code, '')
        FROM gfs_user_homes WHERE user_id = ${sqlLiteral(userId)}::uuid;
    `)
    const line = out.split('\n').find(value => value.trim())
    if (!line) return null
    const [state, drive, storageUsername, resourceId, conflictCode] = splitSqlRow(line)
    return {
      state: state as HomeRow['state'],
      drive: drive || null,
      storageUsername: storageUsername || null,
      resourceId: resourceId || null,
      conflictCode: conflictCode || null,
    }
  }

  async waitForHomeState(userId: string, state: HomeRow['state']): Promise<HomeRow> {
    await expect
      .poll(() => this.readHome(userId)?.state ?? 'absent', { timeout: HOME_READY_TIMEOUT_MS })
      .toBe(state)
    const home = this.readHome(userId)
    if (!home) throw new Error(`[USER-HOME-E2E] home row for ${userId} disappeared`)
    return home
  }

  /** Grants and shares on one resource, for business-signal assertions. */
  accessRows(resourceId: string): AccessRow[] {
    const out = runControlPostgresSql(`
      SELECT id::text, 'grant', subject_type, subject_id, permissions::text, inherit::text
        FROM gfs_grants WHERE resource_id = ${sqlLiteral(resourceId)}::uuid
      UNION ALL
      SELECT id::text, 'share', subject_type, subject_id, permissions::text, include_descendants::text
        FROM gfs_shares WHERE resource_id = ${sqlLiteral(resourceId)}::uuid
      ORDER BY 1;
    `)
    return out
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [id, relation, subjectType, subjectId, permissions, inherit] = splitSqlRow(line)
        return {
          id,
          relation: relation as AccessRow['relation'],
          subjectType,
          subjectId,
          permissions: parsePermissions(permissions),
          inherit: inherit === 't' || inherit === 'true',
        }
      })
  }

  /**
   * The user's recorded file activity, in the list's own order
   * (`last_activity_at DESC, resource_id DESC`). Read-only business signal.
   */
  recentActivity(userId: string): Array<{ resourceId: string; lastActivityAt: string }> {
    const out = runControlPostgresSql(`
      SELECT resource_id::text, to_char(last_activity_at AT TIME ZONE 'UTC',
                                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        FROM gfs_user_file_activity
       WHERE user_id = ${sqlLiteral(userId)}::uuid
       ORDER BY last_activity_at DESC, resource_id DESC;
    `)
    return out
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [resourceId, lastActivityAt] = splitSqlRow(line)
        return { resourceId: resourceId!, lastActivityAt: lastActivityAt! }
      })
  }

  /**
   * The direct-chat run bindings of one user for one Host, grouped by the
   * namespace control-api verified (D14). Exactly one group is expected: a run
   * bound twice in different namespaces would mean two Control APIs.
   */
  directRunBinding(userId: string, hostRef: string): { hostNamespace: string; count: number }[] {
    const out = runControlPostgresSql(`
      SELECT coalesce(host_namespace, '<null>'), count(*)::text
        FROM governed_run_attribution_bindings
       WHERE user_id = ${sqlLiteral(userId)}::uuid
         AND host_ref = ${sqlLiteral(hostRef)}
         AND origin = 'direct_chat'
       GROUP BY 1 ORDER BY 1;
    `)
    return out
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [hostNamespace, count] = splitSqlRow(line)
        return { hostNamespace: hostNamespace!, count: Number(count) }
      })
  }

  accessFor(resourceId: string, subjectType: string, subjectId: string): AccessRow | null {
    return (
      this.accessRows(resourceId).find(
        row => row.subjectType === subjectType && row.subjectId === subjectId
      ) ?? null
    )
  }

  /** Child resource id by name under a parent (live rows only). */
  childId(parentResourceId: string, name: string): string {
    const id = firstDataLine(
      runControlPostgresSql(`
        SELECT resource_id::text FROM gfs_resources
         WHERE parent_resource_id = ${sqlLiteral(parentResourceId)}::uuid
           AND name = ${sqlLiteral(name)} AND deleted_at IS NULL;
      `)
    )
    if (!UUID_RE.test(id)) throw new Error(`[USER-HOME-E2E] ${name} not found under parent`)
    return id
  }

  /**
   * Precondition for the conflict journey: a directory nobody owns at
   * `/Users/<name>` on the E2E drive, created BEFORE the user exists.
   */
  createForeignDirectoryAtHomePath(name: string): string {
    const row = firstDataLine(
      runControlPostgresSql(`
        WITH root_row AS (
          SELECT resource_id FROM gfs_resources
           WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)} AND parent_resource_id IS NULL
             AND deleted_at IS NULL
           LIMIT 1
        ), users_dir AS (
          INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
          SELECT ${sqlLiteral(GFS_E2E_DRIVE)}, resource_id, 'Users', 'directory', '/Users' FROM root_row
          ON CONFLICT (drive, parent_resource_id, name) WHERE deleted_at IS NULL
          DO UPDATE SET updated_at = now()
          RETURNING resource_id
        ), foreign_dir AS (
          INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
          SELECT ${sqlLiteral(GFS_E2E_DRIVE)}, resource_id, ${sqlLiteral(name)}, 'directory',
                 ${sqlLiteral(`/Users/${name}`)}
            FROM users_dir
          RETURNING resource_id
        )
        SELECT resource_id::text FROM foreign_dir;
      `)
    )
    if (!UUID_RE.test(row)) {
      throw new Error(`[USER-HOME-E2E] foreign directory /Users/${name} could not be created`)
    }
    return row
  }

  /**
   * Removes what this run created: agent associations, team memberships and
   * the users themselves, plus any grant/share whose subject is one of them.
   * Bound home directories cannot be removed (the governed-root guard rejects
   * it by design) and stay as retired homes after their users are gone.
   */
  cleanup(): void {
    const errors: unknown[] = []
    const attempt = (sql: string) => {
      try {
        runControlPostgresSql(sql)
      } catch (error) {
        errors.push(error)
      }
    }
    for (const link of this.agentLinks) {
      attempt(
        `DELETE FROM user_agents WHERE user_id = ${sqlLiteral(link.userId)}::uuid AND agent_name = ${sqlLiteral(link.agentName)};`
      )
    }
    for (const user of this.users) {
      attempt(
        `DELETE FROM gfs_grants WHERE subject_type = 'user' AND subject_id = ${sqlLiteral(user.id)};`
      )
      attempt(
        `DELETE FROM gfs_shares WHERE subject_type = 'user' AND subject_id = ${sqlLiteral(user.id)};`
      )
    }
    for (const teamId of this.teams) {
      attempt(`DELETE FROM teams WHERE id = ${sqlLiteral(teamId)}::uuid;`)
    }
    for (const user of this.users) {
      attempt(`DELETE FROM users WHERE id = ${sqlLiteral(user.id)}::uuid;`)
    }
    if (errors.length) {
      throw new Error(`[USER-HOME-E2E] cleanup failed: ${errors.map(String).join('; ')}`)
    }
  }
}
