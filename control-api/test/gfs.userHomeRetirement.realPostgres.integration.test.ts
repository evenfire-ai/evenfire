import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import pino from 'pino'
import request from 'supertest'
import { config } from '../src/config.js'
import { withTransaction } from '../src/db.js'
import { provisionUserHome } from '../src/gfs/userHomeProvisioner.js'
import { asyncHandler } from '../src/http/asyncHandler.js'
import type { K8sGateway } from '../src/k8s.js'
import { rootLogger } from '../src/observability/logger.js'
import { createAdminUsersRouter } from '../src/routes/admin/users.js'
import { checkAccess, handleGrantWrite } from '../src/routes/gfs/grants.js'
import {
  completeControlAdminInvitation,
  createControlAdminInvitation,
} from '../src/services/adminAuthService.js'
import { deleteManagedUserForUser } from '../src/services/directory/membership.js'
import { adminDeleteUser, retireDesktopUser } from '../src/services/directory/users.js'
import { GfsUserHomeReconciler } from '../src/services/gfsUserHomeReconciler.js'
import {
  createDrive,
  createUser,
  createUserHomeDatabase,
  homeState,
} from './helpers/userHomeRealPostgres.js'

const holder = vi.hoisted(() => ({ pool: undefined as Pool | undefined }))
vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  return {
    ...actual,
    pool: { query: (...args: Parameters<Pool['query']>) => holder.pool!.query(...args) },
    withTransaction: ((work, txPool, options) =>
      actual.withTransaction(
        work,
        txPool ?? holder.pool,
        options
      )) as typeof actual.withTransaction,
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('user-home retirement on PostgreSQL', () => {
  let adminPool: Pool
  let database: Awaited<ReturnType<typeof createUserHomeDatabase>>
  let admin: string
  let app: express.Express
  const actor = () => ({ kind: 'control_admin' as const, controlAdminId: admin })

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl! })
    database = await createUserHomeDatabase(adminUrl!, adminPool)
    holder.pool = database.pool
    admin = randomUUID()
    await database.pool.query(
      `INSERT INTO control_admin_users (id, username, email, password_hash, role, status)
       VALUES ($1, $2, $3, 'test-hash', 'admin', 'active')`,
      [admin, `retirement-${admin}`, `${admin}@example.test`]
    )
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      if (req.header('x-user'))
        Object.assign(req, { externalAuth: { userId: req.header('x-user') } })
      else Object.assign(req, { adminAuth: { sub: admin } })
      next()
    })
    app.put('/gfs/grants', asyncHandler(handleGrantWrite))
    app.use(createAdminUsersRouter({} as K8sGateway))
  }, 60_000)
  afterAll(async () => {
    try {
      holder.pool = undefined
      if (database) {
        await database.closeConnections()
        await adminPool.query(`DROP DATABASE "${database.database}"`)
      }
    } finally {
      await adminPool?.end()
    }
  }, 60_000)

  async function fixture() {
    const drive = `retire-${randomUUID()}`
    const root = await createDrive(database.pool, drive)
    const owner = await createUser(database.pool, 'Owner')
    const other = await createUser(database.pool, 'Other')
    expect(await provisionUserHome(owner, { drive, dbPool: database.pool })).toBe('ready')
    const home = (await homeState(database.pool, owner))!.resource_id!
    const file = (
      await database.pool.query<{ resource_id: string }>(
        `INSERT INTO gfs_resources (drive,parent_resource_id,name,kind,path_cache,bytes)
       VALUES ($1,$2,'file','file','/file',7) RETURNING resource_id::text`,
        [drive, home]
      )
    ).rows[0]!.resource_id
    const deletedFile = (
      await database.pool.query<{ resource_id: string }>(
        `INSERT INTO gfs_resources (drive,parent_resource_id,name,kind,path_cache,deleted_at)
       VALUES ($1,$2,'deleted-file','file','/deleted-file',now()) RETURNING resource_id::text`,
        [drive, home]
      )
    ).rows[0]!.resource_id
    const outside = (
      await database.pool.query<{ resource_id: string }>(
        `INSERT INTO gfs_resources (drive,parent_resource_id,name,kind,path_cache)
       VALUES ($1,$2,'outside','file','/outside') RETURNING resource_id::text`,
        [drive, root]
      )
    ).rows[0]!.resource_id
    const team = randomUUID()
    await database.pool.query('INSERT INTO teams(id,name) VALUES ($1,$2)', [team, 'Team'])
    const agent = `agent-${randomUUID().slice(0, 8)}`
    const sharedAgent = `agent-${randomUUID().slice(0, 8)}`
    const teamAgent = `agent-${randomUUID().slice(0, 8)}`
    const agentId = `1st:${config.hostsNamespace}/${agent}`
    const sharedId = `1st:${config.hostsNamespace}/${sharedAgent}`
    const teamAgentId = `1st:${config.hostsNamespace}/${teamAgent}`
    const unrelatedId = `1st:${config.hostsNamespace}/unrelated-${randomUUID().slice(0, 8)}`
    await database.pool.query(
      'INSERT INTO user_agents(user_id,agent_name) VALUES ($1,$2),($1,$3),($4,$3),($1,$5)',
      [owner, agent, sharedAgent, other, teamAgent]
    )
    await database.pool.query('INSERT INTO team_agents(team_id,agent_name) VALUES ($1,$2)', [
      team,
      teamAgent,
    ])
    await database.pool.query(
      `INSERT INTO gfs_grants(drive,resource_id,subject_type,subject_id,permissions,inherit,granted_by)
       VALUES ($1,$2,'operator','','{read}',true,'operator:'),
              ($1,$3,'user',$4,'{read}',false,'operator:'),
              ($1,$2,'team',$5,'{read}',true,'operator:'),
              ($1,$2,'host',$6,'{read}',true,'operator:'),
              ($1,$3,'context','ctx','{read}',false,'operator:'),
              ($1,$7,'user',$8,'{read}',false,'operator:'),
              ($1,$7,'host',$6,'{read}',false,'operator:'),
              ($1,$7,'host',$9,'{read}',false,'operator:'),
              ($1,$7,'host',$10,'{read}',false,'operator:'),
              ($1,$7,'host',$11,'{read}',false,'operator:')`,
      [drive, home, file, other, team, agentId, outside, owner, sharedId, unrelatedId, teamAgentId]
    )
    await database.pool.query(
      `INSERT INTO gfs_grants(drive,resource_id,subject_type,subject_id,permissions,inherit,granted_by)
       VALUES ($1,$2,'user',$3,'{read}',false,'operator:')`,
      [drive, deletedFile, other]
    )
    await database.pool.query(
      `INSERT INTO gfs_shares(drive,resource_id,subject_type,subject_id,permissions,include_descendants)
       VALUES ($1,$2,'user',$3,'{read}',false),($1,$2,'team',$4,'{read}',false),
              ($1,$5,'user',$6,'{read}',false),($1,$7,'user',$3,'{read}',false)`,
      [drive, file, other, team, outside, owner, deletedFile]
    )
    return {
      drive,
      root,
      owner,
      other,
      team,
      home,
      file,
      deletedFile,
      outside,
      agentId,
      sharedId,
      teamAgentId,
      unrelatedId,
    }
  }

  async function assertClean(
    f: Awaited<ReturnType<typeof fixture>>,
    hardDeletedBeforeRepair = false
  ) {
    expect(await homeState(database.pool, f.owner)).toMatchObject({
      state: 'retired',
      resource_id: f.home,
    })
    const inHome = await database.pool.query(
      `SELECT subject_type FROM gfs_grants WHERE resource_id=ANY($1::uuid[]) ORDER BY subject_type`,
      [[f.home, f.file, f.deletedFile]]
    )
    expect(inHome.rows).toEqual([{ subject_type: 'operator' }])
    expect(
      (
        await database.pool.query('SELECT id FROM gfs_shares WHERE resource_id=ANY($1::uuid[])', [
          [f.home, f.file, f.deletedFile],
        ])
      ).rows
    ).toHaveLength(0)
    expect(
      (
        await database.pool.query(
          `SELECT subject_type,subject_id FROM gfs_grants WHERE resource_id=$1 ORDER BY subject_id`,
          [f.outside]
        )
      ).rows
    ).toEqual(
      [
        ...(hardDeletedBeforeRepair ? [{ subject_type: 'host', subject_id: f.agentId }] : []),
        { subject_type: 'host', subject_id: f.sharedId },
        { subject_type: 'host', subject_id: f.teamAgentId },
        { subject_type: 'host', subject_id: f.unrelatedId },
      ].sort((a, b) => a.subject_id.localeCompare(b.subject_id))
    )
    expect(
      (
        await database.pool.query(
          `SELECT id FROM gfs_shares WHERE resource_id=$1 AND subject_id=$2`,
          [f.outside, f.owner]
        )
      ).rows
    ).toHaveLength(0)
    expect(
      (await database.pool.query('SELECT bytes FROM gfs_resources WHERE resource_id=$1', [f.file]))
        .rows
    ).toEqual([{ bytes: '7' }])
  }

  const retirementPaths = [
    'admin-delete',
    'admin-linked',
    'replace-inviter',
    'team-manager',
    'legacy-admin',
  ] as const

  async function prepareRetirement(
    path: (typeof retirementPaths)[number],
    f: Awaited<ReturnType<typeof fixture>>
  ) {
    if (path === 'admin-linked') {
      await database.pool.query(
        `INSERT INTO gfs_desktop_operator_links(id,lineage_id,generation,user_id,control_admin_id,state,source,created_by,row_version)
         VALUES(gen_random_uuid(),gen_random_uuid(),1,$1,$2,'active','initial_setup',$2,1)`,
        [f.owner, admin]
      )
    }
    if (path === 'admin-delete' || path === 'admin-linked') {
      return async () => {
        await request(app)
          .delete(`/admin/users/${f.owner}`)
          .set('Idempotency-Key', randomUUID())
          .send({ reason: 'Retirement test' })
          .expect(200)
      }
    }
    if (path === 'legacy-admin') {
      return async () => {
        expect(await adminDeleteUser(f.owner)).toMatchObject({ ok: true })
      }
    }
    if (path === 'team-manager') {
      const team = randomUUID()
      await database.pool.query('INSERT INTO teams(id,name) VALUES($1,$2)', [team, 'Manager team'])
      await database.pool.query(
        `INSERT INTO team_members(team_id,user_id,role,status) VALUES($1,$2,'admin','active'),($1,$3,'member','active')`,
        [team, f.other, f.owner]
      )
      return async () => {
        const result = await deleteManagedUserForUser(f.other, f.owner, {
          reason: 'Retirement test',
          idempotencyKey: randomUUID(),
          requestId: null,
        })
        expect(result).toHaveProperty('deleted')
      }
    }
    const inviter = randomUUID()
    const inviterEmail = `${inviter}@example.test`
    await database.pool.query('UPDATE users SET email=$2 WHERE id=$1', [f.owner, inviterEmail])
    await database.pool.query(
      `INSERT INTO control_admin_users(id,username,email,password_hash,role,status) VALUES($1,$2,$3,'test-hash','admin','active')`,
      [inviter, `inviter-${inviter}`, inviterEmail]
    )
    const recipient = `${randomUUID()}@example.test`
    const invitation = await createControlAdminInvitation(recipient, inviter, {
      replaceInviter: true,
    })
    if ('error' in invitation) throw new Error(invitation.error)
    return async () => {
      const result = await completeControlAdminInvitation({
        email: recipient,
        invitationId: invitation.id,
        username: `new-${randomUUID()}`,
        passwordHash: 'test-hash',
      })
      expect(result).not.toHaveProperty('error')
    }
  }

  it.each(retirementPaths)(
    'cleans home, user and captured agent entries through %s',
    async path => {
      const f = await fixture()
      expect(
        (
          await database.pool.query(
            `SELECT count(*)::int AS n FROM gfs_grants WHERE resource_id=$1`,
            [f.home]
          )
        ).rows[0].n
      ).toBeGreaterThan(1)
      for (const subject of [`user:${f.other}`, `team:${f.team}`, `host:${f.agentId}`]) {
        expect(
          await checkAccess(
            database.pool,
            { isOperator: false, subjects: new Set([subject]), actorKey: subject },
            f.drive,
            f.file,
            'read'
          )
        ).toBe(true)
      }
      await (
        await prepareRetirement(path, f)
      )()
      await assertClean(f)
      if (path === 'admin-delete') {
        expect(
          (
            await database.pool.query(
              `SELECT actor_on_behalf_of FROM gfs_audit
                WHERE op='user_home.retired' AND subject=$1`,
              [`user:${f.owner}`]
            )
          ).rows
        ).toEqual([{ actor_on_behalf_of: admin }])
      }
      for (const subject of [`user:${f.other}`, `team:${f.team}`, `host:${f.agentId}`]) {
        expect(
          await checkAccess(
            database.pool,
            { isOperator: false, subjects: new Set([subject]), actorKey: subject },
            f.drive,
            f.file,
            'read'
          )
        ).toBe(false)
      }
    }
  )

  it.each(retirementPaths)(
    'serializes provisioning against %s retirement',
    async path => {
      const f = await fixture()
      const retire = await prepareRetirement(path, f)
      const blocker = await database.pool.connect()
      let waiting = 0
      let operations: Promise<PromiseSettledResult<unknown>[]> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.owner])
        operations = Promise.allSettled([
          provisionUserHome(f.owner, { drive: f.drive, dbPool: database.pool }),
          retire(),
        ])
        for (let attempt = 0; attempt < 100 && waiting < 2; attempt++) {
          const result = await database.pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()
             AND wait_event_type='Lock'`
          )
          waiting = result.rows[0]!.count
          if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 20))
        }
        await blocker.query('COMMIT')
      } finally {
        await blocker.query('ROLLBACK').catch(() => {})
        blocker.release()
      }
      const results = await operations!
      for (const result of results) if (result.status === 'rejected') throw result.reason
      expect(waiting).toBeGreaterThanOrEqual(2)
      expect(['retired', 'unchanged']).toContain(
        (results[0] as PromiseFulfilledResult<unknown>).value
      )
      await assertClean(f)
    },
    15_000
  )

  it("removes only the retired user's own entries on / and /Users", async () => {
    const f = await fixture()
    const users = (
      await database.pool.query<{ parent_resource_id: string }>(
        'SELECT parent_resource_id::text FROM gfs_resources WHERE resource_id=$1',
        [f.home]
      )
    ).rows[0]!.parent_resource_id
    await database.pool.query(
      `INSERT INTO gfs_grants(drive,resource_id,subject_type,subject_id,permissions,inherit,granted_by)
       VALUES ($1,$2,'user',$3,'{read}',false,'operator:'),
              ($1,$2,'user',$4,'{read}',false,'operator:'),
              ($1,$5,'user',$3,'{read}',false,'operator:'),
              ($1,$5,'user',$4,'{read}',false,'operator:')`,
      [f.drive, f.root, f.owner, f.other, users]
    )
    await database.pool.query(
      `INSERT INTO gfs_shares(drive,resource_id,subject_type,subject_id,permissions,include_descendants)
       VALUES ($1,$2,'user',$3,'{read}',false),($1,$2,'user',$4,'{read}',false),
              ($1,$5,'user',$3,'{read}',false),($1,$5,'user',$4,'{read}',false)`,
      [f.drive, f.root, f.owner, f.other, users]
    )
    const subjectEntries = async (subjectId: string) =>
      (
        await database.pool.query<{ relation: string; resource_id: string }>(
          `SELECT 'grant' AS relation, resource_id::text AS resource_id FROM gfs_grants
            WHERE resource_id=ANY($1::uuid[]) AND subject_type='user' AND subject_id=$2
           UNION ALL
           SELECT 'share' AS relation, resource_id::text AS resource_id FROM gfs_shares
            WHERE resource_id=ANY($1::uuid[]) AND subject_type='user' AND subject_id=$2
           ORDER BY relation, resource_id`,
          [[f.root, users], subjectId]
        )
      ).rows
    expect(await subjectEntries(f.owner)).toHaveLength(4)
    const otherEntries = await subjectEntries(f.other)
    expect(otherEntries).toHaveLength(4)

    await request(app)
      .delete(`/admin/users/${f.owner}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Retirement test' })
      .expect(200)

    // Witness: the retired user's own four rows on / and /Users are gone.
    expect(await subjectEntries(f.owner)).toHaveLength(0)
    // Another subject's entries on the same two ancestors are untouched.
    expect(await subjectEntries(f.other)).toEqual(otherEntries)
  })

  it('records conflict clearing before retirement and logs the cleanup counts', async () => {
    const f = await fixture()
    await database.pool.query(
      `UPDATE gfs_user_homes SET state='conflict', conflict_code='ownership_conflict',
        conflict_detail=$2::jsonb WHERE user_id=$1`,
      [f.owner, JSON.stringify({ resourceIds: [f.home] })]
    )
    const logger = rootLogger as unknown as Record<symbol, unknown>
    const oldStream = logger[pino.symbols.streamSym]
    const oldLevel = rootLogger.level
    const lines: Array<Record<string, unknown>> = []
    logger[pino.symbols.streamSym] = {
      write: (line: string) => {
        lines.push(JSON.parse(line))
        return true
      },
    }
    rootLogger.level = 'info'
    try {
      await request(app)
        .delete(`/admin/users/${f.owner}`)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'Retirement test' })
        .expect(200)
      const rows = (
        await database.pool.query(
          `SELECT op, gfs_uri FROM gfs_audit WHERE subject=$1 AND op LIKE 'user_home.%' ORDER BY sequence_no`,
          [`user:${f.owner}`]
        )
      ).rows
      expect(rows.map(row => row.op)).toEqual([
        'user_home.provisioned',
        'user_home.conflict_cleared.ownership_conflict',
        'user_home.retired',
      ])
      expect(rows.slice(-2).every(row => row.gfs_uri === `gfs://${f.drive}/${f.home}`)).toBe(true)
      const recorded = lines.filter(
        line => line.event === 'user_home.retired' && line.userId === f.owner
      )
      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({
        transactionState: 'pending_commit',
        homeGrants: expect.any(Number),
        userGrants: expect.any(Number),
        agentGrants: expect.any(Number),
        homeShares: expect.any(Number),
        userShares: expect.any(Number),
      })
      expect(Number(recorded[0]!.homeGrants)).toBeGreaterThan(0)
      await assertClean(f)
    } finally {
      logger[pino.symbols.streamSym] = oldStream
      rootLogger.level = oldLevel
    }
  })

  it('stores a null audit URI when an unprovisioned home is retired', async () => {
    const f = await fixture()
    const pending = await createUser(database.pool, 'Pending User')
    expect((await homeState(database.pool, pending))?.resource_id).toBeNull()
    await request(app)
      .delete(`/admin/users/${pending}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Retirement test' })
      .expect(200)
    expect(
      (
        await database.pool.query(
          `SELECT gfs_uri FROM gfs_audit WHERE subject=$1 AND op='user_home.retired'`,
          [`user:${pending}`]
        )
      ).rows
    ).toEqual([{ gfs_uri: null }])
    expect(
      (
        await database.pool.query(
          `SELECT gfs_uri FROM gfs_audit WHERE subject=$1 AND op='user_home.provisioned'`,
          [`user:${f.owner}`]
        )
      ).rows
    ).toEqual([{ gfs_uri: `gfs://${f.drive}/${f.home}` }])
  })

  it('audits and logs retirement cleanup when the user has no home row', async () => {
    const f = await fixture()
    const user = await createUser(database.pool, 'User Without Home')
    await database.pool.query('DELETE FROM gfs_user_homes WHERE user_id=$1', [user])
    expect(await homeState(database.pool, user)).toBeUndefined()
    await database.pool.query(
      `INSERT INTO gfs_grants(drive,resource_id,subject_type,subject_id,permissions,inherit)
       VALUES ($1,$2,'user',$3,'{read}',false),($1,$2,'user',$4,'{read}',false)`,
      [f.drive, f.outside, user, f.other]
    )
    const grantSubjects = async () =>
      (
        await database.pool.query<{ subject_id: string }>(
          `SELECT subject_id FROM gfs_grants
            WHERE resource_id=$1 AND subject_type='user' AND subject_id=ANY($2::text[])
            ORDER BY subject_id`,
          [f.outside, [user, f.other]]
        )
      ).rows.map(row => row.subject_id)
    expect(await grantSubjects()).toEqual([user, f.other].sort())

    const logger = rootLogger as unknown as Record<symbol, unknown>
    const oldStream = logger[pino.symbols.streamSym]
    const oldLevel = rootLogger.level
    const lines: Array<Record<string, unknown>> = []
    logger[pino.symbols.streamSym] = {
      write: (line: string) => {
        lines.push(JSON.parse(line))
        return true
      },
    }
    rootLogger.level = 'info'
    try {
      await request(app)
        .delete(`/admin/users/${user}`)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'Retirement test' })
        .expect(200)
      expect(await grantSubjects()).toEqual([f.other])
      const audit = await database.pool.query(
        `SELECT op, gfs_uri FROM gfs_audit
          WHERE subject=$1 AND op='user_home.retired' ORDER BY sequence_no`,
        [`user:${user}`]
      )
      expect(audit.rows).toEqual([{ op: 'user_home.retired', gfs_uri: null }])
      const recorded = lines.filter(
        line => line.event === 'user_home.retired' && line.userId === user
      )
      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({
        transactionState: 'pending_commit',
        conflictCode: null,
        conflictDetail: null,
        homeGrants: 0,
        userGrants: 1,
        agentGrants: 0,
        homeShares: 0,
        userShares: 0,
      })
      const ownerAudit = await database.pool.query(
        `SELECT op FROM gfs_audit WHERE subject=$1 AND op='user_home.provisioned'`,
        [`user:${f.owner}`]
      )
      expect(ownerAudit.rows).toEqual([{ op: 'user_home.provisioned' }])
    } finally {
      logger[pino.symbols.streamSym] = oldStream
      rootLogger.level = oldLevel
    }
  })

  it.each([false, true])(
    'serializes concurrent retirements with overlapping grants (second home=%s)',
    async secondHome => {
      const f = await fixture()
      if (secondHome)
        expect(await provisionUserHome(f.other, { drive: f.drive, dbPool: database.pool })).toBe(
          'ready'
        )
      const otherHome = (await homeState(database.pool, f.other))!.resource_id
      await database.pool.query(
        `INSERT INTO gfs_grants(drive,resource_id,subject_type,subject_id,permissions,inherit,granted_by)
       VALUES ($1,$2,'user',$3,'{read}',false,'operator:')`,
        [f.drive, f.home, f.other]
      )
      if (otherHome) {
        await database.pool.query(
          `INSERT INTO gfs_grants(drive,resource_id,subject_type,subject_id,permissions,inherit,granted_by)
         VALUES ($1,$2,'user',$3,'{read}',false,'operator:')`,
          [f.drive, otherHome, f.owner]
        )
      }
      expect(
        await checkAccess(
          database.pool,
          {
            isOperator: false,
            subjects: new Set([`user:${f.other}`]),
            actorKey: `user:${f.other}`,
          },
          f.drive,
          f.file,
          'read'
        )
      ).toBe(true)
      const results = await Promise.all([adminDeleteUser(f.owner), adminDeleteUser(f.other)])
      expect(results).toEqual([
        { ok: true, id: f.owner },
        { ok: true, id: f.other },
      ])
      expect(await homeState(database.pool, f.owner)).toMatchObject({
        state: 'retired',
        resource_id: f.home,
      })
      expect(await homeState(database.pool, f.other)).toMatchObject({
        state: 'retired',
        resource_id: otherHome,
      })
      const homes = [f.home, ...(otherHome ? [otherHome] : [])]
      expect(
        (
          await database.pool.query(
            `SELECT id FROM gfs_grants WHERE resource_id=ANY($1::uuid[]) AND subject_type <> 'operator'`,
            [homes]
          )
        ).rows
      ).toHaveLength(0)
      expect(
        (
          await database.pool.query('SELECT bytes FROM gfs_resources WHERE resource_id=$1', [
            f.file,
          ])
        ).rows
      ).toEqual([{ bytes: '7' }])
    }
  )

  it('removes a shared agent grant when both owners retire on the same drive', async () => {
    const f = await fixture()
    expect(await provisionUserHome(f.other, { drive: f.drive, dbPool: database.pool })).toBe(
      'ready'
    )
    expect(
      (
        await database.pool.query(
          `SELECT id FROM gfs_grants WHERE resource_id=$1 AND subject_id=$2`,
          [f.outside, f.sharedId]
        )
      ).rows
    ).toHaveLength(1)
    const blocker = await database.pool.connect()
    let waiting = 0
    let work: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtext('gfs:structure:' || $1)::bigint)",
        [f.drive]
      )
      work = Promise.allSettled([adminDeleteUser(f.owner), adminDeleteUser(f.other)])
      for (let n = 0; n < 100 && waiting < 2; n++) {
        const result = await database.pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND query LIKE '%gfs:structure:%'`
        )
        waiting = result.rows[0]!.count
        if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 20))
      }
      await blocker.query('COMMIT')
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
    const results = await work!
    for (const result of results) if (result.status === 'rejected') throw result.reason
    expect(waiting).toBe(2)
    expect(
      (
        await database.pool.query(
          `SELECT id FROM gfs_grants WHERE resource_id=$1 AND subject_id=$2`,
          [f.outside, f.sharedId]
        )
      ).rows
    ).toHaveLength(0)
    expect(
      (await database.pool.query('SELECT bytes FROM gfs_resources WHERE resource_id=$1', [f.file]))
        .rows
    ).toEqual([{ bytes: '7' }])
  }, 15_000)

  it('removes a shared agent grant when its owners retire on different drives', async () => {
    const f = await fixture()
    const otherDrive = `other-${randomUUID()}`
    await createDrive(database.pool, otherDrive)
    expect(await provisionUserHome(f.other, { drive: otherDrive, dbPool: database.pool })).toBe(
      'ready'
    )
    const otherHome = (await homeState(database.pool, f.other))!.resource_id!
    expect(
      (
        await database.pool.query(
          `SELECT id FROM gfs_grants WHERE resource_id=$1 AND subject_id=$2`,
          [f.outside, f.sharedId]
        )
      ).rows
    ).toHaveLength(1)
    const blocker = await database.pool.connect()
    let waiting = 0
    let work: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        `SELECT id FROM gfs_grants WHERE resource_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [[f.home, otherHome]]
      )
      work = Promise.allSettled([adminDeleteUser(f.owner), adminDeleteUser(f.other)])
      for (let n = 0; n < 100 && waiting < 2; n++) {
        const result = await database.pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND query LIKE '%home_tree%'`
        )
        waiting = result.rows[0]!.count
        if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 20))
      }
      await blocker.query('COMMIT')
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
    const results = await work!
    for (const result of results) if (result.status === 'rejected') throw result.reason
    expect(waiting).toBe(2)
    const associated = (
      await database.pool.query(`SELECT count(*)::int AS n FROM user_agents WHERE agent_name=$1`, [
        f.sharedId.split('/').at(-1),
      ])
    ).rows[0].n
    const remaining = (
      await database.pool.query(
        `SELECT count(*)::int AS n FROM gfs_grants WHERE resource_id=$1 AND subject_id=$2`,
        [f.outside, f.sharedId]
      )
    ).rows[0].n
    expect(associated).toBe(0)
    expect(remaining).toBe(0)
    expect(
      (await database.pool.query('SELECT bytes FROM gfs_resources WHERE resource_id=$1', [f.file]))
        .rows
    ).toEqual([{ bytes: '7' }])
  }, 15_000)
  it('rejects a grant waiting behind retirement while an independent home remains usable', async () => {
    const f = await fixture()
    const target = await createUser(database.pool, 'Grant Target')
    expect(await provisionUserHome(f.other, { drive: f.drive, dbPool: database.pool })).toBe(
      'ready'
    )
    const otherHome = (await homeState(database.pool, f.other))!.resource_id!
    await database.pool.query(
      `INSERT INTO gfs_grants(drive,resource_id,subject_type,subject_id,permissions,inherit,granted_by)
       VALUES ($1,$2,'user',$3,ARRAY['read','write','delete','manage_acl','share'],true,'operator:')`,
      [f.drive, f.home, f.other]
    )
    const body = {
      drive: f.drive,
      subject: { type: 'user', id: target },
      permissions: ['read'],
      inherit: false,
    }
    await request(app)
      .put('/gfs/grants')
      .set('x-user', f.other)
      .send({ ...body, resourceId: otherHome })
      .expect(200)
    let release!: () => void
    let ready!: () => void
    const parked = new Promise<void>(resolve => {
      release = resolve
    })
    const retired = new Promise<void>(resolve => {
      ready = resolve
    })
    const retirement = withTransaction(async db => {
      await retireDesktopUser(actor(), f.owner, 'Retirement test', randomUUID(), null, { db })
      ready()
      await parked
    }, database.pool)
    await retired
    const issuance = request(app)
      .put('/gfs/grants')
      .set('x-user', f.other)
      .send({ ...body, resourceId: f.home })
      .then(response => response)
    let blocked = false
    try {
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const result = await database.pool.query(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND query LIKE '%gfs:structure:%') AS blocked`
        )
        blocked = result.rows[0].blocked === true
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 20))
      }
    } finally {
      release()
    }
    const [, response] = await Promise.all([retirement, issuance])
    expect(blocked).toBe(true)
    expect(response.status).toBe(403)
    expect(
      (
        await database.pool.query(
          `SELECT id FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
          [f.home, target]
        )
      ).rows
    ).toHaveLength(0)
    expect(
      (
        await database.pool.query(
          `SELECT id FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
          [otherHome, target]
        )
      ).rows
    ).toHaveLength(1)
    expect(
      (await database.pool.query('SELECT bytes FROM gfs_resources WHERE resource_id=$1', [f.file]))
        .rows
    ).toEqual([{ bytes: '7' }])
  }, 15_000)

  it('retries a failed startup repair row on the same reconciler next tick', async () => {
    const blocked = await fixture()
    const healthyRepair = await fixture()
    await database.pool.query(
      `DELETE FROM gfs_grants WHERE subject_type='user' AND
       ((resource_id=$1 AND subject_id=$2) OR (resource_id=$3 AND subject_id=$4))`,
      [blocked.home, blocked.owner, healthyRepair.home, healthyRepair.owner]
    )
    await database.pool.query(`
      CREATE FUNCTION fail_one_home_repair() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.user_id = '${blocked.owner}'::uuid AND NEW.state = 'conflict' THEN
          RAISE EXCEPTION 'injected repair failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_one_home_repair BEFORE UPDATE ON gfs_user_homes
        FOR EACH ROW EXECUTE FUNCTION fail_one_home_repair();
    `)
    const worker = new GfsUserHomeReconciler(blocked.drive, database.pool)
    try {
      await worker.tick()
      expect(await homeState(database.pool, healthyRepair.owner)).toMatchObject({
        state: 'conflict',
        conflict_code: 'ownership_conflict',
      })
      expect(await homeState(database.pool, blocked.owner)).toMatchObject({ state: 'ready' })
    } finally {
      await database.pool.query('DROP TRIGGER fail_one_home_repair ON gfs_user_homes')
      await database.pool.query('DROP FUNCTION fail_one_home_repair()')
    }
    await worker.tick()
    expect(await homeState(database.pool, blocked.owner)).toMatchObject({
      state: 'conflict',
      conflict_code: 'ownership_conflict',
    })
  })

  it('repairs a hard-deleted owner and a missing owner grant without restoring either automatically', async () => {
    const retired = await fixture()
    const broken = await fixture()
    await database.pool.query('DELETE FROM users WHERE id=$1', [retired.owner])
    await database.pool.query(
      `DELETE FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
      [broken.home, broken.owner]
    )
    const worker = new GfsUserHomeReconciler(retired.drive, database.pool)
    await worker.tick()
    await assertClean(retired, true)
    expect(await homeState(database.pool, broken.owner)).toMatchObject({
      state: 'conflict',
      conflict_code: 'ownership_conflict',
    })
    expect(
      (
        await database.pool.query(
          `SELECT id FROM gfs_grants WHERE resource_id=$1 AND subject_type='operator'`,
          [broken.home]
        )
      ).rows
    ).toHaveLength(1)
    expect(
      (
        await database.pool.query('SELECT bytes FROM gfs_resources WHERE resource_id=$1', [
          broken.file,
        ])
      ).rows
    ).toEqual([{ bytes: '7' }])
  })
})
