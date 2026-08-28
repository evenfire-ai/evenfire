import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MockGateway } from './mockGateway.js'

/**
 * UT-2b (FIX-B wiring): a K8s 4xx raised by the gateway on a create with a VALID
 * metadata.name must be forwarded by the wired-in global handler with its real
 * status (here 409), NOT collapsed to 500. The valid name isolates the handler
 * under test from the FIX-A1 name validator.
 */

const mockPoolQuery = vi.fn()
const mockVerifyAdminToken = vi.fn()
const mockIsAdminTokenRevoked = vi.fn()
const mockFindAdminById = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
  // The Host-create path runs inside a carrier transaction that holds a
  // per-model-name advisory lock across the K8s write (R1-H3). Stub the
  // transaction primitives so the work runs inline and the gateway's raw K8s
  // 409 propagates to the global handler — matching routes.resources.test.ts.
  withTransaction: (work: (db: { query: (...a: unknown[]) => unknown }) => Promise<unknown>) =>
    work({ query: async () => ({ rows: [], rowCount: 0 }) }),
  advisoryLockModelName: async () => {},
  advisoryLockModelNames: async () => {},
  boundCarrierTransactionIdleTimeout: async () => {},
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

/** MockGateway whose Host create raises a raw K8s 409 (conflict on .code). */
class ConflictingCreateGateway extends MockGateway {
  override async createResource(
    plural: Parameters<MockGateway['createResource']>[0],
    body: Parameters<MockGateway['createResource']>[1],
    namespace?: string
  ): Promise<unknown> {
    if (plural === 'hosts') {
      const err = new Error('hosts "product-agent" already exists') as Error & { code: number }
      err.code = 409
      throw err
    }
    return super.createResource(plural, body, namespace)
  }
}

describe('routes/resources — K8s error forwarding (UT-2b)', () => {
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

  it('forwards a K8s 409 raised on Host create (valid name) as 409, not 500', async () => {
    const app = createApp(new ConflictingCreateGateway('mcp-host') as never)
    const res = await request(app)
      .post('/api/v1/admin/hosts')
      .set('Cookie', 'control_ui_admin_session=admin-token')
      .send({ metadata: { name: 'product-agent' }, spec: { contextRef: 'c1' } })
    expect(res.status).toBe(409)
  })
})
