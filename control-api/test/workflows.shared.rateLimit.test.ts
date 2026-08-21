import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  adminOutputsReadRateLimits,
  adminWorkflowRateLimitCredential,
  shouldSkipWorkflowGrantEdgeRateLimit,
  workflowAdminReadRateLimits,
  workflowGrantEdgeRateLimitKey,
  workflowGrantReadRateLimit,
  workflowGrantReadRateLimits,
  workflowGrantWriteRateLimits,
} from '../src/routes/workflows/shared/rateLimit.js'

const mockCheckAndIncrement = vi.hoisted(() => vi.fn())

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: (...args: unknown[]) => mockCheckAndIncrement(...args),
}))
vi.mock('../src/observability/metrics.js', () => ({
  rateLimitHitsTotal: { inc: vi.fn() },
}))

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

  it('rate-limit factories pair an edge backstop with the PG limiter', () => {
    expect(workflowGrantReadRateLimits()).toHaveLength(2)
    expect(workflowGrantWriteRateLimits()).toHaveLength(2)
    expect(workflowAdminReadRateLimits()).toHaveLength(2)
    expect(adminOutputsReadRateLimits()).toHaveLength(2)
  })

  it('shouldSkipWorkflowGrantEdgeRateLimit skips anonymous callers', () => {
    const req = { header: () => undefined, ip: '203.0.113.10' } as express.Request
    expect(shouldSkipWorkflowGrantEdgeRateLimit(req)).toBe(true)
  })

  it('workflowGrantEdgeRateLimitKey isolates distinct admin cookies on the same IP', () => {
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

    expect(workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', reqA)).not.toBe(
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
      .set('Cookie', 'control_ui_admin_session=admin-cookie-token')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledOnce()
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
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
      .set('Cookie', 'control_ui_admin_session=admin-cookie-token')
      .expect(200)

    expect(mockCheckAndIncrement).toHaveBeenCalledOnce()
    expect(mockCheckAndIncrement.mock.calls[0]?.[0]).toMatch(/^workflow_grants_read:[0-9a-f]{32}$/)
  })
})
