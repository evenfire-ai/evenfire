import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { requireAuthForControlUI } from '../src/middleware/controlUIAuth.js'
import { createAdminSubscriptionCapabilitiesRouter } from '../src/routes/admin/subscriptionCapabilities.js'
import { signAdminToken, verifyAdminToken } from '../src/utils/auth/adminAuthToken.js'

const authenticate = vi.hoisted(() => vi.fn())
const increment = vi.hoisted(() => vi.fn())
vi.mock('../src/services/adminSessionAuth.js', () => ({ authenticateAdminSession: authenticate }))
vi.mock('../src/services/rateLimiterService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/rateLimiterService.js')>()),
  checkAndIncrement: increment,
}))

const original = { codex: config.codexSubscriptionEnabled, grok: config.grokSubscriptionEnabled }
let session: string

function app() {
  const instance = express()
  instance.use('/api/v1', requireAuthForControlUI, createAdminSubscriptionCapabilitiesRouter())
  return instance
}

beforeEach(() => {
  // Only live database session state is substituted; quota attribution still
  // verifies the actual signed browser credential with the production verifier.
  session = signAdminToken('unit-admin')
  const claims = verifyAdminToken(session)
  authenticate.mockImplementation(async value => (value === session ? claims : null))
  increment.mockResolvedValue({
    allowed: true,
    remaining: 149,
    backendAvailable: true,
    count: 1,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
  })
})

afterEach(() => {
  config.codexSubscriptionEnabled = original.codex
  config.grokSubscriptionEnabled = original.grok
  vi.clearAllMocks()
})

describe('administrative subscription capabilities', () => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])('returns allowlisted integration flags for %s/%s', async (codex, grok) => {
    config.codexSubscriptionEnabled = codex
    config.grokSubscriptionEnabled = grok
    const response = await request(app())
      .get('/api/v1/admin/llm/providers/capabilities')
      .set('Cookie', `control_ui_admin_session=${session}`)
      .expect(200)
    expect(response.body).toEqual({
      providers: {
        'codex-subscription': { enabled: codex },
        'grok-subscription': { enabled: grok },
      },
    })
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers['x-ratelimit-limit']).toBe('150')
  })

  it('rejects missing or unverified sessions before capability discovery', async () => {
    await request(app()).get('/api/v1/admin/llm/providers/capabilities').expect(401)
    await request(app())
      .get('/api/v1/admin/llm/providers/capabilities')
      .set('Cookie', 'control_ui_admin_session=unverified-fixture')
      .expect(401)
    await request(app())
      .get('/api/v1/admin/llm/providers/capabilities')
      .set('Authorization', `Bearer ${session}`)
      .expect(401)
    expect(increment).not.toHaveBeenCalled()
  })

  it('retains the rate limit for authenticated capability reads', async () => {
    increment.mockResolvedValue({
      allowed: false,
      remaining: 0,
      backendAvailable: true,
      count: 151,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })
    const response = await request(app())
      .get('/api/v1/admin/llm/providers/capabilities')
      .set('Cookie', `control_ui_admin_session=${session}`)
      .expect(429)
    expect(response.body.code).toBe('rate_limited')
    expect(response.body.message).toMatch(/Try again/)
    expect(response.headers['retry-after']).toBeDefined()
  })
})
