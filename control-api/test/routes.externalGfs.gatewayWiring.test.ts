import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { correlationIdMiddleware } from '../src/middleware/correlationId.js'
import { __resetExternalGfsIngressRateLimitForTests } from '../src/routes/external/gfs.js'
import { createExternalRouter } from '../src/routes/external/index.js'
import { USER_ACCESS_POLICY_VERSION } from '../src/services/access/userAccessPolicy.js'
import type { ExternalSessionAuthentication } from '../src/services/auth/externalSessionAuthentication.js'
import {
  signUserSessionV2Token,
  verifyUserSessionV2Token,
} from '../src/utils/auth/userSessionV2Token.js'

/**
 * Wiring test for the production mount of the external GFS router.
 *
 * Every other external GFS suite builds `createExternalGfsRouter(gateway)`
 * directly, so none of them reads the line in `routes/external/index.ts` that
 * hands the router its gateway. Without that gateway a V2 token mint answers
 * 503 `authority_unavailable`. This suite mounts `createExternalRouter(gateway)`
 * with the real config and the real `signCurrentExternalGfsUserToken`, and
 * presents a V2 authentication built the way the producer builds it
 * (`authenticateExternalUserSessionIdentity` in
 * `services/auth/externalSessionAuthentication.ts`): token claims from a real
 * `signUserSessionV2Token` -> `verifyUserSessionV2Token` round trip and an
 * authority context derived from those claims.
 */

const mockAuthenticateExternalUserSession = vi.hoisted(() => vi.fn())
const mockRequireWorkflowActionAuthority = vi.hoisted(() => vi.fn())
const mockSignGfsToken = vi.hoisted(() => vi.fn())
const mockCheckAndIncrement = vi.hoisted(() => vi.fn())
const mockQuery = vi.hoisted(() => vi.fn())

// One SQL dispatcher serves both `pool.query` (the lifecycle read reaches it
// through gfsDesktopOperatorLinkService's dynamic `import('../db.js')`) and the
// `transaction.query` handed to the V2 signer's `withTransaction` callback.
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
  withTransaction: async (work: (db: { query: typeof mockQuery }) => Promise<unknown>) =>
    work({ query: mockQuery }),
}))
vi.mock('../src/services/auth/externalSessionAuthentication.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/services/auth/externalSessionAuthentication.js')>()
  return {
    ...actual,
    authenticateExternalUserSession: (...args: unknown[]) =>
      mockAuthenticateExternalUserSession(...args),
  }
})
vi.mock('../src/auth/gfsToken.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/auth/gfsToken.js')>()
  return {
    ...actual,
    signGfsToken: (...args: unknown[]) => mockSignGfsToken(...args),
  }
})
vi.mock('../src/services/rateLimiterService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/rateLimiterService.js')>()
  return {
    ...actual,
    checkAndIncrement: (...args: unknown[]) => mockCheckAndIncrement(...args),
  }
})
vi.mock('../src/services/workflows/workflowAuthorityBindingService.js', async importOriginal => {
  const actual =
    await importOriginal<
      typeof import('../src/services/workflows/workflowAuthorityBindingService.js')
    >()
  return {
    ...actual,
    requireWorkflowActionAuthority: (...args: unknown[]) =>
      mockRequireWorkflowActionAuthority(...args),
  }
})

const U1 = '11111111-aaaa-4aaa-8aaa-111111111111'
const SID = '99999999-9999-4999-8999-999999999999'
const SESSION_JTI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_VERSION = 1
const R = '11111111-1111-1111-1111-111111111111'

const BINDING = {
  version: 2 as const,
  userId: U1,
  sid: SID,
  sessionVersion: SESSION_VERSION,
  delegationJti: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  operationId: 'gfs.read' as const,
  resource: {
    environmentId: 'development:local-cluster',
    type: 'gfs_resource' as const,
    canonicalId: `gfs_resource:${R}`,
    logicalId: R,
    displayName: R,
  },
  target: { drive: 'main', resourceId: R },
  targetHash: 'ath2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  accessPathId: 'ap1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  authorizationRevision: 'ar1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  pathKind: 'direct' as const,
  effectiveTeamId: null,
  behaviorBindingHash: 'bh2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
}

/** Sign a V2 session token with the real signer and the real config keys. */
function signV2SessionToken(): string {
  const issuedAt = Math.floor(Date.now() / 1000)
  return signUserSessionV2Token(
    {
      sub: U1,
      sid: SID,
      jti: SESSION_JTI,
      sv: SESSION_VERSION,
      email: 'u@example.com',
      auth_time: issuedAt,
      amr: ['pwd'],
    },
    issuedAt
  )
}

/**
 * The authenticated V2 result for a presented token, shaped as
 * authenticateExternalUserSession returns it after the live session check.
 */
function v2Authentication(token: string): ExternalSessionAuthentication {
  const tokenClaims = verifyUserSessionV2Token(token)
  if (!tokenClaims) throw new Error('the V2 session fixture did not verify')
  return {
    status: 'authenticated',
    contract: 'v2',
    claims: {
      userId: tokenClaims.sub,
      email: tokenClaims.email ?? '',
      teamId: null,
      role: 'member',
      exp: tokenClaims.exp,
      iat: tokenClaims.iat,
      sessionContract: 'v2',
      sid: tokenClaims.sid,
      jti: tokenClaims.jti,
      sv: tokenClaims.sv,
      ver: 2,
      authTime: tokenClaims.auth_time,
      amr: [...tokenClaims.amr],
    },
    tokenClaims,
    authorityContext: Object.freeze({
      contract: 'v2' as const,
      userId: tokenClaims.sub,
      sid: tokenClaims.sid,
      jti: tokenClaims.jti,
      sessionVersion: tokenClaims.sv,
    }),
    policy: {
      policyVersion: USER_ACCESS_POLICY_VERSION,
      policyRevision: 'gateway-wiring-test',
      acceptV1: true,
      issueV1: true,
      acceptV2: true,
      issueV2: true,
      renewV2: true,
      switchCompatibility: false,
      actionContextV2: true,
      rpcDelegationV2: true,
      minimumClientVersion: null,
      enforceMinimumClient: false,
    },
  }
}

const LIFECYCLE_READ = 'SELECT lifecycle_state FROM users WHERE id = $1::uuid LIMIT 1'
const V2_SIGNER_READ =
  'SELECT u.lifecycle_state, u.lifecycle_version, clock_timestamp() AS db_now, ' +
  's.revoked_at, s.session_version, s.absolute_expires_at, s.idle_expires_at ' +
  'FROM users u JOIN external_user_sessions s ON s.sid = $2 AND s.user_id = u.id ' +
  'WHERE u.id = $1'

function dispatchSql(text: string, values?: unknown[]) {
  const sql = text.replace(/\s+/g, ' ').trim()
  if (sql === LIFECYCLE_READ) {
    return { rows: [{ lifecycle_state: 'active' }], rowCount: 1 }
  }
  if (sql === V2_SIGNER_READ) {
    const now = Date.now()
    return {
      rows: [
        {
          lifecycle_state: 'active',
          lifecycle_version: 1,
          db_now: new Date(now),
          revoked_at: null,
          session_version: SESSION_VERSION,
          absolute_expires_at: new Date(now + 60 * 60 * 1000),
          idle_expires_at: new Date(now + 30 * 60 * 1000),
        },
      ],
      rowCount: 1,
    }
  }
  throw new Error(`unexpected SQL in the gateway wiring test: ${sql} ${JSON.stringify(values)}`)
}

function gatewayDouble() {
  return {
    getResourceExact: vi.fn(),
    listResourcePage: vi.fn(),
    listResource: vi.fn(),
  }
}

function buildApp(gateway: ReturnType<typeof gatewayDouble>) {
  const app = express()
  app.use(express.json())
  app.use(correlationIdMiddleware)
  app.use(createExternalRouter(gateway as never))
  return app
}

describe('external router GFS gateway wiring', () => {
  beforeEach(() => {
    __resetExternalGfsIngressRateLimitForTests()
    mockAuthenticateExternalUserSession.mockReset()
    mockRequireWorkflowActionAuthority.mockReset()
    mockSignGfsToken.mockReset()
    mockCheckAndIncrement.mockReset()
    mockQuery.mockReset()
    mockQuery.mockImplementation(async (text: string, values?: unknown[]) =>
      dispatchSql(text, values)
    )
    mockAuthenticateExternalUserSession.mockImplementation(async (token: string) =>
      v2Authentication(token)
    )
    mockCheckAndIncrement.mockImplementation(async () => ({
      allowed: true,
      backendAvailable: true,
      remaining: 9,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 1,
    }))
    mockRequireWorkflowActionAuthority.mockResolvedValue({
      binding: BINDING,
      sourceIssuedAt: 100,
      sourceExpiresAt: 200,
      bindingHash: 'binding-hash',
    })
    mockSignGfsToken.mockReturnValue({ token: 'fake-gfs-user-token', expiresInSeconds: 300 })
  })

  it("passes the router's gateway to the V2 GFS token authority check", async () => {
    const gateway = gatewayDouble()
    const sessionToken = signV2SessionToken()

    const res = await request(buildApp(gateway))
      .post('/external/gfs/token')
      .set('x-user-session-token', sessionToken)
      .set('x-evenfire-action-delegation', 'signed-v2-action')
      .send({
        scopes: ['gfs.read'],
        operationId: 'gfs.read',
        resourceId: R,
        target: BINDING.target,
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ token: 'fake-gfs-user-token', expiresInSeconds: 300 })

    // The session middleware authenticated the presented V2 token.
    expect(mockAuthenticateExternalUserSession).toHaveBeenCalledTimes(1)
    expect(mockAuthenticateExternalUserSession.mock.calls[0]?.[0]).toBe(sessionToken)

    expect(mockRequireWorkflowActionAuthority).toHaveBeenCalledTimes(1)
    const authorityInput = mockRequireWorkflowActionAuthority.mock.calls[0]?.[0] as {
      gateway: unknown
      operationId: string
      resourceLogicalId: string
      caller: { kind: string; session: unknown }
    }
    expect(authorityInput.gateway).toBe(gateway)
    expect(authorityInput.operationId).toBe('gfs.read')
    expect(authorityInput.resourceLogicalId).toBe(R)
    expect(authorityInput.caller.kind).toBe('user-session')
    expect(authorityInput.caller.session).toEqual({
      contract: 'v2',
      userId: U1,
      sid: SID,
      jti: SESSION_JTI,
      sessionVersion: SESSION_VERSION,
    })

    // The real V2 signer ran: it read the lifecycle and the session row in one
    // statement and signed with the generation that row carried.
    const statements = mockQuery.mock.calls.map(([text]) =>
      String(text).replace(/\s+/g, ' ').trim()
    )
    expect(statements).toEqual([LIFECYCLE_READ, V2_SIGNER_READ])
    expect(mockQuery.mock.calls[1]?.[1]).toEqual([U1, SID])

    expect(mockSignGfsToken).toHaveBeenCalledTimes(1)
    const signed = mockSignGfsToken.mock.calls[0]?.[0] as {
      subject: string
      authGeneration: number
      principalType: string
      actionAuthority: { binding: unknown; sourceIssuedAt: number; sourceExpiresAt: number }
    }
    expect(signed.subject).toBe(U1)
    expect(signed.authGeneration).toBe(1)
    expect(signed.principalType).toBe('user')
    expect(signed.actionAuthority.binding).toEqual(BINDING)
    expect(signed.actionAuthority.sourceIssuedAt).toBe(100)
    expect(signed.actionAuthority.sourceExpiresAt).toBe(200)
  })
})
