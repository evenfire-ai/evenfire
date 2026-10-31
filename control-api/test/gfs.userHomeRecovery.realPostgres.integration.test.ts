import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import request from 'supertest'
import { initDb } from '../src/db.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const runtime = vi.hoisted(() => ({ pool: undefined as import('pg').Pool | undefined }))
vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  return {
    ...actual,
    pool: {
      query: (...args: Parameters<import('pg').Pool['query']>) => runtime.pool!.query(...args),
    },
    withTransaction: ((work, dbPool, options) =>
      actual.withTransaction(
        work,
        dbPool ?? runtime.pool!,
        options
      )) as typeof actual.withTransaction,
  }
})
vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (req.header('x-test-operator') !== 'yes')
      return res.status(401).json({ error: 'Unauthorized' })
    ;(req as express.Request & { adminAuth: { sub: string } }).adminAuth = { sub: 'operator-test' }
    next()
  },
}))
vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

type Fixture = {
  userId: string
  resourceId: string
  drive: string
  rootId: string
  usersId: string
}

describeRealPostgres('GFS user home recovery on real PostgreSQL', () => {
  const database = `gfs_home_recovery_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let fixturePool: Pool
  let app: express.Express
  let databaseCreated = false

  beforeAll(async () => {
    if (!adminUrl) throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required')
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    databaseCreated = true
    const url = new URL(adminUrl)
    url.pathname = `/${database}`
    fixturePool = new Pool({ connectionString: url.toString(), statement_timeout: 10_000 })
    await initDb({ connect: () => fixturePool.connect() })
    runtime.pool = new Pool({
      connectionString: url.toString(),
      options: '-c role=control_api_runtime',
    })
    const identity = await runtime.pool.query('SELECT current_user')
    expect(identity.rows[0].current_user).toBe('control_api_runtime')
    const { registerGfsUserHomeRoutes } = await import('../src/routes/gfs/userHomes.js')
    const router = express.Router()
    registerGfsUserHomeRoutes(router)
    app = express()
    app.use(express.json())
    app.use(router)
    app.use(
      (
        _error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
      ) => {
        res.status(500).json({ error: 'internal_error' })
      }
    )
  }, 60_000)

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(runtime.pool)
      await endPoolAndWaitForClients(fixturePool)
      if (adminPool && databaseCreated) {
        await adminPool.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [database]
        )
        await adminPool.query(`DROP DATABASE ${quoteIdent(database)}`)
      }
    } finally {
      await adminPool?.end()
    }
  }, 60_000)

  async function seedHome(
    kind: 'missing' | 'narrowed' | 'no-inherit' = 'missing',
    userId = randomUUID()
  ): Promise<Fixture> {
    const root = randomUUID()
    const users = randomUUID()
    const resourceId = randomUUID()
    const drive = `home-${randomUUID()}`
    await fixturePool.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)', [
      userId,
      `${userId}@example.test`,
      'Owner',
    ])
    await fixturePool.query(
      `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
       VALUES ($1, $4, NULL, '', 'directory', '/'),
              ($2, $4, $1, 'Users', 'directory', '/Users'),
              ($3, $4, $2, 'owner', 'directory', '/Users/owner')`,
      [root, users, resourceId, drive]
    )
    await fixturePool.query(
      `UPDATE gfs_user_homes SET drive = $2, storage_username = 'owner', resource_id = $3,
              state = 'conflict', conflict_code = 'ownership_conflict', conflict_detail = $4::jsonb
        WHERE user_id = $1`,
      [userId, drive, resourceId, JSON.stringify({ resourceIds: [resourceId] })]
    )
    if (kind !== 'missing') {
      await fixturePool.query(
        `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit, granted_by)
         VALUES ($1, $2, 'user', $3, $4::text[], $5, 'operator')`,
        [
          drive,
          resourceId,
          userId,
          kind === 'narrowed' ? ['read'] : ['read', 'write', 'delete', 'share', 'manage_acl'],
          kind !== 'no-inherit',
        ]
      )
    }
    return { userId, resourceId, drive, rootId: root, usersId: users }
  }

  function restore(fixture: Fixture) {
    return request(app)
      .post(`/gfs/user-homes/${fixture.userId}/restore-owner`)
      .set('x-test-operator', 'yes')
  }

  function retry(userId: string, storageUsername?: string) {
    const call = request(app).post(`/gfs/user-homes/${userId}/retry`).set('x-test-operator', 'yes')
    return storageUsername === undefined ? call : call.send({ storageUsername })
  }

  async function addUnboundConflict(
    fixture: Fixture,
    name: string,
    code: 'path_conflict' | 'ancestor_grant_conflict' = 'path_conflict'
  ): Promise<string> {
    const userId = randomUUID()
    await fixturePool.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)', [
      userId,
      `${userId}@example.test`,
      'Retry Owner',
    ])
    await fixturePool.query(
      `UPDATE gfs_user_homes SET drive = $2, storage_username = $3, state = 'conflict',
              conflict_code = $4, conflict_detail = $5::jsonb
        WHERE user_id = $1`,
      [userId, fixture.drive, name, code, JSON.stringify({ resourceIds: [fixture.resourceId] })]
    )
    return userId
  }

  it('restores the lowercase owner grant for an uppercase route id', async () => {
    const fixture = await seedHome('missing', 'abcdefab-cdef-4abc-8abc-abcdefabcdef')
    const response = await request(app)
      .post(`/gfs/user-homes/${fixture.userId.toUpperCase()}/restore-owner`)
      .set('x-test-operator', 'yes')
    expect(response.status).toBe(200)
    expect(response.body.home).toMatchObject({ userId: fixture.userId, state: 'ready' })
    const rows = await fixturePool.query(
      `SELECT subject_id, permissions, inherit FROM gfs_grants
        WHERE drive = $1 AND resource_id = $2 AND subject_type = 'user'`,
      [fixture.drive, fixture.resourceId]
    )
    expect(rows.rows).toEqual([
      {
        subject_id: fixture.userId,
        permissions: ['read', 'write', 'delete', 'share', 'manage_acl'],
        inherit: true,
      },
    ])
  })

  it.each(['missing', 'narrowed', 'no-inherit'] as const)(
    'restores a %s owner grant atomically and rejects a second restore',
    async kind => {
      const fixture = await seedHome(kind)
      const detail = await request(app)
        .get(`/gfs/user-homes/${fixture.userId}`)
        .set('x-test-operator', 'yes')
      expect(detail.status).toBe(200)
      expect(detail.body.home.conflictDetail).toEqual({
        code: 'ownership_conflict',
        ownerGrant:
          kind === 'missing'
            ? null
            : {
                permissions:
                  kind === 'narrowed'
                    ? ['read']
                    : ['read', 'write', 'delete', 'share', 'manage_acl'],
                inherit: kind !== 'no-inherit',
              },
      })
      const response = await restore(fixture)
      expect(response.status).toBe(200)
      expect(response.body.home).toMatchObject({
        userId: fixture.userId,
        drive: fixture.drive,
        path: '/Users/owner',
        state: 'ready',
        conflictCode: null,
      })
      const grant = await fixturePool.query(
        `SELECT permissions, inherit, granted_by FROM gfs_grants
          WHERE drive = $1 AND resource_id = $2 AND subject_type = 'user' AND subject_id = $3`,
        [fixture.drive, fixture.resourceId, fixture.userId]
      )
      expect(grant.rowCount).toBe(1)
      expect(grant.rows[0].permissions.sort()).toEqual([
        'delete',
        'manage_acl',
        'read',
        'share',
        'write',
      ])
      expect(grant.rows[0]).toMatchObject({ inherit: true, granted_by: 'platform:user-home' })
      const persisted = await fixturePool.query(
        'SELECT state, conflict_code, conflict_detail FROM gfs_user_homes WHERE user_id = $1',
        [fixture.userId]
      )
      expect(persisted.rows[0]).toEqual({
        state: 'ready',
        conflict_code: null,
        conflict_detail: null,
      })
      const audit = await fixturePool.query(
        'SELECT op, actor_on_behalf_of, gfs_uri FROM gfs_audit WHERE subject = $1 ORDER BY sequence_no',
        [`user:${fixture.userId}`]
      )
      expect(audit.rows).toEqual([
        {
          op: 'user_home.conflict_cleared.ownership_conflict',
          actor_on_behalf_of: 'operator-test',
          gfs_uri: `gfs://${fixture.drive}/${fixture.resourceId}`,
        },
        {
          op: 'user_home.restore_owner',
          actor_on_behalf_of: 'operator-test',
          gfs_uri: `gfs://${fixture.drive}/${fixture.resourceId}`,
        },
      ])
      const second = await restore(fixture)
      expect(second.status).toBe(409)
      expect(second.body).toEqual({ error: 'home_not_in_ownership_conflict' })
    }
  )

  it('serializes concurrent restores without a deadlock or duplicate audit', async () => {
    const fixture = await seedHome('narrowed')
    const responses = await Promise.all([restore(fixture), restore(fixture)])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    expect(responses.find(response => response.status === 409)?.body).toEqual({
      error: 'home_not_in_ownership_conflict',
    })
    const result = await fixturePool.query(
      'SELECT count(*)::int AS count FROM gfs_audit WHERE subject = $1',
      [`user:${fixture.userId}`]
    )
    expect(result.rows[0].count).toBe(2)
  })

  it('resolves path conflicts and live access, then reports a removed resource as absent', async () => {
    const fixture = await seedHome('narrowed')
    const teamId = randomUUID()
    await fixturePool.query('INSERT INTO teams (id, name) VALUES ($1, $2)', [teamId, 'Review team'])
    await fixturePool.query(
      `INSERT INTO gfs_shares (drive, resource_id, subject_type, subject_id, permissions, include_descendants)
       VALUES ($1, $2, 'team', $3, ARRAY['read'], true)`,
      [fixture.drive, fixture.resourceId, teamId]
    )
    await fixturePool.query(
      `UPDATE gfs_user_homes SET resource_id = NULL, conflict_code = 'path_conflict', conflict_detail = $2::jsonb WHERE user_id = $1`,
      [fixture.userId, JSON.stringify({ resourceIds: [fixture.resourceId] })]
    )
    const get = () =>
      request(app).get(`/gfs/user-homes/${fixture.userId}`).set('x-test-operator', 'yes')
    const present = await get()
    expect(present.status).toBe(200)
    expect(present.body.home.conflictDetail).toEqual({
      code: 'path_conflict',
      resource: {
        resourceId: fixture.resourceId,
        path: '/Users/owner',
        kind: 'directory',
        createdAt: expect.any(String),
      },
      access: [
        {
          relation: 'grant',
          subjectType: 'user',
          subjectId: fixture.userId,
          subjectLabel: 'Owner',
          permissions: ['read'],
          inherit: true,
        },
        {
          relation: 'share',
          subjectType: 'team',
          subjectId: teamId,
          subjectLabel: 'Review team',
          permissions: ['read'],
          inherit: true,
        },
      ],
    })
    await fixturePool.query('DELETE FROM gfs_grants WHERE resource_id = $1', [fixture.resourceId])
    await fixturePool.query('DELETE FROM gfs_shares WHERE resource_id = $1', [fixture.resourceId])
    await fixturePool.query('DELETE FROM gfs_resources WHERE resource_id = $1', [
      fixture.resourceId,
    ])
    const removed = await get()
    expect(removed.status).toBe(200)
    expect(removed.body.home.conflictDetail).toEqual({
      code: 'path_conflict',
      resource: null,
      access: [],
    })
  })

  it('resolves current ancestor conflicts and stops showing a share after inheritance is removed', async () => {
    const fixture = await seedHome()
    const teamId = randomUUID()
    await fixturePool.query('INSERT INTO teams (id, name) VALUES ($1, $2)', [
      teamId,
      'Ancestor team',
    ])
    const grant = await fixturePool.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ($1, $2, 'user', $3, ARRAY['read'], true) RETURNING id`,
      [fixture.drive, fixture.usersId, fixture.userId]
    )
    const share = await fixturePool.query(
      `INSERT INTO gfs_shares (drive, resource_id, subject_type, subject_id, permissions, include_descendants)
       VALUES ($1, $2, 'team', $3, ARRAY['read'], true) RETURNING id`,
      [fixture.drive, fixture.usersId, teamId]
    )
    await fixturePool.query(
      `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit)
       VALUES ($1, $2, 'host', '1st:mcp-host/agent', ARRAY['read'], true)`,
      [fixture.drive, fixture.usersId]
    )
    await fixturePool.query(
      `UPDATE gfs_user_homes SET conflict_code = 'ancestor_grant_conflict', conflict_detail = $2::jsonb WHERE user_id = $1`,
      [
        fixture.userId,
        JSON.stringify({
          resourceIds: [fixture.usersId],
          grantIds: [grant.rows[0].id],
          shareIds: [share.rows[0].id],
        }),
      ]
    )
    const get = () =>
      request(app).get(`/gfs/user-homes/${fixture.userId}`).set('x-test-operator', 'yes')
    const initial = await get()
    expect(initial.status).toBe(200)
    expect(initial.body.home.conflictDetail).toEqual({
      code: 'ancestor_grant_conflict',
      entries: [
        {
          relation: 'grant',
          resourceId: fixture.usersId,
          path: '/Users',
          subjectType: 'user',
          subjectId: fixture.userId,
          subjectLabel: 'Owner',
          permissions: ['read'],
          inherit: true,
        },
        {
          relation: 'share',
          resourceId: fixture.usersId,
          path: '/Users',
          subjectType: 'team',
          subjectId: teamId,
          subjectLabel: 'Ancestor team',
          permissions: ['read'],
          inherit: true,
        },
      ],
    })
    await fixturePool.query('UPDATE gfs_shares SET include_descendants = false WHERE id = $1', [
      share.rows[0].id,
    ])
    const changed = await get()
    expect(changed.status).toBe(200)
    expect(changed.body.home.conflictDetail.entries).toHaveLength(1)
    expect(changed.body.home.conflictDetail.entries[0].relation).toBe('grant')
    await fixturePool.query(
      'UPDATE gfs_user_homes SET conflict_detail = $2::jsonb WHERE user_id = $1',
      [fixture.userId, JSON.stringify({ resourceIds: [fixture.usersId] })]
    )
    const withoutSpecificIds = await get()
    expect(withoutSpecificIds.status).toBe(200)
    expect(withoutSpecificIds.body.home.conflictDetail.entries).toHaveLength(2)
    expect(withoutSpecificIds.body.home.conflictDetail.entries).toContainEqual(
      expect.objectContaining({
        relation: 'grant',
        subjectType: 'host',
        subjectId: '1st:mcp-host/agent',
        subjectLabel: null,
      })
    )
  })

  it('rolls back when the restored grant does not satisfy all bits, while another restore succeeds', async () => {
    const broken = await seedHome()
    const working = await seedHome()
    await fixturePool.query(`CREATE FUNCTION s4_test_narrow_grant() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.resource_id = '${broken.resourceId}'::uuid THEN NEW.permissions := ARRAY['read']; END IF;
        RETURN NEW;
      END $$`)
    await fixturePool.query(
      'CREATE TRIGGER s4_test_narrow_grant BEFORE INSERT OR UPDATE ON gfs_grants FOR EACH ROW EXECUTE FUNCTION s4_test_narrow_grant()'
    )
    expect((await restore(working)).status).toBe(200)
    expect((await restore(broken)).status).toBe(500)
    const homeRow = await fixturePool.query(
      'SELECT state, conflict_code FROM gfs_user_homes WHERE user_id = $1',
      [broken.userId]
    )
    expect(homeRow.rows[0]).toEqual({ state: 'conflict', conflict_code: 'ownership_conflict' })
    const grant = await fixturePool.query('SELECT id FROM gfs_grants WHERE resource_id = $1', [
      broken.resourceId,
    ])
    expect(grant.rowCount).toBe(0)
    const audit = await fixturePool.query('SELECT op FROM gfs_audit WHERE subject = $1', [
      `user:${broken.userId}`,
    ])
    expect(audit.rowCount).toBe(0)
  })

  it('returns retained homes after hard deletion and 404 only for a missing home', async () => {
    const fixture = await seedHome()
    await fixturePool.query(
      `UPDATE gfs_user_homes SET state = 'retired', conflict_code = NULL, conflict_detail = NULL WHERE user_id = $1`,
      [fixture.userId]
    )
    await fixturePool.query('DELETE FROM users WHERE id = $1', [fixture.userId])
    const detail = await request(app)
      .get(`/gfs/user-homes/${fixture.userId}`)
      .set('x-test-operator', 'yes')
    expect(detail.status).toBe(200)
    expect(detail.body.home).toMatchObject({
      userId: fixture.userId,
      email: null,
      name: null,
      state: 'retired',
      path: '/Users/owner',
    })
    const list = await request(app)
      .get('/gfs/user-homes?state=retired')
      .set('x-test-operator', 'yes')
    expect(list.status).toBe(200)
    expect(list.body.items).toContainEqual(
      expect.objectContaining({ userId: fixture.userId, email: null, name: null })
    )
    const missing = await request(app)
      .get(`/gfs/user-homes/${randomUUID()}`)
      .set('x-test-operator', 'yes')
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: 'home_not_found' })
  })

  it('shows an occupied bound path and retries its unchanged reservation with an audit before the next tick', async () => {
    const fixture = await seedHome('narrowed')
    const occupantId = randomUUID()
    await fixturePool.query(
      `INSERT INTO gfs_resources (resource_id, drive, parent_resource_id, name, kind, path_cache)
       VALUES ($1, $2, $3, 'reserved', 'directory', '/Users/reserved')`,
      [occupantId, fixture.drive, fixture.usersId]
    )
    await fixturePool.query(
      `UPDATE gfs_user_homes SET storage_username = 'reserved', conflict_code = 'path_conflict',
              conflict_detail = $2::jsonb, attempts = 3, last_error = 'previous_error'
        WHERE user_id = $1`,
      [fixture.userId, JSON.stringify({ resourceIds: [occupantId, fixture.resourceId] })]
    )
    await fixturePool.query(`CREATE FUNCTION s4_test_retry_audit_order() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.subject = 'user:${fixture.userId}' AND NEW.op = 'user_home.conflict_cleared.path_conflict'
           AND NOT EXISTS (SELECT 1 FROM gfs_user_homes WHERE user_id = '${fixture.userId}'::uuid
                           AND state = 'conflict' AND conflict_code = 'path_conflict'
                           AND conflict_detail IS NOT NULL) THEN
          RAISE EXCEPTION 'conflict cleared before audit';
        END IF;
        RETURN NEW;
      END $$`)
    await fixturePool.query(
      'CREATE TRIGGER s4_test_retry_audit_order BEFORE INSERT ON gfs_audit FOR EACH ROW EXECUTE FUNCTION s4_test_retry_audit_order()'
    )
    const detail = await request(app)
      .get(`/gfs/user-homes/${fixture.userId}`)
      .set('x-test-operator', 'yes')
    expect(detail.status).toBe(200)
    expect(detail.body.home).toMatchObject({
      resourceId: fixture.resourceId,
      path: '/Users/owner',
      conflictDetail: {
        code: 'path_conflict',
        resource: { resourceId: occupantId, path: '/Users/reserved' },
        access: [],
      },
    })
    const before = await fixturePool.query('SELECT * FROM gfs_user_homes WHERE user_id = $1', [
      fixture.userId,
    ])
    const beforeAudit = await fixturePool.query('SELECT * FROM gfs_audit WHERE subject = $1', [
      `user:${fixture.userId}`,
    ])
    const denied = await retry(fixture.userId, 'different')
    expect(denied.status).toBe(409)
    expect(denied.body).toEqual({ error: 'home_not_retryable' })
    expect(
      (await fixturePool.query('SELECT * FROM gfs_user_homes WHERE user_id = $1', [fixture.userId]))
        .rows
    ).toEqual(before.rows)
    expect(
      (
        await fixturePool.query('SELECT * FROM gfs_audit WHERE subject = $1', [
          `user:${fixture.userId}`,
        ])
      ).rows
    ).toEqual(beforeAudit.rows)

    const accepted = await retry(fixture.userId, 'reserved')
    expect(accepted.status).toBe(202)
    expect(accepted.body.home).toMatchObject({
      state: 'pending',
      attempts: 0,
      lastError: null,
      conflictCode: null,
      storageUsername: 'reserved',
      resourceId: fixture.resourceId,
    })
    const audit = await fixturePool.query(
      'SELECT op, actor_on_behalf_of, gfs_uri FROM gfs_audit WHERE subject = $1 ORDER BY sequence_no',
      [`user:${fixture.userId}`]
    )
    expect(audit.rows).toEqual([
      {
        op: 'user_home.conflict_cleared.path_conflict',
        actor_on_behalf_of: 'operator-test',
        gfs_uri: `gfs://${fixture.drive}/${fixture.resourceId}`,
      },
    ])
    const contender = await addUnboundConflict(fixture, 'contender-old')
    const contenderRetry = await retry(contender, 'reserved')
    expect(contenderRetry.status).toBe(202)
    expect(contenderRetry.body.home.storageUsername).toBe(
      `reserved-${contender.replace(/-/g, '').slice(0, 8)}`
    )
    const { provisionUserHome } = await import('../src/gfs/userHomeProvisioner.js')
    expect(
      await provisionUserHome(fixture.userId, { drive: fixture.drive, dbPool: fixturePool })
    ).toBe('conflict')
    const afterTick = await fixturePool.query(
      'SELECT state, conflict_code, storage_username, resource_id FROM gfs_user_homes WHERE user_id = $1',
      [fixture.userId]
    )
    expect(afterTick.rows[0]).toEqual({
      state: 'conflict',
      conflict_code: 'path_conflict',
      storage_username: 'reserved',
      resource_id: fixture.resourceId,
    })
  })

  it('preserves a bound ancestor-conflict name and accepts a retry without a name', async () => {
    const fixture = await seedHome('narrowed')
    await fixturePool.query(
      `UPDATE gfs_user_homes SET conflict_code = 'ancestor_grant_conflict', conflict_detail = $2::jsonb
        WHERE user_id = $1`,
      [fixture.userId, JSON.stringify({ resourceIds: [fixture.usersId] })]
    )
    const before = await fixturePool.query('SELECT * FROM gfs_user_homes WHERE user_id = $1', [
      fixture.userId,
    ])
    const denied = await retry(fixture.userId, 'different')
    expect(denied.status).toBe(409)
    expect(denied.body).toEqual({ error: 'home_not_retryable' })
    expect(
      (await fixturePool.query('SELECT * FROM gfs_user_homes WHERE user_id = $1', [fixture.userId]))
        .rows
    ).toEqual(before.rows)
    expect(
      (
        await fixturePool.query('SELECT op FROM gfs_audit WHERE subject = $1', [
          `user:${fixture.userId}`,
        ])
      ).rowCount
    ).toBe(0)
    const accepted = await retry(fixture.userId)
    expect(accepted.status).toBe(202)
    expect(accepted.body.home).toMatchObject({
      state: 'pending',
      storageUsername: 'owner',
      attempts: 0,
    })
    const audit = await fixturePool.query('SELECT op, gfs_uri FROM gfs_audit WHERE subject = $1', [
      `user:${fixture.userId}`,
    ])
    expect(audit.rows).toEqual([
      {
        op: 'user_home.conflict_cleared.ancestor_grant_conflict',
        gfs_uri: `gfs://${fixture.drive}/${fixture.resourceId}`,
      },
    ])
  })

  it('leaves an invalid unbound name unchanged, then retries an ancestor conflict and provisions it', async () => {
    const fixture = await seedHome()
    await fixturePool.query(
      `UPDATE gfs_user_homes SET resource_id = NULL, conflict_code = 'ancestor_grant_conflict',
              conflict_detail = $2::jsonb WHERE user_id = $1`,
      [fixture.userId, JSON.stringify({ resourceIds: [fixture.usersId] })]
    )
    const before = await fixturePool.query('SELECT * FROM gfs_user_homes WHERE user_id = $1', [
      fixture.userId,
    ])
    const denied = await retry(fixture.userId, 'users')
    expect(denied.status).toBe(422)
    expect(denied.body).toEqual({ error: 'invalid_name' })
    expect(
      (await fixturePool.query('SELECT * FROM gfs_user_homes WHERE user_id = $1', [fixture.userId]))
        .rows
    ).toEqual(before.rows)
    expect(
      (
        await fixturePool.query('SELECT op FROM gfs_audit WHERE subject = $1', [
          `user:${fixture.userId}`,
        ])
      ).rowCount
    ).toBe(0)
    const accepted = await retry(fixture.userId, 'recovered')
    expect(accepted.status).toBe(202)
    expect(accepted.body.home).toMatchObject({ state: 'pending', storageUsername: 'recovered' })
    const audit = await fixturePool.query('SELECT op, gfs_uri FROM gfs_audit WHERE subject = $1', [
      `user:${fixture.userId}`,
    ])
    expect(audit.rows).toEqual([
      { op: 'user_home.conflict_cleared.ancestor_grant_conflict', gfs_uri: null },
    ])
    const { provisionUserHome } = await import('../src/gfs/userHomeProvisioner.js')
    expect(
      await provisionUserHome(fixture.userId, { drive: fixture.drive, dbPool: fixturePool })
    ).toBe('ready')
    const home = await fixturePool.query(
      'SELECT state, storage_username, resource_id FROM gfs_user_homes WHERE user_id = $1',
      [fixture.userId]
    )
    expect(home.rows[0]).toMatchObject({
      state: 'ready',
      storage_username: 'recovered',
      resource_id: expect.any(String),
    })
    expect(home.rows[0].resource_id).not.toBe(fixture.resourceId)
  })

  it('serializes competing reservations and releases old names only for unbound homes', async () => {
    const fixture = await seedHome()
    await fixturePool.query(
      `UPDATE gfs_user_homes SET resource_id = NULL, conflict_code = 'path_conflict',
              conflict_detail = $2::jsonb WHERE user_id = $1`,
      [fixture.userId, JSON.stringify({ resourceIds: [fixture.resourceId] })]
    )
    const second = await addUnboundConflict(fixture, 'second-old')
    const responses = await Promise.all([retry(fixture.userId, 'chosen'), retry(second, 'chosen')])
    expect(responses.map(response => response.status)).toEqual([202, 202])
    const reservations = await fixturePool.query<{ user_id: string; storage_username: string }>(
      'SELECT user_id::text, storage_username FROM gfs_user_homes WHERE user_id = ANY($1::uuid[])',
      [[fixture.userId, second]]
    )
    const winner = reservations.rows.find(row => row.storage_username === 'chosen')
    const loser = reservations.rows.find(row => row.storage_username !== 'chosen')
    expect(winner).toBeDefined()
    expect(loser?.storage_username).toBe(`chosen-${loser?.user_id.replace(/-/g, '').slice(0, 8)}`)
    const third = await addUnboundConflict(fixture, 'third-old')
    const released = await retry(third, 'owner')
    expect(released.status).toBe(202)
    expect(released.body.home).toMatchObject({ state: 'pending', storageUsername: 'owner' })
    const audit = await fixturePool.query('SELECT op, gfs_uri FROM gfs_audit WHERE subject = $1', [
      `user:${third}`,
    ])
    expect(audit.rows).toEqual([
      {
        op: 'user_home.conflict_cleared.path_conflict',
        gfs_uri: `gfs://${fixture.drive}/${fixture.resourceId}`,
      },
    ])
  })

  it('rolls back unique-name savepoints and uses the owner UUID after two collisions', async () => {
    const fixture = await seedHome()
    const target = await addUnboundConflict(fixture, 'old-name')
    await addUnboundConflict(fixture, 'chosen')
    await addUnboundConflict(fixture, `chosen-${target.replace(/-/g, '').slice(0, 8)}`)
    const response = await retry(target, 'chosen')
    expect(response.status).toBe(202)
    expect(response.body.home).toMatchObject({ state: 'pending', storageUsername: target })
    const audit = await fixturePool.query('SELECT op FROM gfs_audit WHERE subject = $1', [
      `user:${target}`,
    ])
    expect(audit.rows).toEqual([{ op: 'user_home.conflict_cleared.path_conflict' }])
  })

  it('rolls back a reservation when its audit fails while another retry succeeds', async () => {
    const fixture = await seedHome()
    const failing = await addUnboundConflict(fixture, 'failing-old')
    const working = await addUnboundConflict(fixture, 'working-old')
    await fixturePool.query(`CREATE FUNCTION s4_test_retry_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.subject = 'user:${failing}' THEN RAISE EXCEPTION 'test audit failure'; END IF;
        RETURN NEW;
      END $$`)
    await fixturePool.query(
      'CREATE TRIGGER s4_test_retry_audit_failure BEFORE INSERT ON gfs_audit FOR EACH ROW EXECUTE FUNCTION s4_test_retry_audit_failure()'
    )
    const before = await fixturePool.query('SELECT * FROM gfs_user_homes WHERE user_id = $1', [
      failing,
    ])
    const success = await retry(working, 'working-new')
    expect(success.status).toBe(202)
    expect(success.body.home).toMatchObject({ state: 'pending', storageUsername: 'working-new' })
    const failure = await retry(failing, 'failing-new')
    expect(failure.status).toBe(500)
    expect(
      (await fixturePool.query('SELECT * FROM gfs_user_homes WHERE user_id = $1', [failing])).rows
    ).toEqual(before.rows)
    expect(
      (await fixturePool.query('SELECT op FROM gfs_audit WHERE subject = $1', [`user:${failing}`]))
        .rowCount
    ).toBe(0)
    const successAudit = await fixturePool.query('SELECT op FROM gfs_audit WHERE subject = $1', [
      `user:${working}`,
    ])
    expect(successAudit.rows).toEqual([{ op: 'user_home.conflict_cleared.path_conflict' }])
  })

  it('pages the user-home inventory with a strictly increasing cursor', async () => {
    const seeded = Array.from({ length: 120 }, () => randomUUID())
    await fixturePool.query(
      `INSERT INTO users (id, email, name)
       SELECT input.id, input.id || '@example.test', 'Inventory User'
         FROM unnest($1::uuid[]) AS input(id)`,
      [seeded]
    )
    // The enrollment trigger creates one pending home per new user.
    const enrolled = await fixturePool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM gfs_user_homes WHERE user_id = ANY($1::uuid[])',
      [seeded]
    )
    expect(enrolled.rows[0]!.count).toBe(seeded.length)

    const seen: string[] = []
    let pages = 0
    let cursor: string | null = null
    do {
      const query: { limit: string; cursor?: string } = { limit: '100' }
      if (cursor) query.cursor = cursor
      const response: request.Response = await request(app)
        .get('/gfs/user-homes')
        .query(query)
        .set('x-test-operator', 'yes')
      expect(response.status).toBe(200)
      pages += 1
      seen.push(...response.body.items.map((item: { userId: string }) => item.userId))
      cursor = response.body.nextCursor
      expect(pages).toBeLessThan(20)
    } while (cursor !== null)

    expect(pages).toBeGreaterThanOrEqual(2)
    for (const userId of seeded) {
      expect(seen.filter(id => id === userId)).toHaveLength(1)
    }
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]! > seen[index - 1]!).toBe(true)
    }
  })
})
