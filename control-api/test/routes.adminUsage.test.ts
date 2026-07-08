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

const TEST_NOW = new Date('2026-05-07T00:00:00.000Z')

function authedGet(path: string) {
  const app = createApp(new MockGateway('mcp-server') as never)
  return request(app).get(path).set('Cookie', 'control_ui_admin_session=admin-token')
}

describe('GET /api/v1/admin/usage/llm', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TEST_NOW)
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
    vi.useRealTimers()
  })

  it('rejects unauthenticated requests with 401', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)
    await request(app)
      .get(
        '/api/v1/admin/usage/llm?from=2026-05-06T00:00:00Z&to=2026-05-06T12:00:00Z&interval=5min&groupBy=model'
      )
      .expect(401)
  })

  it('rejects when admin token verification returns null', async () => {
    mockVerifyAdminToken.mockReturnValueOnce(null)
    await authedGet(
      '/api/v1/admin/usage/llm?from=2026-05-06T00:00:00Z&to=2026-05-06T12:00:00Z&interval=5min&groupBy=model'
    ).expect(401)
  })

  it('rejects when interval is missing or unsupported', async () => {
    await authedGet(
      '/api/v1/admin/usage/llm?from=2026-05-06T00:00:00Z&to=2026-05-06T12:00:00Z&groupBy=model'
    ).expect(400)
    await authedGet(
      '/api/v1/admin/usage/llm?from=2026-05-06T00:00:00Z&to=2026-05-06T12:00:00Z&interval=events&groupBy=model'
    ).expect(400)
  })

  it('rejects unknown groupBy (no SQL identifier injection)', async () => {
    const res = await authedGet(
      '/api/v1/admin/usage/llm?from=2026-05-06T00:00:00Z&to=2026-05-06T12:00:00Z&interval=5min&groupBy=request_count'
    ).expect(400)
    expect(res.body.error).toBe('invalid_query')
  })

  it('rejects from >= to', async () => {
    await authedGet(
      '/api/v1/admin/usage/llm?from=2026-05-06T12:00:00Z&to=2026-05-06T00:00:00Z&interval=5min&groupBy=model'
    ).expect(400)
  })

  it('rejects when range exceeds tier retention', async () => {
    const longAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    const now = new Date().toISOString()
    const res = await authedGet(
      `/api/v1/admin/usage/llm?from=${encodeURIComponent(longAgo)}&to=${encodeURIComponent(now)}&interval=5min&groupBy=model`
    ).expect(400)
    expect(res.body.error).toBe('range_too_old_for_interval')
  })

  it('returns the rows shape on the happy path', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          bucket: new Date('2026-05-06T00:05:00Z'),
          group_col: 'gpt-4o',
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 40,
          cache_write_tokens: 10,
          total_tokens: 150,
          request_count: 1,
        },
      ],
      rowCount: 1,
    })
    const res = await authedGet(
      '/api/v1/admin/usage/llm?from=2026-05-06T00:00:00Z&to=2026-05-06T12:00:00Z&interval=5min&groupBy=model'
    ).expect(200)
    expect(res.body).toEqual({
      from: '2026-05-06T00:00:00.000Z',
      to: '2026-05-06T12:00:00.000Z',
      interval: '5min',
      groupBy: 'model',
      rows: [
        {
          bucket: '2026-05-06T00:05:00.000Z',
          group: 'gpt-4o',
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 40,
          cache_write_tokens: 10,
          total_tokens: 150,
          request_count: 1,
        },
      ],
    })
  })

  it('threads filters JSON through to the query', async () => {
    const filters = JSON.stringify({ host_ref: ['chatllm'], source_kind: ['workflow'] })
    await authedGet(
      `/api/v1/admin/usage/llm?from=2026-05-06T00:00:00Z&to=2026-05-06T12:00:00Z&interval=5min&groupBy=recipe_name&filters=${encodeURIComponent(filters)}`
    ).expect(200)
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    const [, params] = mockPoolQuery.mock.calls[0]
    expect(params).toEqual([
      '2026-05-06T00:00:00.000Z',
      '2026-05-06T12:00:00.000Z',
      'chatllm',
      'workflow',
    ])
  })

  it('rejects filters JSON whose keys are not in the allowlist', async () => {
    const filters = JSON.stringify({ injected_column: ['x'] })
    const res = await authedGet(
      `/api/v1/admin/usage/llm?from=2026-05-06T00:00:00Z&to=2026-05-06T12:00:00Z&interval=5min&groupBy=model&filters=${encodeURIComponent(filters)}`
    ).expect(400)
    expect(res.body.error).toBe('invalid_query')
  })

  it('rejects malformed filters JSON', async () => {
    await authedGet(
      `/api/v1/admin/usage/llm?from=2026-05-06T00:00:00Z&to=2026-05-06T12:00:00Z&interval=5min&groupBy=model&filters=${encodeURIComponent('not json')}`
    ).expect(400)
  })
})

describe('GET /api/v1/admin/usage/llm/totals', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TEST_NOW)
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
    vi.useRealTimers()
  })

  it('rejects unauthenticated', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)
    await request(app)
      .get(
        '/api/v1/admin/usage/llm/totals?from=2026-05-06T00:00:00Z&to=2026-05-06T12:00:00Z&interval=5min&groupBy=model'
      )
      .expect(401)
  })

  it('rejects unknown groupBy', async () => {
    await authedGet(
      '/api/v1/admin/usage/llm/totals?from=2026-05-06T00:00:00Z&to=2026-05-06T12:00:00Z&interval=5min&groupBy=hax'
    ).expect(400)
  })

  it('returns top-N rows ordered by total_tokens desc', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          group_col: 'team-a',
          input_tokens: 500,
          output_tokens: 300,
          cache_read_tokens: 200,
          cache_write_tokens: 25,
          total_tokens: 800,
          request_count: 5,
        },
        {
          group_col: null,
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 150,
          request_count: 1,
        },
      ],
      rowCount: 2,
    })
    const res = await authedGet(
      '/api/v1/admin/usage/llm/totals?from=2026-05-06T00:00:00Z&to=2026-05-06T12:00:00Z&interval=5min&groupBy=team_id&limit=10'
    ).expect(200)
    expect(res.body.rows).toEqual([
      {
        group: 'team-a',
        input_tokens: 500,
        output_tokens: 300,
        cache_read_tokens: 200,
        cache_write_tokens: 25,
        total_tokens: 800,
        request_count: 5,
      },
      {
        group: null,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 150,
        request_count: 1,
      },
    ])
    const [sql] = mockPoolQuery.mock.calls[0]
    expect(String(sql)).toMatch(/LIMIT 10/)
  })

  it('rejects non-positive limit', async () => {
    await authedGet(
      '/api/v1/admin/usage/llm/totals?from=2026-05-06T00:00:00Z&to=2026-05-06T12:00:00Z&interval=5min&groupBy=team_id&limit=0'
    ).expect(400)
  })
})
