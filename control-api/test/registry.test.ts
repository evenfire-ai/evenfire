import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'
import request from 'supertest'
import { config } from '../src/config.js'
// Imported after mocks so the route file picks up the mocked deps.
import { createRegistryRouter } from '../src/routes/registry.js'

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

// Voucher v2 requires mode-aware signing material. registry.test.ts uses the
// REAL config + real mintIdentityVoucher (only db/auth are mocked), so — per
// review correction C-I2 — inject managed-mode v2 material here (else every
// mint throws VoucherUnavailableError → 500 and the 429/200 tests fail).
function voucherKeypair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

describe('POST /registry/identity-voucher', () => {
  const origMode = config.registryConnectionMode
  const origKey = config.registryVoucherPrivateKey
  const origKid = config.registryVoucherKid

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
    // C-I2: managed-mode v2 material so mintIdentityVoucher succeeds.
    const { privateKey } = voucherKeypair()
    ;(config as Record<string, unknown>).registryConnectionMode = 'managed'
    ;(config as Record<string, unknown>).registryVoucherPrivateKey = privateKey
    ;(config as Record<string, unknown>).registryVoucherKid = 'key-uuid-default'
  })

  afterEach(() => {
    ;(config as Record<string, unknown>).registryConnectionMode = origMode
    ;(config as Record<string, unknown>).registryVoucherPrivateKey = origKey
    ;(config as Record<string, unknown>).registryVoucherKid = origKid
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

  it('returns 200 with a voucher-v2 JWT (kid header, minimal payload)', async () => {
    const { privateKey, publicKey } = voucherKeypair()
    ;(config as Record<string, unknown>).registryConnectionMode = 'managed'
    ;(config as Record<string, unknown>).registryVoucherPrivateKey = privateKey
    ;(config as Record<string, unknown>).registryVoucherKid = 'key-uuid-77'
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

    const header = jwt.decode(res.body.voucher, { complete: true })!.header
    expect(header.kid).toBe('key-uuid-77')

    const payload = jwt.verify(res.body.voucher, publicKey, {
      algorithms: ['RS256'],
      issuer: 'control-api',
      audience: 'registry-api',
    }) as jwt.JwtPayload
    expect(payload.iss).toBe('control-api')
    expect(payload.aud).toBe('registry-api')
    expect(payload.sub).toBe('admin-uuid-123')
    // v2 drops the synthetic identity + iat.
    expect(payload.username).toBeUndefined()
    expect(payload.email).toBeUndefined()
    expect(payload.iat).toBeUndefined()
    expect(typeof payload.jti).toBe('string')
    expect((payload.jti as string).length).toBeGreaterThan(0)
    expect(typeof payload.exp).toBe('number')
    expect((payload.exp as number) - Math.floor(Date.now() / 1000)).toBeGreaterThan(0)
    expect((payload.exp as number) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60)
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
})
