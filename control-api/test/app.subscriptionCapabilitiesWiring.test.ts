import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { MockGateway } from './mockGateway.js'

const mockVerifyAdminToken = vi.fn()
const mockIsAdminTokenRevoked = vi.fn()
const mockFindAdminById = vi.fn()
const limiterQuery = vi.fn()

// The read limiter counts in the dedicated limiter pool; answer its upsert at
// the boundary so the request reaches the capabilities handler.
vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn() },
  rateLimitPool: { query: (...args: unknown[]) => limiterQuery(...args) },
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

const CAPABILITIES = '/api/v1/admin/llm/providers/capabilities'

describe('subscription capability discovery wiring through createApp', () => {
  beforeEach(() => {
    mockVerifyAdminToken.mockReset()
    mockVerifyAdminToken.mockReturnValue(ADMIN_CLAIMS)
    mockIsAdminTokenRevoked.mockReset()
    mockIsAdminTokenRevoked.mockResolvedValue(false)
    mockFindAdminById.mockReset()
    mockFindAdminById.mockResolvedValue(ACTIVE_ADMIN)
    limiterQuery.mockReset()
    limiterQuery.mockResolvedValue({ rows: [{ count: 1 }], rowCount: 1 })
  })

  it('serves an authenticated administrator through the mounted, rate-limited router', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)
    const response = await request(app)
      .get(CAPABILITIES)
      .set('Cookie', 'control_ui_admin_session=admin-token')
      .expect(200)
    expect(response.body).toEqual({
      providers: {
        'codex-subscription': { enabled: config.codexSubscriptionEnabled },
        'grok-subscription': { enabled: config.grokSubscriptionEnabled },
      },
    })
    expect(response.headers['cache-control']).toBe('private, no-store')
    // The read family limiter counted this request in the limiter pool.
    expect(limiterQuery).toHaveBeenCalled()
    expect(String(limiterQuery.mock.calls[0]?.[1]?.[0])).toContain('admin_subscription_read:')
  })

  it('rejects the same route without a verified session', async () => {
    mockVerifyAdminToken.mockReturnValue(null)
    const app = createApp(new MockGateway('mcp-server') as never)
    await request(app).get(CAPABILITIES).expect(401)
    // Witness: the guard evaluated the presented cookie before refusing.
    await request(app)
      .get(CAPABILITIES)
      .set('Cookie', 'control_ui_admin_session=unverified-fixture')
      .expect(401)
    expect(mockVerifyAdminToken).toHaveBeenCalledWith('unverified-fixture')
  })
})
