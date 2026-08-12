import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  authenticatedExternalUserRateLimit,
  preAuthExternalUserRateLimit,
} from '../src/middleware/externalUserRateLimitPolicy.js'

const limiter = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))
vi.mock('../src/services/rateLimiterService.js', () => limiter)

const operations = [
  ['session_lifecycle', 'external_session_lifecycle'],
  ['invitation_mutation', 'external_invitation_mutation'],
  ['invitation_sensitive_action', 'external_invitation_sensitive_action'],
  ['invitation_read', 'external_invitation_read'],
  ['access_capabilities', 'external_access_capabilities'],
] as const

function allowedResult() {
  return {
    allowed: true,
    remaining: 9,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  }
}

describe('external user rate-limit policy', () => {
  it.each(operations)(
    'keys authenticated %s by the server-authenticated user',
    async (operation, bucket) => {
      limiter.checkAndIncrement.mockResolvedValueOnce(allowedResult())
      const app = express()
      app.use((req, _res, next) => {
        ;(req as express.Request & { externalAuth?: { userId: string } }).externalAuth = {
          userId: 'server-user',
        }
        next()
      })
      app.get('/protected', authenticatedExternalUserRateLimit(operation), (_req, res) => {
        res.status(204).end()
      })

      await request(app)
        .get('/protected')
        .set('x-user-session-token', 'never-used-as-a-key')
        .expect(204)

      expect(limiter.checkAndIncrement).toHaveBeenLastCalledWith(`${bucket}:user:server-user`, 10)
    }
  )

  it('uses a bounded IP fallback before authentication without reading the session token', async () => {
    limiter.checkAndIncrement.mockResolvedValueOnce(allowedResult())
    const app = express()
    app.get('/pre-auth', preAuthExternalUserRateLimit('session_lifecycle'), (_req, res) => {
      res.status(204).end()
    })

    await request(app)
      .get('/pre-auth')
      .set('x-forwarded-for', '198.51.100.52')
      .set('x-user-session-token', 'never-used-as-a-key')
      .expect(204)

    expect(limiter.checkAndIncrement).toHaveBeenLastCalledWith(
      expect.stringMatching(/^external_session_lifecycle:ip:/),
      10
    )
    expect(limiter.checkAndIncrement.mock.calls.at(-1)?.[0]).not.toContain('never-used-as-a-key')
  })
})
