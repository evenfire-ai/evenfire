import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import request from 'supertest'
import { config } from '../src/config.js'
// Imported after mocks so the route file picks up the mocked deps.
import { createRegistryRouter } from '../src/routes/registry.js'
import { registrySyntheticUsername } from '../src/services/registryVoucher.js'

// Mock adminAuthService so the route can fetch the admin's username from
// control_admin_users without touching pg. Mirrors the pattern in
// routes.adminAuth.test.ts which mocks the same service module.
const adminSvc = vi.hoisted(() => ({
  findAdminById: vi.fn(),
}))

// Mock controlUIAuth so the authenticated test path doesn't need to mint a
// real RS256 admin JWT. The unauthenticated test path uses a separate app
// instance with the real middleware (via createApp).
const uiAuth = vi.hoisted(() => ({
  requireAuthForControlUI: vi.fn((req: any, _res: any, next: any) => {
    req.adminAuth = {
      sub: 'admin-uuid-123',
      role: 'admin',
      jti: 'jti-1',
      exp: 9999999999,
      typ: 'user',
    }
    next()
  }),
}))

vi.mock('../src/services/adminAuthService.js', () => adminSvc)
vi.mock('../src/middleware/controlUIAuth.js', () => uiAuth)

// Mock the PG pool so the rate-limit middleware (which calls
// `rate_limit_buckets INSERT ... ON CONFLICT ... RETURNING count`) counts in
// memory instead of fail-opening on a DB error. Keyed on (bucketKey,
// windowStartMs) to match the real PG unique index — mirrors
// routes.mcp-host.renewal.refresh.rate-limit.test.ts.
const rateLimitCounts = new Map<string, number>()
const mockPoolQuery = vi.fn(async (sql: unknown, params?: unknown[]) => {
  const text = typeof sql === 'string' ? sql : ''
  if (/rate_limit_buckets/i.test(text)) {
    const bucketKey = Array.isArray(params) && typeof params[0] === 'string' ? params[0] : 'unknown'
    const windowStart = Array.isArray(params) && typeof params[1] === 'number' ? params[1] : 0
    const key = `${bucketKey}|${windowStart}`
    const next = (rateLimitCounts.get(key) ?? 0) + 1
    rateLimitCounts.set(key, next)
    return { rows: [{ count: next }], rowCount: 1 }
  }
  return { rows: [], rowCount: 0 }
})

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(args[0], args[1] as unknown[] | undefined),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

describe('POST /registry/identity-voucher', () => {
  beforeEach(() => {
    adminSvc.findAdminById.mockReset()
    uiAuth.requireAuthForControlUI.mockReset()
    uiAuth.requireAuthForControlUI.mockImplementation((req: any, _res: any, next: any) => {
      req.adminAuth = {
        sub: 'admin-uuid-123',
        role: 'admin',
        jti: 'jti-1',
        exp: 9999999999,
        typ: 'user',
      }
      next()
    })
    // Reset the in-memory rate-limit bucket so each test starts with a fresh
    // window — otherwise loops in other tests would consume this test's quota.
    rateLimitCounts.clear()
    mockPoolQuery.mockClear()
  })

  it('returns 401 when auth middleware rejects the request', async () => {
    // Simulate requireAuthForControlUI rejecting an unauthenticated caller.
    uiAuth.requireAuthForControlUI.mockImplementation((_req: any, res: any, _next: any) => {
      res.status(401).json({ error: 'unauthorized' })
    })

    const app = express()
    app.use(express.json())
    app.use(createRegistryRouter())

    const res = await request(app).post('/registry/identity-voucher').send({})
    expect(res.status).toBe(401)
  })

  it('returns 200 with a valid RS256 voucher JWT for authenticated admins', async () => {
    adminSvc.findAdminById.mockResolvedValue({
      id: 'admin-uuid-123',
      username: 'alice',
      role: 'admin',
      status: 'active',
    })

    const app = express()
    app.use(express.json())
    app.use(createRegistryRouter())

    const res = await request(app).post('/registry/identity-voucher').send({}).expect(200)

    expect(typeof res.body.voucher).toBe('string')

    // Voucher must be a valid RS256 JWT signed with the admin private key
    // (we verify with the matching public key derived from the same secret).
    const publicKey = createPublicKey(config.adminJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    })
    const payload = jwt.verify(res.body.voucher, publicKey, {
      algorithms: ['RS256'],
      issuer: 'control-api',
      audience: 'registry-api',
    }) as jwt.JwtPayload

    expect(payload.iss).toBe('control-api')
    expect(payload.aud).toBe('registry-api')
    expect(payload.sub).toBe('admin-uuid-123')
    // Synthetic registry identity is deployment-namespaced (see registrySyntheticUsername):
    // never a reserved bareword, unique per deployment.
    const expectedUsername = registrySyntheticUsername({ id: 'admin-uuid-123', username: 'alice' } as never)
    expect(payload.username).toBe(expectedUsername)
    expect(payload.email).toBe(`${expectedUsername}@control-api.local`)
    expect(typeof payload.jti).toBe('string')
    expect((payload.jti as string).length).toBeGreaterThan(0)
    expect(typeof payload.iat).toBe('number')
    expect(typeof payload.exp).toBe('number')
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(60)
    expect((payload.exp as number) - (payload.iat as number)).toBeGreaterThan(0)
  })

  it('returns 401 when the admin record cannot be found in the database', async () => {
    adminSvc.findAdminById.mockResolvedValue(null)

    const app = express()
    app.use(express.json())
    app.use(createRegistryRouter())

    const res = await request(app).post('/registry/identity-voucher').send({})
    expect(res.status).toBe(401)
  })

  it('rate-limits per-admin: 31st request in a minute returns 429', async () => {
    adminSvc.findAdminById.mockResolvedValue({
      id: 'admin-uuid-123',
      username: 'rl-admin',
      passwordHash: 'irrelevant',
      role: 'admin',
      status: 'active',
      failedAttempts: 0,
      lockedUntil: null,
    })

    const app = express()
    app.use(express.json())
    app.use(createRegistryRouter())

    // Drain the bucket. Cap is 30/min (set in the route definition).
    for (let i = 0; i < 30; i += 1) {
      const ok = await request(app).post('/registry/identity-voucher')
      expect(ok.status).toBe(200)
    }
    const denied = await request(app).post('/registry/identity-voucher')
    expect(denied.status).toBe(429)
  })

  it('rejects disabled admins with 401', async () => {
    adminSvc.findAdminById.mockResolvedValue({
      id: 'admin-uuid-123',
      username: 'locked-out-admin',
      passwordHash: 'irrelevant',
      role: 'admin',
      status: 'disabled',
      failedAttempts: 0,
      lockedUntil: null,
    })

    const app = express()
    app.use(express.json())
    app.use(createRegistryRouter())

    const res = await request(app).post('/registry/identity-voucher')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })

  describe('signing key precedence', () => {
    const originalKey = config.registryVoucherPrivateKey

    afterEach(() => {
      // Restore after each test to avoid leaking key state into other suites.
      ;(config as { registryVoucherPrivateKey: string }).registryVoucherPrivateKey = originalKey
    })

    it('signs with config.registryVoucherPrivateKey when it is set (not adminJwtPrivateKey)', async () => {
      // Generate a dedicated voucher keypair for this test.
      const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })

      // Inject the dedicated key.
      ;(config as { registryVoucherPrivateKey: string }).registryVoucherPrivateKey = privateKey

      adminSvc.findAdminById.mockResolvedValue({
        id: 'admin-uuid-123',
        username: 'alice',
        role: 'admin',
        status: 'active',
      })

      const app = express()
      app.use(express.json())
      app.use(createRegistryRouter())
      const res = await request(app).post('/registry/identity-voucher').send({}).expect(200)

      // Must verify against the dedicated public key, NOT the admin key.
      const payload = jwt.verify(res.body.voucher, publicKey, {
        algorithms: ['RS256'],
        issuer: 'control-api',
        audience: 'registry-api',
      }) as jwt.JwtPayload
      expect(payload.sub).toBe('admin-uuid-123')

      // Sanity: the admin key MUST NOT verify this voucher.
      const adminPubKey = createPublicKey(config.adminJwtPrivateKey).export({
        type: 'spki',
        format: 'pem',
      })
      expect(() =>
        jwt.verify(res.body.voucher, adminPubKey, {
          algorithms: ['RS256'],
          issuer: 'control-api',
          audience: 'registry-api',
        })
      ).toThrow()
    })
  })
})
