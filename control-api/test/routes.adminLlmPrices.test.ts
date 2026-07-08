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

const PRICE_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'openai',
  model: 'gpt-4o',
  input_token_price: '2.50000000',
  output_token_price: '10.00000000',
  cache_read_token_price: '1.25000000',
  cache_write_token_price: '0.00000000',
  currency: 'USD',
  effective_from: new Date('2026-06-01T00:00:00Z'),
  enabled: true,
  created_at: new Date('2026-06-01T00:00:00Z'),
  updated_at: new Date('2026-06-01T00:00:00Z'),
}

function app() {
  return createApp(new MockGateway('mcp-server') as never)
}

function authed(method: 'get' | 'post' | 'put' | 'delete', path: string) {
  return request(app())[method](path).set('Cookie', 'control_ui_admin_session=admin-token')
}

describe('admin llm-prices routes', () => {
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
    await request(app()).get('/api/v1/admin/llm-prices').expect(401)
  })

  it('GET /admin/llm-prices returns rows with numeric prices', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [PRICE_ROW], rowCount: 1 })
    const res = await authed('get', '/api/v1/admin/llm-prices').expect(200)
    expect(res.body.rows).toHaveLength(1)
    expect(res.body.rows[0]).toMatchObject({
      id: PRICE_ROW.id,
      provider: 'openai',
      model: 'gpt-4o',
      input_token_price: 2.5,
      output_token_price: 10,
      cache_read_token_price: 1.25,
      cache_write_token_price: 0,
      currency: 'USD',
      enabled: true,
    })
  })

  it('GET /admin/llm-prices/unpriced surfaces usage models without an enabled price', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ provider: 'claude', model: 'claude-3-opus' }],
      rowCount: 1,
    })
    const res = await authed('get', '/api/v1/admin/llm-prices/unpriced').expect(200)
    expect(res.body.rows).toEqual([{ provider: 'claude', model: 'claude-3-opus' }])
    const [sql] = mockPoolQuery.mock.calls[0]
    expect(String(sql)).toMatch(/NOT EXISTS/)
    expect(String(sql)).toMatch(/usage_daily/)
    expect(String(sql)).toMatch(/usage_5min/)
  })

  it('GET /admin/llm-prices/:id returns 404 when missing', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await authed('get', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`).expect(404)
  })

  it('GET /admin/llm-prices/:id returns 404 for a non-UUID id without hitting the DB', async () => {
    await authed('get', '/api/v1/admin/llm-prices/not-a-uuid').expect(404)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('POST /admin/llm-prices creates a price (cache prices default to 0)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [PRICE_ROW], rowCount: 1 })
    const res = await authed('post', '/api/v1/admin/llm-prices')
      .send({ provider: 'openai', model: 'gpt-4o', input_token_price: 2.5, output_token_price: 10 })
      .expect(201)
    expect(res.body.provider).toBe('openai')
    const [, params] = mockPoolQuery.mock.calls[0]
    // cache_read/write default to 0
    expect(params).toEqual(['openai', 'gpt-4o', 2.5, 10, 0, 0, 'USD', true])
  })

  it('POST /admin/llm-prices rejects a negative price with 400', async () => {
    const res = await authed('post', '/api/v1/admin/llm-prices')
      .send({ provider: 'openai', model: 'gpt-4o', input_token_price: -1, output_token_price: 10 })
      .expect(400)
    expect(res.body.error).toBe('invalid_request')
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('POST /admin/llm-prices rejects a missing provider with 400', async () => {
    await authed('post', '/api/v1/admin/llm-prices')
      .send({ model: 'gpt-4o', input_token_price: 1, output_token_price: 2 })
      .expect(400)
  })

  it('POST /admin/llm-prices maps a unique violation to 409', async () => {
    mockPoolQuery.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
    const res = await authed('post', '/api/v1/admin/llm-prices')
      .send({ provider: 'openai', model: 'gpt-4o', input_token_price: 2.5, output_token_price: 10 })
      .expect(409)
    expect(res.body.error).toBe('conflict')
  })

  it('PUT /admin/llm-prices/:id updates provided fields and bumps updated_at', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ ...PRICE_ROW, output_token_price: '12.00000000' }],
      rowCount: 1,
    })
    const res = await authed('put', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`)
      .send({ output_token_price: 12 })
      .expect(200)
    expect(res.body.output_token_price).toBe(12)
    const [sql, params] = mockPoolQuery.mock.calls[0]
    expect(String(sql)).toMatch(/output_token_price = \$1/)
    expect(String(sql)).toMatch(/updated_at = NOW\(\)/)
    expect(params).toEqual([12, PRICE_ROW.id])
  })

  it('PUT /admin/llm-prices/:id rejects an empty body with 400', async () => {
    await authed('put', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`).send({}).expect(400)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('PUT /admin/llm-prices/:id rejects unknown fields with 400', async () => {
    await authed('put', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`)
      .send({ provider: 'openai', bogus: 1 })
      .expect(400)
  })

  it('PUT /admin/llm-prices/:id returns 404 when the row is missing', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await authed('put', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`)
      .send({ enabled: false })
      .expect(404)
  })

  it('DELETE /admin/llm-prices/:id returns 204 on success', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [PRICE_ROW], rowCount: 1 }) // getLlmPrice
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // findCostBudgetsPinningModel → none
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // deleteLlmPrice
    await authed('delete', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`).expect(204)
  })

  it('DELETE /admin/llm-prices/:id returns 404 when the price is missing', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }) // getLlmPrice → none
    await authed('delete', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`).expect(404)
  })

  it('DELETE /admin/llm-prices/:id returns 409 when a cost budget pins the model', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [PRICE_ROW], rowCount: 1 }) // getLlmPrice
      .mockResolvedValueOnce({ rows: [{ id: 'b1', name: 'cap' }], rowCount: 1 }) // budgets pin it
    const res = await authed('delete', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`).expect(409)
    expect(res.body.error).toBe('price_in_use_by_budget')
    expect(res.body.budgets).toEqual([{ id: 'b1', name: 'cap' }])
    // The price row is left intact — no DELETE ran.
    const del = mockPoolQuery.mock.calls.find(c =>
      /DELETE FROM llm_model_prices/.test(String(c[0]))
    )
    expect(del).toBeUndefined()
  })

  it('PUT /admin/llm-prices/:id returns 409 when disabling a price a cost budget pins', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [PRICE_ROW], rowCount: 1 }) // getLlmPrice (enabled)
      .mockResolvedValueOnce({ rows: [{ id: 'b1', name: 'cap' }], rowCount: 1 }) // budgets pin it
    const res = await authed('put', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`)
      .send({ enabled: false })
      .expect(409)
    expect(res.body.error).toBe('price_in_use_by_budget')
    const upd = mockPoolQuery.mock.calls.find(c => /UPDATE llm_model_prices/.test(String(c[0])))
    expect(upd).toBeUndefined()
  })

  it('PUT /admin/llm-prices/:id allows disabling when no cost budget pins the model', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [PRICE_ROW], rowCount: 1 }) // getLlmPrice
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no budgets pin it
      .mockResolvedValueOnce({ rows: [{ ...PRICE_ROW, enabled: false }], rowCount: 1 }) // update
    const res = await authed('put', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`)
      .send({ enabled: false })
      .expect(200)
    expect(res.body.enabled).toBe(false)
  })

  it('PUT /admin/llm-prices/:id returns 409 when re-keying a price a cost budget pins', async () => {
    // Changing provider/model moves the active row off the OLD (provider, model)
    // that cost budgets pinned — a delete in disguise, so it must 409 too.
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [PRICE_ROW], rowCount: 1 }) // getLlmPrice (openai/gpt-4o)
      .mockResolvedValueOnce({ rows: [{ id: 'b1', name: 'cap' }], rowCount: 1 }) // budgets pin OLD key
    const res = await authed('put', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`)
      .send({ provider: 'anthropic' })
      .expect(409)
    expect(res.body.error).toBe('price_in_use_by_budget')
    // The budget lookup used the OLD key (existing.provider/model), and no UPDATE ran.
    const budgetCall = mockPoolQuery.mock.calls.find(c => /FROM token_budgets/.test(String(c[0])))
    expect(budgetCall![1] as unknown[]).toEqual(['openai', 'gpt-4o'])
    const upd = mockPoolQuery.mock.calls.find(c => /UPDATE llm_model_prices/.test(String(c[0])))
    expect(upd).toBeUndefined()
  })

  it('PUT /admin/llm-prices/:id allows re-keying when no cost budget pins the old model', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [PRICE_ROW], rowCount: 1 }) // getLlmPrice
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no budgets pin OLD key
      .mockResolvedValueOnce({ rows: [{ ...PRICE_ROW, model: 'gpt-4o-mini' }], rowCount: 1 }) // update
    const res = await authed('put', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`)
      .send({ model: 'gpt-4o-mini' })
      .expect(200)
    expect(res.body.model).toBe('gpt-4o-mini')
  })

  it('PUT /admin/llm-prices/:id does NOT guard a non-key edit (amounts only)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [PRICE_ROW], rowCount: 1 }) // updateLlmPrice only
    await authed('put', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`)
      .send({ output_token_price: 12 })
      .expect(200)
    // No pre-fetch / budget lookup: the first (and only) query is the UPDATE.
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    expect(String(mockPoolQuery.mock.calls[0][0])).toMatch(/UPDATE llm_model_prices/)
  })

  it('PUT /admin/llm-prices/:id does NOT 409 on a no-op re-set of the same key', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [PRICE_ROW], rowCount: 1 }) // getLlmPrice (provider provided)
      .mockResolvedValueOnce({ rows: [PRICE_ROW], rowCount: 1 }) // update (key unchanged → no budget lookup)
    await authed('put', `/api/v1/admin/llm-prices/${PRICE_ROW.id}`)
      .send({ provider: 'openai' }) // same as existing → not a real re-key
      .expect(200)
    const budgetCall = mockPoolQuery.mock.calls.find(c => /FROM token_budgets/.test(String(c[0])))
    expect(budgetCall).toBeUndefined()
  })
})
