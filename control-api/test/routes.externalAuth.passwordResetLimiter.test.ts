import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createHash } from 'node:crypto'
import request from 'supertest'

/**
 * `POST /external/auth/password-reset/request` is called before login and keys
 * its limiter on the submitted email. The email has no length bound before the
 * limiter, so it must enter the bucket key as a fixed-size digest: otherwise a
 * client can grow the limiter's storage with one oversized value per request.
 */

const limiterCalls = vi.hoisted(() => [] as Array<{ key: string; max: number }>)

vi.mock('../src/services/rateLimiterService.js', () => ({
  RATE_LIMIT_BACKEND_RETRY_AFTER_SECONDS: 2,
  checkAndIncrement: vi.fn(async (key: string, max: number) => {
    limiterCalls.push({ key, max })
    return {
      allowed: true,
      remaining: max - 1,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
      backendAvailable: true,
    }
  }),
}))

const directory = vi.hoisted(() => ({
  getTeamAgents: vi.fn(),
  getUserAgents: vi.fn(),
  googleLoginData: vi.fn(),
  passwordLoginData: vi.fn(),
  requestProfilePasswordReset: vi.fn(async () => undefined),
}))
vi.mock('../src/services/directory/index.js', () => directory)
vi.mock('../src/db.js', () => ({ pool: { query: vi.fn() } }))

const { createExternalAuthRouter } = await import('../src/routes/external/auth.js')

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use(createExternalAuthRouter({} as never))
  return app
}

describe('external password reset request limiter key', () => {
  beforeEach(() => {
    limiterCalls.length = 0
    directory.requestProfilePasswordReset.mockClear()
  })

  it('keys the bucket on a digest of the normalized email', async () => {
    const response = await request(buildApp())
      .post('/external/auth/password-reset/request')
      .send({ email: '  Someone@Example.TEST ' })

    expect(response.status).toBe(200)
    // Liveness witness: the handler ran after the limiter.
    expect(directory.requestProfilePasswordReset).toHaveBeenCalledWith('someone@example.test')
    expect(limiterCalls).toEqual([
      { key: `profile_password_reset:${sha256('someone@example.test')}`, max: 5 },
    ])
  })

  it('gives an oversized email the same fixed-size key on every request', async () => {
    const app = buildApp()
    // Under express.json's default 100 kB limit here; production allows more.
    const huge = `${'a'.repeat(50_000)}@example.test`
    await request(app).post('/external/auth/password-reset/request').send({ email: huge })
    await request(app).post('/external/auth/password-reset/request').send({ email: huge })

    expect(limiterCalls).toHaveLength(2)
    expect(limiterCalls[0]?.key).toBe(`profile_password_reset:${sha256(huge)}`)
    expect(limiterCalls[1]?.key).toBe(limiterCalls[0]?.key)
  })

  it('keys a request with no email on the source address', async () => {
    await request(buildApp())
      .post('/external/auth/password-reset/request')
      .set('x-forwarded-for', '198.51.100.4')
      .send({})

    expect(limiterCalls).toEqual([{ key: 'profile_password_reset_ip:198.51.100.4', max: 5 }])
  })
})
