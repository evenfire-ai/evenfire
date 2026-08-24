import { beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { findMembership } from '../src/services/directory/membership.js'
import * as userApprovalRequestService from '../src/services/userApprovalRequestService.js'
import { signExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
import {
  MCP_HOST_CREDENTIAL_CAPABILITY,
  MCP_HOST_HCC_AUDIENCE,
  MCP_HOST_WORKFLOW_AUDIENCE,
  issueMcpHostAccessJwt,
  issueMcpHostRefreshJwt,
  verifyMcpHostAccessJwt,
  verifyMcpHostControlJwt,
  verifyMcpHostRefreshJwt,
} from '../src/utils/auth/mcpHostJwtToken.js'
import { MockGateway } from './mockGateway.js'

// Mock userApprovalRequestService for all tests
vi.mock('../src/services/userApprovalRequestService.js')

// Mock notificationEmitter to avoid DB calls
vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

// Mock the DB pool so the decision auth middleware does not hit a real database.
// This is required for the /decide tests which load approval rows from DB.
//
// The admin/external approval routes now hit the pool for TWO distinct purposes:
//   1. rate_limit_buckets INSERT ... RETURNING count  (rate limiter middleware)
//   2. workflow_* lookups (decision auth, JTI consumption, approval rows, etc.)
//
// We dispatch on SQL fragment so rate-limit queries always return a permissive
// count (= 1) regardless of test ordering, and the test's `mockResolvedValueOnce`
// is only consumed for NON-rate-limit queries. This keeps each test focused on
// its actual invariant instead of having to stub the rate limiter too.
const mockPoolQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>()
const mockPoolQueryDispatch = vi.fn(async (sql: unknown, params?: unknown[]) => {
  const text = typeof sql === 'string' ? sql : ''
  if (/rate_limit_buckets/i.test(text)) {
    return { rows: [{ count: 1 }], rowCount: 1 }
  }
  if (
    /external_user_session_security_epochs/i.test(text) &&
    /external_v1_session_revocations/i.test(text)
  ) {
    return {
      rows: [
        {
          id: String(params?.[0] ?? ''),
          lifecycle_state: 'active',
          lifecycle_version: 1,
          valid_after: null,
          token_revoked: false,
        },
      ],
      rowCount: 1,
    }
  }
  if (/lifecycle_state/i.test(text)) {
    return { rows: [{ lifecycle_state: 'active', lifecycle_version: 1 }], rowCount: 1 }
  }
  return mockPoolQuery(text, params)
})
vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQueryDispatch(args[0], args[1] as unknown[] | undefined),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

// Mock membership service to avoid DB calls in team-targeted approval tests
vi.mock('../src/services/directory/membership.js', () => ({
  findMembership: vi.fn().mockResolvedValue(null),
}))

/**
 * Invariant S4: user identity on /decide comes ONLY from x-user-session-token
 * (external OAuth). Service-token Bearer JWTs must NEVER be accepted.
 */
describe('Security: External /decide endpoint', () => {
  let app: ReturnType<typeof createApp>
  let sessionToken: string

  const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const TEAM_ID = '11111111-2222-3333-4444-555555555555'
  const APPROVAL_ID = '99999999-8888-7777-6666-555555555555'
  const NS = 'default'
  const RECIPE = 'test-recipe'

  // Internal service credentials for external-rest-api proxying.
  // The /external/ routes are behind requireInternalToken.
  const INTERNAL_TOKEN = 'dev-external-rest-api-token'
  const INTERNAL_SERVICE = 'external-rest-api'

  /** Helper: add internal service auth (external-rest-api proxy headers). */
  function withInternalAuth(req: request.Test): request.Test {
    return req
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
      .set('x-service-token', INTERNAL_SERVICE)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockPoolQuery.mockReset()
    // Default: rows empty so non-stubbed queries don't accidentally succeed.
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    app = createApp(new MockGateway('mcp-server') as never)

    sessionToken = signExternalSessionToken({
      userId: USER_ID,
      email: 'test@example.com',
      teamId: TEAM_ID,
      role: 'admin',
      authGeneration: 1,
    })
  })

  it('rejects request without any auth (no session token)', async () => {
    const res = await request(app)
      .post(`/api/v1/external/workflow-approvals/${APPROVAL_ID}/decide`)
      .send({ decision: 'approve' })
    expect(res.status).toBe(401)
  })

  it('lists pending approvals for the authenticated external user', async () => {
    const pending = [
      {
        id: APPROVAL_ID,
        recipeNamespace: NS,
        recipeName: RECIPE,
        requestedAt: '2026-04-16T09:00:00.000Z',
        expiresAt: '2026-04-16T09:15:00.000Z',
        payload: { message: 'Approve recipe execution' },
        correlation: { taskId: 'task-1' },
        target: { userId: USER_ID, teamId: TEAM_ID, teamName: 'Alpha' },
      },
    ]
    vi.mocked(userApprovalRequestService.listPendingApprovalsForUser).mockResolvedValueOnce(pending)

    const res = await withInternalAuth(
      request(app)
        .get('/api/v1/external/workflow-approvals/pending?limit=15')
        .set('x-user-session-token', sessionToken)
    )

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: pending })
    expect(userApprovalRequestService.listPendingApprovalsForUser).toHaveBeenCalledWith(USER_ID, 15)
  })

  it('rejects pending approval list when limit is invalid', async () => {
    const res = await withInternalAuth(
      request(app)
        .get('/api/v1/external/workflow-approvals/pending?limit=0')
        .set('x-user-session-token', sessionToken)
    )

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('limit')
  })

  it('rejects Bearer service token — service tokens never represent users', async () => {
    const { token: workflowToken } = issueMcpHostAccessJwt('ns', 'recipe')

    const res = await request(app)
      .post(`/api/v1/external/workflow-approvals/${APPROVAL_ID}/decide`)
      .set('Authorization', `Bearer ${workflowToken}`)
      .send({ decision: 'approve' })
    expect(res.status).toBe(401)
  })

  it('rejects valid internal service token (rpc-proxy style)', async () => {
    const res = await request(app)
      .post(`/api/v1/external/workflow-approvals/${APPROVAL_ID}/decide`)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
      .send({ decision: 'approve' })
    expect(res.status).toBe(401)
  })

  it('accepts valid external session token for user-targeted approval', async () => {
    // Mock the DB query in approvalDecisionAccess to return a pending approval targeting this user
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: APPROVAL_ID,
          status: 'pending',
          target_user_id: USER_ID,
          target_team_id: null,
          recipe_namespace: NS,
          recipe_name: RECIPE,
        },
      ],
      rowCount: 1,
    })

    // Mock the allowlist re-check to pass
    vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)

    // Mock the recordDecision call
    vi.mocked(userApprovalRequestService.recordDecision).mockResolvedValueOnce({ ok: true })

    const res = await withInternalAuth(
      request(app)
        .post(`/api/v1/external/workflow-approvals/${APPROVAL_ID}/decide`)
        .set('x-user-session-token', sessionToken)
        .send({ decision: 'approve' })
    )

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(userApprovalRequestService.recordDecision).toHaveBeenCalledWith(
      APPROVAL_ID,
      'approve',
      { userId: USER_ID },
      undefined,
      expect.objectContaining({
        clientIp: expect.any(String),
        userAgent: null,
        correlationId: expect.any(String),
      })
    )
  })

  it('returns the created workflow run when a pre-run approval is accepted', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: APPROVAL_ID,
          status: 'pending',
          target_user_id: USER_ID,
          target_team_id: null,
          recipe_namespace: NS,
          recipe_name: RECIPE,
        },
      ],
      rowCount: 1,
    })

    vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)
    vi.mocked(userApprovalRequestService.recordDecision).mockResolvedValueOnce({
      ok: true,
      workflowRun: {
        created: true,
        row: {
          run_id: '33333333-4444-4555-8666-777777777777',
          recipe_namespace: NS,
          recipe_name: RECIPE,
          phase: 'Pending',
          actor_type: 'user',
          actor_id: USER_ID,
          team_id: null,
          usage_team_id: null,
          idempotency_key: 'manual-pre-run',
          trigger_source: 'onDemand',
          inputs: {},
          intermediate_parameters: null,
          output_overrides: null,
          child_recipe_name: null,
          child_recipe_namespace: null,
          owner_instance_id: null,
          max_duration_seconds: null,
          ttl_seconds_after_finished: null,
          approval_request_id: APPROVAL_ID,
          idempotency_payload_hash: 'hash-1',
          started_at: null,
          completed_at: null,
          last_reconciled_at: null,
          created_at: '2026-04-20T10:05:00.000Z',
          updated_at: '2026-04-20T10:05:00.000Z',
        },
      },
    })

    const res = await withInternalAuth(
      request(app)
        .post(`/api/v1/external/workflow-approvals/${APPROVAL_ID}/decide`)
        .set('x-user-session-token', sessionToken)
        .send({ decision: 'approve' })
    )

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      run: {
        id: '33333333-4444-4555-8666-777777777777',
        phase: 'Pending',
        source: 'live',
        actor: { type: 'user-session', userId: USER_ID },
      },
    })
  })

  it('rejects malformed approval ids before any DB lookup', async () => {
    const res = await withInternalAuth(
      request(app)
        .post('/api/v1/external/workflow-approvals/not-a-uuid/decide')
        .set('x-user-session-token', sessionToken)
        .send({ decision: 'approve' })
    )

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid approval id format')
    expect(mockPoolQuery).not.toHaveBeenCalled()
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('records the targeted approval team in the decision audit trail', async () => {
    const targetTeamId = '22222222-3333-4444-5555-666666666666'

    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: APPROVAL_ID,
          status: 'pending',
          target_user_id: null,
          target_team_id: targetTeamId,
          recipe_namespace: NS,
          recipe_name: RECIPE,
        },
      ],
      rowCount: 1,
    })

    vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)
    vi.mocked(findMembership).mockResolvedValueOnce({
      team_id: targetTeamId,
      role: 'admin',
      team_name: 'Target Team',
    } as never)
    vi.mocked(userApprovalRequestService.recordDecision).mockResolvedValueOnce({ ok: true })

    const res = await withInternalAuth(
      request(app)
        .post(`/api/v1/external/workflow-approvals/${APPROVAL_ID}/decide`)
        .set('x-user-session-token', sessionToken)
        .send({ decision: 'approve' })
    )

    expect(res.status).toBe(200)
    expect(userApprovalRequestService.recordDecision).toHaveBeenCalledWith(
      APPROVAL_ID,
      'approve',
      { userId: USER_ID, teamId: targetTeamId },
      undefined,
      expect.objectContaining({
        clientIp: expect.any(String),
        userAgent: null,
        correlationId: expect.any(String),
      })
    )
  })

  it('rejects decision when target no longer in allowlist', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: APPROVAL_ID,
          status: 'pending',
          target_user_id: USER_ID,
          target_team_id: null,
          recipe_namespace: NS,
          recipe_name: RECIPE,
        },
      ],
      rowCount: 1,
    })

    // Allowlist re-check fails
    vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(false)

    const res = await withInternalAuth(
      request(app)
        .post(`/api/v1/external/workflow-approvals/${APPROVAL_ID}/decide`)
        .set('x-user-session-token', sessionToken)
        .send({ decision: 'approve' })
    )

    expect(res.status).toBe(403)
    expect(res.body.error).toContain('allowlist')
  })

  it('rejects decision with invalid decision value', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: APPROVAL_ID,
          status: 'pending',
          target_user_id: USER_ID,
          target_team_id: null,
          recipe_namespace: NS,
          recipe_name: RECIPE,
        },
      ],
      rowCount: 1,
    })
    vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)

    const res = await withInternalAuth(
      request(app)
        .post(`/api/v1/external/workflow-approvals/${APPROVAL_ID}/decide`)
        .set('x-user-session-token', sessionToken)
        .send({ decision: 'maybe' })
    )

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('approve')
  })

  it('returns 500 when approval decision auth middleware hits an infrastructure error', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('db unavailable'))

    const res = await withInternalAuth(
      request(app)
        .post(`/api/v1/external/workflow-approvals/${APPROVAL_ID}/decide`)
        .set('x-user-session-token', sessionToken)
        .send({ decision: 'approve' })
    )

    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Internal Server Error')
    expect(res.body.correlationId).toBeDefined()
  })
})

/**
 * Security tests for the provisioner -> control-api mcp-host token issuance path.
 * Invariant: only InternalControl JWT callers can issue mcpHost credentials.
 */
describe('Security: /auth/mcp-host/:namespace/:name/tokens access control', () => {
  let app: ReturnType<typeof createApp>

  function internalControlSecretForIssuer(iss: string): string {
    return iss === 'hcc'
      ? config.internalControlJwtHccHmacSecret
      : config.internalControlJwtWrcHmacSecret
  }

  function signInternalControlJwt(
    iss: string,
    overrides: { audience?: string; secret?: string } = {}
  ): string {
    return jwt.sign(
      {
        iss,
        aud: overrides.audience ?? 'control-api',
        sub: `${iss}-provisioner`,
      },
      overrides.secret ?? internalControlSecretForIssuer(iss),
      {
        algorithm: 'HS256',
        expiresIn: 60,
        jwtid: `${iss}-issue-security-${Date.now()}`,
      }
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    app = createApp(new MockGateway('mcp-server') as never)
  })

  it('rejects request without auth', async () => {
    const res = await request(app).post('/api/v1/auth/mcp-host/ns/recipe/tokens')
    expect(res.status).toBe(401)
  })

  it('rejects workflow JWT access token (wrong auth type)', async () => {
    const { token } = issueMcpHostAccessJwt('ns', 'recipe')
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/ns/recipe/tokens')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects x-service-token: rpc-proxy (wrong service)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/ns/recipe/tokens')
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')
    expect(res.status).toBe(401)
  })

  // Negative coverage: malformed, wrongly scoped, or unknown InternalControl
  // identities must be rejected and must not fall back to static provisioner tokens.
  it('rejects malformed InternalControl bearer', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/ns/recipe/tokens')
      .set('Authorization', 'Bearer wrong-token-but-long-enough-to-pass-floor')
    expect(res.status).toBe(401)
  })

  it('rejects signed InternalControl JWT with wrong audience', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc', { audience: 'wrong-aud' })}`)
      .send({ includeMcpHostControlToken: true })
    expect(res.status).toBe(401)
  })

  it('rejects signed InternalControl JWT with unknown issuer', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('other')}`)
      .send({ includeMcpHostControlToken: true })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })

  it('rejects signed InternalControl JWT with wrong HMAC secret', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc', { secret: 'wrong-secret' })}`)
      .send({ includeMcpHostControlToken: true })
    expect(res.status).toBe(401)
  })

  it('rejects HCC issuer tokens signed with the WRC key', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/mcp-host/standalone/tokens')
      .set(
        'Authorization',
        `Bearer ${signInternalControlJwt('hcc', {
          secret: config.internalControlJwtWrcHmacSecret,
        })}`
      )
      .send({ includeMcpHostControlToken: true })
    expect(res.status).toBe(401)
  })

  it('rejects WRC issuer tokens signed with the HCC key', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/recipe/tokens')
      .set(
        'Authorization',
        `Bearer ${signInternalControlJwt('wrc', {
          secret: config.internalControlJwtHccHmacSecret,
        })}`
      )
      .send({ includeMcpHostControlToken: true })
    expect(res.status).toBe(401)
  })
})

/**
 * Security: Refresh token rotation (one-time use).
 */
describe('Security: Refresh token rotation', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    app = createApp(new MockGateway('mcp-server') as never)
  })

  it('issues new tokens with valid refresh token', async () => {
    const { token: refreshToken } = issueMcpHostRefreshJwt('ns', 'recipe')
    // Mock: INSERT revocation row succeeds, so this request wins the one-time-use race.
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ jti: 'jti-1' }], rowCount: 1 })
    const res = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${refreshToken}`)
      .send()
    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeDefined()
    expect(res.body.refreshToken).toBeDefined()
    for (const encoded of [res.body.accessToken, res.body.refreshToken]) {
      const claims = jwt.decode(encoded) as Record<string, unknown>
      expect(claims.aud).toBe(MCP_HOST_WORKFLOW_AUDIENCE)
      expect(claims.host_uid).toBeUndefined()
      expect(claims.mcpCapabilities).toBeUndefined()
    }
  })

  it('preserves signed HCC lineage across ordinary rotation and keeps the control token separate', async () => {
    const workflowControlScopes = ['workflow:list' as const, 'workflow:read' as const]
    const hostRef = 'chatllm'
    const hostUid = 'signed-host-uid'
    const { token: refreshToken } = issueMcpHostRefreshJwt(
      config.hostsNamespace,
      'standalone',
      [hostRef],
      {
        workflowControlScopes,
        hccCredential: { hostUid },
      }
    )
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ jti: 'hcc-refresh-jti' }], rowCount: 1 })

    const res = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${refreshToken}`)
      .send({ hostUid: 'body-controlled-uid', mcpCapabilities: [] })

    expect(res.status).toBe(200)
    for (const encoded of [res.body.accessToken, res.body.refreshToken]) {
      const claims = jwt.decode(encoded) as Record<string, unknown>
      expect(claims.aud).toEqual([MCP_HOST_WORKFLOW_AUDIENCE, MCP_HOST_HCC_AUDIENCE])
      expect(claims.hostRefs).toEqual([hostRef])
      expect(claims.host_uid).toBe(hostUid)
      expect(claims.mcpCapabilities).toEqual([MCP_HOST_CREDENTIAL_CAPABILITY])
      expect(claims.workflowControlScopes).toEqual(workflowControlScopes)
    }

    const control = jwt.decode(res.body.mcpHostControlToken) as Record<string, unknown>
    expect(control.aud).toBe('mcp-host')
    expect(control.hostRefs).toEqual([hostRef])
    expect(control.scopes).toEqual(workflowControlScopes)
    expect(control.host_uid).toBeUndefined()
    expect(control.mcpCapabilities).toBeUndefined()

    expect(verifyMcpHostAccessJwt(res.body.mcpHostControlToken)).toBeNull()
    await expect(verifyMcpHostRefreshJwt(res.body.mcpHostControlToken)).resolves.toBeNull()
    expect(verifyMcpHostControlJwt(res.body.accessToken)).toBeNull()
    expect(verifyMcpHostControlJwt(res.body.refreshToken)).toBeNull()
  })

  it('rejects access token used as refresh token (scope mismatch)', async () => {
    const { token: accessToken } = issueMcpHostAccessJwt('ns', 'recipe')
    const res = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${accessToken}`)
      .send()
    expect(res.status).toBe(401)
  })

  it('rejects reused refresh token (old JTI revoked after rotation)', async () => {
    const { token: refreshToken } = issueMcpHostRefreshJwt('ns', 'recipe')

    // First use - should succeed and consume the old JTI.
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ jti: 'jti-1' }], rowCount: 1 })

    const res1 = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${refreshToken}`)
      .send()
    expect(res1.status).toBe(200)
    expect(res1.body.refreshToken).toBeDefined()

    const res2 = await request(app)
      .post('/api/v1/workflow-auth/refresh')
      .set('Authorization', `Bearer ${refreshToken}`)
      .send()
    expect(res2.status).toBe(401)
  })

  it('allows only one winner when two refresh requests race on the same token', async () => {
    const { token: refreshToken } = issueMcpHostRefreshJwt('ns', 'recipe')

    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ jti: 'jti-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', `Bearer ${refreshToken}`)
        .send(),
      request(app)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', `Bearer ${refreshToken}`)
        .send(),
    ])

    expect([res1.status, res2.status].sort()).toEqual([200, 401])
  })
})

/**
 * Security: Recipe-binding enforcement.
 */
describe('Security: Recipe-binding enforcement', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    app = createApp(new MockGateway('mcp-server') as never)
  })

  it('uses JWT recipe claims and rejects body params that mismatch them', async () => {
    // Token is for "ns1/recipeA". The body MUST carry recipeNamespace/recipeName
    // equal to the JWT claims; mismatched body params are a binding violation
    // and must be rejected with 400 `recipe_binding_mismatch`.
    const { token } = issueMcpHostAccessJwt('ns1', 'recipeA')

    const res = await request(app)
      .post('/api/v1/workflow-approvals/request')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'key-1')
      .send({
        recipeNamespace: 'attacker-ns',
        recipeName: 'attacker-recipe',
        target: { userId: '00000000-0000-0000-0000-000000000001' },
        payload: { message: 'test' },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('recipe_binding_mismatch')
    // The service must NEVER be invoked when the binding is rejected.
    expect(userApprovalRequestService.allowlistCheck).not.toHaveBeenCalled()
    expect(userApprovalRequestService.createApprovalRequest).not.toHaveBeenCalled()
  })

  it('allows request when body recipe params match JWT claims', async () => {
    const { token } = issueMcpHostAccessJwt('ns1', 'recipeA')

    vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)
    vi.mocked(userApprovalRequestService.createApprovalRequest).mockResolvedValueOnce({
      id: 'test-id',
      status: 'pending' as const,
      expiresAt: '2026-01-01T00:00:00Z',
    })

    const res = await request(app)
      .post('/api/v1/workflow-approvals/request')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'key-2')
      .send({
        recipeNamespace: 'ns1',
        recipeName: 'recipeA',
        target: { userId: '00000000-0000-0000-0000-000000000001' },
        payload: { message: 'test' },
      })

    expect(res.status).toBe(200)
    // Verify the service was called with JWT claims (which equal body params).
    expect(userApprovalRequestService.allowlistCheck).toHaveBeenCalledWith(
      'ns1',
      'recipeA',
      '00000000-0000-0000-0000-000000000001',
      undefined
    )
  })
})
