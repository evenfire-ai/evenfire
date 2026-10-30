import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { requireExternalSessionRateLimitContext } from '../src/middleware/externalSessionAuth.js'
import { createExternalAuthRouter } from '../src/routes/external/auth.js'

const sessions = vi.hoisted(() => ({
  authenticateExternalUserSession: vi.fn(),
  authenticateExternalUserSessionIdentity: vi.fn(),
  renewExternalUserSession: vi.fn(),
}))
const revocations = vi.hoisted(() => ({
  revokeAllUserSessions: vi.fn(),
  revokeLegacyUserSession: vi.fn(),
  revokeUserSession: vi.fn(),
}))
const issuance = vi.hoisted(() => ({
  exchangeLegacyExternalUserSession: vi.fn(),
  issueExternalUserSession: vi.fn(),
  selectExternalSessionRepresentation: vi.fn(),
}))
const liveTeam = vi.hoisted(() => ({ getLiveTeamMembership: vi.fn() }))
const directory = vi.hoisted(() => ({
  getTeamAgents: vi.fn(),
  getUserAgents: vi.fn(),
  googleLoginData: vi.fn(),
  requestProfilePasswordReset: vi.fn(),
}))
const database = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../src/services/auth/externalSessionAuthentication.js', () => sessions)
vi.mock('../src/services/auth/externalSessionIssuance.js', () => issuance)
vi.mock('../src/services/auth/userSessionService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/auth/userSessionService.js')>()
  return { ...actual, ...revocations }
})
vi.mock('../src/services/access/liveTeamAuthorization.js', () => liveTeam)
vi.mock('../src/services/directory/index.js', () => directory)
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => database.query(...args) },
  withTransaction: vi.fn(),
}))

const claims = {
  userId: 'user-1',
  email: 'user@example.test',
  teamId: null,
  role: 'member' as const,
  authGeneration: 1,
  iat: 1_700_000_000,
  exp: 1_800_000_000,
}

function authenticated() {
  return {
    status: 'authenticated' as const,
    contract: 'v1' as const,
    claims,
    authorityContext: {
      contract: 'v1' as const,
      userId: claims.userId,
      tokenHash: 'synthetic-hash',
      issuedAt: 1_700_000_000,
      authGeneration: 1,
    },
    policy: { issueV1: true, issueV2: true, acceptV1: true, acceptV2: true },
  }
}

/**
 * Mounts the rate-limit context middleware and injects a body that a JSON
 * parser cannot produce: an object whose String() coercion throws. This is the
 * shape a non-string token takes before the middleware's own 401 boundary.
 */
function rateLimitContextApp() {
  const value = express()
  value.use(express.json())
  value.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.header('x-synthetic-throwing-token-body') === 'true') {
      req.body = {
        token: {
          toString: () => {
            throw new TypeError('synthetic token coercion')
          },
        },
      }
    }
    next()
  })
  value.post(
    '/external/auth/session/renew',
    requireExternalSessionRateLimitContext({ purpose: 'renew' }),
    (_req, res) => res.status(200).json({ ok: true })
  )
  value.use(clerumErrorHandler)
  return value
}

function authRouterApp() {
  const value = express()
  value.use(express.json())
  value.use(createExternalAuthRouter({} as never))
  value.use(clerumErrorHandler)
  return value
}

describe('external session token type boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessions.authenticateExternalUserSession.mockResolvedValue(authenticated())
  })

  it('answers the middleware 401 for a non-string body token without coercing it', async () => {
    const response = await request(rateLimitContextApp())
      .post('/external/auth/session/renew')
      .set('x-synthetic-throwing-token-body', 'true')

    expect(response.status).toBe(401)
    expect(response.body).toMatchObject({ error: { code: 'invalid_session' } })
    expect(sessions.authenticateExternalUserSession).not.toHaveBeenCalled()
  })

  it('still authenticates a string body token at the same middleware boundary', async () => {
    const response = await request(rateLimitContextApp())
      .post('/external/auth/session/renew')
      .send({ token: 'synthetic-id-token' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
    expect(sessions.authenticateExternalUserSession).toHaveBeenCalledWith(
      'synthetic-id-token',
      expect.objectContaining({ purpose: 'renew' })
    )
  })

  it('answers the rpc-token 401 for a non-string sessionToken without coercing it', async () => {
    const response = await request(authRouterApp())
      .post('/external/rpc/token')
      .send({ sessionToken: { synthetic: 'synthetic-non-string-token' } })

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    expect(sessions.authenticateExternalUserSession).not.toHaveBeenCalled()
  })

  it('still authenticates a string sessionToken at the rpc-token boundary', async () => {
    const response = await request(authRouterApp())
      .post('/external/rpc/token')
      .send({ sessionToken: 'synthetic-id-token', scopes: [], hostRefs: [] })

    expect(sessions.authenticateExternalUserSession).toHaveBeenCalledWith(
      'synthetic-id-token',
      expect.objectContaining({ purpose: 'rpc_legacy' })
    )
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'invalid_host_refs' })
  })
})
