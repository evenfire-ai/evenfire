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
      authGeneration: 1,
    })
    mocks.searchDirectory.mockResolvedValue({ items: [], nextCursor: null })
    mocks.checkAndIncrement.mockResolvedValue(allowedRateLimitResult())
  })

  it('allows an ordinary member of the team to search', async () => {
    mocks.membership.mockResolvedValue({ teamId: 'team-1', role: 'member' })

    const response = await request(app())
      .get('/external/directory/search?teamId=team-1&q=person')
      .set('x-user-session-token', 'session')

    expect(response.status).toBe(200)
    expect(mocks.membership).toHaveBeenCalledWith(
      'user-1',
      'team-1',
      expect.objectContaining({ budget: expect.anything() })
    )
    expect(mocks.searchDirectory).toHaveBeenCalledWith('team-1', 'person', undefined)
  })

  it('refuses a caller without a live team membership', async () => {
    mocks.membership.mockResolvedValue(null)

    const response = await request(app())
      .get('/external/directory/search?teamId=team-1&q=person')
      .set('x-user-session-token', 'session')

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('forbidden')
    expect(mocks.membership).toHaveBeenCalledWith(
      'user-1',
      'team-1',
      expect.objectContaining({ budget: expect.anything() })
    )
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

  it('keeps dev limits: an allowed search charges no per-user PG bucket', async () => {
    mocks.membership.mockResolvedValue({ teamId: 'team-1', role: 'admin' })

    const response = await request(app())
      .get('/external/directory/search?teamId=team-1&q=person')
      .set('x-user-session-token', 'session')
      .expect(200)

    // Witness: the search ran with live membership and its budget.
    expect(mocks.membership).toHaveBeenCalledWith(
      'user-1',
      'team-1',
      expect.objectContaining({ budget: expect.anything() })
    )
    expect(mocks.searchDirectory).toHaveBeenCalledWith('team-1', 'person', undefined)
    // dev has no per-user directory-search bucket on this route.
    expect(mocks.checkAndIncrement).not.toHaveBeenCalled()
    expect(response.headers['x-ratelimit-limit']).toBeUndefined()
  })
})
