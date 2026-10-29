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
    const manager = await createUser(database.pool, 'Manager')
    const outsider = await createUser(database.pool, 'Outside Team')
    const team = randomUUID()
    await database.pool.query('INSERT INTO teams (id,name) VALUES ($1,$2)', [team, 'Visible team'])
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
          `SELECT permissions, include_descendants, created_by FROM gfs_shares WHERE resource_id=$1 AND subject_id=$2`,
          [folder, outsider]
        )
      ).rows
    ).toEqual([
      { permissions: ['read', 'share'], include_descendants: true, created_by: `user:${owner}` },
    ])
    expect(
      (
        await database.pool.query(
          `SELECT outcome, desktop_user_id::text, authority_source FROM gfs_audit WHERE sequence_no > $1 AND subject=$2 AND op LIKE 'share.create%'`,
          [before, `user:${outsider}`]
        )
      ).rows
    ).toEqual([{ outcome: 'allowed', desktop_user_id: owner, authority_source: 'user-session' }])
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
