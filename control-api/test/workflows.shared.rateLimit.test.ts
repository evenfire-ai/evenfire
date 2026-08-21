import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import request from 'supertest'
import {
  adminWorkflowRateLimitCredential,
  workflowGrantEdgeRateLimitKey,
  workflowGrantReadRateLimit,
} from '../src/routes/workflows/shared/rateLimit.js'

const mockCheckAndIncrement = vi.hoisted(() => vi.fn())

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: (...args: unknown[]) => mockCheckAndIncrement(...args),
}))
vi.mock('../src/observability/metrics.js', () => ({
  rateLimitHitsTotal: { inc: vi.fn() },
}))

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

  it('workflowGrantEdgeRateLimitKey buckets by IP regardless of bearer token', () => {
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

  it('edge backstop caps distinct bogus bearer tokens from the same IP', async () => {
    const edgeLimit = rateLimit({
      windowMs: 60_000,
      limit: 2,
      standardHeaders: false,
      legacyHeaders: false,
      keyGenerator: req => workflowGrantEdgeRateLimitKey('workflow_grants_read_edge', req),
      handler: (_req, res) => {
        res.status(429).json({ error: 'Too Many Requests' })
      },
    })

    const app = express()
    app.get('/grants', edgeLimit, (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app).get('/grants').set('Authorization', 'Bearer bogus-1').expect(200)
    await request(app).get('/grants').set('Authorization', 'Bearer bogus-2').expect(200)
    await request(app).get('/grants').set('Authorization', 'Bearer bogus-3').expect(429)
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
