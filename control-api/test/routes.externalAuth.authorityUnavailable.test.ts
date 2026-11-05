import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { rootLogger } from '../src/observability/logger.js'
import { createExternalAuthRouter } from '../src/routes/external/auth.js'
import { createExternalDirectoryRouter } from '../src/routes/external/directory.js'
import {
  ExternalSessionBackendUnavailableError,
  externalSessionDatabaseFailure,
} from '../src/services/auth/sessionDatabaseFailure.js'

const sessions = vi.hoisted(() => ({
  authenticateExternalUserSession: vi.fn(),
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
  searchDirectory: vi.fn(),
  DIRECTORY_SEARCH_MAX_QUERY_LENGTH: 200,
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

const POLICY = { issueV1: true, issueV2: true, acceptV1: true, acceptV2: true }

const v1Claims = {
  userId: 'user-1',
  email: 'user@example.test',
  teamId: 'team-1',
  role: 'admin' as const,
  authGeneration: 1,
  iat: 1_700_000_000,
  exp: 1_800_000_000,
}

const v2Claims = {
  userId: 'user-1',
  email: 'user@example.test',
  teamId: null,
  role: 'member' as const,
  sid: 'sid-1',
  jti: 'jti-1',
}

function authenticated(claims: typeof v1Claims | typeof v2Claims, contract: 'v1' | 'v2') {
  return {
    status: 'authenticated' as const,
    contract,
    claims,
    authorityContext:
      contract === 'v2'
        ? {
            contract: 'v2' as const,
            userId: claims.userId,
            sid: 'sid-1',
            jti: 'jti-1',
            sessionVersion: 1,
          }
        : {
            contract: 'v1' as const,
            userId: claims.userId,
            tokenHash: 'source-hash',
            issuedAt: 1_700_000_000,
            authGeneration: 1,
          },
    policy: POLICY,
  }
}

function unavailable(): ExternalSessionBackendUnavailableError {
  return new ExternalSessionBackendUnavailableError(new Error('private pg-pool sentinel'))
}

const warn = vi.spyOn(rootLogger, 'warn').mockImplementation(() => undefined)

/**
 * The handler-level 503 is marked as a retryable outage: both headers, and one
 * warn log naming the event and carrying the outage cause (the witness that the
 * marking path ran, not only the response).
 */
function expectMarkedAuthorityUnavailable(response: request.Response, event: string): void {
  expect(response.headers['retry-after']).toBe('2')
  expect(response.headers['cache-control']).toBe('no-store')
  expect(warn).toHaveBeenCalledOnce()
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      event,
      err: expect.objectContaining({ message: 'private pg-pool sentinel' }),
    }),
    'external authority is unavailable'
  )
}

function app() {
  const value = express()
  value.use(express.json())
  value.use(createExternalAuthRouter({} as never))
  value.use(clerumErrorHandler)
  return value
}

function sessionTokenRequest(overrides: Record<string, unknown> = {}) {
  return request(app())
    .post('/external/auth/session-token')
    .set('x-forwarded-for', '203.0.113.44')
    .set('x-user-session-token', 'synthetic-source-token')
    .send({
      userId: v1Claims.userId,
      email: v1Claims.email,
      teamId: 'team-1',
      role: 'admin',
      ...overrides,
    })
}

beforeEach(() => {
  vi.clearAllMocks()
  sessions.authenticateExternalUserSession.mockResolvedValue(authenticated(v1Claims, 'v1'))
  issuance.exchangeLegacyExternalUserSession.mockResolvedValue({
    status: 'issued',
    token: 'synthetic-replacement-token',
    role: 'admin',
  })
  revocations.revokeUserSession.mockResolvedValue(true)
  revocations.revokeAllUserSessions.mockResolvedValue(1)
  liveTeam.getLiveTeamMembership.mockResolvedValue({ teamId: 'team-1', role: 'admin' })
  database.query.mockResolvedValue({
    rows: [{ role: 'admin', lifecycle_version: 1 }],
    rowCount: 1,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('external auth authority unavailability parity', () => {
  describe('POST /external/auth/session-token', () => {
    it('answers 503 authority_unavailable for a classified database outage', async () => {
      issuance.exchangeLegacyExternalUserSession.mockRejectedValue(unavailable())

      const response = await sessionTokenRequest()

      expect(response.status).toBe(503)
      expect(response.body).toMatchObject({
        error: {
          code: 'authority_unavailable',
          message: 'Authorization is temporarily unavailable.',
          retryable: true,
        },
      })
      expect(JSON.stringify(response.body)).not.toContain('private pg-pool sentinel')
      expectMarkedAuthorityUnavailable(response, 'external_auth_authority_unavailable')
    })

    it('keeps a plain dependency error on the sanitized 500 path', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      issuance.exchangeLegacyExternalUserSession.mockRejectedValue(new Error('boom'))

      const response = await sessionTokenRequest()

      expect(response.status).toBe(500)
      expect(response.body).toMatchObject({ error: 'Internal Server Error' })
      expect(response.body.error).not.toBe('authority_unavailable')
      expect(JSON.stringify(response.body)).not.toContain('boom')
      expect(response.headers['retry-after']).toBeUndefined()
    })

    it('classifies a v2 membership transport failure at the database boundary', async () => {
      sessions.authenticateExternalUserSession.mockResolvedValue(authenticated(v2Claims, 'v2'))
      database.query.mockRejectedValue(new Error('private pg-pool sentinel'))

      const response = await sessionTokenRequest()

      expect(response.status).toBe(503)
      expect(response.body).toMatchObject({
        error: {
          code: 'authority_unavailable',
          message: 'Authorization is temporarily unavailable.',
          retryable: true,
        },
      })
      expect(JSON.stringify(response.body)).not.toContain('private pg-pool sentinel')
      expectMarkedAuthorityUnavailable(response, 'external_auth_authority_unavailable')
    })
  })

  describe('POST /external/auth/session/renew', () => {
    function renewRequest() {
      return request(app())
        .post('/external/auth/session/renew')
        .set('x-forwarded-for', '203.0.113.44')
        .set('x-user-session-token', 'synthetic-session-token')
    }

    beforeEach(() => {
      sessions.authenticateExternalUserSession.mockResolvedValue(authenticated(v2Claims, 'v2'))
    })

    it('answers 503 authority_unavailable for a classified database outage', async () => {
      sessions.renewExternalUserSession.mockRejectedValue(unavailable())

      const response = await renewRequest()

      expect(response.status).toBe(503)
      expect(response.body).toMatchObject({
        error: {
          code: 'authority_unavailable',
          message: 'Session authority is temporarily unavailable.',
          retryable: true,
        },
      })
      expectMarkedAuthorityUnavailable(response, 'external_auth_authority_unavailable')
    })

    it('keeps a plain dependency error on the sanitized 500 path', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      sessions.renewExternalUserSession.mockRejectedValue(new Error('boom'))

      const response = await renewRequest()

      expect(response.status).toBe(500)
      expect(response.body).toMatchObject({ error: 'Internal Server Error' })
      expect(JSON.stringify(response.body)).not.toContain('boom')
      expect(response.headers['retry-after']).toBeUndefined()
    })
  })

  describe('POST /external/auth/session/logout', () => {
    function logoutRequest() {
      return request(app())
        .post('/external/auth/session/logout')
        .set('x-forwarded-for', '203.0.113.44')
        .set('x-user-session-token', 'synthetic-session-token')
    }

    beforeEach(() => {
      sessions.authenticateExternalUserSession.mockResolvedValue(authenticated(v2Claims, 'v2'))
    })

    it('answers 503 authority_unavailable for a classified database outage', async () => {
      revocations.revokeUserSession.mockRejectedValue(unavailable())

      const response = await logoutRequest()

      expect(response.status).toBe(503)
      expect(response.body).toMatchObject({
        error: {
          code: 'authority_unavailable',
          message: 'Session authority is temporarily unavailable.',
          retryable: true,
        },
      })
      expectMarkedAuthorityUnavailable(response, 'external_auth_authority_unavailable')
    })

    it('keeps a plain dependency error on the sanitized 500 path', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      revocations.revokeUserSession.mockRejectedValue(new Error('boom'))

      const response = await logoutRequest()

      expect(response.status).toBe(500)
      expect(response.body).toMatchObject({ error: 'Internal Server Error' })
      expect(JSON.stringify(response.body)).not.toContain('boom')
      expect(response.headers['retry-after']).toBeUndefined()
    })
  })

  describe('POST /external/auth/sessions/revoke-all', () => {
    function revokeAllRequest() {
      return request(app())
        .post('/external/auth/sessions/revoke-all')
        .set('x-forwarded-for', '203.0.113.44')
        .set('x-user-session-token', 'synthetic-session-token')
    }

    it('answers 503 authority_unavailable for a classified database outage', async () => {
      revocations.revokeAllUserSessions.mockRejectedValue(unavailable())

      const response = await revokeAllRequest()

      expect(response.status).toBe(503)
      expect(response.body).toMatchObject({
        error: {
          code: 'authority_unavailable',
          message: 'Session authority is temporarily unavailable.',
          retryable: true,
        },
      })
      expectMarkedAuthorityUnavailable(response, 'external_auth_authority_unavailable')
    })

    it('keeps a plain dependency error on the sanitized 500 path', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      revocations.revokeAllUserSessions.mockRejectedValue(new Error('boom'))

      const response = await revokeAllRequest()

      expect(response.status).toBe(500)
      expect(response.body).toMatchObject({ error: 'Internal Server Error' })
      expect(JSON.stringify(response.body)).not.toContain('boom')
      expect(response.headers['retry-after']).toBeUndefined()
    })
  })

  describe('POST /external/auth/sessions/:sid/revoke', () => {
    function revokeTargetRequest() {
      return request(app())
        .post('/external/auth/sessions/target-session/revoke')
        .set('x-forwarded-for', '203.0.113.44')
        .set('x-user-session-token', 'synthetic-session-token')
    }

    beforeEach(() => {
      sessions.authenticateExternalUserSession.mockResolvedValue(authenticated(v2Claims, 'v2'))
    })

    it('answers 503 authority_unavailable for a classified database outage', async () => {
      revocations.revokeUserSession.mockRejectedValue(unavailable())

      const response = await revokeTargetRequest()

      expect(response.status).toBe(503)
      expect(response.body).toMatchObject({
        error: {
          code: 'authority_unavailable',
          message: 'Session authority is temporarily unavailable.',
          retryable: true,
        },
      })
      expectMarkedAuthorityUnavailable(response, 'external_auth_authority_unavailable')
    })

    it('keeps a plain dependency error on the sanitized 500 path', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      revocations.revokeUserSession.mockRejectedValue(new Error('boom'))

      const response = await revokeTargetRequest()

      expect(response.status).toBe(500)
      expect(response.body).toMatchObject({ error: 'Internal Server Error' })
      expect(JSON.stringify(response.body)).not.toContain('boom')
      expect(response.headers['retry-after']).toBeUndefined()
    })
  })

  describe('POST /external/rpc/token', () => {
    function rpcTokenRequest() {
      return request(app())
        .post('/external/rpc/token')
        .set('x-forwarded-for', '203.0.113.44')
        .send({
          sessionToken: 'synthetic-session-token',
          scopes: ['host:message:invoke'],
          hostRefs: ['agent-a'],
        })
    }

    it('answers 503 authority_unavailable for a classified live-membership outage', async () => {
      liveTeam.getLiveTeamMembership.mockRejectedValue(unavailable())

      const response = await rpcTokenRequest()

      expect(response.status).toBe(503)
      expect(response.body).toMatchObject({
        error: {
          code: 'authority_unavailable',
          message: 'Authorization is temporarily unavailable.',
          retryable: true,
        },
      })
      expectMarkedAuthorityUnavailable(response, 'external_auth_authority_unavailable')
    })

    it('keeps a plain live-membership error on the sanitized 500 path', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      liveTeam.getLiveTeamMembership.mockRejectedValue(new Error('boom'))

      const response = await rpcTokenRequest()

      expect(response.status).toBe(500)
      expect(response.body).toMatchObject({ error: 'Internal Server Error' })
      expect(JSON.stringify(response.body)).not.toContain('boom')
      expect(response.headers['retry-after']).toBeUndefined()
    })

    it('answers the session backend 503 for a classified outage in the session stage', async () => {
      sessions.authenticateExternalUserSession.mockRejectedValue(unavailable())

      const response = await rpcTokenRequest()

      expect(response.status).toBe(503)
      expect(response.body).toEqual({
        error: 'session_backend_unavailable',
        retryAfterSeconds: 2,
      })
      expect(response.headers['retry-after']).toBe('2')
      expect(response.headers['cache-control']).toBe('no-store')
      expect(sessions.authenticateExternalUserSession).toHaveBeenCalledOnce()
      expect(liveTeam.getLiveTeamMembership).not.toHaveBeenCalled()
    })

    it('keeps a plain session-stage error on the sanitized 500 path', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      sessions.authenticateExternalUserSession.mockRejectedValue(new Error('boom'))

      const response = await rpcTokenRequest()

      expect(response.status).toBe(500)
      expect(response.body).toMatchObject({ error: 'Internal Server Error' })
      expect(JSON.stringify(response.body)).not.toContain('boom')
      expect(response.headers['retry-after']).toBeUndefined()
      expect(sessions.authenticateExternalUserSession).toHaveBeenCalledOnce()
    })
  })

  describe('GET /external/directory/search (team parameter authorization)', () => {
    function directoryApp() {
      const value = express()
      value.use(express.json())
      value.use(createExternalDirectoryRouter())
      value.use(clerumErrorHandler)
      return value
    }

    it('answers the flat 503 authority_unavailable marked as a retryable outage', async () => {
      liveTeam.getLiveTeamMembership.mockRejectedValue(unavailable())

      const response = await request(directoryApp())
        .get('/external/directory/search')
        .query({ teamId: 'team-1', q: 'synthetic' })
        .set('x-forwarded-for', '203.0.113.44')
        .set('x-user-session-token', 'synthetic-session-token')

      expect(response.status).toBe(503)
      expect(response.body).toEqual({ error: 'authority_unavailable' })
      expectMarkedAuthorityUnavailable(response, 'external_team_authority_unavailable')
      expect(liveTeam.getLiveTeamMembership).toHaveBeenCalledWith('user-1', 'team-1', {
        onDatabaseFailure: externalSessionDatabaseFailure,
      })
      expect(directory.searchDirectory).not.toHaveBeenCalled()
    })
  })
})
