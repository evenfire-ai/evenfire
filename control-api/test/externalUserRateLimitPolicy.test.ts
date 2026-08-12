import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  beforeEach(() => vi.clearAllMocks())

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
      app.get('/protected', ...authenticatedExternalUserRateLimit(operation), (_req, res) => {
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

  it('uses the client IP forwarded only by the authenticated external REST service', async () => {
    limiter.checkAndIncrement.mockResolvedValueOnce(allowedResult())
    const app = express()
    app.use((req, _res, next) => {
      req.internalService = { name: 'external-rest-api' }
      next()
    })
    app.get('/pre-auth', preAuthExternalUserRateLimit('session_lifecycle'), (_req, res) => {
      res.status(204).end()
    })

    await request(app).get('/pre-auth').set('x-evenfire-client-ip', '198.51.100.52').expect(204)

    expect(limiter.checkAndIncrement).toHaveBeenLastCalledWith(
      'external_session_lifecycle:ip:198.51.100.52',
      10
    )
  })

  it('does not trust a forwarded client IP from another internal service', async () => {
    limiter.checkAndIncrement.mockResolvedValueOnce(allowedResult())
    const app = express()
    app.use((req, _res, next) => {
      req.internalService = { name: 'rpc-proxy' }
      next()
    })
    app.get('/pre-auth', preAuthExternalUserRateLimit('session_lifecycle'), (_req, res) => {
      res.status(204).end()
    })

    await request(app).get('/pre-auth').set('x-evenfire-client-ip', '198.51.100.52').expect(204)

    expect(limiter.checkAndIncrement).toHaveBeenLastCalledWith(
      expect.not.stringContaining('198.51.100.52'),
      10
    )
  })

  it('uses canonical denial behavior and short-circuits the protected handler', async () => {
    limiter.checkAndIncrement.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 11,
    })
    const handler = vi.fn((_req, res) => res.status(204).end())
    const app = express()
    app.use((req, _res, next) => {
      ;(req as express.Request & { externalAuth?: { userId: string } }).externalAuth = {
        userId: 'server-user',
      }
      next()
    })
    app.get('/protected', ...authenticatedExternalUserRateLimit('session_lifecycle'), handler)

    const response = await request(app).get('/protected').expect(429)

    expect(response.body).toMatchObject({ error: { code: 'rate_limited', retryable: true } })
    expect(response.headers['retry-after']).toBeDefined()
    expect(response.headers['x-ratelimit-limit']).toBe('10')
    expect(handler).not.toHaveBeenCalled()
  })

  it('fails closed before the authenticated limiter when trusted context is absent', async () => {
    const handler = vi.fn((_req, res) => res.status(204).end())
    const app = express()
    app.get('/protected', ...authenticatedExternalUserRateLimit('session_lifecycle'), handler)

    await request(app).get('/protected').expect(401)

    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })
})
