import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalOauthGrantsRouter } from '../src/routes/external/oauthGrants.js'

// Mock the pool used inside the router (no real DB needed).
vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
}))

// Mock the store so we can assert calls without a real DB.
const storeMock = vi.hoisted(() => ({
  listUserOAuthGrants: vi.fn(),
  deleteOAuthGrant: vi.fn(),
}))
vi.mock('../src/oauth/store.js', () => storeMock)

const rateLimitMock = vi.hoisted(() => ({
  checkAndIncrement: vi.fn(),
}))
vi.mock('../src/services/rateLimiterService.js', () => rateLimitMock)

// Mirror the exact pattern from routes.external.workflowApprovalMediums.test.ts:
// mock requireValidExternalSessionToken to inject req.externalAuth.
vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  requireValidExternalSessionToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    ;(req as express.Request & { externalAuth?: { userId: string } }).externalAuth = {
      userId: 'user-1',
    }
    next()
  },
}))

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createExternalOauthGrantsRouter())
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  )
  return app
}

describe('/external/oauth/grants', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMock.listUserOAuthGrants.mockResolvedValue([])
    storeMock.deleteOAuthGrant.mockResolvedValue(undefined)
    rateLimitMock.checkAndIncrement.mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 29,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })
  })

  it("GET lists only the caller's grants (userId from session)", async () => {
    storeMock.listUserOAuthGrants.mockResolvedValue([
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'leadforge',
        oauthClientId: 'google-gmail',
        provider: 'google',
        background: true,
        updatedAt: new Date('2026-06-01'),
      },
    ])
    const res = await request(makeApp()).get('/external/oauth/grants')
    expect(res.status).toBe(200)
    expect(storeMock.listUserOAuthGrants).toHaveBeenCalledWith(expect.anything(), 'user-1')
    expect(res.body.grants[0].recipeName).toBe('leadforge')
  })

  it("DELETE revokes the caller's grant (userId from session, not body)", async () => {
    const res = await request(makeApp()).delete(
      '/external/oauth/grants/sandbox-recipes/leadforge/google-gmail'
    )
    expect(res.status).toBe(204)
    expect(storeMock.deleteOAuthGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        grantKind: 'user',
        userId: 'user-1',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'leadforge',
        oauthClientId: 'google-gmail',
      })
    )
  })

  it('rate limits reads by authenticated user before listing grants', async () => {
    rateLimitMock.checkAndIncrement.mockResolvedValueOnce({
      allowed: false,
      count: 31,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })

    const res = await request(makeApp()).get('/external/oauth/grants')

    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
    expect(res.headers['x-ratelimit-limit']).toBe('30')
    expect(res.headers['x-ratelimit-remaining']).toBe('0')
    expect(res.body).toMatchObject({ error: { code: 'rate_limited', retryable: true } })
    expect(rateLimitMock.checkAndIncrement).toHaveBeenCalledWith(
      'external_oauth_grant_read:user:user-1',
      30
    )
    expect(storeMock.listUserOAuthGrants).not.toHaveBeenCalled()
  })

  it('rate limits revocation by authenticated user before deleting a grant', async () => {
    rateLimitMock.checkAndIncrement.mockResolvedValueOnce({
      allowed: false,
      count: 11,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
    })

    const res = await request(makeApp()).delete(
      '/external/oauth/grants/sandbox-recipes/leadforge/google-gmail'
    )

    expect(res.status).toBe(429)
    expect(res.headers['x-ratelimit-limit']).toBe('10')
    expect(rateLimitMock.checkAndIncrement).toHaveBeenCalledWith(
      'external_oauth_grant_mutation:user:user-1',
      10
    )
    expect(storeMock.deleteOAuthGrant).not.toHaveBeenCalled()
  })
})
