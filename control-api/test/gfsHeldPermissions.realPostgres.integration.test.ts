import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

vi.mock('../src/services/tracing/controlApiPermissionEvents.js', () => ({
  appendControlApiPermissionEventsInTransaction: vi.fn(async () => null),
}))

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
describe.skipIf(!adminUrl)('R1-M1 isolated user-session membership authority', () => {
  const userId = '11111111-1111-4111-8111-111111111111'
  const primaryTeamId = '22222222-2222-4222-8222-222222222222'
  const secondaryTeamId = '33333333-3333-4333-8333-333333333333'
  const rootId = '00000000-0000-4000-8000-000000000001'
  const folderId = '00000000-0000-4000-8000-000000000002'
  const resourceId = '00000000-0000-4000-8000-000000000003'
  const database = `r1m1_r6m_${randomUUID().replaceAll('-', '')}`
  let adminPool: Pool
  let setup: Pool
  let db: typeof import('../src/db.js')
  let membership: typeof import('../src/services/directory/membership.js')
  let resolvePrincipalSubjects: (typeof import('../src/gfs/subjects.js'))['resolvePrincipalSubjects']
  let resolveCaller: (typeof import('../src/routes/gfs/grants.js'))['resolveCaller']
  let heldPermissions: (typeof import('../src/routes/gfs/grants.js'))['heldPermissions']
  let writeGrant: (typeof import('../src/routes/gfs/grants.js'))['writeGfsGrantBatchInTransaction']
  let writeShare: (typeof import('../src/routes/gfs/shares.js'))['writeGfsShareBatchInTransaction']

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl! })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    process.env.CONTROL_API_PG_CONNECTION_STRING = url.toString()
    setup = new Pool({ connectionString: url.toString() })
    await setup.query(`CREATE TABLE users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL)`)
    await setup.query(`CREATE TABLE teams (id uuid PRIMARY KEY, name text NOT NULL)`)
    await setup.query(`CREATE TABLE team_members (
      team_id uuid NOT NULL REFERENCES teams(id), user_id uuid NOT NULL REFERENCES users(id),
      role text NOT NULL, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (team_id, user_id))`)
    await setup.query(`CREATE TABLE gfs_resources (
      resource_id uuid PRIMARY KEY, drive text NOT NULL, parent_resource_id uuid,
      name text NOT NULL, kind text NOT NULL, path_cache text, version int NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz)`)
    await setup.query(`CREATE TABLE gfs_grants (
      drive text NOT NULL, resource_id uuid NOT NULL, subject_type text NOT NULL,
      subject_id text NOT NULL, permissions text[] NOT NULL, inherit boolean NOT NULL,
      granted_by text, updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (drive, resource_id, subject_type, subject_id))`)
    await setup.query(`CREATE TABLE gfs_shares (
      drive text NOT NULL, resource_id uuid NOT NULL, subject_type text NOT NULL,
      subject_id text NOT NULL, permissions text[] NOT NULL, include_descendants boolean NOT NULL,
      created_by text, UNIQUE (drive, resource_id, subject_type, subject_id))`)
    await setup.query(`CREATE TABLE gfs_audit (
      sequence_no bigserial PRIMARY KEY, subject text NOT NULL, actor_on_behalf_of text,
      op text NOT NULL, gfs_uri text NOT NULL, outcome text NOT NULL, source_ip text,
      request_id text, row_hash text NOT NULL, desktop_user_id uuid, authority_source text)`)
    await setup.query(`INSERT INTO users(id, email) VALUES ($1, 'r6@example.test')`, [userId])
    await setup.query(`INSERT INTO teams(id, name) VALUES ($1, 'primary'), ($2, 'secondary')`, [
      primaryTeamId,
      secondaryTeamId,
    ])
    await setup.query(
      `INSERT INTO team_members(team_id, user_id, role, status) VALUES
      ($1, $3, 'member', 'active'), ($2, $3, 'member', 'active')`,
      [primaryTeamId, secondaryTeamId, userId]
    )
    await setup.query(
      `INSERT INTO gfs_resources(resource_id, drive, parent_resource_id, name, kind)
      VALUES ($1, 'main', NULL, '/', 'directory'), ($2, 'main', $1, 'T-only', 'directory'),
      ($3, 'main', $2, 'secret.txt', 'file')`,
      [rootId, folderId, resourceId]
    )
    db = await import('../src/db.js')
    membership = await import('../src/services/directory/membership.js')
    resolvePrincipalSubjects = (await import('../src/gfs/subjects.js')).resolvePrincipalSubjects
    const grants = await import('../src/routes/gfs/grants.js')
    resolveCaller = grants.resolveCaller
    heldPermissions = grants.heldPermissions
    writeGrant = grants.writeGfsGrantBatchInTransaction
    writeShare = (await import('../src/routes/gfs/shares.js')).writeGfsShareBatchInTransaction
  }, 60_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(db?.pool)
      await endPoolAndWaitForClients(setup)
      if (!adminPool) return
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await adminPool?.end()
    }
  }, 60_000)

  async function resetAcl() {
    await setup.query('TRUNCATE gfs_audit, gfs_shares, gfs_grants')
  }

  async function userSessionCaller() {
    const groups = await resolvePrincipalSubjects(db.pool, { type: 'user', id: userId })
    const req = {
      externalAuth: { userId, teamId: primaryTeamId },
      gfsSubjectKeys: [...groups, `team:${primaryTeamId}`],
    }
    return resolveCaller(req as never)
  }

  async function grant(subjectId: string, inherit: boolean, resource = folderId) {
    const client = await db.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await writeGrant(client as never, {
        req: { adminAuth: { sub: 'operator-test' }, ip: '127.0.0.1' } as never,
        caller: { isOperator: true, subjects: new Set(['operator:']), actorKey: 'operator:' },
        drive: 'main',
        resourceId: resource,
        subjects: [{ type: 'team', id: subjectId }],
        permissions: ['read'],
        inherit,
      })
      expect(result.error).toBeNull()
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async function share(subjectId: string) {
    const client = await db.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await writeShare(client as never, {
        req: { adminAuth: { sub: 'operator-test' }, ip: '127.0.0.1' } as never,
        caller: { isOperator: true, subjects: new Set(['operator:']), actorKey: 'operator:' },
        drive: 'main',
        resourceId: folderId,
        subjects: [{ type: 'team', id: subjectId }],
        permissions: ['read'],
        includeDescendants: true,
      })
      expect(result.error).toBeNull()
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  it('uses the real resolver and caller for active, removed, and added secondary membership', async () => {
    await resetAcl()
    await grant(secondaryTeamId, true)
    const capturedActive = await userSessionCaller()
    expect(capturedActive).toMatchObject({ desktopUserId: userId, authoritySource: 'user-session' })
    expect(capturedActive.subjects.has(`team:${secondaryTeamId}`)).toBe(true)
    expect(await heldPermissions(db.pool, capturedActive, 'main', resourceId)).toContain('read')

    await membership.softDeleteMember(secondaryTeamId, userId, 'operator:test')
    const staleHeld = await heldPermissions(db.pool, capturedActive, 'main', resourceId)
    const refreshed = await userSessionCaller()
    expect(refreshed.subjects.has(`team:${secondaryTeamId}`)).toBe(false)
    const refreshedHeld = await heldPermissions(db.pool, refreshed, 'main', resourceId)
    expect(staleHeld).not.toContain('read')
    expect(refreshedHeld).not.toContain('read')

    const capturedWithoutMembership = refreshed
    await membership.addMemberToTeam(secondaryTeamId, userId, 'operator:test')
    expect(await heldPermissions(db.pool, capturedWithoutMembership, 'main', resourceId)).toContain(
      'read'
    )
    const newlyActive = await userSessionCaller()
    expect(newlyActive.subjects.has(`team:${secondaryTeamId}`)).toBe(true)
    expect(await heldPermissions(db.pool, newlyActive, 'main', resourceId)).toContain('read')
  }, 30_000)

  it('isolates primary, user, secondary direct, inherited, and share authority sources', async () => {
    await resetAcl()
    await setup.query('UPDATE team_members SET status=$3 WHERE team_id=$1 AND user_id=$2', [
      secondaryTeamId,
      userId,
      'deleted',
    ])
    await grant(primaryTeamId, true)
    const primaryOnly = await userSessionCaller()
    expect(primaryOnly.subjects.has(`team:${primaryTeamId}`)).toBe(true)
    expect(primaryOnly.subjects.has(`team:${secondaryTeamId}`)).toBe(false)
    expect(await heldPermissions(db.pool, primaryOnly, 'main', resourceId)).toContain('read')

    await resetAcl()
    await setup.query('DELETE FROM team_members WHERE user_id=$1', [userId])
    const userSubjects = await resolvePrincipalSubjects(db.pool, { type: 'user', id: userId })
    const userCaller = resolveCaller({
      externalAuth: { userId, teamId: null },
      gfsSubjectKeys: [...userSubjects],
    } as never)
    await setup.query(
      `INSERT INTO gfs_grants
      (drive, resource_id, subject_type, subject_id, permissions, inherit)
      VALUES ('main', $1, 'user', $2, ARRAY['read'], false)`,
      [resourceId, userId]
    )
    expect(await heldPermissions(db.pool, userCaller, 'main', resourceId)).toContain('read')

    await setup.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
      VALUES ($1, $2, 'member', 'active')`,
      [secondaryTeamId, userId]
    )
    await resetAcl()
    await grant(secondaryTeamId, false, resourceId)
    const secondaryDirect = await userSessionCaller()
    expect(secondaryDirect.subjects.has(`team:${secondaryTeamId}`)).toBe(true)
    expect(await heldPermissions(db.pool, secondaryDirect, 'main', resourceId)).toContain('read')

    await resetAcl()
    await grant(secondaryTeamId, true)
    const secondaryInherited = await userSessionCaller()
    expect(await heldPermissions(db.pool, secondaryInherited, 'main', resourceId)).toContain('read')

    await resetAcl()
    await share(secondaryTeamId)
    const secondaryShare = await userSessionCaller()
    expect(await heldPermissions(db.pool, secondaryShare, 'main', resourceId)).toContain('read')

    await resetAcl()
    await grant(secondaryTeamId, false, resourceId)
    await membership.softDeleteMember(secondaryTeamId, userId, 'operator:test')
    const staticCaller = {
      isOperator: false,
      subjects: new Set([`team:${secondaryTeamId}`]),
      actorKey: 'service:static-fixture',
    }
    expect(staticCaller).not.toHaveProperty('desktopUserId')
    expect(staticCaller).not.toHaveProperty('authoritySource')
    expect(await heldPermissions(db.pool, staticCaller, 'main', resourceId)).toContain('read')
  }, 30_000)

  it('D0 denies a captured user-session caller after live membership removal', async () => {
    await resetAcl()
    await setup.query('UPDATE team_members SET status=$3 WHERE team_id=$1 AND user_id=$2', [
      secondaryTeamId,
      userId,
      'active',
    ])
    await grant(secondaryTeamId, true)
    const caller = await userSessionCaller()
    expect(caller.authoritySource).toBe('user-session')
    await membership.softDeleteMember(secondaryTeamId, userId, 'operator:test')

    // The user-session permission statement must derive secondary membership from this snapshot.
    expect(await heldPermissions(db.pool, caller, 'main', resourceId)).not.toContain('read')
  }, 30_000)

  it('generates user-session membership and evaluation/publication schedules against real producers', async () => {
    const observed = new Set<string>()
    const expectedRed: string[] = []
    const publicationOrders = new Set<string>()

    class AddSecondary {
      check(model: { active: boolean }) {
        return !model.active
      }
      async run(model: { active: boolean }, real: { trace: string[] }) {
        await membership.addMemberToTeam(secondaryTeamId, userId, userId)
        model.active = true
        real.trace.push('membership-add')
      }
      toString() {
        return 'add-secondary-membership'
      }
    }
    class RemoveSecondary {
      check(model: { active: boolean }) {
        return model.active
      }
      async run(model: { active: boolean }, real: { trace: string[] }) {
        await membership.softDeleteMember(secondaryTeamId, userId, userId)
        model.active = false
        real.trace.push('membership-remove')
      }
      toString() {
        return 'remove-secondary-membership'
      }
    }
    class CaptureCaller {
      check() {
        return true
      }
      async run(
        model: { active: boolean; captured: boolean },
        real: {
          caller: Awaited<ReturnType<typeof userSessionCaller>> | null
          trace: string[]
        }
      ) {
        real.caller = await userSessionCaller()
        model.captured = true
        expect(real.caller.authoritySource).toBe('user-session')
        real.trace.push(`caller-capture-${model.active ? 'member' : 'nonmember'}`)
      }
      toString() {
        return 'capture-user-session-caller'
      }
    }
    class Evaluate {
      check(model: { captured: boolean }) {
        return model.captured
      }
      async run(
        model: { active: boolean },
        real: {
          caller: Awaited<ReturnType<typeof userSessionCaller>> | null
          scheduler: { schedule<T>(promise: Promise<T>, label: string): Promise<T> }
          pending: Array<{ published: Promise<boolean>; expected: boolean; trace: string }>
          resolutionOrder: string[]
          trace: string[]
        }
      ) {
        const expectedAtEvaluation = model.active
        const trace = `evaluation-${real.pending.length + 1}-${expectedAtEvaluation ? 'allow' : 'deny'}`
        let evaluated!: () => void
        const completed = new Promise<void>(resolve => {
          evaluated = resolve
        })
        const raw = heldPermissions(db.pool, real.caller!, 'main', resourceId).then(bits => {
          evaluated()
          return bits.includes('read')
        })
        const published = real.scheduler.schedule(raw, trace).then(result => {
          // Publication is observable only after the scheduler releases this Promise.
          real.resolutionOrder.push(trace)
          return result
        })
        // The production heldPermissions Promise has completed; the scheduler still owns
        // publication so a later membership commit may occur before the result is observed.
        await completed
        real.pending.push({ published, expected: expectedAtEvaluation, trace })
        real.trace.push('permission-evaluation-complete')
      }
      toString() {
        return 'evaluate-permission'
      }
    }

    const commandsArbitrary = fc.commands(
      [
        fc.constant(new AddSecondary()),
        fc.constant(new RemoveSecondary()),
        fc.constant(new CaptureCaller()),
        fc.constant(new Evaluate()),
      ],
      { minCommands: 4, maxCommands: 10 }
    )

    await fc.assert(
      fc.asyncProperty(fc.scheduler(), commandsArbitrary, async (scheduler, commands) => {
        await resetAcl()
        await setup.query('UPDATE team_members SET status=$3 WHERE team_id=$1 AND user_id=$2', [
          secondaryTeamId,
          userId,
          'deleted',
        ])
        await grant(secondaryTeamId, true)
        const model = { active: false, captured: false }
        const real = {
          scheduler,
          caller: null as Awaited<ReturnType<typeof userSessionCaller>> | null,
          pending: [] as Array<{ published: Promise<boolean>; expected: boolean; trace: string }>,
          resolutionOrder: [] as string[],
          trace: [] as string[],
        }
        await fc.asyncModelRun(() => ({ model, real }), commands)
        await scheduler.waitAll()
        for (const item of real.pending) {
          const actual = await item.published
          if (actual !== item.expected)
            expectedRed.push(`${item.trace}:expected=${item.expected}:actual=${actual}`)
          else observed.add(`evaluation-match-${actual ? 'allow' : 'deny'}`)
        }
        publicationOrders.add(real.resolutionOrder.join(' > ') || 'no-evaluation')
        real.trace.push(...real.resolutionOrder.map(() => 'response-published'))
        real.trace.forEach(event => observed.add(event))
        const activeRow = await setup.query(
          'SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2',
          [secondaryTeamId, userId]
        )
        expect(activeRow.rows[0]?.status === 'active').toBe(model.active)
        for (const item of real.pending) expect(item.published).toBeInstanceOf(Promise)
      }),
      { seed: 12931121, numRuns: 32, endOnFailure: true }
    )

    expect([...observed].some(value => value.startsWith('membership-add'))).toBe(true)
    expect([...observed].some(value => value.startsWith('membership-remove'))).toBe(true)
    expect([...observed].some(value => value.startsWith('caller-capture'))).toBe(true)
    expect([...observed].some(value => value === 'permission-evaluation-complete')).toBe(true)
    expect(expectedRed).toHaveLength(0)
    process.stdout.write(
      JSON.stringify({
        generator: 'fc.commands + fc.scheduler',
        seed: 12931121,
        runs: 32,
        distinctEventSequences: publicationOrders.size,
        eventClasses: [...observed],
        mismatches: expectedRed,
        replay: 'seed=12931121; fast-check failure replay path is emitted on assertion failure',
        adapters: [
          'addMemberToTeam',
          'softDeleteMember',
          'resolvePrincipalSubjects',
          'resolveCaller',
          'heldPermissions',
        ],
        authority:
          'corrected single-statement reader; all generated outcomes match evaluation-time membership',
      }) + '\n'
    )
  }, 90_000)
})
