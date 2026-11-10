import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// The catalog tombstone: every admin DELETE and every rename of an allowlist row
// records the pair that left, in the same transaction as the mutation, so a later
// catalog sync never re-enables a model the operator removed.
//
// Real PostgreSQL proves what a fake cannot: that the pair recorded is the one the
// mutation actually removed under concurrency (row locks, READ COMMITTED
// re-evaluation), that a failing tombstone INSERT rolls the mutation back on every
// route path, and the migration's ACL. Route cases drive the REAL admin router over
// HTTP; rows come from the real producers. Skipped without
// CONTROL_API_REAL_PG_ADMIN_URL.

const mockVerifyAdminToken = vi.fn()
const mockIsAdminTokenRevoked = vi.fn()
const mockFindAdminById = vi.fn()

vi.mock('../src/utils/auth/adminAuthToken.js', () => ({
  verifyAdminToken: (...args: unknown[]) => mockVerifyAdminToken(...args),
}))

vi.mock('../src/services/adminAuthService.js', () => ({
  findAdminById: (...args: unknown[]) => mockFindAdminById(...args),
  isAdminTokenRevoked: (...args: unknown[]) => mockIsAdminTokenRevoked(...args),
}))

const ADMIN_CLAIMS = {
  sub: '00000000-0000-4000-8000-000000000001',
  typ: 'user' as const,
  role: 'admin' as const,
  jti: 'admin-jti',
  exp: Math.floor(Date.now() / 1000) + 3600,
}
const ACTIVE_ADMIN = {
  id: ADMIN_CLAIMS.sub,
  username: 'admin',
  email: 'admin@example.com',
  passwordHash: 'hash',
  sessionVersion: 0,
  role: 'admin' as const,
  status: 'active' as const,
  failedAttempts: 0,
  lockedUntil: null,
}
const COOKIE = 'control_ui_admin_session=admin-token'
const MODELS_PATH = '/api/v1/admin/llm-models'

type Pair = { provider: string; model: string }

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

describeRealPostgres('llm catalog tombstone on admin DELETE / rename (real PostgreSQL)', () => {
  const database = `control_api_catalog_dismissed_${randomBytes(6).toString('hex')}`
  // describe.skip still runs this factory, so it must not build a URL without the env.
  const connectionString = adminUrl ? databaseUrl(adminUrl, database) : ''
  const previousPgEnv = process.env.CONTROL_API_PG_CONNECTION_STRING

  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  // Independent sessions for the two racing transactions.
  let racePool: Pool
  type TxClient = import('../src/db.js').DbTransactionClient
  let mod: {
    createApp: (gateway: unknown) => import('express').Express
    pool: import('../src/db.js').DbClient
    createAllowedModel: typeof import('../src/services/llmAllowedModels.js').createAllowedModel
    updateAllowedModel: typeof import('../src/services/llmAllowedModels.js').updateAllowedModel
    deleteAllowedModel: typeof import('../src/services/llmAllowedModels.js').deleteAllowedModel
    MockGateway: typeof import('./mockGateway.js').MockGateway
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString

    const dbMod = await import('../src/db.js')
    corePool = dbMod.pool as unknown as Pool
    corePool.on('error', () => {})
    limiterPool = dbMod.rateLimitPool as unknown as Pool
    limiterPool.on('error', () => {})
    const migratePool = new Pool({ connectionString })
    await dbMod.initDb({ connect: () => migratePool.connect() })
    await endPoolAndWaitForClients(migratePool)

    racePool = new Pool({ connectionString })
    racePool.on('error', () => {})

    const appMod = await import('../src/app.js')
    const allowlistMod = await import('../src/services/llmAllowedModels.js')
    const { MockGateway } = await import('./mockGateway.js')
    mod = {
      createApp: appMod.createApp as never,
      pool: dbMod.pool,
      createAllowedModel: allowlistMod.createAllowedModel,
      updateAllowedModel: allowlistMod.updateAllowedModel,
      deleteAllowedModel: allowlistMod.deleteAllowedModel,
      MockGateway,
    }
  }, 60_000)

  afterAll(async () => {
    try {
      if (previousPgEnv === undefined) delete process.env.CONTROL_API_PG_CONNECTION_STRING
      else process.env.CONTROL_API_PG_CONNECTION_STRING = previousPgEnv
      await endPoolAndWaitForClients(racePool).catch(() => {})
      await endPoolAndWaitForClients(corePool).catch(() => {})
      await endPoolAndWaitForClients(limiterPool).catch(() => {})
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  async function resetTables(): Promise<void> {
    await mod.pool.query('DROP TRIGGER IF EXISTS fail_tombstone ON llm_catalog_dismissed')
    await mod.pool.query('DELETE FROM llm_allowed_models')
    await mod.pool.query('DELETE FROM llm_catalog_dismissed')
  }

  beforeEach(async () => {
    mockVerifyAdminToken.mockReset().mockReturnValue(ADMIN_CLAIMS)
    mockIsAdminTokenRevoked.mockReset().mockResolvedValue(false)
    mockFindAdminById.mockReset().mockResolvedValue(ACTIVE_ADMIN)
    await resetTables()
  })

  afterEach(resetTables)

  function app() {
    return mod.createApp(new mod.MockGateway())
  }

  async function seed(provider: string, model: string, enabled: boolean): Promise<string> {
    const row = await mod.createAllowedModel({ provider, model, enabled }, 'test-seed')
    return row.id
  }

  async function dismissed(): Promise<Pair[]> {
    const res = await mod.pool.query(
      'SELECT provider, model FROM llm_catalog_dismissed ORDER BY provider, model'
    )
    return res.rows as Pair[]
  }

  async function row(id: string): Promise<Pair | undefined> {
    const res = await mod.pool.query(
      'SELECT provider, model FROM llm_allowed_models WHERE id = $1',
      [id]
    )
    return res.rows[0] as Pair | undefined
  }

  // A tombstone INSERT that fails inside the database, the way a missing GRANT or
  // a constraint would surface at runtime.
  async function makeTombstoneInsertFail(): Promise<void> {
    await mod.pool.query(`
      CREATE OR REPLACE FUNCTION fail_tombstone_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced tombstone failure'; END $$;
      CREATE TRIGGER fail_tombstone BEFORE INSERT ON llm_catalog_dismissed
        FOR EACH ROW EXECUTE FUNCTION fail_tombstone_insert();
    `)
  }

  async function beginTx(): Promise<PoolClient> {
    const client = await racePool.connect()
    await client.query('BEGIN')
    return client
  }

  // Waits until some session of the test database is blocked on a row lock, i.e.
  // the second racer has reached the contended statement.
  async function waitForLockWaiter(): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const res = await adminPool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock'`,
        [database]
      )
      if ((res.rows[0] as { n: number }).n > 0) return
      await new Promise(r => setTimeout(r, 20))
    }
    throw new Error('the second transaction never blocked on the row lock')
  }

  describe('every route path records the removed pair', () => {
    it('gated DELETE of an enabled row', async () => {
      const id = await seed('claude', 'claude-haiku-4-5', true)
      await request(app()).delete(`${MODELS_PATH}/${id}`).set('Cookie', COOKIE).expect(204)
      expect(await row(id)).toBeUndefined()
      expect(await dismissed()).toEqual([{ provider: 'claude', model: 'claude-haiku-4-5' }])
    })

    it('DELETE ?force', async () => {
      const id = await seed('claude', 'claude-haiku-4-5', true)
      await request(app())
        .delete(`${MODELS_PATH}/${id}?force=true`)
        .set('Cookie', COOKIE)
        .expect(204)
      expect(await row(id)).toBeUndefined()
      expect(await dismissed()).toEqual([{ provider: 'claude', model: 'claude-haiku-4-5' }])
    })

    it('ungated rename of a disabled row records the old pair', async () => {
      const id = await seed('claude', 'claude-haiku-4-5', false)
      await request(app())
        .put(`${MODELS_PATH}/${id}`)
        .set('Cookie', COOKIE)
        .send({ model: 'claude-haiku-4-6' })
        .expect(200)
      expect(await row(id)).toEqual({ provider: 'claude', model: 'claude-haiku-4-6' })
      expect(await dismissed()).toEqual([{ provider: 'claude', model: 'claude-haiku-4-5' }])
    })

    it('gated rename of an enabled row records the old pair', async () => {
      const id = await seed('claude', 'claude-haiku-4-5', true)
      await request(app())
        .put(`${MODELS_PATH}/${id}`)
        .set('Cookie', COOKIE)
        .send({ model: 'claude-haiku-4-6' })
        .expect(200)
      expect(await dismissed()).toEqual([{ provider: 'claude', model: 'claude-haiku-4-5' }])
    })

    it('a provider-only rename records (old provider, same model)', async () => {
      const id = await seed('openrouter', 'shared-model', false)
      await request(app())
        .put(`${MODELS_PATH}/${id}?force=true`)
        .set('Cookie', COOKIE)
        .send({ provider: 'openai' })
        .expect(200)
      expect(await row(id)).toEqual({ provider: 'openai', model: 'shared-model' })
      expect(await dismissed()).toEqual([{ provider: 'openrouter', model: 'shared-model' }])
    })

    it('an update that keeps the pair (even resubmitting it) records nothing', async () => {
      const id = await seed('claude', 'claude-haiku-4-5', true)
      await request(app())
        .put(`${MODELS_PATH}/${id}`)
        .set('Cookie', COOKIE)
        .send({ provider: 'claude', model: 'claude-haiku-4-5', display_name: 'Haiku' })
        .expect(200)
      await request(app())
        .put(`${MODELS_PATH}/${id}`)
        .set('Cookie', COOKIE)
        .send({ enabled: false })
        .expect(200)
      expect(await dismissed()).toEqual([])
    })

    it('create → delete → create → delete of the same pair succeeds and keeps one tombstone', async () => {
      const body = { provider: 'claude', model: 'claude-haiku-4-5', enabled: true }
      for (let i = 0; i < 2; i++) {
        const created = await request(app())
          .post(MODELS_PATH)
          .set('Cookie', COOKIE)
          .send(body)
          .expect(201)
        // A later CREATE does not lift the tombstone.
        expect(await dismissed()).toHaveLength(i)
        await request(app())
          .delete(`${MODELS_PATH}/${created.body.id}?force=true`)
          .set('Cookie', COOKIE)
          .expect(204)
      }
      expect(await dismissed()).toEqual([{ provider: 'claude', model: 'claude-haiku-4-5' }])
    })
  })

  describe('a failing tombstone INSERT rolls the mutation back', () => {
    it.each([
      ['gated DELETE', true, 'delete', ''],
      ['DELETE ?force', true, 'delete', '?force=true'],
      ['gated rename', true, 'put', ''],
      ['ungated rename (disabled row)', false, 'put', ''],
      ['rename ?force', true, 'put', '?force=true'],
    ] as const)('%s', async (_label, enabled, method, query) => {
      const id = await seed('claude', 'claude-haiku-4-5', enabled)
      await makeTombstoneInsertFail()
      const req = request(app())[method](`${MODELS_PATH}/${id}${query}`).set('Cookie', COOKIE)
      const res = method === 'put' ? await req.send({ model: 'claude-haiku-4-6' }) : await req
      expect(res.status).toBe(500)
      expect(await row(id)).toEqual({ provider: 'claude', model: 'claude-haiku-4-5' })
      expect(await dismissed()).toEqual([])
    })
  })

  describe('concurrent mutations of the same id record the pair that really left', () => {
    it('DELETE racing a rename that commits first tombstones the renamed pair', async () => {
      const id = await seed('claude', 'm1', false)
      const renamer = await beginTx()
      const deleter = await beginTx()
      try {
        await mod.updateAllowedModel(id, { model: 'm2' }, 'renamer', renamer as unknown as TxClient)
        const deleting = mod.deleteAllowedModel(id, 'deleter', deleter as unknown as TxClient)
        await waitForLockWaiter()
        await renamer.query('COMMIT')
        expect(await deleting).toBe(true)
        await deleter.query('COMMIT')
      } finally {
        await renamer.query('ROLLBACK').catch(() => {})
        await deleter.query('ROLLBACK').catch(() => {})
        renamer.release()
        deleter.release()
      }
      expect(await row(id)).toBeUndefined()
      expect(await dismissed()).toEqual([
        { provider: 'claude', model: 'm1' },
        { provider: 'claude', model: 'm2' },
      ])
    })

    it('a rename racing a DELETE that commits first finds no row and records nothing more', async () => {
      const id = await seed('claude', 'm1', false)
      const deleter = await beginTx()
      const renamer = await beginTx()
      try {
        expect(await mod.deleteAllowedModel(id, 'deleter', deleter as unknown as TxClient)).toBe(
          true
        )
        const renaming = mod.updateAllowedModel(
          id,
          { model: 'm2' },
          'renamer',
          renamer as unknown as TxClient
        )
        await waitForLockWaiter()
        await deleter.query('COMMIT')
        expect(await renaming).toBeNull()
        await renamer.query('COMMIT')
      } finally {
        await deleter.query('ROLLBACK').catch(() => {})
        await renamer.query('ROLLBACK').catch(() => {})
        deleter.release()
        renamer.release()
      }
      expect(await dismissed()).toEqual([{ provider: 'claude', model: 'm1' }])
    })

    it('two concurrent renames tombstone each pair that left, never the stale one twice', async () => {
      const id = await seed('claude', 'm1', false)
      const first = await beginTx()
      const second = await beginTx()
      try {
        await mod.updateAllowedModel(id, { model: 'm2' }, 'first', first as unknown as TxClient)
        const renaming = mod.updateAllowedModel(
          id,
          { model: 'm3' },
          'second',
          second as unknown as TxClient
        )
        await waitForLockWaiter()
        await first.query('COMMIT')
        expect(await renaming).toMatchObject({ provider: 'claude', model: 'm3' })
        await second.query('COMMIT')
      } finally {
        await first.query('ROLLBACK').catch(() => {})
        await second.query('ROLLBACK').catch(() => {})
        first.release()
        second.release()
      }
      expect(await row(id)).toEqual({ provider: 'claude', model: 'm3' })
      expect(await dismissed()).toEqual([
        { provider: 'claude', model: 'm1' },
        { provider: 'claude', model: 'm2' },
      ])
    })

    it('a second rename back to the value the first one left decides against the locked row', async () => {
      // Both requests carry model m1. Read without a lock, the second one would
      // see m1 and skip the tombstone; locked, it sees m2 and records it.
      const id = await seed('claude', 'm1', false)
      const first = await beginTx()
      const second = await beginTx()
      try {
        await mod.updateAllowedModel(id, { model: 'm2' }, 'first', first as unknown as TxClient)
        const renaming = mod.updateAllowedModel(
          id,
          { model: 'm1' },
          'second',
          second as unknown as TxClient
        )
        await waitForLockWaiter()
        await first.query('COMMIT')
        await renaming
        await second.query('COMMIT')
      } finally {
        await first.query('ROLLBACK').catch(() => {})
        await second.query('ROLLBACK').catch(() => {})
        first.release()
        second.release()
      }
      expect(await row(id)).toEqual({ provider: 'claude', model: 'm1' })
      expect(await dismissed()).toEqual([
        { provider: 'claude', model: 'm1' },
        { provider: 'claude', model: 'm2' },
      ])
    })
  })

  it('grants the runtime role exactly the append envelope', async () => {
    const res = await mod.pool.query(
      `SELECT has_table_privilege('control_api_runtime', 'llm_catalog_dismissed', 'SELECT') AS sel,
              has_table_privilege('control_api_runtime', 'llm_catalog_dismissed', 'INSERT') AS ins,
              has_table_privilege('control_api_runtime', 'llm_catalog_dismissed', 'UPDATE') AS upd,
              has_table_privilege('control_api_runtime', 'llm_catalog_dismissed', 'DELETE') AS del,
              has_table_privilege('control_api_runtime', 'llm_catalog_dismissed', 'TRUNCATE') AS trn,
              has_table_privilege('workflow_recipes_runtime', 'llm_catalog_dismissed', 'SELECT') AS wrc,
              has_table_privilege('trace_maintenance_runtime', 'llm_catalog_dismissed', 'SELECT') AS trace`
    )
    expect(res.rows[0]).toEqual({
      sel: true,
      ins: true,
      upd: false,
      del: false,
      trn: false,
      wrc: false,
      trace: false,
    })

    const runtime = await racePool.connect()
    try {
      await runtime.query('SET ROLE control_api_runtime')
      await runtime.query(
        `INSERT INTO llm_catalog_dismissed (provider, model) VALUES ('claude', 'role-check')
         ON CONFLICT DO NOTHING`
      )
      const read = await runtime.query(
        `SELECT model FROM llm_catalog_dismissed WHERE provider = 'claude'`
      )
      expect(read.rows).toEqual([{ model: 'role-check' }])
      await expect(
        runtime.query(`UPDATE llm_catalog_dismissed SET model = 'x' WHERE provider = 'claude'`)
      ).rejects.toMatchObject({ code: '42501' })
      await expect(
        runtime.query(`DELETE FROM llm_catalog_dismissed WHERE provider = 'claude'`)
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await runtime.query('RESET ROLE').catch(() => {})
      runtime.release()
    }
  })
})
