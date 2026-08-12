import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalDirectoryRouter } from '../src/routes/external/directory.js'

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  membership: vi.fn(),
  searchDirectory: vi.fn(),
  checkAndIncrement: vi.fn(),
}))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: mocks.verify,
}))
vi.mock('../src/services/access/liveTeamAuthorization.js', () => ({
  getLiveTeamMembership: mocks.membership,
}))
vi.mock('../src/services/auth/userSessionService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/auth/userSessionService.js')>()
  return {
    ...actual,
    validateLegacyUserSession: vi.fn(async () => ({ status: 'valid', identity: {} })),
  }
})
vi.mock('../src/services/directory/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/directory/index.js')>()
  return { ...actual, searchDirectory: mocks.searchDirectory }
})
vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: mocks.checkAndIncrement,
}))

function allowedRateLimitResult() {
  const now = Date.now()
  return {
    allowed: true,
    remaining: 29,
    resetMs: now + 60_000,
    windowStartMs: now,
    count: 1,
  }
}

function app() {
  const value = express()
  value.use(createExternalDirectoryRouter())
  return value
}

describe('external directory authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verify.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.com',
      teamId: 'team-1',
      role: 'member',
      exp: 2_000_000_000,
      sessionContract: 'v1',
    })
    mocks.searchDirectory.mockResolvedValue({ items: [], nextCursor: null })
    mocks.checkAndIncrement.mockResolvedValue(allowedRateLimitResult())
  })

  it('denies an ordinary member without executing the PII search', async () => {
    mocks.membership.mockResolvedValue({ teamId: 'team-1', role: 'member' })

    const response = await request(app())
      .get('/external/directory/search?teamId=team-1&q=person')
      .set('x-user-session-token', 'session')

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('forbidden')
    expect(mocks.searchDirectory).not.toHaveBeenCalled()
  })

  it.each(['admin', 'inviter'] as const)('allows a current %s to search', async role => {
    mocks.membership.mockResolvedValue({ teamId: 'team-1', role })

    const response = await request(app())
      .get('/external/directory/search?teamId=team-1&q=person')
      .set('x-user-session-token', 'session')

    expect(response.status).toBe(200)
    expect(mocks.searchDirectory).toHaveBeenCalledWith('team-1', 'person', undefined)
  })

  it('uses the authenticated user key and canonical limiter on an allowed search', async () => {
    mocks.membership.mockResolvedValue({ teamId: 'team-1', role: 'admin' })

    const response = await request(app())
      .get('/external/directory/search?teamId=team-1&q=person')
      .set('x-user-session-token', 'session')
      .expect(200)

    expect(mocks.checkAndIncrement).toHaveBeenCalledOnce()
    expect(mocks.checkAndIncrement).toHaveBeenCalledWith('directory-search:user-1', 30)
    expect(response.headers['x-ratelimit-limit']).toBe('30')
    expect(response.headers['x-ratelimit-remaining']).toBe('29')
    expect(response.headers['x-ratelimit-reset']).toBeDefined()
    expect(mocks.searchDirectory).toHaveBeenCalledWith('team-1', 'person', undefined)
  })

  it('returns the canonical 429 and does not search when the limiter denies', async () => {
    const resetMs = Date.now() + 60_000
    mocks.membership.mockResolvedValue({ teamId: 'team-1', role: 'admin' })
    mocks.checkAndIncrement.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetMs,
      windowStartMs: resetMs - 60_000,
      count: 31,
    })

    const response = await request(app())
      .get('/external/directory/search?teamId=team-1&q=person')
      .set('x-user-session-token', 'session')
      .expect(429)

    expect(mocks.checkAndIncrement).toHaveBeenCalledOnce()
    expect(mocks.checkAndIncrement).toHaveBeenCalledWith('directory-search:user-1', 30)
    expect(response.body).toMatchObject({
      error: { code: 'rate_limited', retryable: true },
    })
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
    expect(response.headers['x-ratelimit-limit']).toBe('30')
    expect(response.headers['x-ratelimit-remaining']).toBe('0')
    expect(response.headers['x-ratelimit-reset']).toBe(String(Math.floor(resetMs / 1000)))
    expect(mocks.searchDirectory).not.toHaveBeenCalled()
  })
})
