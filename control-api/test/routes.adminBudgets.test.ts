import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()
const mockVerifyAdminToken = vi.fn()
const mockIsAdminTokenRevoked = vi.fn()
const mockFindAdminById = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

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

const BUDGET_ROW = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'monthly cost cap',
  enabled: true,
  scope: { team_id: ['t1'] },
  unit: 'cost',
  currency: 'USD',
  limit_amount: '500.0000',
  period: 'monthly',
  timezone: 'UTC',
  min_start_amount: '0.0000',
  max_task_amount: null,
  enforcement: 'warn',
  created_at: new Date('2026-06-01T00:00:00Z'),
  updated_at: new Date('2026-06-01T00:00:00Z'),
}

function app() {
  return createApp(new MockGateway('mcp-server') as never)
}

function authed(method: 'get' | 'post' | 'put' | 'delete' | 'patch', path: string) {
  return request(app())[method](path).set('Cookie', 'control_ui_admin_session=admin-token')
}

describe('admin budgets routes', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockVerifyAdminToken.mockReset()
    mockVerifyAdminToken.mockReturnValue(ADMIN_CLAIMS)
    mockIsAdminTokenRevoked.mockReset()
    mockIsAdminTokenRevoked.mockResolvedValue(false)
    mockFindAdminById.mockReset()
    mockFindAdminById.mockResolvedValue(ACTIVE_ADMIN)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('rejects unauthenticated requests with 401', async () => {
    await request(app()).get('/api/v1/admin/budgets').expect(401)
  })

  it('GET /admin/budgets returns rows with computed spent/remaining', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [BUDGET_ROW], rowCount: 1 }) // listBudgets
      .mockResolvedValueOnce({
        rows: [
          { provider: 'openai', model: 'gpt-4o', priced: true, tokens: '1000', amount: '12.5000' },
        ],
        rowCount: 1,
      }) // computeBudgetSpent (cost)
    const res = await authed('get', '/api/v1/admin/budgets').expect(200)
    expect(res.body.rows).toHaveLength(1)
    expect(res.body.rows[0]).toMatchObject({
      id: BUDGET_ROW.id,
      name: 'monthly cost cap',
      unit: 'cost',
      limit_amount: 500,
      scope: { team_id: ['t1'] },
      spent: 12.5,
      remaining: 487.5,
    })
  })

  it('GET /admin/budgets/:id returns detail with spend', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [BUDGET_ROW], rowCount: 1 }) // getBudget
      .mockResolvedValueOnce({
        rows: [{ provider: 'openai', model: 'gpt-4o', priced: true, tokens: '0', amount: '0' }],
        rowCount: 1,
      }) // spend
    const res = await authed('get', `/api/v1/admin/budgets/${BUDGET_ROW.id}`).expect(200)
    expect(res.body).toMatchObject({ id: BUDGET_ROW.id, spent: 0, remaining: 500 })
  })

  it('GET /admin/budgets/:id returns 404 for a non-UUID id without hitting the DB', async () => {
    await authed('get', '/api/v1/admin/budgets/not-a-uuid').expect(404)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('GET /admin/budgets/:id returns 404 when missing', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await authed('get', `/api/v1/admin/budgets/${BUDGET_ROW.id}`).expect(404)
  })

  it('POST /admin/budgets creates a budget', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [BUDGET_ROW], rowCount: 1 })
    const res = await authed('post', '/api/v1/admin/budgets')
      .send({
        name: 'monthly cost cap',
        unit: 'cost',
        currency: 'USD',
        limit_amount: 500,
        period: 'monthly',
        scope: { team_id: ['t1'] },
        enforcement: 'warn',
      })
      .expect(201)
    expect(res.body.name).toBe('monthly cost cap')
    const [sql, params] = mockPoolQuery.mock.calls[0]
    expect(String(sql)).toMatch(/INSERT INTO token_budgets/)
    expect(params[2]).toBe(JSON.stringify({ team_id: ['t1'] }))
  })

  it('POST /admin/budgets rejects a cost budget pinning an unpriced model (400)', async () => {
    // findUnpricedScopedModels finds no active price for the pinned model.
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const res = await authed('post', '/api/v1/admin/budgets')
      .send({
        name: 'b',
        unit: 'cost',
        currency: 'USD',
        limit_amount: 10,
        period: 'daily',
        scope: { model: ['mystery-model'] },
      })
      .expect(400)
    expect(res.body.error).toBe('unpriced_models')
    expect(res.body.models).toEqual([{ provider: null, model: 'mystery-model' }])
    const insert = mockPoolQuery.mock.calls.find(c =>
      /INSERT INTO token_budgets/.test(String(c[0]))
    )
    expect(insert).toBeUndefined()
  })

  it('POST /admin/budgets allows a cost budget when the pinned model is priced', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ model: 'gpt-4o' }], rowCount: 1 }) // guard: priced
      .mockResolvedValueOnce({ rows: [BUDGET_ROW], rowCount: 1 }) // INSERT
    await authed('post', '/api/v1/admin/budgets')
      .send({
        name: 'b',
        unit: 'cost',
        currency: 'USD',
        limit_amount: 10,
        period: 'daily',
        scope: { model: ['gpt-4o'] },
      })
      .expect(201)
  })

  it("POST /admin/budgets rejects unit='cost' without currency (400)", async () => {
    await authed('post', '/api/v1/admin/budgets')
      .send({ name: 'b', unit: 'cost', limit_amount: 10, period: 'daily' })
      .expect(400)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('POST /admin/budgets rejects an arbitrary scope key (400)', async () => {
    const res = await authed('post', '/api/v1/admin/budgets')
      .send({
        name: 'b',
        unit: 'tokens',
        limit_amount: 10,
        period: 'daily',
        scope: { drop_table: ['x'] },
      })
      .expect(400)
    expect(res.body.error).toBe('invalid_request')
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('POST /admin/budgets rejects a non-string[] scope value (400)', async () => {
    await authed('post', '/api/v1/admin/budgets')
      .send({
        name: 'b',
        unit: 'tokens',
        limit_amount: 10,
        period: 'daily',
        scope: { team_id: [1, 2] },
      })
      .expect(400)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('POST /admin/budgets maps a DB check violation to 400', async () => {
    mockPoolQuery.mockRejectedValueOnce(Object.assign(new Error('check'), { code: '23514' }))
    const res = await authed('post', '/api/v1/admin/budgets')
      .send({ name: 'b', unit: 'tokens', limit_amount: 10, period: 'daily' })
      .expect(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('PUT /admin/budgets/:id updates provided fields', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...BUDGET_ROW, name: 'renamed' }], rowCount: 1 })
    const res = await authed('put', `/api/v1/admin/budgets/${BUDGET_ROW.id}`)
      .send({ name: 'renamed' })
      .expect(200)
    expect(res.body.name).toBe('renamed')
    const [sql, params] = mockPoolQuery.mock.calls[0]
    expect(String(sql)).toMatch(/name = \$1/)
    expect(params).toEqual(['renamed', BUDGET_ROW.id])
  })

  it('PUT /admin/budgets/:id rejects an empty body with 400', async () => {
    await authed('put', `/api/v1/admin/budgets/${BUDGET_ROW.id}`).send({}).expect(400)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('PUT /admin/budgets/:id rejects unknown fields with 400', async () => {
    await authed('put', `/api/v1/admin/budgets/${BUDGET_ROW.id}`)
      .send({ name: 'x', bogus: 1 })
      .expect(400)
  })

  it('PUT /admin/budgets/:id returns 404 when missing', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await authed('put', `/api/v1/admin/budgets/${BUDGET_ROW.id}`)
      .send({ enabled: false })
      .expect(404)
  })

  it('PATCH /admin/budgets/:id toggles enabled', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...BUDGET_ROW, enabled: false }], rowCount: 1 })
    const res = await authed('patch', `/api/v1/admin/budgets/${BUDGET_ROW.id}`)
      .send({ enabled: false })
      .expect(200)
    expect(res.body.enabled).toBe(false)
    const [sql, params] = mockPoolQuery.mock.calls[0]
    expect(String(sql)).toMatch(/SET enabled = \$1/)
    expect(params).toEqual([false, BUDGET_ROW.id])
  })

  it('PATCH /admin/budgets/:id rejects a non-boolean enabled (400)', async () => {
    await authed('patch', `/api/v1/admin/budgets/${BUDGET_ROW.id}`)
      .send({ enabled: 'yes' })
      .expect(400)
  })

  it('DELETE /admin/budgets/:id returns 204 on success', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 })
    await authed('delete', `/api/v1/admin/budgets/${BUDGET_ROW.id}`).expect(204)
  })

  it('DELETE /admin/budgets/:id returns 404 when nothing was deleted', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await authed('delete', `/api/v1/admin/budgets/${BUDGET_ROW.id}`).expect(404)
  })
})
