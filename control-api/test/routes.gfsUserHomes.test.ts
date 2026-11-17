import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { rootLogger } from '../src/observability/logger.js'

const USER = '11111111-1111-4111-8111-111111111111'
const RESOURCE = '22222222-2222-4222-8222-222222222222'
const ADMIN = '33333333-3333-4333-8333-333333333333'
const TEAM = '44444444-4444-4444-8444-444444444444'
const GRANT = '55555555-5555-4555-8555-555555555555'
const SHARE = '66666666-6666-4666-8666-666666666666'
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

const row = {
  user_id: USER,
  email: 'owner@example.test',
  name: 'Owner',
  state: 'conflict',
  drive: 'archive',
  storage_username: 'owner',
  resource_id: RESOURCE,
  path_cache: '/Users/owner',
  conflict_code: 'ownership_conflict',
  conflict_detail: { resourceIds: [RESOURCE] },
  attempts: 2,
  last_attempt_at: null,
  last_error: null,
  created_at: '2026-10-27T00:00:00.000Z',
  updated_at: '2026-10-27T00:00:00.000Z',
}

async function app() {
  const { registerGfsUserHomeRoutes } = await import('../src/routes/gfs/userHomes.js')
  const router = express.Router()
  registerGfsUserHomeRoutes(router)
  const application = express()
  application.use(express.json())
  application.use(router)
  return application
}

function allowed() {
  return { allowed: true, backendAvailable: true, remaining: 149, resetMs: Date.now() + 60_000 }
}

let restored = false
let ownerGrantWritten = false
beforeEach(() => {
  restored = false
  ownerGrantWritten = false
  mocks.query.mockReset()
  mocks.limiter.mockReset().mockResolvedValue(allowed())
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (sql.includes('FROM gfs_user_homes WHERE')) return { rows: [row] }
    if (sql.includes('FROM gfs_resources') && sql.includes('FOR SHARE'))
      return { rows: [{ resource_id: RESOURCE }] }
    if (sql.includes('SELECT permissions, inherit FROM gfs_grants'))
      return {
        rows: [
          ownerGrantWritten
            ? { permissions: ['read', 'write', 'delete', 'share', 'manage_acl'], inherit: true }
            : { permissions: ['read'], inherit: false },
        ],
      }
    if (sql.includes('INSERT INTO gfs_grants')) {
      ownerGrantWritten = true
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO gfs_audit')) return { rows: [{ id: '1' }] }
    if (sql.includes('UPDATE gfs_user_homes')) {
      restored = true
      return { rows: [] }
    }
    if (sql.includes('count(*)')) return { rows: [{ state: 'conflict', count: 1 }] }
    if (sql.includes('FROM gfs_user_homes h'))
      return {
        rows: [
          restored ? { ...row, state: 'ready', conflict_code: null, conflict_detail: null } : row,
        ],
      }
    throw new Error(`unexpected SQL: ${sql}`)
  })
})

describe('operator user-home routes', () => {
  it('requires operator authentication on inventory, detail and restore while those routes work for an operator', async () => {
    const application = await app()
    for (const [method, path] of [
      ['get', '/gfs/user-homes'],
      ['get', `/gfs/user-homes/${USER}`],
      ['post', `/gfs/user-homes/${USER}/restore-owner`],
    ] as const) {
      const denied = await request(application)[method](path)
      expect(denied.status).toBe(401)
      const permitted = await request(application)[method](path).set('x-test-operator', 'yes')
      expect(permitted.status).toBe(200)
    }
    expect(mocks.limiter.mock.calls.map(call => call[0])).toEqual([
      `gfs_user_homes_read:${ADMIN}`,
      `gfs_user_homes_read:${ADMIN}`,
      `gfs_user_homes_write:${ADMIN}`,
    ])
  })

  it('returns the requested detail and rejects malformed and absent ids', async () => {
    const application = await app()
    const valid = await request(application)
      .get(`/gfs/user-homes/${USER}`)
      .set('x-test-operator', 'yes')
    expect(valid.status).toBe(200)
    expect(valid.body.home).toMatchObject({
      userId: USER,
      email: 'owner@example.test',
      name: 'Owner',
      drive: 'archive',
      path: '/Users/owner',
      conflictCode: 'ownership_conflict',
    })
    const malformed = await request(application)
      .get('/gfs/user-homes/invalid')
      .set('x-test-operator', 'yes')
    expect(malformed.status).toBe(400)
    mocks.query.mockResolvedValue({ rows: [] })
    const missing = await request(application)
      .get(`/gfs/user-homes/${USER}`)
      .set('x-test-operator', 'yes')
    expect(missing.status).toBe(404)
  })

  it('paginates at 100 and returns unfiltered state counts, rejecting an invalid filter', async () => {
    const application = await app()
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...row,
      user_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    }))
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes('count(*)')
        ? {
            rows: [
              { state: 'conflict', count: 101 },
              { state: 'ready', count: 2 },
            ],
          }
        : { rows }
    )
    const page = await request(application)
      .get('/gfs/user-homes?state=conflict&limit=100')
      .set('x-test-operator', 'yes')
    expect(page.status).toBe(200)
    expect(page.body.items).toHaveLength(100)
    expect(Object.keys(page.body.items[0]).sort()).toEqual([
      'attempts',
      'conflictCode',
      'drive',
      'email',
      'lastAttemptAt',
      'lastError',
      'name',
      'path',
      'resourceId',
      'state',
      'storageUsername',
      'updatedAt',
      'userId',
    ])
    expect(page.body.nextCursor).toBe(rows[99].user_id)
    expect(page.body.counts).toEqual({ pending: 0, ready: 2, conflict: 101, retired: 0 })
    const invalid = await request(application)
      .get('/gfs/user-homes?state=unknown')
      .set('x-test-operator', 'yes')
    expect(invalid.status).toBe(400)
    expect(invalid.body.error).toBe('invalid_state')
    const defaultPage = await request(application)
      .get('/gfs/user-homes')
      .set('x-test-operator', 'yes')
    expect(defaultPage.body.items).toHaveLength(50)
    expect(defaultPage.body.nextCursor).toBe(rows[49].user_id)
    for (const [query, error] of [
      ['limit=0', 'invalid_limit'],
      ['limit=101', 'invalid_limit'],
      ['cursor=bad', 'invalid_cursor'],
    ] as const) {
      const rejected = await request(application)
        .get(`/gfs/user-homes?${query}`)
        .set('x-test-operator', 'yes')
      expect(rejected.status).toBe(400)
      expect(rejected.body.error).toBe(error)
    }
  })

  it('keeps a deleted user home in inventory and detail with null identity fields', async () => {
    const application = await app()
    const deleted = {
      ...row,
      email: null,
      name: null,
      state: 'retired',
      conflict_code: null,
      conflict_detail: null,
    }
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes('count(*)') ? { rows: [{ state: 'retired', count: 1 }] } : { rows: [deleted] }
    )
    const inventory = await request(application)
      .get('/gfs/user-homes?state=retired')
      .set('x-test-operator', 'yes')
    expect(inventory.status).toBe(200)
    expect(inventory.body.items[0]).toMatchObject({
      userId: USER,
      email: null,
      name: null,
      state: 'retired',
      path: '/Users/owner',
    })
    const detail = await request(application)
      .get(`/gfs/user-homes/${USER}`)
      .set('x-test-operator', 'yes')
    expect(detail.status).toBe(200)
    expect(detail.body.home).toMatchObject({
      email: null,
      name: null,
      state: 'retired',
      conflictDetail: null,
    })
    mocks.query.mockResolvedValue({ rows: [] })
    await request(application)
      .get(`/gfs/user-homes/${USER}`)
      .set('x-test-operator', 'yes')
      .expect(404)
  })

  it('shows a path conflict and its current direct access, then reports a vanished resource', async () => {
    const application = await app()
    let exists = true
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('count(*)')) return { rows: [{ state: 'conflict', count: 1 }] }
      if (sql.includes('FROM gfs_user_homes h'))
        return { rows: [{ ...row, conflict_code: 'path_conflict' }] }
      if (sql.includes('SELECT resource_id, path_cache, kind, created_at FROM gfs_resources')) {
        return {
          rows: exists
            ? [
                {
                  resource_id: RESOURCE,
                  path_cache: '/Users/owner',
                  kind: 'directory',
                  created_at: '2026-10-27T00:00:00.000Z',
                },
              ]
            : [],
        }
      }
      if (sql.includes('WITH access AS'))
        return {
          rows: [
            {
              relation: 'grant',
              resource_id: RESOURCE,
              path: '/Users/owner',
              subject_type: 'user',
              subject_id: USER,
              permissions: ['read'],
              inherit: true,
            },
            {
              relation: 'share',
              resource_id: RESOURCE,
              path: '/Users/owner',
              subject_type: 'team',
              subject_id: TEAM,
              permissions: ['write'],
              inherit: false,
            },
          ],
        }
      if (sql.includes('FROM users WHERE'))
        return { rows: [{ id: USER, name: 'Owner', email: 'owner@example.test' }] }
      if (sql.includes('FROM teams WHERE')) return { rows: [{ id: TEAM, name: 'Team' }] }
      throw new Error('unexpected query')
    })
    const detail = await request(application)
      .get(`/gfs/user-homes/${USER}`)
      .set('x-test-operator', 'yes')
    expect(detail.status).toBe(200)
    expect(detail.body.home.conflictDetail).toEqual({
      code: 'path_conflict',
      resource: {
        resourceId: RESOURCE,
        path: '/Users/owner',
        kind: 'directory',
        createdAt: '2026-10-27T00:00:00.000Z',
      },
      access: [
        {
          relation: 'grant',
          subjectType: 'user',
          subjectId: USER,
          subjectLabel: 'Owner',
          permissions: ['read'],
          inherit: true,
        },
        {
          relation: 'share',
          subjectType: 'team',
          subjectId: TEAM,
          subjectLabel: 'Team',
          permissions: ['write'],
          inherit: false,
        },
      ],
    })
    const inventory = await request(application)
      .get('/gfs/user-homes')
      .set('x-test-operator', 'yes')
    expect(inventory.status).toBe(200)
    expect(inventory.body.items[0]).not.toHaveProperty('conflictDetail')
    exists = false
    const vanished = await request(application)
      .get(`/gfs/user-homes/${USER}`)
      .set('x-test-operator', 'yes')
    expect(vanished.body.home.conflictDetail).toEqual({
      code: 'path_conflict',
      resource: null,
      access: [],
    })
  })

  it('resolves ancestor grant and share identifiers with live paths and labels', async () => {
    const application = await app()
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM gfs_user_homes h'))
        return {
          rows: [
            {
              ...row,
              conflict_code: 'ancestor_grant_conflict',
              conflict_detail: { resourceIds: [RESOURCE], grantIds: [GRANT], shareIds: [SHARE] },
            },
          ],
        }
      if (sql.includes('WITH access AS'))
        return {
          rows: [
            {
              relation: 'grant',
              resource_id: RESOURCE,
              path: '/Users',
              subject_type: 'user',
              subject_id: USER,
              permissions: ['read'],
              inherit: true,
            },
            {
              relation: 'share',
              resource_id: RESOURCE,
              path: '/Users',
              subject_type: 'host',
              subject_id: '1st:mcp-host/agent',
              permissions: ['read'],
              inherit: true,
            },
          ],
        }
      if (sql.includes('FROM users WHERE'))
        return { rows: [{ id: USER, name: null, email: 'owner@example.test' }] }
      throw new Error('unexpected query')
    })
    const response = await request(application)
      .get(`/gfs/user-homes/${USER}`)
      .set('x-test-operator', 'yes')
    expect(response.status).toBe(200)
    expect(response.body.home.conflictDetail).toEqual({
      code: 'ancestor_grant_conflict',
      entries: [
        {
          relation: 'grant',
          resourceId: RESOURCE,
          path: '/Users',
          subjectType: 'user',
          subjectId: USER,
          subjectLabel: 'owner@example.test',
          permissions: ['read'],
          inherit: true,
        },
        {
          relation: 'share',
          resourceId: RESOURCE,
          path: '/Users',
          subjectType: 'host',
          subjectId: '1st:mcp-host/agent',
          subjectLabel: null,
          permissions: ['read'],
          inherit: true,
        },
      ],
    })
    const accessQuery = mocks.query.mock.calls.find(call =>
      String(call[0]).includes('WITH access AS')
    )
    expect(accessQuery?.[1]).toEqual([[RESOURCE], 'archive', true, [GRANT], [SHARE]])
  })

  it('shows a narrowed owner grant and then null when that grant is removed', async () => {
    const application = await app()
    const get = () =>
      request(application).get(`/gfs/user-homes/${USER}`).set('x-test-operator', 'yes')
    const narrowed = await get()
    expect(narrowed.body.home.conflictDetail).toEqual({
      code: 'ownership_conflict',
      ownerGrant: { permissions: ['read'], inherit: false },
    })
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM gfs_user_homes h') ? { rows: [row] } : { rows: [] }
    )
    const removed = await get()
    expect(removed.body.home.conflictDetail).toEqual({
      code: 'ownership_conflict',
      ownerGrant: null,
    })
  })

  it('fails closed on malformed stored conflict identifiers while accepting a valid record', async () => {
    const application = await app()
    const get = () =>
      request(application).get(`/gfs/user-homes/${USER}`).set('x-test-operator', 'yes')
    expect((await get()).status).toBe(200)
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM gfs_user_homes h'))
        return { rows: [{ ...row, conflict_detail: { resourceIds: ['invalid'] } }] }
      throw new Error('invalid identifiers must not reach a lookup')
    })
    expect((await get()).status).toBe(500)
  })

  it('uses separate admin limits and refuses work on a denied bucket', async () => {
    const application = await app()
    await request(application)
      .get(`/gfs/user-homes/${USER}`)
      .set('x-test-operator', 'yes')
      .expect(200)
    const callsBefore = mocks.query.mock.calls.length
    mocks.limiter.mockResolvedValueOnce({ ...allowed(), allowed: false, remaining: 0 })
    await request(application)
      .post(`/gfs/user-homes/${USER}/restore-owner`)
      .set('x-test-operator', 'yes')
      .expect(429)
    expect(mocks.query.mock.calls).toHaveLength(callsBefore)
    const response = await request(application)
      .post(`/gfs/user-homes/${USER}/restore-owner`)
      .set('x-test-operator', 'yes')
      .expect(200)
    expect(response.body.home).toMatchObject({ userId: USER, state: 'ready', conflictCode: null })
  })

  it('locks in order, upserts the five owner permissions and audits before clearing the conflict', async () => {
    const log = vi.spyOn(rootLogger, 'info').mockImplementation(() => undefined)
    const application = await app()
    await request(application)
      .post(`/gfs/user-homes/${USER}/restore-owner`)
      .set('x-test-operator', 'yes')
      .expect(200)
    const queries = mocks.query.mock.calls.map(call => String(call[0]))
    expect(queries[0]).toContain('pg_advisory_xact_lock')
    expect(queries[0]).toContain('gfs:user-home:')
    expect(queries[1]).toContain('FROM gfs_user_homes')
    expect(queries[1]).toContain('FOR UPDATE')
    expect(queries[3]).toContain('ON CONFLICT (drive, resource_id, subject_type, subject_id)')
    expect(queries[3]).toContain('DO UPDATE SET')
    expect(queries[3]).toContain('inherit = true')
    expect(mocks.query.mock.calls[3][1]).toEqual([
      'archive',
      RESOURCE,
      USER,
      ['read', 'write', 'delete', 'share', 'manage_acl'],
    ])
    expect(queries[4]).toContain('SELECT permissions, inherit FROM gfs_grants')
    expect(queries[4]).toContain('FOR UPDATE')
    expect(queries[5]).toContain('INSERT INTO gfs_audit')
    expect(queries[6]).toContain("state = 'ready'")
    expect(queries[7]).toContain('INSERT INTO gfs_audit')
    expect(mocks.query.mock.calls[5][1][2]).toBe('user_home.conflict_cleared.ownership_conflict')
    expect(mocks.query.mock.calls[7][1][2]).toBe('user_home.restore_owner')
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        conflictCode: 'ownership_conflict',
        conflictDetail: { resourceIds: [RESOURCE] },
      }),
      'user home conflict clearing'
    )
    log.mockRestore()
  })

  it('canonicalizes an uppercase owner id before restoring the grant', async () => {
    const userId = 'abcdefab-cdef-4abc-8abc-abcdefabcdef'
    const application = await app()
    const response = await request(application)
      .post(`/gfs/user-homes/${userId.toUpperCase()}/restore-owner`)
      .set('x-test-operator', 'yes')
    expect(response.status).toBe(200)
    const lock = mocks.query.mock.calls.find(call =>
      String(call[0]).includes('pg_advisory_xact_lock')
    )
    const grant = mocks.query.mock.calls.find(call =>
      String(call[0]).includes('INSERT INTO gfs_grants')
    )
    expect(lock?.[1]).toEqual([userId])
    expect(grant?.[1]?.[2]).toBe(userId)
  })

  it('rejects an unrelated conflict and a broken binding while restoring a valid conflict', async () => {
    const application = await app()
    await request(application)
      .post(`/gfs/user-homes/${USER}/restore-owner`)
      .set('x-test-operator', 'yes')
      .expect(200)
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (sql.includes('FROM gfs_user_homes WHERE'))
        return { rows: [{ ...row, conflict_code: 'path_conflict' }] }
      throw new Error('unexpected mutation')
    })
    const wrong = await request(application)
      .post(`/gfs/user-homes/${USER}/restore-owner`)
      .set('x-test-operator', 'yes')
    expect(wrong.status).toBe(409)
    expect(wrong.body.error).toBe('home_not_in_ownership_conflict')
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (sql.includes('FROM gfs_user_homes WHERE'))
        return { rows: [{ ...row, resource_id: null }] }
      throw new Error('unexpected mutation')
    })
    const broken = await request(application)
      .post(`/gfs/user-homes/${USER}/restore-owner`)
      .set('x-test-operator', 'yes')
    expect(broken.status).toBe(500)
  })
})
