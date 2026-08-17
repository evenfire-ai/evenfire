import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRateLimiter } from '../src/middleware/rateLimit.js'

describe('external-rest rate-limit route contracts', () => {
  it('keeps auth/me-style limiter instances isolated while preserving their own 429 envelope', async () => {
    const app = express()
    app.set('trust proxy', 1)
    app.get(
      '/auth/password-login',
      createRateLimiter({ windowMs: 60_000, maxRequests: 1, errorCode: 'auth_rate_limited' }),
      (_req, res) => res.status(200).json({ ok: true })
    )
    app.get(
      '/me/teams/directory',
      createRateLimiter({ windowMs: 60_000, maxRequests: 1, errorCode: 'directory_rate_limited' }),
      (_req, res) => res.status(200).json({ ok: true })
    )

    const ip = '198.51.100.40'
    await request(app).get('/auth/password-login').set('x-forwarded-for', ip).expect(200)
    await request(app).get('/me/teams/directory').set('x-forwarded-for', ip).expect(200)

    const authLimited = await request(app)
      .get('/auth/password-login')
      .set('x-forwarded-for', ip)
      .expect(429)
    expect(authLimited.body).toMatchObject({
      error: 'auth_rate_limited',
      retryAfterSeconds: expect.any(Number),
    })
    expect(authLimited.headers['retry-after']).toMatch(/^\d+$/)
    expect(authLimited.headers['x-ratelimit-limit']).toBe('1')
    expect(authLimited.headers['x-ratelimit-remaining']).toBe('0')

    const directoryLimited = await request(app)
      .get('/me/teams/directory')
      .set('x-forwarded-for', ip)
      .expect(429)
    expect(directoryLimited.body.error).toBe('directory_rate_limited')
    expect(directoryLimited.headers['x-ratelimit-limit']).toBe('1')
  })

  it('keys the default limiter by the trusted client IP rather than globally', async () => {
    const app = express()
    app.set('trust proxy', 1)
    app.get(
      '/invitations/token/:token',
      createRateLimiter({ windowMs: 60_000, maxRequests: 1 }),
      (_req, res) => res.status(200).json({ ok: true })
    )

    await request(app)
      .get('/invitations/token/one')
      .set('x-forwarded-for', '198.51.100.41')
      .expect(200)
    await request(app)
      .get('/invitations/token/two')
      .set('x-forwarded-for', '198.51.100.42')
      .expect(200)

    await request(app)
      .get('/invitations/token/three')
      .set('x-forwarded-for', '198.51.100.41')
      .expect(429)
  })
})
