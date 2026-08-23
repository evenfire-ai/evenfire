import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  adminCodexReadRateLimits,
  adminCodexWriteRateLimits,
  adminOutputsReadRateLimits,
  adminWorkflowRateLimitCredential,
  adminWorkflowTriggerRateLimit,
  codexOAuthCallbackRateLimits,
  llmProviderAttemptAuthorizeRateLimits,
  shouldSkipWorkflowGrantEdgeRateLimit,
  verifiedAdminRateLimitSubject,
  workflowAdminReadRateLimits,
  workflowGrantEdgeRateLimitKey,
  workflowGrantReadRateLimit,
  workflowGrantReadRateLimits,
  workflowGrantWriteRateLimits,
} from '../src/routes/workflows/shared/rateLimit.js'

const mockCheckAndIncrement = vi.hoisted(() => vi.fn())
const mockVerifyAdminToken = vi.hoisted(() => vi.fn())

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: (...args: unknown[]) => mockCheckAndIncrement(...args),
}))
vi.mock('../src/observability/metrics.js', () => ({
  rateLimitHitsTotal: { inc: vi.fn() },
}))
vi.mock('../src/utils/auth/adminAuthToken.js', () => ({
  verifyAdminToken: (token: string) => mockVerifyAdminToken(token),
}))

function signedClaims(sub: string) {
  return {
    sub,
    typ: 'user' as const,
    role: 'admin' as const,
    jti: 'jti',
    exp: 1,
    sessionVersion: 0,
  }
}

function pgAllows() {
  mockCheckAndIncrement.mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  })
}

describe('routes/workflows/shared/rateLimit', () => {
  beforeEach(() => {
    mockVerifyAdminToken.mockImplementation((token: string) =>
      token.startsWith('signed-') ? signedClaims(token.slice('signed-'.length)) : null
    )
  })

  it('adminWorkflowRateLimitCredential accepts HttpOnly admin session cookies', () => {
    const req = {
      header(name: string) {
        if (name.toLowerCase() === 'cookie') {
          return 'control_ui_admin_session=admin-cookie-token'
        }
        return undefined
      },
    } as express.Request

    expect(adminWorkflowRateLimitCredential(req)).toBe('admin-cookie-token')
  })

  it('llmProviderAttemptAuthorizeRateLimits meters callers before JWT is attached', async () => {
    mockCheckAndIncrement.mockReset()
    const app = express()
    app.post('/authorize', ...llmProviderAttemptAuthorizeRateLimits(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    for (let i = 0; i < 60; i++) {
      pgAllows()
      await request(app).post('/authorize').expect(200)
    }
    pgAllows()
    const res = await request(app).post('/authorize').expect(429)
    expect(res.body).toMatchObject({
      error: 'Too Many Requests',
      retryAfterSeconds: expect.any(Number),
    })
  })

  it('rate-limit factories pair an edge backstop with the PG limiter', () => {
    expect(workflowGrantReadRateLimits()).toHaveLength(2)
    expect(workflowGrantWriteRateLimits()).toHaveLength(2)
    expect(workflowAdminReadRateLimits()).toHaveLength(2)
    expect(adminOutputsReadRateLimits()).toHaveLength(2)
    expect(adminCodexReadRateLimits()).toHaveLength(2)
    expect(adminCodexWriteRateLimits()).toHaveLength(2)
    expect(codexOAuthCallbackRateLimits()).toHaveLength(2)
    expect(llmProviderAttemptAuthorizeRateLimits()).toHaveLength(2)
  })

  it('shouldSkipWorkflowGrantEdgeRateLimit skips anonymous callers', () => {
    const req = { header: () => undefined, ip: '203.0.113.10' } as express.Request
    expect(shouldSkipWorkflowGrantEdgeRateLimit(req)).toBe(true)
  })

  it('verifiedAdminRateLimitSubject ignores unverified cookies and bearers', () => {
    expect(verifiedAdminRateLimitSubject('forged-cookie')).toBeNull()
    expect(verifiedAdminRateLimitSubject('signed-admin-a')).toBe('admin-a')
  })

  it('workflowGrantEdgeRateLimitKey isolates verified admin subjects on the same IP', () => {
    const reqA = {
      ip: '203.0.113.10',
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'control_ui_admin_session=signed-admin-a' : undefined,
    } as express.Request
    const reqB = {
      ip: '203.0.113.10',
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'control_ui_admin_session=signed-admin-b' : undefined,
    } as express.Request

    expect(workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqA)).not.toBe(
      workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqB)
    )
  })

  it('keeps rotated signed sessions in separate pre-auth buckets', () => {
    mockVerifyAdminToken.mockImplementation((value: string) =>
      value.startsWith('signed-') ? signedClaims('same-admin') : null
    )
    const reqA = {
      ip: '203.0.113.10',
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'control_ui_admin_session=signed-admin-a' : undefined,
    } as express.Request
    const reqB = {
      ip: '203.0.113.10',
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'control_ui_admin_session=signed-admin-b' : undefined,
    } as express.Request

    expect(workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqA)).not.toBe(
      workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqB)
    )
  })

  it('workflowGrantEdgeRateLimitKey aggregates unverified cookies on the same IP', () => {
    const reqA = {
      ip: '203.0.113.10',
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'control_ui_admin_session=cookie-a' : undefined,
    } as express.Request
    const reqB = {
      ip: '203.0.113.10',
      header: (name: string) =>
        name.toLowerCase() === 'cookie' ? 'control_ui_admin_session=cookie-b' : undefined,
    } as express.Request

    expect(workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqA)).toBe(
      workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqB)
    )
  })

  it('workflowGrantEdgeRateLimitKey buckets distinct bogus bearer tokens from the same IP', () => {
    const reqA = {
      ip: '203.0.113.10',
      header: () => 'Bearer token-a',
    } as express.Request
    const reqB = {
      ip: '203.0.113.10',
      header: () => 'Bearer token-b',
    } as express.Request

    expect(workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqA)).toBe(
      workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqB)
    )
  })

  it.each([
    {
      label: 'workflowGrantWriteRateLimits',
      method: 'put' as const,
      limit: 20,
      cookie: 'write-edge-cookie',
      mount: (app: express.Express) => {
        app.put('/probe', ...workflowGrantWriteRateLimits(), (_req, res) => {
          res.status(200).json({ ok: true })
        })
      },
    },
    {
      label: 'workflowGrantReadRateLimits',
      method: 'get' as const,
      limit: 60,
      cookie: 'grant-read-edge-cookie',
      mount: (app: express.Express) => {
        app.get('/probe', ...workflowGrantReadRateLimits(), (_req, res) => {
          res.status(200).json({ ok: true })
        })
      },
    },
    {
      label: 'workflowAdminReadRateLimits',
      method: 'get' as const,
      limit: 60,
      cookie: 'admin-read-edge-cookie',
      mount: (app: express.Express) => {
        app.get('/probe', ...workflowAdminReadRateLimits(), (_req, res) => {
          res.status(200).json({ ok: true })
        })
      },
    },
    {
      label: 'adminOutputsReadRateLimits',
      method: 'get' as const,
      limit: 30,
      cookie: 'outputs-read-edge-cookie',
      mount: (app: express.Express) => {
        app.get('/probe', ...adminOutputsReadRateLimits(), (_req, res) => {
          res.status(200).json({ ok: true })
        })
      },
    },
  ])(
    '$label returns 429 from the real edge factory after the quota',
    async ({ method, limit, cookie, mount }) => {
      mockCheckAndIncrement.mockReset()

      const app = express()
      mount(app)

      for (let i = 0; i < limit; i++) {
        pgAllows()
        await request(app)
          [method]('/probe')
          .set('Cookie', `control_ui_admin_session=${cookie}`)
          .expect(200)
      }

      pgAllows()
      const res = await request(app)
        [method]('/probe')
        .set('Cookie', `control_ui_admin_session=${cookie}`)
        .expect(429)

      expect(res.body).toMatchObject({
        error: 'Too Many Requests',
        retryAfterSeconds: expect.any(Number),
      })
      expect(res.headers['retry-after']).toBeDefined()
    }
  )

  it('workflowGrantWriteRateLimits does not edge-limit anonymous callers', async () => {
    mockCheckAndIncrement.mockReset()

    const app = express()
    app.put('/grants', ...workflowGrantWriteRateLimits(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    for (let i = 0; i < 25; i++) {
      await request(app).put('/grants').expect(200)
    }
  })

  it('workflowGrantWriteRateLimits aggregates unverified cookie rotation on the same IP', async () => {
    mockCheckAndIncrement.mockReset()

    const app = express()
    app.put('/grants', ...workflowGrantWriteRateLimits(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    for (let i = 0; i < 20; i++) {
      pgAllows()
      await request(app)
        .put('/grants')
        .set('Cookie', `control_ui_admin_session=forged-${i}`)
        .expect(200)
    }

    pgAllows()
    const res = await request(app)
      .put('/grants')
      .set('Cookie', 'control_ui_admin_session=forged-final')
      .expect(429)

    expect(res.body).toMatchObject({
      error: 'Too Many Requests',
      retryAfterSeconds: expect.any(Number),
    })
  })

  it('workflowGrantReadRateLimit reuses one IP PG bucket for rotated unverified cookies', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 59,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const app = express()
    app.get('/grants', workflowGrantReadRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .get('/grants')
      .set('Cookie', 'control_ui_admin_session=forged-cookie-a')
      .expect(200)
    await request(app)
      .get('/grants')
      .set('Cookie', 'control_ui_admin_session=forged-cookie-b')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(2)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toMatch(/^workflow_grants_read:ip:/)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toBe(mockCheckAndIncrement.mock.calls[1]?.[0])
  })

  it('workflowTriggerRateLimit reuses one IP PG bucket for rotated unverified cookies', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const { workflowTriggerRateLimit } = await import('../src/routes/workflows/shared/rateLimit.js')
    const app = express()
    app.post('/trigger', workflowTriggerRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .post('/trigger')
      .set('Cookie', 'control_ui_admin_session=forged-cookie-a')
      .expect(200)
    await request(app)
      .post('/trigger')
      .set('Cookie', 'control_ui_admin_session=forged-cookie-b')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(2)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toBe(mockCheckAndIncrement.mock.calls[1]?.[0])
  })

  it('workflowTriggerRateLimit meters cookie-only admin workflow triggers', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const { workflowTriggerRateLimit } = await import('../src/routes/workflows/shared/rateLimit.js')
    const app = express()
    app.post('/trigger', workflowTriggerRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .post('/trigger')
      .set('Cookie', 'control_ui_admin_session=signed-admin-cookie')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledOnce()
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
  })

  it('adminWorkflowTriggerRateLimit isolates rotated signed sessions', async () => {
    mockVerifyAdminToken.mockImplementation((value: string) =>
      value.startsWith('signed-') ? signedClaims('same-admin') : null
    )
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const app = express()
    app.post('/trigger', adminWorkflowTriggerRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .post('/trigger')
      .set('Cookie', 'control_ui_admin_session=signed-admin-a')
      .expect(200)
    await request(app)
      .post('/trigger')
      .set('Cookie', 'control_ui_admin_session=signed-admin-b')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledTimes(2)
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).not.toBe(
      mockCheckAndIncrement.mock.calls[1]?.[0]
    )
  })

  it('workflowGrantReadRateLimit meters cookie-only admin workflow callers', async () => {
    mockCheckAndIncrement.mockReset()
    mockCheckAndIncrement.mockResolvedValue({
      allowed: true,
      remaining: 59,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    })

    const app = express()
    app.get('/grants', workflowGrantReadRateLimit(), (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app)
      .get('/grants')
      .set('Cookie', 'control_ui_admin_session=signed-admin-cookie')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledOnce()
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toMatch(/^workflow_grants_read:[0-9a-f]{32}$/)
  })
})
