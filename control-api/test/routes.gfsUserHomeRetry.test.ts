import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const USER = '11111111-1111-4111-8111-111111111111'
const RESOURCE = '22222222-2222-4222-8222-222222222222'
const ADMIN = '33333333-3333-4333-8333-333333333333'
const mocks = vi.hoisted(() => ({ query: vi.fn(), limiter: vi.fn() }))

vi.mock('../src/db.js', () => ({
  pool: { query: mocks.query },
  withTransaction: (work: (db: { query: typeof mocks.query }) => Promise<unknown>) =>
    work({ query: mocks.query }),
}))
vi.mock('../src/services/rateLimiterService.js', () => ({
  RATE_LIMIT_BACKEND_RETRY_AFTER_SECONDS: 2,
  checkAndIncrement: mocks.limiter,
}))
vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (req.header('x-test-operator') !== 'yes')
      return res.status(401).json({ error: 'Unauthorized' })
    ;(req as express.Request & { adminAuth: { sub: string } }).adminAuth = { sub: ADMIN }
    next()
  },
}))

function home(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER,
    email: 'owner@example.test',
    name: 'Owner',
    state: 'conflict',
    drive: 'main',
    storage_username: 'owner',
    resource_id: RESOURCE,
    path_cache: '/Users/owner',
    conflict_code: 'path_conflict',
    conflict_detail: { resourceIds: [RESOURCE] },
    attempts: 4,
    last_attempt_at: null,
    last_error: 'previous_error',
    updated_at: '2026-10-28T00:00:00.000Z',
    ...overrides,
  }
}

let current: ReturnType<typeof home> | undefined
let audit: unknown[][]

beforeEach(() => {
  current = home()
  audit = []
  mocks.query.mockReset()
  mocks.limiter.mockReset().mockResolvedValue({
    allowed: true,
    backendAvailable: true,
    remaining: 9,
    resetMs: Date.now() + 60_000,
  })
  mocks.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (sql.includes('FROM gfs_user_homes WHERE')) return { rows: current ? [current] : [] }
    if (sql.startsWith('SAVEPOINT') || sql.startsWith('RELEASE SAVEPOINT')) return { rows: [] }
    if (sql.includes('SET drive = $2, storage_username = $3')) {
      current = { ...current!, drive: values[1] as string, storage_username: values[2] as string }
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO gfs_audit')) {
      audit.push(values)
      return { rows: [{ id: String(audit.length) }] }
    }
    if (sql.includes('UPDATE gfs_user_homes SET state = $2')) {
      current = {
        ...current!,
        state: String(values[1]),
        conflict_code: null,
        conflict_detail: null,
        attempts: 0,
        last_error: null,
      } as ReturnType<typeof home>
      return { rows: [] }
    }
    if (sql.includes('FROM gfs_user_homes h')) return { rows: current ? [current] : [] }
    throw new Error(`unexpected SQL: ${sql}`)
  })
})

async function app() {
  const { registerGfsUserHomeRoutes } = await import('../src/routes/gfs/userHomes.js')
  const router = express.Router()
  registerGfsUserHomeRoutes(router)
  const application = express()
  application.use(express.json())
  application.use(router)
  return application
}

describe('operator user-home retry route', () => {
  it('requires operator auth and the shared write limit, then accepts an allowed request', async () => {
    const application = await app()
    const path = `/gfs/user-homes/${USER}/retry`
    await request(application).post(path).expect(401)
    expect(mocks.query).not.toHaveBeenCalled()
    mocks.limiter.mockResolvedValueOnce({
      allowed: false,
      backendAvailable: true,
      remaining: 0,
      resetMs: Date.now() + 60_000,
    })
    await request(application).post(path).set('x-test-operator', 'yes').expect(429)
    expect(mocks.query).not.toHaveBeenCalled()
    await request(application).post(path).set('x-test-operator', 'yes').expect(202)
    expect(mocks.limiter.mock.calls.map(call => call[0])).toEqual([
      `gfs_user_homes_write:${ADMIN}`,
      `gfs_user_homes_write:${ADMIN}`,
    ])
    expect(audit).toHaveLength(1)
  })

  it('rejects malformed or absent users and accepts an existing home', async () => {
    const application = await app()
    const post = (id: string) =>
      request(application).post(`/gfs/user-homes/${id}/retry`).set('x-test-operator', 'yes')
    const malformed = await post('invalid')
    expect(malformed.status).toBe(400)
    expect(malformed.body).toEqual({ error: 'invalid_user_id' })
    current = undefined
    const missing = await post(USER)
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: 'home_not_found' })
    current = home()
    expect((await post(USER)).status).toBe(202)
    expect(audit).toHaveLength(1)
  })

  it('rejects non-conflict states and owner conflicts while a path conflict can be retried', async () => {
    const application = await app()
    const post = () =>
      request(application).post(`/gfs/user-homes/${USER}/retry`).set('x-test-operator', 'yes')
    for (const state of ['pending', 'ready', 'retired']) {
      current = home({ state, conflict_code: null, conflict_detail: null })
      const before = structuredClone(current)
      const denied = await post()
      expect(denied.status).toBe(409)
      expect(denied.body).toEqual({ error: 'home_not_retryable' })
      expect(current).toEqual(before)
      expect(audit).toEqual([])
    }
    current = home({ conflict_code: 'ownership_conflict' })
    const before = structuredClone(current)
    const owner = await post()
    expect(owner.status).toBe(409)
    expect(owner.body).toEqual({ error: 'home_owner_grant_requires_operator_restore' })
    expect(current).toEqual(before)
    expect(audit).toEqual([])
    current = home()
    expect((await post()).status).toBe(202)
    expect(audit).toHaveLength(1)
  })

  it('rejects invalid new names without mutation and reserves a valid name', async () => {
    const application = await app()
    current = home({ resource_id: null })
    const post = (storageUsername: unknown) =>
      request(application)
        .post(`/gfs/user-homes/${USER}/retry`)
        .set('x-test-operator', 'yes')
        .send({ storageUsername })
    for (const name of ['', 'Bad Name', 'users', '44444444-4444-4444-8444-444444444444', 42]) {
      const before = structuredClone(current)
      const denied = await post(name)
      expect(denied.status).toBe(422)
      expect(denied.body).toEqual({ error: 'invalid_name' })
      expect(current).toEqual(before)
      expect(audit).toEqual([])
    }
    mocks.query.mockClear()
    const accepted = await post('new-owner')
    expect(accepted.status).toBe(202)
    expect(accepted.body.home).toMatchObject({ state: 'pending', storageUsername: 'new-owner' })
    expect(audit).toHaveLength(1)
    const statements = mocks.query.mock.calls.map(call => String(call[0]))
    const lockUser = statements.findIndex(sql => sql.includes('gfs:user-home:'))
    const lockStructure = statements.findIndex(sql => sql.includes('gfs:structure:'))
    const lockRow = statements.findIndex(sql => sql.includes('FOR UPDATE'))
    const clearAudit = statements.findIndex(sql => sql.includes('INSERT INTO gfs_audit'))
    const clearConflict = statements.findIndex(sql =>
      sql.includes('UPDATE gfs_user_homes SET state')
    )
    expect(lockUser).toBeLessThan(lockStructure)
    expect(lockStructure).toBeLessThan(lockRow)
    expect(clearAudit).toBeLessThan(clearConflict)
  })

  it('rejects a different name on a bound path conflict and accepts the reserved name', async () => {
    const application = await app()
    const post = (storageUsername: string) =>
      request(application)
        .post(`/gfs/user-homes/${USER}/retry`)
        .set('x-test-operator', 'yes')
        .send({ storageUsername })
    const before = structuredClone(current)
    const denied = await post('different')
    expect(denied.status).toBe(409)
    expect(denied.body).toEqual({ error: 'home_not_retryable' })
    expect(current).toEqual(before)
    expect(audit).toEqual([])
    const accepted = await post('owner')
    expect(accepted.status).toBe(202)
    expect(accepted.body.home).toMatchObject({
      state: 'pending',
      attempts: 0,
      conflictCode: null,
      resourceId: RESOURCE,
      storageUsername: 'owner',
    })
    expect(audit).toHaveLength(1)
    expect(audit[0]?.[2]).toBe('user_home.conflict_cleared.path_conflict')
    expect(audit[0]?.[3]).toBe(`gfs://main/${RESOURCE}`)
  })

  it('preserves a bound ancestor-conflict name and accepts retry without a new name', async () => {
    const application = await app()
    current = home({ conflict_code: 'ancestor_grant_conflict' })
    const before = structuredClone(current)
    const path = `/gfs/user-homes/${USER}/retry`
    const denied = await request(application)
      .post(path)
      .set('x-test-operator', 'yes')
      .send({ storageUsername: 'different' })
    expect(denied.status).toBe(409)
    expect(current).toEqual(before)
    expect(audit).toEqual([])
    const accepted = await request(application).post(path).set('x-test-operator', 'yes')
    expect(accepted.status).toBe(202)
    expect(accepted.body.home).toMatchObject({ state: 'pending', storageUsername: 'owner' })
    expect(audit[0]?.[2]).toBe('user_home.conflict_cleared.ancestor_grant_conflict')
  })
})
