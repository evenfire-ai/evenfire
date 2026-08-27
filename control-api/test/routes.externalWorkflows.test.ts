import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createExternalWorkflowsRouter } from '../src/routes/external/workflows/index.js'
import { MockGateway } from './mockGateway.js'

const RECIPE_NS = 'sandbox-recipes'

const mockPoolQuery = vi.fn()
const mockWithTransaction = vi.fn()
const mockIssueWorkflowControlToken = vi.fn()
const mockVerifyWorkflowControlToken = vi.fn()
const mockIsHostRefAuthorized = vi.fn()
const mockVerifyAdminToken = vi.fn()
const mockAuthenticateExternalUserSession = vi.fn()
const mockVerifyInternalControlJwt = vi.fn()
const mockIsAdminTokenRevoked = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => {
      if (String(args[0]).includes('SELECT lifecycle_state, lifecycle_version')) {
        return Promise.resolve({ rows: [{ lifecycle_state: 'active', lifecycle_version: 1 }] })
      }
      return mockPoolQuery(...args)
    },
  },
  withTransaction: (...args: unknown[]) => mockWithTransaction(...args),
}))

vi.mock('../src/utils/auth/mcpHostJwtToken.js', () => ({
  issueMcpHostControlJwt: (...args: unknown[]) => mockIssueWorkflowControlToken(...args),
  verifyMcpHostControlJwt: (...args: unknown[]) => mockVerifyWorkflowControlToken(...args),
  isHostRefAuthorized: (...args: unknown[]) => mockIsHostRefAuthorized(...args),
}))

vi.mock('../src/utils/auth/adminAuthToken.js', () => ({
  verifyAdminToken: (...args: unknown[]) => mockVerifyAdminToken(...args),
}))

vi.mock('../src/services/auth/externalSessionAuthentication.js', () => ({
  authenticateExternalUserSession: (...args: unknown[]) =>
    mockAuthenticateExternalUserSession(...args),
}))

vi.mock('../src/utils/auth/internalControlToken.js', () => ({
  verifyInternalControlJwt: (...args: unknown[]) => mockVerifyInternalControlJwt(...args),
}))

vi.mock('../src/services/adminAuthService.js', () => ({
  isAdminTokenRevoked: (...args: unknown[]) => mockIsAdminTokenRevoked(...args),
}))

vi.mock('../src/utils/auth/delegationToken.js', () => ({
  signWrcDelegationToken: vi.fn(() => 'mock-control-to-wrc-token'),
}))

vi.mock('../src/config.js', () => ({
  config: {
    mcpServersNamespace: 'mcp-server',
    sandboxNamespace: 'sandbox-recipes',
    userApprovalRequestDefaultTtlSec: 3600,
  },
}))

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
}))

const VALID_RECIPE = {
  metadata: {
    name: 'test-recipe',
    namespace: RECIPE_NS,
    uid: 'uid-123',
    creationTimestamp: '2026-04-18T09:00:00.000Z',
  },
  spec: {
    workloads: [{ id: 'svc', type: 'deployment', image: 'my-image:latest' }],
    triggers: { onDemand: { requiresApproval: false } },
  },
}

const USER_SESSION_CLAIMS = {
  userId: 'user-123',
  email: 'user@example.com',
  teamId: 'team-1',
  role: 'member' as const,
  authGeneration: 1,
  exp: Math.floor(Date.now() / 1000) + 3600,
}

const ADMIN_CLAIMS = {
  sub: 'admin-1',
  typ: 'user' as const,
  role: 'admin' as const,
  jti: 'admin-jti',
  exp: Math.floor(Date.now() / 1000) + 3600,
}

const WORKFLOW_CONTROL_CLAIMS = {
  sub: `${RECIPE_NS}/test-recipe`,
  recipeNamespace: RECIPE_NS,
  recipeName: 'test-recipe',
  hostRefs: [`${RECIPE_NS}/test-recipe`],
  typ: 'service' as const,
  scopes: ['workflow:list', 'workflow:read', 'workflow:trigger'] as const,
  iss: 'test',
  aud: 'mcp-host',
  jti: 'mcp-host-control-jti',
  exp: Math.floor(Date.now() / 1000) + 600,
}

function makeApp(gateway: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createExternalWorkflowsRouter(gateway as never))
  return app
}

describe('routes/external/workflows', () => {
  let gateway: MockGateway

  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockWithTransaction.mockReset()
    mockIssueWorkflowControlToken.mockReset()
    mockVerifyWorkflowControlToken.mockReset()
    mockIsHostRefAuthorized.mockReset()
    mockVerifyAdminToken.mockReset()
    mockAuthenticateExternalUserSession.mockReset()
    mockVerifyInternalControlJwt.mockReset()
    mockIsAdminTokenRevoked.mockReset()
    gateway = new MockGateway(RECIPE_NS)

    mockIssueWorkflowControlToken.mockReturnValue({
      token: 'mock-mcp-host-workflow-control-token',
      expiresInSeconds: 600,
    })
    mockIsAdminTokenRevoked.mockResolvedValue(false)
    mockAuthenticateExternalUserSession.mockImplementation(token => {
      if (token === 'user-session-token' || token === 'user-session-token-rotated') {
        return Promise.resolve({
          status: 'authenticated',
          contract: 'v1',
          claims: USER_SESSION_CLAIMS,
          authorityContext: {
            contract: 'v1',
            userId: USER_SESSION_CLAIMS.userId,
            tokenHash: `${token}-hash`,
            issuedAt: USER_SESSION_CLAIMS.iat,
            authGeneration: USER_SESSION_CLAIMS.authGeneration,
          },
        })
      }
      if (token === 'user-session-token-b') {
        return Promise.resolve({
          status: 'authenticated',
          contract: 'v1',
          claims: { ...USER_SESSION_CLAIMS, userId: 'user-456' },
          authorityContext: {
            contract: 'v1',
            userId: 'user-456',
            tokenHash: `${token}-hash`,
            issuedAt: USER_SESSION_CLAIMS.iat,
            authGeneration: USER_SESSION_CLAIMS.authGeneration,
          },
        })
      }
      return Promise.resolve({ status: 'invalid', reason: 'invalid_representation' })
    })
    mockVerifyAdminToken.mockImplementation(token =>
      token === 'admin-token' ? ADMIN_CLAIMS : null
    )
    mockVerifyWorkflowControlToken.mockImplementation(token =>
      token === 'mcp-host-workflow-control-token' ? WORKFLOW_CONTROL_CLAIMS : null
    )
    mockVerifyInternalControlJwt.mockImplementation(token =>
      token === 'internal-control-wrc-token'
        ? {
            iss: 'wrc',
            sub: 'wrc-provisioner',
            jti: 'internal-control-jti',
            exp: Math.floor(Date.now() / 1000) + 60,
          }
        : null
    )
    mockIsHostRefAuthorized.mockImplementation(
      (claims: { hostRefs?: string[] }, ns: string, name: string) =>
        Array.isArray(claims.hostRefs) && claims.hostRefs.includes(`${ns}/${name}`)
    )
    mockWithTransaction.mockImplementation(
      async (work: (db: { query: typeof mockPoolQuery }) => unknown) =>
        work({ query: mockPoolQuery })
    )
  })

  describe('Caller-kind gate (allowedCallerKinds: ["user-session"])', () => {
    it('accepts user-session callers on GET /external/workflows', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ recipe_namespace: RECIPE_NS, recipe_name: 'test-recipe' }],
        rowCount: 1,
      })

      const app = makeApp(gateway)
      const res = await request(app)
        .get('/external/workflows')
        .set('x-user-session-token', 'user-session-token')
        .expect(200)

      expect(res.body.count).toBe(1)
      expect(res.body.items[0].metadata.name).toBe('test-recipe')
    })

    it('rejects admin-ui callers with 401 (not 403) to prevent auth-probing', async () => {
      const app = makeApp(gateway)
      await request(app)
        .get('/external/workflows')
        .set('Authorization', 'Bearer admin-token')
        .expect(401)
    })

    it('rejects mcp-host-control callers with 401 (not 403) to prevent auth-probing', async () => {
      const app = makeApp(gateway)
      await request(app)
        .get('/external/workflows')
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .expect(401)
    })

    it('rejects InternalControl provisioner callers with 401 (not 403) to prevent auth-probing', async () => {
      const app = makeApp(gateway)
      await request(app)
        .get('/external/workflows')
        .set('Authorization', 'Bearer internal-control-wrc-token')
        .expect(401)
    })

    it('returns 401 when no credentials are supplied', async () => {
      const app = makeApp(gateway)
      await request(app).get('/external/workflows').expect(401)
    })
  })

  describe('runtime token issuance isolation', () => {
    it('does NOT register POST /external/workflows/:ns/:name/auth/issue', async () => {
      // External mount must not expose token issuance. No router handler means
      // Express falls through to 404 (admin-ui bearer alone would otherwise 201).
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)

      const app = makeApp(gateway)
      await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/auth/issue`)
        .set('Authorization', 'Bearer admin-token')
        .expect(404)
    })

    it('does NOT register the endpoint even for user-session callers', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)

      const app = makeApp(gateway)
      await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/auth/issue`)
        .set('x-user-session-token', 'user-session-token')
        .expect(404)
    })
  })

  describe('Cross-user isolation (ensureRecipeAuthorized)', () => {
    it('returns 403 when user-session caller has no grant for the recipe', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      // direct user grant miss, then current-session team grant miss.
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const app = makeApp(gateway)
      await request(app)
        .get(`/external/workflows/${RECIPE_NS}/test-recipe`)
        .set('x-user-session-token', 'user-session-token')
        .expect(403)
    })

    it('allows user-session caller to view a recipe they are granted', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })

      const app = makeApp(gateway)
      const res = await request(app)
        .get(`/external/workflows/${RECIPE_NS}/test-recipe`)
        .set('x-user-session-token', 'user-session-token')
        .expect(200)

      expect(res.body.metadata.name).toBe('test-recipe')
    })
  })

  describe('POST /external/workflows/:ns/:name/trigger', () => {
    // Rate limiter (10 req/min per token) consumes the first mockPoolQuery call
    // — see matching helper in adminWorkflows.test.ts.
    function mockRateLimiterAllowed() {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: 1 }], rowCount: 1 })
    }

    function makeTransportRecipe(overrides: Record<string, unknown> = {}) {
      return {
        ...VALID_RECIPE,
        ...overrides,
        spec: {
          ...VALID_RECIPE.spec,
          ...((overrides.spec as Record<string, unknown> | undefined) ?? {}),
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'ghcr.io/aas-ee/open-web-search:latest',
              transport: { type: 'streamableHttp' },
              egressBindings: [{ egressClass: 'public-web' }],
            },
          ],
        },
      }
    }

    it('requires Idempotency-Key header', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })

      const app = makeApp(gateway)
      await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('x-user-session-token', 'user-session-token')
        .send({ inputs: { topic: 'alpha' } })
        .expect(400)
    })

    it('creates a run when authorized user-session caller supplies Idempotency-Key', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const dbRow = {
        run_id: 'external-run-uuid',
        recipe_namespace: RECIPE_NS,
        recipe_name: 'test-recipe',
        phase: 'Pending',
        actor_type: 'user',
        actor_id: 'user-123',
        idempotency_key: 'external-key-1',
        trigger_source: 'onDemand',
        inputs: { topic: 'alpha' },
        intermediate_parameters: null,
        output_overrides: null,
        child_recipe_name: null,
        child_recipe_namespace: null,
        owner_instance_id: null,
        max_duration_seconds: null,
        ttl_seconds_after_finished: null,
        started_at: '2026-04-20T10:05:00.000Z',
        completed_at: null,
        last_reconciled_at: null,
        created_at: '2026-04-20T10:05:00.000Z',
        updated_at: '2026-04-20T10:05:00.000Z',
      }
      mockRateLimiterAllowed()
      mockPoolQuery
        // 1. ensureRecipeAuthorized → granted
        .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
        // 2. createRun INSERT ... ON CONFLICT DO NOTHING RETURNING * → winner
        .mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 })

      const app = makeApp(gateway)
      const res = await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer service-token')
        .set('x-user-session-token', 'user-session-token')
        .set('Idempotency-Key', 'external-key-1')
        .send({ inputs: { topic: 'alpha' } })
        .expect(201)

      expect(res.body.id).toBe('external-run-uuid')
      expect(res.body.phase).toBe('Pending')
      expect(res.body.source).toBe('live')
      expect(res.body.actor).toEqual({ type: 'user-session', userId: 'user-123' })
      expect(res.body.executionRef).toBeNull()
    })

    it('creates a pre-run approval instead of a run when onDemand approval is required', async () => {
      await gateway.createResource(
        'workflowrecipes',
        {
          ...VALID_RECIPE,
          spec: {
            ...VALID_RECIPE.spec,
            triggers: { onDemand: { requiresApproval: true, allowedActors: ['user'] } },
          },
        } as never,
        RECIPE_NS
      )
      mockRateLimiterAllowed()
      mockPoolQuery
        // 1. ensureRecipeAuthorized → granted
        .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
        // 2. allowlistCheck → direct user target allowed
        .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
        // 3. createWorkflowTriggerApprovalRequest INSERT workflow_approval_requests
        .mockResolvedValueOnce({
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              expires_at: '2026-04-20T11:05:00.000Z',
              status: 'pending',
            },
          ],
          rowCount: 1,
        })
        // 4. typed trigger intent insert
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        // 5. typed run intent insert
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })

      const app = makeApp(gateway)
      const res = await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('x-user-session-token', 'user-session-token')
        .set('Idempotency-Key', 'external-key-approval')
        .send({ inputs: { topic: 'alpha' } })
        .expect(202)

      expect(res.body).toMatchObject({
        approvalRequired: true,
        approvalRequestId: '11111111-1111-4111-8111-111111111111',
        status: 'pending',
      })
      expect(
        mockPoolQuery.mock.calls.some(call => String(call[0]).includes('INSERT INTO workflow_runs'))
      ).toBe(false)
      expect(mockPoolQuery).toHaveBeenCalledTimes(6)
    })

    it('rejects approval-gated user triggers before transport MCP runtime is ready', async () => {
      await gateway.createResource(
        'workflowrecipes',
        makeTransportRecipe({
          status: {
            phase: 'active',
            workloadInstances: { 'web-search': 'test-recipe-web-search-a1b2c3d4' },
          },
          spec: {
            ...VALID_RECIPE.spec,
            triggers: { onDemand: { requiresApproval: true, allowedActors: ['user'] } },
          },
        }) as never,
        RECIPE_NS
      )
      mockRateLimiterAllowed()
      mockPoolQuery
        // 1. direct/session trigger grant exists
        .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })

      const app = makeApp(gateway)
      const res = await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('x-user-session-token', 'user-session-token')
        .set('Idempotency-Key', 'external-key-runtime-not-ready')
        .send({ inputs: { topic: 'alpha' } })
        .expect(409)

      expect(res.body).toMatchObject({
        error: 'workflow_runtime_not_ready',
        reason: 'mcpserver_missing',
      })
      expect(
        mockPoolQuery.mock.calls.some(call =>
          String(call[0]).includes('INSERT INTO workflow_approval_requests')
        )
      ).toBe(false)
      expect(
        mockPoolQuery.mock.calls.some(call => String(call[0]).includes('INSERT INTO workflow_runs'))
      ).toBe(false)
    })

    it('rejects an idempotency hit that lacks a typed trigger run intent', async () => {
      await gateway.createResource(
        'workflowrecipes',
        {
          ...VALID_RECIPE,
          spec: {
            ...VALID_RECIPE.spec,
            triggers: { onDemand: { requiresApproval: true, allowedActors: ['user'] } },
          },
        } as never,
        RECIPE_NS
      )
      const callerKey = `external-rest-api:user:${USER_SESSION_CLAIMS.userId}:direct`
      const idempotencyKey = 'external-key-stale-approval'
      const payload = {
        message: `Approve ${RECIPE_NS}/test-recipe workflow trigger.`,
        metadata: {
          workflowTrigger: {
            namespace: RECIPE_NS,
            name: 'test-recipe',
            caller: callerKey,
          },
          workflowTriggerRequest: {
            source: 'external-rest-api',
            actorType: 'user',
          },
        },
      }
      const { computePayloadHash } = await import('../src/services/userApprovalRequestService.js')
      const payloadHash = computePayloadHash({
        targetUserId: USER_SESSION_CLAIMS.userId,
        payload,
        correlation: { taskId: idempotencyKey },
        ttlSeconds: 3600,
      })

      mockRateLimiterAllowed()
      mockPoolQuery
        // 1. ensureRecipeAuthorized → granted
        .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
        // 2. allowlistCheck → direct user target allowed
        .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
        // 3. createWorkflowTriggerApprovalRequest INSERT hits idempotency conflict
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // 4. existing approval has matching request hash but no typed run intent
        .mockResolvedValueOnce({
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              status: 'pending',
              expiresAt: '2026-04-20T11:05:00.000Z',
              payloadHash,
              runIntentApprovalRequestId: null,
              run_id: null,
            },
          ],
          rowCount: 1,
        })

      const app = makeApp(gateway)
      const res = await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('x-user-session-token', 'user-session-token')
        .set('Idempotency-Key', idempotencyKey)
        .send({ inputs: { topic: 'alpha' } })
        .expect(409)

      expect(res.body).toMatchObject({
        error: 'idempotency_key_payload_mismatch',
        approvalRequestId: '11111111-1111-4111-8111-111111111111',
        status: 'pending',
        message: expect.stringContaining('missing typed workflow run intent'),
      })
      expect(
        mockPoolQuery.mock.calls.some(call =>
          String(call[0]).includes('INSERT INTO workflow_approval_trigger_run_intents')
        )
      ).toBe(false)
    })

    it('rejects user-session trigger when recipe does not declare onDemand trigger', async () => {
      await gateway.createResource(
        'workflowrecipes',
        {
          ...VALID_RECIPE,
          spec: {
            workloads: VALID_RECIPE.spec.workloads,
          },
        } as never,
        RECIPE_NS
      )
      mockRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })

      const app = makeApp(gateway)
      const res = await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('x-user-session-token', 'user-session-token')
        .set('Idempotency-Key', 'external-key-no-trigger')
        .send({ inputs: { topic: 'alpha' } })
        .expect(400)

      expect(res.body.error).toBe('Workflow does not declare an onDemand trigger')
      expect(mockPoolQuery).toHaveBeenCalledTimes(2)
    })

    it('returns 403 when user lacks recipe grant — prevents cross-user trigger', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockRateLimiterAllowed()
      // direct user grant miss, then current-session team grant miss.
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const app = makeApp(gateway)
      await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('x-user-session-token', 'user-session-token')
        .set('Idempotency-Key', 'external-key-2')
        .send({ inputs: { topic: 'alpha' } })
        .expect(403)
    })

    function rateLimitBucketKeys(): string[] {
      return mockPoolQuery.mock.calls
        .filter(call => String(call[0]).includes('INSERT INTO rate_limit_buckets'))
        .map(call => String((call[1] as unknown[] | undefined)?.[0] ?? ''))
    }

    it('keys independent trigger buckets for two user sessions behind the same service bearer', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      })
      mockRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      })

      const app = makeApp(gateway)
      await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer service-token')
        .set('x-user-session-token', 'user-session-token')
        .set('Idempotency-Key', 'external-key-user-a')
        .send({ inputs: { topic: 'alpha' } })
        .expect(403)
      await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer service-token')
        .set('x-user-session-token', 'user-session-token-b')
        .set('Idempotency-Key', 'external-key-user-b')
        .send({ inputs: { topic: 'alpha' } })
        .expect(403)

      const keys = rateLimitBucketKeys()
      expect(keys).toHaveLength(2)
      expect(keys[0]).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
      expect(keys[1]).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
      expect(keys[0]).not.toBe(keys[1])
    })

    it('reuses one trigger bucket for two session tokens of the same verified user', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      })
      mockRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      })

      const app = makeApp(gateway)
      await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer service-token')
        .set('x-user-session-token', 'user-session-token')
        .set('Idempotency-Key', 'external-key-same-user-a')
        .send({ inputs: { topic: 'alpha' } })
        .expect(403)
      await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer service-token')
        .set('x-user-session-token', 'user-session-token-rotated')
        .set('Idempotency-Key', 'external-key-same-user-b')
        .send({ inputs: { topic: 'alpha' } })
        .expect(403)

      const keys = rateLimitBucketKeys()
      expect(keys).toHaveLength(2)
      expect(keys[0]).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
      expect(keys[0]).toBe(keys[1])
    })

    it('reuses one trigger bucket for the same user session and service bearer', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      })
      mockRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      })

      const app = makeApp(gateway)
      await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer service-token')
        .set('x-user-session-token', 'user-session-token')
        .set('Idempotency-Key', 'external-key-same-a')
        .send({ inputs: { topic: 'alpha' } })
        .expect(403)
      await request(app)
        .post(`/external/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer service-token')
        .set('x-user-session-token', 'user-session-token')
        .set('Idempotency-Key', 'external-key-same-b')
        .send({ inputs: { topic: 'alpha' } })
        .expect(403)

      const keys = rateLimitBucketKeys()
      expect(keys).toHaveLength(2)
      expect(keys[0]).toMatch(/^workflow_trigger:[0-9a-f]{32}$/)
      expect(keys[0]).toBe(keys[1])
    })
  })

  describe('GET /external/workflows/:ns/:name/health', () => {
    it('serves workflow health for an authorized user-session caller', async () => {
      await gateway.createResource(
        'workflowrecipes',
        {
          ...VALID_RECIPE,
          status: {
            phase: 'Ready',
            workflowExecution: { phase: 'Idle' },
          },
        } as never,
        RECIPE_NS
      )
      mockPoolQuery
        // 1. ensureRecipeAuthorized → granted
        .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
        // 2. listRunsByRecipe → one active live run
        .mockResolvedValueOnce({
          rows: [
            {
              run_id: 'external-health-run-id',
              recipe_namespace: RECIPE_NS,
              recipe_name: 'test-recipe',
              phase: 'Running',
              actor_type: 'user',
              actor_id: 'user-123',
              idempotency_key: null,
              trigger_source: 'onDemand',
              inputs: null,
              intermediate_parameters: null,
              output_overrides: null,
              child_recipe_name: null,
              child_recipe_namespace: null,
              owner_instance_id: null,
              max_duration_seconds: null,
              ttl_seconds_after_finished: null,
              started_at: '2026-04-20T10:05:05.000Z',
              completed_at: null,
              last_reconciled_at: null,
              created_at: '2026-04-20T10:05:00.000Z',
              updated_at: '2026-04-20T10:05:00.000Z',
            },
          ],
          rowCount: 1,
        })
        // 3. workflow_runs_audit → empty
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const app = makeApp(gateway)
      const res = await request(app)
        .get(`/external/workflows/${RECIPE_NS}/test-recipe/health`)
        .set('x-user-session-token', 'user-session-token')
        .expect(200)

      expect(res.body).toMatchObject({
        recipe: `${RECIPE_NS}/test-recipe`,
        phase: 'Ready',
        workflowPhase: 'Idle',
        activeRuns: 1,
      })
      expect(res.body.lastRun.id).toBe('external-health-run-id')
    })

    it('scopes workflow health to runs owned by the user-session caller', async () => {
      await gateway.createResource(
        'workflowrecipes',
        {
          ...VALID_RECIPE,
          status: {
            phase: 'Ready',
            workflowExecution: { phase: 'Idle' },
          },
        } as never,
        RECIPE_NS
      )
      mockPoolQuery
        // 1. ensureRecipeAuthorized → granted
        .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
        // 2. Scoped live DB lookup; in-memory guard rejects an over-broad DB result too.
        .mockResolvedValueOnce({
          rows: [
            {
              run_id: 'foreign-running-run-id',
              recipe_namespace: RECIPE_NS,
              recipe_name: 'test-recipe',
              phase: 'Running',
              actor_type: 'user',
              actor_id: 'other-user',
              team_id: 'team-1',
              usage_team_id: 'team-1',
              idempotency_key: null,
              trigger_source: 'onDemand',
              inputs: null,
              intermediate_parameters: null,
              output_overrides: null,
              child_recipe_name: 'foreign-child',
              child_recipe_namespace: RECIPE_NS,
              owner_instance_id: null,
              max_duration_seconds: null,
              ttl_seconds_after_finished: null,
              approval_request_id: null,
              idempotency_payload_hash: null,
              started_at: '2026-04-20T10:06:00.000Z',
              completed_at: null,
              last_reconciled_at: null,
              created_at: '2026-04-20T10:06:00.000Z',
              updated_at: '2026-04-20T10:06:00.000Z',
            },
          ],
          rowCount: 1,
        })
        // 3. workflow_runs_audit → empty
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const app = makeApp(gateway)
      const res = await request(app)
        .get(`/external/workflows/${RECIPE_NS}/test-recipe/health`)
        .set('x-user-session-token', 'user-session-token')
        .expect(200)

      expect(res.body.activeRuns).toBe(0)
      expect(res.body.lastRun).toBeNull()
    })

    it('returns 403 when the user-session caller has no health grant', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const app = makeApp(gateway)
      await request(app)
        .get(`/external/workflows/${RECIPE_NS}/test-recipe/health`)
        .set('x-user-session-token', 'user-session-token')
        .expect(403)
    })

    it('returns 404 when the current recipe no longer exists', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })

      const app = makeApp(gateway)
      await request(app)
        .get(`/external/workflows/${RECIPE_NS}/test-recipe/health`)
        .set('x-user-session-token', 'user-session-token')
        .expect(404)
    })
  })

  describe('GET /external/workflows/:ns/:name/runs', () => {
    it('returns empty list when user has grant but no runs exist', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockPoolQuery
        // 1. ensureRecipeAuthorized → granted
        .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
        // 2. listRunsByRecipe live DB lookup → empty
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // 3. workflow_runs_audit → empty
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const app = makeApp(gateway)
      const res = await request(app)
        .get(`/external/workflows/${RECIPE_NS}/test-recipe/runs?limit=10`)
        .set('x-user-session-token', 'user-session-token')
        .expect(200)

      expect(res.body.count).toBe(0)
      expect(res.body.items).toEqual([])
    })

    it('does not expose another user run even when caller has a grant to the same recipe', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockPoolQuery
        // 1. ensureRecipeAuthorized → granted
        .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
        // 2. Scoped live DB lookup; in-memory guard also rejects a buggy over-broad DB result.
        .mockResolvedValueOnce({
          rows: [
            {
              run_id: 'foreign-run-id',
              recipe_namespace: RECIPE_NS,
              recipe_name: 'test-recipe',
              phase: 'Succeeded',
              actor_type: 'user',
              actor_id: 'other-user',
              team_id: 'team-1',
              usage_team_id: 'team-1',
              idempotency_key: null,
              trigger_source: 'onDemand',
              inputs: null,
              intermediate_parameters: null,
              output_overrides: null,
              child_recipe_name: 'foreign-child',
              child_recipe_namespace: RECIPE_NS,
              owner_instance_id: null,
              max_duration_seconds: null,
              ttl_seconds_after_finished: null,
              approval_request_id: null,
              idempotency_payload_hash: null,
              started_at: '2026-04-20T10:06:00.000Z',
              completed_at: '2026-04-20T10:07:00.000Z',
              last_reconciled_at: null,
              created_at: '2026-04-20T10:06:00.000Z',
              updated_at: '2026-04-20T10:07:00.000Z',
            },
            {
              run_id: 'own-run-id',
              recipe_namespace: RECIPE_NS,
              recipe_name: 'test-recipe',
              phase: 'Succeeded',
              actor_type: 'user',
              actor_id: 'user-123',
              team_id: 'team-1',
              usage_team_id: 'team-1',
              idempotency_key: null,
              trigger_source: 'onDemand',
              inputs: null,
              intermediate_parameters: null,
              output_overrides: null,
              child_recipe_name: 'own-child',
              child_recipe_namespace: RECIPE_NS,
              owner_instance_id: null,
              max_duration_seconds: null,
              ttl_seconds_after_finished: null,
              approval_request_id: null,
              idempotency_payload_hash: null,
              started_at: '2026-04-20T10:05:00.000Z',
              completed_at: '2026-04-20T10:05:30.000Z',
              last_reconciled_at: null,
              created_at: '2026-04-20T10:05:00.000Z',
              updated_at: '2026-04-20T10:05:30.000Z',
            },
          ],
          rowCount: 2,
        })
        // 3. workflow_runs_audit → includes only a foreign archived run, also rejected.
        .mockResolvedValueOnce({
          rows: [
            {
              run_id: 'foreign-audit-run-id',
              triggerer_user_id: 'other-user',
              triggerer_admin_user_id: null,
              triggerer_team_id: 'team-1',
              usage_team_id: 'team-1',
              triggerer_actor_type: 'user',
              triggerer_host_ref: null,
              triggered_at: '2026-04-20T09:00:00.000Z',
              started_at: '2026-04-20T09:00:00.000Z',
              completed_at: '2026-04-20T09:01:00.000Z',
              final_phase: 'Succeeded',
              error_message: null,
            },
          ],
          rowCount: 1,
        })

      const app = makeApp(gateway)
      const res = await request(app)
        .get(`/external/workflows/${RECIPE_NS}/test-recipe/runs?limit=10`)
        .set('x-user-session-token', 'user-session-token')
        .expect(200)

      expect(res.body.count).toBe(1)
      expect(res.body.items.map((item: { id: string }) => item.id)).toEqual(['own-run-id'])
      expect(JSON.stringify(mockPoolQuery.mock.calls[1][0])).toContain('actor_id::text')
    })

    it('exposes an approval-bound autonomous run to the approval target user only', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockPoolQuery
        // 1. ensureRecipeAuthorized → granted
        .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
        // 2. Scoped live DB lookup returns one approval-targeted run and one foreign run.
        .mockResolvedValueOnce({
          rows: [
            {
              run_id: 'approved-target-run-id',
              recipe_namespace: RECIPE_NS,
              recipe_name: 'test-recipe',
              phase: 'Succeeded',
              actor_type: 'autonomous',
              actor_id: 'mcp-host-principal',
              team_id: null,
              usage_team_id: null,
              idempotency_key: 'approval-key-1',
              trigger_source: 'autonomous',
              inputs: null,
              intermediate_parameters: null,
              output_overrides: null,
              child_recipe_name: 'approved-target-child',
              child_recipe_namespace: RECIPE_NS,
              owner_instance_id: null,
              max_duration_seconds: null,
              ttl_seconds_after_finished: null,
              approval_request_id: '00000000-0000-4000-8000-000000000123',
              approval_target_user_id: 'user-123',
              approval_target_team_id: null,
              approval_target_team_member_user_id: null,
              idempotency_payload_hash: 'hash-1',
              started_at: '2026-04-20T10:06:00.000Z',
              completed_at: '2026-04-20T10:07:00.000Z',
              last_reconciled_at: null,
              created_at: '2026-04-20T10:06:00.000Z',
              updated_at: '2026-04-20T10:07:00.000Z',
            },
            {
              run_id: 'foreign-approved-run-id',
              recipe_namespace: RECIPE_NS,
              recipe_name: 'test-recipe',
              phase: 'Succeeded',
              actor_type: 'autonomous',
              actor_id: 'mcp-host-principal',
              team_id: null,
              usage_team_id: null,
              idempotency_key: 'approval-key-2',
              trigger_source: 'autonomous',
              inputs: null,
              intermediate_parameters: null,
              output_overrides: null,
              child_recipe_name: 'foreign-approved-child',
              child_recipe_namespace: RECIPE_NS,
              owner_instance_id: null,
              max_duration_seconds: null,
              ttl_seconds_after_finished: null,
              approval_request_id: '00000000-0000-4000-8000-000000000456',
              approval_target_user_id: 'other-user',
              approval_target_team_id: null,
              approval_target_team_member_user_id: null,
              idempotency_payload_hash: 'hash-2',
              started_at: '2026-04-20T10:08:00.000Z',
              completed_at: '2026-04-20T10:09:00.000Z',
              last_reconciled_at: null,
              created_at: '2026-04-20T10:08:00.000Z',
              updated_at: '2026-04-20T10:09:00.000Z',
            },
          ],
          rowCount: 2,
        })
        // 3. workflow_runs_audit → empty
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const app = makeApp(gateway)
      const res = await request(app)
        .get(`/external/workflows/${RECIPE_NS}/test-recipe/runs?limit=10`)
        .set('x-user-session-token', 'user-session-token')
        .expect(200)

      expect(res.body.count).toBe(1)
      expect(res.body.items.map((item: { id: string }) => item.id)).toEqual([
        'approved-target-run-id',
      ])
      expect(String(mockPoolQuery.mock.calls[1][0])).toContain('workflow_approval_requests')
      expect(String(mockPoolQuery.mock.calls[1][0])).toContain('team_workflow_triggers')
      expect(String(mockPoolQuery.mock.calls[1][0])).toContain("tm.status = 'active'")
    })

    it('returns 403 when user-session caller is not granted to the recipe', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const app = makeApp(gateway)
      await request(app)
        .get(`/external/workflows/${RECIPE_NS}/test-recipe/runs?limit=10`)
        .set('x-user-session-token', 'user-session-token')
        .expect(403)
    })
  })

  describe('Defense in depth — basePath isolation', () => {
    it('does NOT expose /admin/workflows under the external mount', async () => {
      const app = makeApp(gateway)
      // External mount registers only /external/workflows; /admin/workflows has no handler,
      // so Express falls through to 404 — even with valid credentials.
      await request(app)
        .get('/admin/workflows')
        .set('x-user-session-token', 'user-session-token')
        .expect(404)
    })
  })
})
