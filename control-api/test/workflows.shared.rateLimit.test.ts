import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  adminWorkflowRateLimitCredential,
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
