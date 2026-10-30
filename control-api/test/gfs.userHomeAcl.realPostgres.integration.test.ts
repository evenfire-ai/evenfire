import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import request from 'supertest'
import { withTransaction } from '../src/db.js'
import { lockUserHome, restoreUserHomeOwnerGrant } from '../src/gfs/userHomeOwnerRestore.js'
import { provisionUserHome } from '../src/gfs/userHomeProvisioner.js'
import { asyncHandler } from '../src/http/asyncHandler.js'
import {
  handleGrantDelete,
  handleGrantListForCaller,
  handleGrantWrite,
} from '../src/routes/gfs/grants.js'
import {
  handleShareDelete,
  handleShareListForCaller,
  handleShareWrite,
} from '../src/routes/gfs/shares.js'
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
const ALL = ['read', 'write', 'delete', 'manage_acl', 'share']

describeRealPostgres('user-home ACL routes on PostgreSQL', () => {
  let adminPool: Pool
  let database: Awaited<ReturnType<typeof createUserHomeDatabase>>
  let drive: string
  let root: string
  let owner: string
  let home: string
  let admin: string
  let app: express.Express

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl! })
    database = await createUserHomeDatabase(adminUrl!, adminPool)
    holder.pool = database.pool
    admin = randomUUID()
    await database.pool.query(
      `INSERT INTO control_admin_users (id, username, password_hash, role, status)
       VALUES ($1, $2, 'test-hash', 'admin', 'active')`,
      [admin, `acl-${admin}`]
    )
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      if (req.header('x-operator')) Object.assign(req, { adminAuth: { sub: admin } })
      else Object.assign(req, { externalAuth: { userId: req.header('x-user') } })
      next()
    })
    app.get('/grants', asyncHandler(handleGrantListForCaller))
    app.put('/grants', asyncHandler(handleGrantWrite))
    app.delete('/grants/:id', asyncHandler(handleGrantDelete))
    app.get('/shares', asyncHandler(handleShareListForCaller))
    app.post('/shares', asyncHandler(handleShareWrite))
    app.delete('/shares/:id', asyncHandler(handleShareDelete))
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

  beforeEach(async () => {
    drive = `acl-${randomUUID()}`
    root = await createDrive(database.pool, drive)
    owner = await createUser(database.pool, 'Owner')
    expect(await provisionUserHome(owner, { drive, dbPool: database.pool })).toBe('ready')
    home = (await homeState(database.pool, owner))!.resource_id!
  })

  async function grant(
    resourceId: string,
    subjectType: string,
    subjectId: string,
    permissions = ALL,
    inherit = true
  ) {
    const result = await database.pool.query<{ id: string }>(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text`,
      [drive, resourceId, subjectType, subjectId, permissions, inherit]
    )
    return result.rows[0]!.id
  }

  it('marks only the bound owner grant for the owner, a manager, and an operator', async () => {
    const manager = await createUser(database.pool, 'Manager')
    const managerGrant = await grant(home, 'user', manager, ALL, true)
    const contextGrant = await grant(home, 'context', owner, ['read'], false)
    for (const caller of [owner, manager, 'operator']) {
      const response = request(app).get('/grants').query({ drive, resourceId: home })
      if (caller === 'operator') response.set('x-operator', 'yes')
      else response.set('x-user', caller)
      const { body } = await response.expect(200)
      expect(body.items).toHaveLength(3)
      const ownerRow = body.items.find(
        (item: { subject: { type: string; id: string } }) =>
          item.subject.type === 'user' && item.subject.id === owner
      )
      expect(ownerRow.homeOwner).toBe(true)
      const otherRows = body.items.filter((item: { id: string }) =>
        [managerGrant, contextGrant].includes(item.id)
      )
      expect(otherRows).toHaveLength(2)
      expect(otherRows.map((item: object) => Object.hasOwn(item, 'homeOwner'))).toEqual([
        false,
        false,
      ])
    }

    const folder = (
      await database.pool.query<{ resource_id: string }>(
        `INSERT INTO gfs_resources (drive,parent_resource_id,name,kind,path_cache)
         VALUES ($1,$2,'folder','directory','/folder') RETURNING resource_id::text`,
        [drive, home]
      )
    ).rows[0]!.resource_id
    const ownerOnFolder = await grant(folder, 'user', owner, ['read'], true)
    const { body } = await request(app)
      .get('/grants')
      .set('x-user', owner)
      .query({ drive, resourceId: folder })
      .expect(200)
    expect(body.items).toHaveLength(1)
    expect(body.items[0].id).toBe(ownerOnFolder)
    expect(Object.hasOwn(body.items[0], 'homeOwner')).toBe(false)
  })

  it('protects the owner grant while the owner can revoke another grant and an operator can narrow it', async () => {
    const other = await createUser(database.pool, 'Other')
    const ownerRow = await database.pool.query<{ id: string }>(
      `SELECT id::text FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
      [home, owner]
    )
    const otherGrant = await grant(home, 'user', other, ['read'], false)
    await request(app).delete(`/grants/${otherGrant}`).set('x-user', owner).expect(200)
    await request(app)
      .delete(`/grants/${ownerRow.rows[0]!.id}`)
      .set('x-user', owner)
      .expect(403)
      .expect(({ body }) => expect(body.error).toBe('home_owner_grant_protected'))
    await request(app)
      .put('/grants')
      .set('x-user', owner)
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: owner },
        permissions: ['read'],
        inherit: true,
      })
      .expect(403)
      .expect(({ body }) => expect(body.error).toBe('home_owner_grant_protected'))
    expect((await homeState(database.pool, owner))?.state).toBe('ready')
    await request(app)
      .put('/grants')
      .set('x-operator', 'yes')
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: owner },
        permissions: ALL,
        inherit: true,
      })
      .expect(200)
    expect((await homeState(database.pool, owner))?.state).toBe('ready')
    await request(app)
      .put('/grants')
      .set('x-operator', 'yes')
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: owner },
        permissions: ['read'],
        inherit: true,
      })
      .expect(200)
    expect(await homeState(database.pool, owner)).toMatchObject({
      state: 'conflict',
      conflict_code: 'ownership_conflict',
    })
    expect(
      (
        await database.pool.query(`SELECT permissions, inherit FROM gfs_grants WHERE id=$1`, [
          ownerRow.rows[0]!.id,
        ])
      ).rows
    ).toEqual([{ permissions: ['read'], inherit: true }])
  })

  it('protects the owner grant from a manager who holds fewer permissions', async () => {
    const manager = await createUser(database.pool, 'Limited Manager')
    const other = await createUser(database.pool, 'Other')
    await grant(home, 'user', manager, ['read', 'manage_acl'], true)
    const otherGrant = await grant(home, 'user', other, ['read'], false)
    const ownerGrant = (
      await database.pool.query<{ id: string }>(
        `SELECT id::text FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
        [home, owner]
      )
    ).rows[0]!.id
    await request(app).delete(`/grants/${otherGrant}`).set('x-user', manager).expect(200)
    await request(app)
      .delete(`/grants/${ownerGrant}`)
      .set('x-user', manager)
      .expect(403)
      .expect(({ body }) => expect(body.error).toBe('home_owner_grant_protected'))
    await request(app)
      .put('/grants')
      .set('x-user', manager)
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: owner },
        permissions: ['read'],
        inherit: true,
      })
      .expect(403)
      .expect(({ body }) => expect(body.error).toBe('home_owner_grant_protected'))
    expect(
      (await database.pool.query('SELECT id FROM gfs_grants WHERE id=$1', [ownerGrant])).rows
    ).toHaveLength(1)
    expect((await homeState(database.pool, owner))?.state).toBe('ready')
  })

  it('protects a revoked owner grant from non-operator restoration', async () => {
    const manager = await createUser(database.pool, 'Manager')
    await grant(home, 'user', manager, ALL, true)
    const ownerGrant = (
      await database.pool.query<{ id: string }>(
        `SELECT id::text FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
        [home, owner]
      )
    ).rows[0]!.id
    await request(app)
      .put('/grants')
      .set('x-user', manager)
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: owner },
        permissions: ALL,
        inherit: true,
      })
      .expect(200)
    await request(app).delete(`/grants/${ownerGrant}`).set('x-operator', 'yes').expect(200)
    await request(app)
      .put('/grants')
      .set('x-user', manager)
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: owner },
        permissions: ALL,
        inherit: true,
      })
      .expect(403)
      .expect(({ body }) => expect(body.error).toBe('home_owner_grant_protected'))
    expect(
      (
        await database.pool.query(
          `SELECT id FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
          [home, owner]
        )
      ).rows
    ).toHaveLength(0)
    expect(await homeState(database.pool, owner)).toMatchObject({
      state: 'conflict',
      conflict_code: 'ownership_conflict',
    })
  })

  it('marks an operator-revoked owner grant as an ownership conflict', async () => {
    const other = await createUser(database.pool, 'Other')
    const otherGrant = await grant(home, 'user', other, ['read'], false)
    const ownerGrant = (
      await database.pool.query<{ id: string }>(
        `SELECT id::text FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
        [home, owner]
      )
    ).rows[0]!.id
    await request(app).delete(`/grants/${otherGrant}`).set('x-user', owner).expect(200)
    await request(app).delete(`/grants/${ownerGrant}`).set('x-operator', 'yes').expect(200)
    expect(await homeState(database.pool, owner)).toMatchObject({
      state: 'conflict',
      conflict_code: 'ownership_conflict',
    })
    expect(
      (await database.pool.query('SELECT id FROM gfs_grants WHERE id=$1', [ownerGrant])).rows
    ).toHaveLength(0)
    expect(
      (
        await database.pool.query('SELECT resource_id FROM gfs_resources WHERE resource_id=$1', [
          home,
        ])
      ).rows
    ).toHaveLength(1)
  })

  it('restores a conflicted owner grant through an operator PUT under the required locks', async () => {
    const ownerGrant = (
      await database.pool.query<{ id: string }>(
        `SELECT id::text FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
        [home, owner]
      )
    ).rows[0]!.id
    await request(app).delete(`/grants/${ownerGrant}`).set('x-operator', 'yes').expect(200)
    expect(await homeState(database.pool, owner)).toMatchObject({
      state: 'conflict',
      conflict_code: 'ownership_conflict',
    })
    const before = (
      await database.pool.query<{ id: string }>(
        'SELECT COALESCE(max(sequence_no),0)::text AS id FROM gfs_audit'
      )
    ).rows[0]!.id
    const querySpy = vi.spyOn(Client.prototype, 'query')
    let statements: string[]
    try {
      await request(app)
        .put('/grants')
        .set('x-operator', 'yes')
        .send({
          drive,
          resourceId: home,
          subject: { type: 'user', id: owner },
          permissions: ALL,
          inherit: true,
        })
        .expect(200)
      statements = querySpy.mock.calls.map(call => String(call[0]))
    } finally {
      querySpy.mockRestore()
    }
    const userLock = statements.findIndex(sql => sql.includes('gfs:user-home:'))
    const structureLock = statements.findIndex(sql => sql.includes('gfs:structure:'))
    const homeLock = statements.findIndex(
      sql => sql.includes('FROM gfs_user_homes') && sql.includes('FOR UPDATE')
    )
    expect(userLock).toBeGreaterThanOrEqual(0)
    expect(structureLock).toBeGreaterThan(userLock)
    expect(homeLock).toBeGreaterThan(structureLock)
    expect(await homeState(database.pool, owner)).toMatchObject({
      state: 'ready',
      conflict_code: null,
      conflict_detail: null,
      last_error: null,
    })
    expect(
      (
        await database.pool.query(
          `SELECT permissions,inherit,granted_by FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
          [home, owner]
        )
      ).rows
    ).toEqual([{ permissions: ALL, inherit: true, granted_by: 'operator:' }])
    expect(
      (
        await database.pool.query(
          `SELECT op,actor_on_behalf_of,outcome FROM gfs_audit
        WHERE sequence_no>$1 AND subject=$2 AND op LIKE 'user_home.%' ORDER BY sequence_no`,
          [before, `user:${owner}`]
        )
      ).rows
    ).toEqual([
      {
        op: 'user_home.conflict_cleared.ownership_conflict',
        actor_on_behalf_of: admin,
        outcome: 'allowed',
      },
      { op: 'user_home.restore_owner', actor_on_behalf_of: admin, outcome: 'allowed' },
    ])
  })

  it('waits for the owner lock before taking the structure lock during restoration', async () => {
    const ownerGrant = (
      await database.pool.query<{ id: string }>(
        `SELECT id::text FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
        [home, owner]
      )
    ).rows[0]!.id
    await request(app).delete(`/grants/${ownerGrant}`).set('x-operator', 'yes').expect(200)
    const blocker = await database.pool.connect()
    let pending: Promise<request.Response> | undefined
    let blocked = false
    let structureFree = false
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtext('gfs:user-home:' || $1)::bigint)",
        [owner]
      )
      pending = request(app)
        .put('/grants')
        .set('x-operator', 'yes')
        .send({
          drive,
          resourceId: home,
          subject: { type: 'user', id: owner },
          permissions: ALL,
          inherit: true,
        })
        .then(response => response)
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const result = await database.pool.query(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND query LIKE '%gfs:user-home:%') AS blocked`
        )
        blocked = result.rows[0].blocked === true
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 20))
      }
      const check = await database.pool.query(
        "SELECT pg_try_advisory_xact_lock(hashtext('gfs:structure:' || $1)::bigint) AS available",
        [drive]
      )
      structureFree = check.rows[0].available === true
      await blocker.query('COMMIT')
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
    expect((await pending!).status).toBe(200)
    expect(blocked).toBe(true)
    expect(structureFree).toBe(true)
    expect(await homeState(database.pool, owner)).toMatchObject({
      state: 'ready',
      conflict_code: null,
    })
  }, 15_000)

  it('keeps ownership conflict when an operator PUT still narrows the owner grant', async () => {
    const ownerGrant = (
      await database.pool.query<{ id: string }>(
        `SELECT id::text FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
        [home, owner]
      )
    ).rows[0]!.id
    await request(app).delete(`/grants/${ownerGrant}`).set('x-operator', 'yes').expect(200)
    await request(app)
      .put('/grants')
      .set('x-operator', 'yes')
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: owner },
        permissions: ['read'],
        inherit: true,
      })
      .expect(200)
    expect(
      (
        await database.pool.query(
          `SELECT permissions,inherit FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
          [home, owner]
        )
      ).rows
    ).toEqual([{ permissions: ['read'], inherit: true }])
    expect(await homeState(database.pool, owner)).toMatchObject({
      state: 'conflict',
      conflict_code: 'ownership_conflict',
    })
  })

  it('rolls back an operator restore when its lifecycle audit cannot be written', async () => {
    const other = await createUser(database.pool, 'Other')
    await request(app)
      .put('/grants')
      .set('x-operator', 'yes')
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: other },
        permissions: ['read'],
        inherit: false,
      })
      .expect(200)
    const ownerGrant = (
      await database.pool.query<{ id: string }>(
        `SELECT id::text FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
        [home, owner]
      )
    ).rows[0]!.id
    await request(app).delete(`/grants/${ownerGrant}`).set('x-operator', 'yes').expect(200)
    const before = (
      await database.pool.query<{ id: string }>(
        'SELECT COALESCE(max(sequence_no),0)::text AS id FROM gfs_audit'
      )
    ).rows[0]!.id
    await database.pool.query(`
      CREATE FUNCTION fail_owner_restore_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.op = 'user_home.restore_owner' THEN RAISE EXCEPTION 'injected audit failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_owner_restore_audit BEFORE INSERT ON gfs_audit
        FOR EACH ROW EXECUTE FUNCTION fail_owner_restore_audit();
    `)
    try {
      await request(app)
        .put('/grants')
        .set('x-operator', 'yes')
        .send({
          drive,
          resourceId: home,
          subject: { type: 'user', id: owner },
          permissions: ALL,
          inherit: true,
        })
        .expect(500)
    } finally {
      await database.pool.query('DROP TRIGGER fail_owner_restore_audit ON gfs_audit')
      await database.pool.query('DROP FUNCTION fail_owner_restore_audit()')
    }
    expect(
      (
        await database.pool.query(
          `SELECT id FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
          [home, owner]
        )
      ).rows
    ).toHaveLength(0)
    expect(await homeState(database.pool, owner)).toMatchObject({
      state: 'conflict',
      conflict_code: 'ownership_conflict',
    })
    expect(
      (
        await database.pool.query(
          `SELECT op FROM gfs_audit WHERE sequence_no>$1 AND subject=$2 AND op LIKE 'user_home.%'`,
          [before, `user:${owner}`]
        )
      ).rows
    ).toHaveLength(0)
    expect(
      (
        await database.pool.query(
          `SELECT id FROM gfs_grants WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
          [home, other]
        )
      ).rows
    ).toHaveLength(1)
  })

  it('restores an owner grant through the shared transaction helper used by the operator route', async () => {
    await request(app)
      .put('/grants')
      .set('x-operator', 'yes')
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: owner },
        permissions: ['read'],
        inherit: false,
      })
      .expect(200)
    expect(await homeState(database.pool, owner)).toMatchObject({
      state: 'conflict',
      conflict_code: 'ownership_conflict',
    })
    const result = await withTransaction(async db => {
      await lockUserHome(db, owner)
      return restoreUserHomeOwnerGrant(
        db,
        owner,
        { actorKey: 'operator:', actorOnBehalfOf: admin },
        async binding => {
          await db.query(
            `INSERT INTO gfs_grants(drive,resource_id,subject_type,subject_id,permissions,inherit,granted_by)
           VALUES ($1,$2,'user',$3,$4,true,'platform:user-home')
           ON CONFLICT (drive,resource_id,subject_type,subject_id)
           DO UPDATE SET permissions=EXCLUDED.permissions,inherit=true,granted_by='platform:user-home'`,
            [binding.drive, binding.resourceId, binding.userId, ALL]
          )
        }
      )
    }, database.pool)
    expect(result).toBe('restored')
    expect(await homeState(database.pool, owner)).toMatchObject({
      state: 'ready',
      conflict_code: null,
    })
    expect(
      (
        await database.pool.query(
          `SELECT op FROM gfs_audit WHERE subject=$1 AND op LIKE 'user_home.%' ORDER BY sequence_no DESC LIMIT 2`,
          [`user:${owner}`]
        )
      ).rows
    ).toEqual([
      { op: 'user_home.restore_owner' },
      { op: 'user_home.conflict_cleared.ownership_conflict' },
    ])
  })

  it.each(['user', 'operator'] as const)(
    'blocks ancestor grants and shares for non-operator subjects under %s authority',
    async authority => {
      const manager = await createUser(database.pool, 'Manager')
      const target = await createUser(database.pool, 'Target')
      const team = randomUUID()
      const users = (
        await database.pool.query<{ parent_resource_id: string }>(
          'SELECT parent_resource_id::text FROM gfs_resources WHERE resource_id=$1',
          [home]
        )
      ).rows[0]!.parent_resource_id
      await grant(home, 'user', manager, ALL, true)
      const subjects = [
        { type: 'user', id: target },
        { type: 'team', id: team },
        { type: 'host', id: '1st:host-namespace/individual-agent' },
        { type: 'context', id: 'example-context' },
      ]
      const authorize = (call: request.Test) =>
        authority === 'operator' ? call.set('x-operator', 'yes') : call.set('x-user', manager)
      for (const ancestor of [root, users]) {
        // A legacy direct grant lets the user-authority case reach the new guard.
        await grant(ancestor, 'user', manager, ALL, false)
        for (const subject of subjects) {
          const grantBody = { drive, resourceId: ancestor, subject, permissions: ['read'] }
          for (const inherit of [false, true]) {
            await authorize(request(app).put('/grants'))
              .send({ ...grantBody, inherit })
              .expect(409)
              .expect(({ body }) => expect(body.error).toBe('ancestor_home_exposure'))
            const shareResponse = authorize(request(app).post('/shares')).send({
              ...grantBody,
              includeDescendants: inherit,
            })
            if (subject.type === 'host') {
              await shareResponse
                .expect(403)
                .expect(({ body }) => expect(body.error).toBe('share_to_agent_forbidden'))
            } else {
              await shareResponse
                .expect(409)
                .expect(({ body }) => expect(body.error).toBe('ancestor_home_exposure'))
            }
          }
        }
        if (authority === 'operator') {
          const subject = { type: 'operator' }
          for (const inherit of [false, true]) {
            await authorize(request(app).put('/grants'))
              .send({
                drive,
                resourceId: ancestor,
                subject,
                permissions: ['read'],
                inherit,
              })
              .expect(200)
            await authorize(request(app).post('/shares'))
              .send({
                drive,
                resourceId: ancestor,
                subject,
                permissions: ['read'],
                includeDescendants: inherit,
              })
              .expect(200)
          }
        }
      }
      await authorize(request(app).put('/grants'))
        .send({
          drive,
          resourceId: home,
          subject: { type: 'user', id: target },
          permissions: ['read'],
          inherit: true,
        })
        .expect(200)
      await authorize(request(app).post('/shares'))
        .send({
          drive,
          resourceId: home,
          subject: { type: 'user', id: target },
          permissions: ['read'],
          includeDescendants: true,
        })
        .expect(200)
      await request(app)
        .get('/grants')
        .set('x-user', owner)
        .query({ drive, resourceId: home })
        .expect(200)
    }
  )

  it('keeps ordinary callers behind the existing authority checks on ancestors', async () => {
    const user = await createUser(database.pool, 'Ordinary User')
    const target = await createUser(database.pool, 'Target')
    const body = {
      drive,
      resourceId: root,
      subject: { type: 'user', id: target },
      permissions: ['read'],
    }
    await request(app)
      .put('/grants')
      .set('x-user', user)
      .send({ ...body, inherit: true })
      .expect(403)
      .expect(({ body: result }) => expect(result.error).toBe('not_manager'))
    await request(app)
      .post('/shares')
      .set('x-user', user)
      .send({ ...body, includeDescendants: true })
      .expect(403)
      .expect(({ body: result }) => expect(result.error).toBe('not_sharer'))
    // Model a pre-existing direct grant so the caller reaches the ancestor guard.
    await grant(root, 'user', user, ALL, false)
    for (const inherit of [false, true]) {
      await request(app)
        .put('/grants')
        .set('x-user', user)
        .send({ ...body, inherit })
        .expect(409)
        .expect(({ body: result }) => expect(result.error).toBe('ancestor_home_exposure'))
      await request(app)
        .post('/shares')
        .set('x-user', user)
        .send({ ...body, includeDescendants: inherit })
        .expect(409)
        .expect(({ body: result }) => expect(result.error).toBe('ancestor_home_exposure'))
    }
  })

  it('shows profiles only to the home owner and records the owner lowering another manager share', async () => {
    // W3: provisioning records the platform as the introducer of the owner grant.
    expect(
      (
        await database.pool.query(
          `SELECT granted_by, introduced_by FROM gfs_grants
            WHERE drive = $1 AND resource_id = $2 AND subject_type = 'user' AND subject_id = $3`,
          [drive, home, owner]
        )
      ).rows
    ).toEqual([{ granted_by: 'platform:user-home', introduced_by: 'platform:user-home' }])
    const manager = await createUser(database.pool, 'Manager')
    const outsider = await createUser(database.pool, 'Outside Team')
    const team = randomUUID()
    await database.pool.query('INSERT INTO teams (id,name) VALUES ($1,$2)', [team, 'Visible team'])
    // D20: the outsider is in the manager's team, not the owner's; the manager's
    // shares below make the outsider and the team visible to the owner.
    for (const member of [manager, outsider]) {
      await database.pool.query(
        "INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,'member','active')",
        [team, member]
      )
    }
    const folder = (
      await database.pool.query<{ resource_id: string }>(
        `INSERT INTO gfs_resources (drive,parent_resource_id,name,kind,path_cache)
       VALUES ($1,$2,'subfolder','directory','/subfolder') RETURNING resource_id::text`,
        [drive, home]
      )
    ).rows[0]!.resource_id
    await grant(home, 'user', manager, ALL, true)
    await grant(folder, 'user', outsider, ['read'], false)
    await grant(folder, 'team', team, ['read'], false)
    await request(app)
      .post('/shares')
      .set('x-user', manager)
      .send({
        drive,
        resourceId: folder,
        subject: { type: 'user', id: outsider },
        permissions: ALL,
        includeDescendants: true,
      })
      .expect(200)
    await request(app)
      .post('/shares')
      .set('x-user', manager)
      .send({
        drive,
        resourceId: folder,
        subject: { type: 'team', id: team },
        permissions: ['read'],
        includeDescendants: false,
      })
      .expect(200)
    // W2: both rows record the manager as author and introducer at creation.
    const createdShares = await database.pool.query<{
      subject_id: string
      created_by: string | null
      introduced_by: string | null
    }>(`SELECT subject_id, created_by, introduced_by FROM gfs_shares WHERE resource_id = $1`, [
      folder,
    ])
    expect(createdShares.rows).toHaveLength(2)
    expect(createdShares.rows.map(row => [row.created_by, row.introduced_by])).toEqual([
      [`user:${manager}`, `user:${manager}`],
      [`user:${manager}`, `user:${manager}`],
    ])
    // The owner row is profiled only through its `platform:` introducer; the
    // manager's row has no author and no introducer, so it stays unprofiled.
    const homeList = await request(app)
      .get('/grants')
      .set('x-user', owner)
      .query({ drive, resourceId: home })
      .expect(200)
    expect(homeList.body.items).toHaveLength(2)
    const ownerRow = homeList.body.items.find(
      (item: { subject: { type: string; id: string } }) => item.subject.id === owner
    )
    expect(ownerRow.homeOwner).toBe(true)
    expect(ownerRow.subjectProfile).toEqual({ name: 'Owner', email: `${owner}@example.test` })
    const managerRow = homeList.body.items.find(
      (item: { subject: { id: string } }) => item.subject.id === manager
    )
    expect(managerRow).toBeDefined()
    expect(managerRow).not.toHaveProperty('subjectProfile')
    for (const path of ['/grants', '/shares']) {
      const visible = await request(app)
        .get(path)
        .set('x-user', owner)
        .query({ drive, resourceId: folder })
        .expect(200)
      expect(visible.body.items.length).toBeGreaterThan(0)
      const outside = visible.body.items.find(
        (item: { subject: { id: string } }) => item.subject.id === outsider
      )
      expect(outside.subjectProfile).toEqual({
        name: 'Outside Team',
        email: `${outsider}@example.test`,
      })
      const teamRow = visible.body.items.find(
        (item: { subject: { id: string } }) => item.subject.id === team
      )
      expect(teamRow.subjectProfile).toEqual({ name: 'Visible team' })
      const other = await request(app)
        .get(path)
        .set('x-user', manager)
        .query({ drive, resourceId: folder })
        .expect(200)
      expect(other.body.items.length).toBeGreaterThan(0)
      expect(other.body.items.every((item: object) => !Object.hasOwn(item, 'subjectProfile'))).toBe(
        true
      )
    }
    const outsideFolder = (
      await database.pool.query<{ resource_id: string }>(
        `INSERT INTO gfs_resources (drive,parent_resource_id,name,kind,path_cache)
         VALUES ($1,$2,'outside','directory','/outside') RETURNING resource_id::text`,
        [drive, root]
      )
    ).rows[0]!.resource_id
    await grant(outsideFolder, 'user', owner, ALL, false)
    await grant(outsideFolder, 'user', outsider, ['read'], false)
    await request(app)
      .post('/shares')
      .set('x-user', owner)
      .send({
        drive,
        resourceId: outsideFolder,
        subject: { type: 'user', id: outsider },
        permissions: ['read'],
        includeDescendants: false,
      })
      .expect(200)
    for (const path of ['/grants', '/shares']) {
      const outsideHome = await request(app)
        .get(path)
        .set('x-user', owner)
        .query({ drive, resourceId: outsideFolder })
        .expect(200)
      expect(outsideHome.body.items.length).toBeGreaterThan(0)
      expect(
        outsideHome.body.items.every((item: object) => !Object.hasOwn(item, 'subjectProfile'))
      ).toBe(true)
    }
    const before = (
      await database.pool.query<{ sequence_no: string }>(
        'SELECT COALESCE(max(sequence_no),0)::text AS sequence_no FROM gfs_audit'
      )
    ).rows[0]!.sequence_no
    await request(app)
      .post('/shares')
      .set('x-user', owner)
      .send({
        drive,
        resourceId: folder,
        subject: { type: 'user', id: outsider },
        permissions: ['read', 'share'],
        includeDescendants: true,
      })
      .expect(200)
    expect(
      (
        await database.pool.query(
          `SELECT permissions, include_descendants, created_by, introduced_by FROM gfs_shares WHERE resource_id=$1 AND subject_id=$2`,
          [folder, outsider]
        )
      ).rows
    ).toEqual([
      {
        permissions: ['read', 'share'],
        include_descendants: true,
        created_by: `user:${owner}`,
        introduced_by: `user:${manager}`,
      },
    ])
    expect(
      (
        await database.pool.query(
          `SELECT outcome, desktop_user_id::text, authority_source FROM gfs_audit WHERE sequence_no > $1 AND subject=$2 AND op LIKE 'share.create%'`,
          [before, `user:${outsider}`]
        )
      ).rows
    ).toEqual([{ outcome: 'allowed', desktop_user_id: owner, authority_source: 'user-session' }])
    // A second rewrite must not move the introducer to the first rewriter.
    await request(app)
      .post('/shares')
      .set('x-user', owner)
      .send({
        drive,
        resourceId: folder,
        subject: { type: 'user', id: outsider },
        permissions: ['read'],
        includeDescendants: false,
      })
      .expect(200)
    expect(
      (
        await database.pool.query(
          `SELECT permissions, include_descendants, created_by, introduced_by FROM gfs_shares WHERE resource_id=$1 AND subject_id=$2`,
          [folder, outsider]
        )
      ).rows
    ).toEqual([
      {
        permissions: ['read'],
        include_descendants: false,
        created_by: `user:${owner}`,
        introduced_by: `user:${manager}`,
      },
    ])
    // D26 keeps the outsider identified after both lowerings. On `/grants` the
    // outsider row carries no author, so only the manager's share for the same
    // subject on the same resource makes it visible.
    for (const path of ['/grants', '/shares']) {
      const lowered = await request(app)
        .get(path)
        .set('x-user', owner)
        .query({ drive, resourceId: folder })
        .expect(200)
      expect(lowered.body.items.length).toBeGreaterThan(0)
      const outsiderRow = lowered.body.items.find(
        (item: { subject: { id: string } }) => item.subject.id === outsider
      )
      expect(outsiderRow.subjectProfile).toEqual({
        name: 'Outside Team',
        email: `${outsider}@example.test`,
      })
    }
  })

  it('does not reveal a stranger the owner granted by UUID, and still profiles a teammate', async () => {
    const teammate = await createUser(database.pool, 'Owner Teammate')
    const exTeammate = await createUser(database.pool, 'Former Teammate')
    const stranger = await createUser(database.pool, 'Stranger')
    const vouched = await createUser(database.pool, 'Vouched Person')
    const ownerTeam = randomUUID()
    const exOwnerTeam = randomUUID()
    const foreignTeam = randomUUID()
    const vouchedTeam = randomUUID()
    await database.pool.query(
      'INSERT INTO teams (id,name) VALUES ($1,$2),($3,$4),($5,$6),($7,$8)',
      [
        ownerTeam,
        'Owner team',
        exOwnerTeam,
        'Former owner team',
        foreignTeam,
        'Foreign team',
        vouchedTeam,
        'Vouched team',
      ]
    )
    for (const [member, status] of [
      [owner, 'active'],
      [teammate, 'active'],
      [exTeammate, 'deleted'],
    ] as const) {
      await database.pool.query(
        'INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,$3,$4)',
        [ownerTeam, member, 'member', status]
      )
    }
    // The owner left this team, so it must not count as one of the caller's.
    await database.pool.query(
      "INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,'member','deleted')",
      [exOwnerTeam, owner]
    )
    await database.pool.query(
      "INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,'member','active')",
      [foreignTeam, stranger]
    )
    // Caller-team branch: these rows carry no author and no introducer.
    await grant(home, 'user', teammate, ['read'], false)
    await grant(home, 'team', ownerTeam, ['read'], false)
    await grant(home, 'user', exTeammate, ['read'], false)
    await grant(home, 'team', exOwnerTeam, ['read'], false)
    // The owner writes the stranger and foreign-team entries through the API
    // with UUIDs the Desktop directory would never offer for them.
    for (const subject of [
      { type: 'user', id: stranger },
      { type: 'team', id: foreignTeam },
    ]) {
      await request(app)
        .put('/grants')
        .set('x-user', owner)
        .send({ drive, resourceId: home, subject, permissions: ['read'], inherit: false })
        .expect(200)
    }
    // W1 INSERT: the owner is the author and the introducer at creation.
    expect(
      (
        await database.pool.query(
          `SELECT granted_by, introduced_by FROM gfs_grants
            WHERE drive = $1 AND resource_id = $2 AND subject_id = $3`,
          [drive, home, stranger]
        )
      ).rows
    ).toEqual([{ granted_by: `user:${owner}`, introduced_by: `user:${owner}` }])
    for (const subject of [
      { type: 'user', id: vouched },
      { type: 'team', id: vouchedTeam },
    ]) {
      await request(app)
        .put('/grants')
        .set('x-operator', 'yes')
        .send({ drive, resourceId: home, subject, permissions: ['read'], inherit: false })
        .expect(200)
    }
    expect(
      (
        await database.pool.query(
          `SELECT subject_type, subject_id, introduced_by FROM gfs_grants
            WHERE drive = $1 AND resource_id = $2 AND introduced_by = 'operator:'
            ORDER BY subject_id`,
          [drive, home]
        )
      ).rows
    ).toHaveLength(2)
    // The introducer set is scoped to the listed resource: a trusted entry for
    // the stranger elsewhere on the drive must not identify it inside the home.
    const outsideFolder = (
      await database.pool.query<{ resource_id: string }>(
        `INSERT INTO gfs_resources (drive,parent_resource_id,name,kind,path_cache)
         VALUES ($1,$2,'outside-stranger','directory','/outside-stranger')
         RETURNING resource_id::text`,
        [drive, root]
      )
    ).rows[0]!.resource_id
    await request(app)
      .put('/grants')
      .set('x-operator', 'yes')
      .send({
        drive,
        resourceId: outsideFolder,
        subject: { type: 'user', id: stranger },
        permissions: ['read'],
        inherit: false,
      })
      .expect(200)
    expect(
      (
        await database.pool.query(
          `SELECT introduced_by FROM gfs_grants WHERE resource_id = $1 AND subject_id = $2`,
          [outsideFolder, stranger]
        )
      ).rows
    ).toEqual([{ introduced_by: 'operator:' }])
    const listed = await request(app)
      .get('/grants')
      .set('x-user', owner)
      .query({ drive, resourceId: home })
      .expect(200)
    const row = (id: string) =>
      listed.body.items.find((item: { subject: { id?: string } }) => item.subject.id === id)
    expect(listed.body.items).toHaveLength(9)
    expect(row(teammate).subjectProfile).toEqual({
      name: 'Owner Teammate',
      email: `${teammate}@example.test`,
    })
    expect(row(ownerTeam).subjectProfile).toEqual({ name: 'Owner team' })
    expect(row(vouched).subjectProfile).toEqual({
      name: 'Vouched Person',
      email: `${vouched}@example.test`,
    })
    expect(row(vouchedTeam).subjectProfile).toEqual({ name: 'Vouched team' })
    for (const hidden of [stranger, foreignTeam, exTeammate, exOwnerTeam]) {
      expect(row(hidden)).toBeDefined()
      expect(row(hidden)).not.toHaveProperty('subjectProfile')
    }
    // No laundering: an operator rewrite after the owner's rewrite keeps the
    // owner as the introducer, so the stranger stays unidentified.
    await request(app)
      .put('/grants')
      .set('x-user', owner)
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: stranger },
        permissions: ['read', 'write'],
        inherit: false,
      })
      .expect(200)
    await request(app)
      .put('/grants')
      .set('x-operator', 'yes')
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: stranger },
        permissions: ['read'],
        inherit: false,
      })
      .expect(200)
    expect(
      (
        await database.pool.query(
          `SELECT granted_by, introduced_by FROM gfs_grants
            WHERE drive = $1 AND resource_id = $2 AND subject_id = $3`,
          [drive, home, stranger]
        )
      ).rows
    ).toEqual([{ granted_by: 'operator:', introduced_by: `user:${owner}` }])
    const afterLaundering = await request(app)
      .get('/grants')
      .set('x-user', owner)
      .query({ drive, resourceId: home })
      .expect(200)
    const laundered = afterLaundering.body.items.find(
      (item: { subject: { id?: string } }) => item.subject.id === stranger
    )
    expect(laundered).toBeDefined()
    expect(laundered).not.toHaveProperty('subjectProfile')
    // Witness: a trusted subject is still profiled in the same response.
    expect(
      afterLaundering.body.items.find(
        (item: { subject: { id?: string } }) => item.subject.id === vouched
      ).subjectProfile
    ).toEqual({ name: 'Vouched Person', email: `${vouched}@example.test` })
  })

  it('does not reveal a stranger the owner shared a folder with by UUID, and still profiles a teammate', async () => {
    const teammate = await createUser(database.pool, 'Share Teammate')
    const stranger = await createUser(database.pool, 'Share Stranger')
    const team = randomUUID()
    await database.pool.query('INSERT INTO teams (id,name) VALUES ($1,$2)', [team, 'Share team'])
    for (const member of [owner, teammate]) {
      await database.pool.query(
        "INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,'member','active')",
        [team, member]
      )
    }
    const folder = (
      await database.pool.query<{ resource_id: string }>(
        `INSERT INTO gfs_resources (drive,parent_resource_id,name,kind,path_cache)
         VALUES ($1,$2,'share-folder','directory','/share-folder') RETURNING resource_id::text`,
        [drive, home]
      )
    ).rows[0]!.resource_id
    // The owner writes both shares by UUID. The stranger's share is the only
    // entry for that subject on this resource, so no other entry can vouch for it.
    for (const subject of [
      { type: 'user', id: stranger },
      { type: 'user', id: teammate },
    ]) {
      await request(app)
        .post('/shares')
        .set('x-user', owner)
        .send({
          drive,
          resourceId: folder,
          subject,
          permissions: ['read'],
          includeDescendants: false,
        })
        .expect(200)
    }
    // W2 INSERT: the owner is the author and the introducer of both shares.
    const createdShares = await database.pool.query<{
      subject_id: string
      created_by: string | null
      introduced_by: string | null
    }>(
      `SELECT subject_id, created_by, introduced_by FROM gfs_shares WHERE drive = $1 AND resource_id = $2`,
      [drive, folder]
    )
    expect(createdShares.rows).toHaveLength(2)
    expect(createdShares.rows.map(row => row.subject_id).sort()).toEqual(
      [stranger, teammate].sort()
    )
    expect(createdShares.rows.map(row => [row.created_by, row.introduced_by])).toEqual([
      [`user:${owner}`, `user:${owner}`],
      [`user:${owner}`, `user:${owner}`],
    ])
    const listed = await request(app)
      .get('/shares')
      .set('x-user', owner)
      .query({ drive, resourceId: folder })
      .expect(200)
    expect(listed.body.items).toHaveLength(2)
    const row = (id: string) =>
      listed.body.items.find((item: { subject: { id?: string } }) => item.subject.id === id)
    // Positive witness in the same response: the teammate shares an active team
    // with the owner, so the caller-team branch still identifies that subject.
    expect(row(teammate).subjectProfile).toEqual({
      name: 'Share Teammate',
      email: `${teammate}@example.test`,
    })
    expect(row(stranger)).toBeDefined()
    expect(row(stranger)).not.toHaveProperty('subjectProfile')
  })

  it('keeps the identity of a grant a co-manager introduced after the owner changes its role', async () => {
    const manager = await createUser(database.pool, 'Manager')
    const peer = await createUser(database.pool, 'Peer')
    const peerTeam = randomUUID()
    await database.pool.query('INSERT INTO teams (id,name) VALUES ($1,$2)', [peerTeam, 'Peer team'])
    for (const member of [manager, peer]) {
      await database.pool.query(
        "INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,'member','active')",
        [peerTeam, member]
      )
    }
    await grant(home, 'user', manager, ALL, true)
    await request(app)
      .put('/grants')
      .set('x-user', manager)
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: peer },
        permissions: ['read'],
        inherit: false,
      })
      .expect(200)
    // W1 INSERT: the manager is the author and the introducer at creation.
    expect(
      (
        await database.pool.query(
          `SELECT granted_by, introduced_by FROM gfs_grants WHERE resource_id=$1 AND subject_id=$2`,
          [home, peer]
        )
      ).rows
    ).toEqual([{ granted_by: `user:${manager}`, introduced_by: `user:${manager}` }])
    const listedPeer = async () => {
      const listed = await request(app)
        .get('/grants')
        .set('x-user', owner)
        .query({ drive, resourceId: home })
        .expect(200)
      const peerRow = listed.body.items.find(
        (item: { subject: { id?: string } }) => item.subject.id === peer
      )
      expect(peerRow).toBeDefined()
      return peerRow
    }
    expect((await listedPeer()).subjectProfile).toEqual({
      name: 'Peer',
      email: `${peer}@example.test`,
    })
    // C3: the owner changes the role. The author changes, the introducer does not.
    await request(app)
      .put('/grants')
      .set('x-user', owner)
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: peer },
        permissions: ['read', 'write'],
        inherit: false,
      })
      .expect(200)
    expect(
      (
        await database.pool.query(
          `SELECT granted_by, introduced_by FROM gfs_grants WHERE resource_id=$1 AND subject_id=$2`,
          [home, peer]
        )
      ).rows
    ).toEqual([{ granted_by: `user:${owner}`, introduced_by: `user:${manager}` }])
    expect((await listedPeer()).subjectProfile).toEqual({
      name: 'Peer',
      email: `${peer}@example.test`,
    })
    // A second rewrite must not move the introducer to the first rewriter.
    await request(app)
      .put('/grants')
      .set('x-user', owner)
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: peer },
        permissions: ['read'],
        inherit: false,
      })
      .expect(200)
    expect(
      (
        await database.pool.query(
          `SELECT granted_by, introduced_by FROM gfs_grants WHERE resource_id=$1 AND subject_id=$2`,
          [home, peer]
        )
      ).rows
    ).toEqual([{ granted_by: `user:${owner}`, introduced_by: `user:${manager}` }])
    expect((await listedPeer()).subjectProfile).toEqual({
      name: 'Peer',
      email: `${peer}@example.test`,
    })
  })

  it('drops a profile when the introducing manager or the subject left the shared team', async () => {
    const manager = await createUser(database.pool, 'Introducing Manager')
    const keptPeer = await createUser(database.pool, 'Kept Peer')
    const subjectLeft = await createUser(database.pool, 'Subject Left Team')
    const introducerLeft = await createUser(database.pool, 'Introducer Left Team')
    const keptTeam = randomUUID()
    const subjectLeftTeam = randomUUID()
    const introducerLeftTeam = randomUUID()
    const keptTeamSubject = randomUUID()
    const introducerLeftTeamSubject = randomUUID()
    await database.pool.query(
      `INSERT INTO teams (id,name) VALUES ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10)`,
      [
        keptTeam,
        'Kept peer team',
        subjectLeftTeam,
        'Subject left team',
        introducerLeftTeam,
        'Introducer left team',
        keptTeamSubject,
        'Kept subject team',
        introducerLeftTeamSubject,
        'Introducer left subject team',
      ]
    )
    // The owner is in none of these teams. Each user pair shares exactly one
    // team, so only the predicate named in each case can identify the subject.
    for (const [team, member, status] of [
      [keptTeam, manager, 'active'],
      [keptTeam, keptPeer, 'active'],
      [subjectLeftTeam, manager, 'active'],
      [subjectLeftTeam, subjectLeft, 'deleted'],
      [introducerLeftTeam, manager, 'deleted'],
      [introducerLeftTeam, introducerLeft, 'active'],
      [keptTeamSubject, manager, 'active'],
      [introducerLeftTeamSubject, manager, 'deleted'],
    ] as const) {
      await database.pool.query(
        'INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,$3,$4)',
        [team, member, 'member', status]
      )
    }
    // The manager manages the owner's home and introduces every subject below.
    await grant(home, 'user', manager, ALL, true)
    for (const subject of [
      { type: 'user', id: keptPeer },
      { type: 'user', id: subjectLeft },
      { type: 'user', id: introducerLeft },
      { type: 'team', id: keptTeamSubject },
      { type: 'team', id: introducerLeftTeamSubject },
    ]) {
      await request(app)
        .put('/grants')
        .set('x-user', manager)
        .send({ drive, resourceId: home, subject, permissions: ['read'], inherit: false })
        .expect(200)
    }
    // W1 INSERT: the manager is the recorded introducer of all five entries.
    const recorded = await database.pool.query<{
      subject_id: string
      granted_by: string
      introduced_by: string
    }>(
      `SELECT subject_id, granted_by, introduced_by FROM gfs_grants
        WHERE drive = $1 AND resource_id = $2 AND introduced_by = $3`,
      [drive, home, `user:${manager}`]
    )
    expect(recorded.rows.map(row => row.subject_id).sort()).toEqual(
      [keptPeer, subjectLeft, introducerLeft, keptTeamSubject, introducerLeftTeamSubject].sort()
    )
    expect(recorded.rows.every(row => row.granted_by === `user:${manager}`)).toBe(true)
    const listed = await request(app)
      .get('/grants')
      .set('x-user', owner)
      .query({ drive, resourceId: home })
      .expect(200)
    // positive owner row, the manager's own authorless row, and five entries above
    expect(listed.body.items).toHaveLength(7)
    const row = (id: string) =>
      listed.body.items.find((item: { subject: { id?: string } }) => item.subject.id === id)
    // Positive witnesses in the same response: the still-active common team keeps
    // both the peer's profile and the team name.
    expect(row(keptPeer).subjectProfile).toEqual({
      name: 'Kept Peer',
      email: `${keptPeer}@example.test`,
    })
    expect(row(keptTeamSubject).subjectProfile).toEqual({ name: 'Kept subject team' })
    // Subject-side deletion, introducer-side deletion, and a deleted introducer
    // on the team branch each hide only their own row.
    for (const hidden of [subjectLeft, introducerLeft, introducerLeftTeamSubject]) {
      expect(row(hidden)).toBeDefined()
      expect(row(hidden)).not.toHaveProperty('subjectProfile')
    }
  })

  it('treats an entry created before the introducer column as introduced by its recorded author and freezes it on the first rewrite', async () => {
    const manager = await createUser(database.pool, 'Legacy Manager')
    const legacyPeer = await createUser(database.pool, 'Legacy Peer')
    const legacyGrantee = await createUser(database.pool, 'Legacy Grantee')
    const legacyStranger = await createUser(database.pool, 'Legacy Stranger')
    const legacyTeam = randomUUID()
    await database.pool.query('INSERT INTO teams (id,name) VALUES ($1,$2)', [
      legacyTeam,
      'Legacy team',
    ])
    for (const member of [manager, legacyPeer, legacyGrantee]) {
      await database.pool.query(
        "INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,'member','active')",
        [legacyTeam, member]
      )
    }
    const folder = (
      await database.pool.query<{ resource_id: string }>(
        `INSERT INTO gfs_resources (drive,parent_resource_id,name,kind,path_cache)
         VALUES ($1,$2,'legacy','directory','/legacy') RETURNING resource_id::text`,
        [drive, home]
      )
    ).rows[0]!.resource_id
    // Pre-0132 rows: no `introduced_by`, only the recorded author.
    await database.pool.query(
      `INSERT INTO gfs_shares (drive, resource_id, subject_type, subject_id, permissions, include_descendants, created_by)
       VALUES ($1,$2,'user',$3,$4::text[],false,$5),($1,$2,'user',$6,'{read}',false,$7)`,
      [
        drive,
        folder,
        legacyPeer,
        ['read', 'write'],
        `user:${manager}`,
        legacyStranger,
        `user:${owner}`,
      ]
    )
    await database.pool.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit, granted_by)
       VALUES ($1,$2,'user',$3,$4::text[],false,$5)`,
      [drive, folder, legacyGrantee, ['read'], `user:${manager}`]
    )
    const legacyRows = await database.pool.query<{ introduced_by: string | null }>(
      `SELECT introduced_by FROM gfs_shares WHERE resource_id=$1
        UNION ALL
       SELECT introduced_by FROM gfs_grants WHERE resource_id=$1`,
      [folder]
    )
    expect(legacyRows.rows).toHaveLength(3)
    expect(legacyRows.rows.map(row => row.introduced_by)).toEqual([null, null, null])
    // The recorded author is the introducer of a pre-0132 row.
    const sharesBefore = await request(app)
      .get('/shares')
      .set('x-user', owner)
      .query({ drive, resourceId: folder })
      .expect(200)
    expect(sharesBefore.body.items).toHaveLength(2)
    expect(
      sharesBefore.body.items.find(
        (item: { subject: { id?: string } }) => item.subject.id === legacyPeer
      ).subjectProfile
    ).toEqual({ name: 'Legacy Peer', email: `${legacyPeer}@example.test` })
    const hiddenBefore = sharesBefore.body.items.find(
      (item: { subject: { id?: string } }) => item.subject.id === legacyStranger
    )
    expect(hiddenBefore).toBeDefined()
    expect(hiddenBefore).not.toHaveProperty('subjectProfile')
    const grantsBefore = await request(app)
      .get('/grants')
      .set('x-user', owner)
      .query({ drive, resourceId: folder })
      .expect(200)
    expect(grantsBefore.body.items).toHaveLength(1)
    expect(grantsBefore.body.items[0].subjectProfile).toEqual({
      name: 'Legacy Grantee',
      email: `${legacyGrantee}@example.test`,
    })
    // The first rewrite stores the author the row carried before it.
    await request(app)
      .post('/shares')
      .set('x-user', owner)
      .send({
        drive,
        resourceId: folder,
        subject: { type: 'user', id: legacyPeer },
        permissions: ['read'],
        includeDescendants: false,
      })
      .expect(200)
    await request(app)
      .put('/grants')
      .set('x-user', owner)
      .send({
        drive,
        resourceId: folder,
        subject: { type: 'user', id: legacyGrantee },
        permissions: ['read', 'write'],
        inherit: false,
      })
      .expect(200)
    await request(app)
      .post('/shares')
      .set('x-operator', 'yes')
      .send({
        drive,
        resourceId: folder,
        subject: { type: 'user', id: legacyStranger },
        permissions: ['read'],
        includeDescendants: false,
      })
      .expect(200)
    expect(
      (
        await database.pool.query(
          `SELECT created_by, introduced_by FROM gfs_shares WHERE resource_id=$1 AND subject_id=$2`,
          [folder, legacyPeer]
        )
      ).rows
    ).toEqual([{ created_by: `user:${owner}`, introduced_by: `user:${manager}` }])
    expect(
      (
        await database.pool.query(
          `SELECT granted_by, introduced_by FROM gfs_grants WHERE resource_id=$1 AND subject_id=$2`,
          [folder, legacyGrantee]
        )
      ).rows
    ).toEqual([{ granted_by: `user:${owner}`, introduced_by: `user:${manager}` }])
    expect(
      (
        await database.pool.query(
          `SELECT created_by, introduced_by FROM gfs_shares WHERE resource_id=$1 AND subject_id=$2`,
          [folder, legacyStranger]
        )
      ).rows
    ).toEqual([{ created_by: 'operator:', introduced_by: `user:${owner}` }])
    const sharesAfter = await request(app)
      .get('/shares')
      .set('x-user', owner)
      .query({ drive, resourceId: folder })
      .expect(200)
    expect(sharesAfter.body.items).toHaveLength(2)
    expect(
      sharesAfter.body.items.find(
        (item: { subject: { id?: string } }) => item.subject.id === legacyPeer
      ).subjectProfile
    ).toEqual({ name: 'Legacy Peer', email: `${legacyPeer}@example.test` })
    const hiddenAfter = sharesAfter.body.items.find(
      (item: { subject: { id?: string } }) => item.subject.id === legacyStranger
    )
    expect(hiddenAfter).toBeDefined()
    expect(hiddenAfter).not.toHaveProperty('subjectProfile')
    const grantsAfter = await request(app)
      .get('/grants')
      .set('x-user', owner)
      .query({ drive, resourceId: folder })
      .expect(200)
    expect(grantsAfter.body.items).toHaveLength(1)
    expect(grantsAfter.body.items[0].subjectProfile).toEqual({
      name: 'Legacy Grantee',
      email: `${legacyGrantee}@example.test`,
    })
  })

  it('waits for the drive structure lock before deleting a share', async () => {
    const target = await createUser(database.pool, 'Revoked Target')
    const shareId = (
      await database.pool.query<{ id: string }>(
        `INSERT INTO gfs_shares (drive, resource_id, subject_type, subject_id, permissions, include_descendants, created_by)
         VALUES ($1, $2, 'user', $3, '{read}', false, 'operator:') RETURNING id::text`,
        [drive, home, target]
      )
    ).rows[0]!.id
    const blocker = await database.pool.connect()
    let pending: Promise<request.Response> | undefined
    let blocked = false
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtext('gfs:structure:' || $1)::bigint)",
        [drive]
      )
      pending = request(app)
        .delete(`/shares/${shareId}`)
        .set('x-operator', 'yes')
        .then(response => response)
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const result = await database.pool.query(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND query LIKE '%gfs:structure:%') AS blocked`
        )
        blocked = result.rows[0].blocked === true
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 20))
      }
      await blocker.query('COMMIT')
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
    expect((await pending!).status).toBe(200)
    expect(blocked).toBe(true)
    // Witness: the authorized deletion still removed the share row.
    expect(
      (await database.pool.query('SELECT id FROM gfs_shares WHERE id=$1', [shareId])).rows
    ).toHaveLength(0)
  }, 15_000)

  it('holds the drive structure lock before it waits on the share row', async () => {
    const target = await createUser(database.pool, 'Order Target')
    const shareId = (
      await database.pool.query<{ id: string }>(
        `INSERT INTO gfs_shares (drive, resource_id, subject_type, subject_id, permissions, include_descendants, created_by)
         VALUES ($1, $2, 'user', $3, '{read}', false, 'operator:') RETURNING id::text`,
        [drive, home, target]
      )
    ).rows[0]!.id
    const blocker = await database.pool.connect()
    let pending: Promise<request.Response> | undefined
    let waitingOnRow = false
    let structureFree = true
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM gfs_shares WHERE id = $1 FOR UPDATE', [shareId])
      pending = request(app)
        .delete(`/shares/${shareId}`)
        .set('x-operator', 'yes')
        .then(response => response)
      for (let attempt = 0; attempt < 100 && !waitingOnRow; attempt++) {
        const result = await database.pool.query(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND query LIKE '%FROM gfs_shares%FOR UPDATE%') AS waiting`
        )
        waitingOnRow = result.rows[0].waiting === true
        if (!waitingOnRow) await new Promise(resolve => setTimeout(resolve, 20))
      }
      // Structure lock first: while the DELETE waits on the row it already holds
      // gfs:structure:<drive>, so another session cannot take it. With the row
      // lock first, the DELETE would wait on the row without holding it.
      const check = await database.pool.query(
        "SELECT pg_try_advisory_xact_lock(hashtext('gfs:structure:' || $1)::bigint) AS available",
        [drive]
      )
      structureFree = check.rows[0].available === true
      await blocker.query('COMMIT')
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
    expect(waitingOnRow).toBe(true)
    expect(structureFree).toBe(false)
    expect((await pending!).status).toBe(200)
    // Witness: the DELETE completed once the row lock was released.
    expect(
      (await database.pool.query('SELECT id FROM gfs_shares WHERE id=$1', [shareId])).rows
    ).toHaveLength(0)
  }, 15_000)

  it('rejects a non-operator owner grant that drops inherit and leaves the row unchanged', async () => {
    const manager = await createUser(database.pool, 'Manager')
    await grant(home, 'user', manager, ALL, true)
    const ownerRow = () =>
      database.pool.query(
        `SELECT permissions, inherit FROM gfs_grants
          WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
        [home, owner]
      )
    const before = (await ownerRow()).rows
    expect(before).toHaveLength(1)
    await request(app)
      .put('/grants')
      .set('x-user', manager)
      .send({
        drive,
        resourceId: home,
        subject: { type: 'user', id: owner },
        permissions: ALL,
        inherit: false,
      })
      .expect(403)
      .expect(({ body }) => expect(body.error).toBe('home_owner_grant_protected'))
    // Witness: the protected row is readable after the refusal and unchanged.
    expect((await ownerRow()).rows).toEqual(before)
  })

  it('rejects a bulk owner grant PUT with an uppercase owner id and writes no other subject', async () => {
    const manager = await createUser(database.pool, 'Manager')
    const other = await createUser(database.pool, 'Other')
    await grant(home, 'user', manager, ALL, true)
    const otherRows = async () =>
      (
        await database.pool.query(
          `SELECT id::text FROM gfs_grants
            WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
          [home, other]
        )
      ).rows
    // Witness: the second subject has no pre-request entry to lose.
    expect(await otherRows()).toHaveLength(0)
    // Witness: the same query shape returns a row for a subject that has one.
    expect(
      (
        await database.pool.query(
          `SELECT id::text FROM gfs_grants
            WHERE resource_id=$1 AND subject_type='user' AND subject_id=$2`,
          [home, manager]
        )
      ).rows
    ).toHaveLength(1)
    await request(app)
      .put('/grants')
      .set('x-user', manager)
      .send({
        drive,
        resourceId: home,
        subjects: [
          { type: 'user', id: owner.toUpperCase() },
          { type: 'user', id: other },
        ],
        permissions: ['read'],
        inherit: true,
      })
      .expect(403)
      .expect(({ body }) => expect(body.error).toBe('home_owner_grant_protected'))
    expect(await otherRows()).toHaveLength(0)
  })
})
