import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  externalUserRateLimitOptions,
  requireAuthenticatedExternalUserRateLimitContext,
} from '../src/middleware/externalUserRateLimitPolicy.js'
import { rateLimitMiddleware } from '../src/middleware/rateLimitMiddleware.js'

const limiter = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }))
vi.mock('../src/services/rateLimiterService.js', () => limiter)

const operations = [
  ['session_lifecycle', 'external_session_lifecycle', 10],
  ['invitation_mutation', 'external_invitation_mutation', 10],
  ['invitation_sensitive_action', 'external_invitation_sensitive_action', 10],
  ['invitation_read', 'external_invitation_read', 10],
  ['access_capabilities', 'external_access_capabilities', 10],
  ['oauth_grant_read', 'external_oauth_grant_read', 30],
  ['oauth_grant_mutation', 'external_oauth_grant_mutation', 10],
  ['member_read', 'external_member_read', 30],
  ['member_mutation', 'external_member_mutation', 10],
  ['shared_filesystem_read', 'external_shared_filesystem_read', 30],
  ['workflow_approval_medium_read', 'external_workflow_approval_medium_read', 30],
  ['workflow_approval_medium_mutation', 'external_workflow_approval_medium_mutation', 10],
  ['notification_preference_read', 'external_notification_preference_read', 30],
  ['notification_preference_mutation', 'external_notification_preference_mutation', 10],
  ['authentication_attempt', 'external_authentication_attempt', 5],
  ['session_verify', 'external_session_verify', 10],
  ['rpc_token', 'external_rpc_token', 10],
  ['team_user_read', 'external_team_user_read', 30],
  ['team_user_mutation', 'external_team_user_mutation', 10],
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
    async (operation, bucket, maxPerMinute) => {
      limiter.checkAndIncrement.mockResolvedValueOnce(allowedResult())
      const app = express()
      app.use((req, _res, next) => {
        ;(req as express.Request & { externalAuth?: { userId: string } }).externalAuth = {
          userId: 'server-user',
        }
        next()
      })
      app.get(
        '/protected',
        requireAuthenticatedExternalUserRateLimitContext,
        rateLimitMiddleware(externalUserRateLimitOptions(operation, 'authenticated')),
        (_req, res) => {
          res.status(204).end()
        }
      )

      await request(app)
        .get('/protected')
        .set('x-user-session-token', 'never-used-as-a-key')
        .expect(204)

      expect(limiter.checkAndIncrement).toHaveBeenLastCalledWith(
        `${bucket}:user:server-user`,
        maxPerMinute
      )
    }
  )

  it('uses a bounded IP fallback before authentication without reading the session token', async () => {
    limiter.checkAndIncrement.mockResolvedValueOnce(allowedResult())
    const app = express()
    app.get(
      '/pre-auth',
      rateLimitMiddleware(externalUserRateLimitOptions('session_lifecycle', 'pre_auth')),
      (_req, res) => {
        res.status(204).end()
      }
    )

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
    app.get(
      '/pre-auth',
      rateLimitMiddleware(externalUserRateLimitOptions('session_lifecycle', 'pre_auth')),
      (_req, res) => {
        res.status(204).end()
      }
    )

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
    app.get(
      '/pre-auth',
      rateLimitMiddleware(externalUserRateLimitOptions('session_lifecycle', 'pre_auth')),
      (_req, res) => {
        res.status(204).end()
      }
    )

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
    app.get(
      '/protected',
      requireAuthenticatedExternalUserRateLimitContext,
      rateLimitMiddleware(externalUserRateLimitOptions('session_lifecycle', 'authenticated')),
      handler
    )

    const response = await request(app).get('/protected').expect(429)

    expect(response.body).toMatchObject({ error: { code: 'rate_limited', retryable: true } })
    expect(response.headers['retry-after']).toBeDefined()
    expect(response.headers['x-ratelimit-limit']).toBe('10')
    expect(handler).not.toHaveBeenCalled()
  })

  it('fails closed before the authenticated limiter when trusted context is absent', async () => {
    const handler = vi.fn((_req, res) => res.status(204).end())
    const app = express()
    app.get(
      '/protected',
      requireAuthenticatedExternalUserRateLimitContext,
      rateLimitMiddleware(externalUserRateLimitOptions('session_lifecycle', 'authenticated')),
      handler
    )

    await request(app).get('/protected').expect(401)

    expect(limiter.checkAndIncrement).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })
})
