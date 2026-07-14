import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createWorkflowsAdminRouter } from '../src/routes/admin/workflows/index.js'
import { createMcpHostWorkflowRoutes } from '../src/routes/mcp-host/workflows/index.js'
import { MockGateway } from './mockGateway.js'

const RECIPE_NS = 'sandbox-recipes'
const CONTROL_PLANE_ADMIN_USAGE_TEAM_ID = 'control-plane-admin-ui'

const mockPoolQuery = vi.fn()
const mockPoolConnect = vi.fn()
const mockIssueWorkflowControlToken = vi.fn()
const mockVerifyWorkflowControlToken = vi.fn()
const mockVerifyInternalControlJwt = vi.fn()
const mockIsHostRefAuthorized = vi.fn()
const mockVerifyAdminToken = vi.fn()
const mockVerifyExternalSessionToken = vi.fn()
const mockIsAdminTokenRevoked = vi.fn()
const mockListWorkflowGrants = vi.fn()
const mockSetWorkflowGrants = vi.fn()
const mockListTeamWorkflowGrants = vi.fn()
const mockSetTeamWorkflowGrants = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: (...args: unknown[]) => mockPoolConnect(...args),
  },
  withTransaction: vi.fn(),
}))

vi.mock('../src/utils/auth/mcpHostJwtToken.js', () => ({
  issueMcpHostControlJwt: (...args: unknown[]) => mockIssueWorkflowControlToken(...args),
  verifyMcpHostControlJwt: (...args: unknown[]) => mockVerifyWorkflowControlToken(...args),
  isHostRefAuthorized: (...args: unknown[]) => mockIsHostRefAuthorized(...args),
  getMcpHostCallerKey: (claims: { hostRefs?: string[]; sub: string }) => {
    const hostRef = claims.hostRefs?.[0]?.trim()
    if (!hostRef) throw new Error('mcp-host JWT missing canonical hostRefs[0] caller binding')
    return hostRef
  },
}))

vi.mock('../src/utils/auth/internalControlToken.js', () => ({
  verifyInternalControlJwt: (...args: unknown[]) => mockVerifyInternalControlJwt(...args),
}))

vi.mock('../src/utils/auth/adminAuthToken.js', () => ({
  verifyAdminToken: (...args: unknown[]) => mockVerifyAdminToken(...args),
}))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: (...args: unknown[]) => mockVerifyExternalSessionToken(...args),
}))

vi.mock('../src/services/adminAuthService.js', () => ({
  isAdminTokenRevoked: (...args: unknown[]) => mockIsAdminTokenRevoked(...args),
}))

vi.mock('../src/services/directory/index.js', () => ({
  listTeamWorkflowGrants: (...args: unknown[]) => mockListTeamWorkflowGrants(...args),
  listWorkflowGrants: (...args: unknown[]) => mockListWorkflowGrants(...args),
  setTeamWorkflowGrants: (...args: unknown[]) => mockSetTeamWorkflowGrants(...args),
  setWorkflowGrants: (...args: unknown[]) => mockSetWorkflowGrants(...args),
}))

vi.mock('../src/utils/auth/delegationToken.js', () => ({
  signWrcDelegationToken: vi.fn(() => 'mock-control-to-wrc-token'),
}))

vi.mock('../src/config.js', () => ({
  config: {
    hostsNamespace: 'mcp-host',
    mcpServersNamespace: 'mcp-server',
    sandboxNamespace: 'sandbox-recipes',
  },
}))

// Typed loosely because individual tests override `spec.triggers.onDemand` with
// fields (e.g. `allowedActors`) that are read dynamically on the server side.
const VALID_RECIPE: {
  metadata: { name: string; namespace: string; uid: string; creationTimestamp: string }
  spec: {
    workloads: Array<{ id: string; type: string; image: string }>
    triggers: {
      onDemand: { requiresApproval: boolean; allowedActors?: string[] }
    }
    runRetention?: {
      maxRunDurationSeconds?: number
      ttlSecondsAfterFinished?: number
    }
    inputContract?: Record<string, unknown>
  }
} = {
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

function makeRecipe(
  overrides: Partial<typeof VALID_RECIPE> & { status?: Record<string, unknown> } = {}
) {
  return {
    ...VALID_RECIPE,
    ...overrides,
    metadata: {
      ...VALID_RECIPE.metadata,
      ...(overrides.metadata ?? {}),
    },
    spec: {
      ...VALID_RECIPE.spec,
      ...(overrides.spec ?? {}),
    },
  }
}

const USER_SESSION_CLAIMS = {
  userId: 'user-123',
  email: 'user@example.com',
  teamId: 'team-1',
  role: 'member' as const,
  exp: Math.floor(Date.now() / 1000) + 3600,
}

const ADMIN_CLAIMS = {
  // Production `signAdminToken` always sets `sub` to `users.id`, which is a
  // UUID. Using a valid UUID here (instead of 'admin-1') keeps the fixture
  // realistic so that if a future integration test lifts the service mock
  // and executes the real `::uuid` cast in `trigger_grants_audit`, this
  // value parses cleanly.
  sub: '00000000-0000-4000-8000-000000000001',
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
  app.use(createWorkflowsAdminRouter(gateway as never))
  return app
}

function makeRuntimeApp(gateway: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createMcpHostWorkflowRoutes(gateway as never))
  return app
}

function makeApiRuntimeApp(gateway: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', createMcpHostWorkflowRoutes(gateway as never))
  return app
}

describe('routes/admin/workflows', () => {
  let gateway: MockGateway

  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockPoolConnect.mockReset()
    mockIssueWorkflowControlToken.mockReset()
    mockVerifyWorkflowControlToken.mockReset()
    mockVerifyInternalControlJwt.mockReset()
    mockIsHostRefAuthorized.mockReset()
    mockVerifyAdminToken.mockReset()
    mockVerifyExternalSessionToken.mockReset()
    mockIsAdminTokenRevoked.mockReset()
    mockListWorkflowGrants.mockReset()
    mockSetWorkflowGrants.mockReset()
    mockListTeamWorkflowGrants.mockReset()
    mockSetTeamWorkflowGrants.mockReset()
    vi.unstubAllGlobals()
    gateway = new MockGateway(RECIPE_NS)

    mockIssueWorkflowControlToken.mockReturnValue({
      token: 'mock-mcp-host-workflow-control-token',
      expiresInSeconds: 600,
    })
    mockIsAdminTokenRevoked.mockResolvedValue(false)
    mockVerifyExternalSessionToken.mockImplementation(token =>
      token === 'user-session-token' ? USER_SESSION_CLAIMS : null
    )
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
            aud: 'control-api',
            sub: 'wrc-provisioner',
            iat: 1,
            exp: 9999999999,
            jti: 'wrc-jti',
          }
        : token === 'internal-control-hcc-token'
          ? {
              iss: 'hcc',
              aud: 'control-api',
              sub: 'hcc-provisioner',
              iat: 1,
              exp: 9999999999,
              jti: 'hcc-jti',
            }
          : token === 'internal-control-other-token'
            ? {
                iss: 'other',
                aud: 'control-api',
                sub: 'other-provisioner',
                iat: 1,
                exp: 9999999999,
                jti: 'other-jti',
              }
            : null
    )
    mockIsHostRefAuthorized.mockImplementation(
      (claims: { hostRefs?: string[] }, ns: string, name: string) =>
        Array.isArray(claims.hostRefs) && claims.hostRefs.includes(`${ns}/${name}`)
    )
  })

  describe('runtime /workflows broker routes', () => {
    it('requires mcp-host-control auth', async () => {
      const app = makeRuntimeApp(gateway)
      await request(app).get('/workflows').set('Authorization', 'Bearer admin-token').expect(401)
    })

    it('lists minimal runtime DTOs for mcp-host-control callers', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)

      const app = makeRuntimeApp(gateway)
      const res = await request(app)
        .get('/workflows')
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .expect(200)

      expect(res.body).toEqual({
        items: [
          {
            namespace: RECIPE_NS,
            name: 'test-recipe',
            hostRef: `${RECIPE_NS}/test-recipe`,
            phase: 'Unknown',
            workflowPhase: null,
            triggers: { onDemand: { requiresApproval: false } },
            inputContract: null,
          },
        ],
        count: 1,
      })
      expect(res.body.items[0].spec).toBeUndefined()
    })

    it('filters shared mcp-host runtime lists by the authenticated approval target grants', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      await gateway.createResource(
        'workflowrecipes',
        makeRecipe({
          metadata: { name: 'other-recipe', namespace: RECIPE_NS, uid: 'uid-456' },
        }) as never,
        RECIPE_NS
      )
      mockVerifyWorkflowControlToken.mockImplementation(token =>
        token === 'mcp-host-workflow-control-token'
          ? {
              ...WORKFLOW_CONTROL_CLAIMS,
              sub: 'mcp-host/standalone',
              recipeNamespace: 'mcp-host',
              recipeName: 'standalone',
              hostRefs: ['mcp-host/standalone'],
            }
          : null
      )
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ recipe_namespace: RECIPE_NS, recipe_name: 'test-recipe' }],
        rowCount: 1,
      })

      const app = makeRuntimeApp(gateway)
      const res = await request(app)
        .get('/workflows?targetUserId=00000000-0000-4000-8000-000000000001')
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .expect(200)

      expect(res.body.count).toBe(1)
      expect(res.body.items.map((item: { name: string }) => item.name)).toEqual(['test-recipe'])
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining('FROM user_workflow_triggers'),
        ['00000000-0000-4000-8000-000000000001']
      )
    })

    it('does not expose workflows to a shared mcp-host runtime list without approval target context', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      await gateway.createResource(
        'workflowrecipes',
        makeRecipe({
          metadata: { name: 'other-recipe', namespace: RECIPE_NS, uid: 'uid-456' },
        }) as never,
        RECIPE_NS
      )
      mockVerifyWorkflowControlToken.mockImplementation(token =>
        token === 'mcp-host-workflow-control-token'
          ? {
              ...WORKFLOW_CONTROL_CLAIMS,
              sub: 'mcp-host/standalone',
              recipeNamespace: 'mcp-host',
              recipeName: 'standalone',
              hostRefs: ['mcp-host/standalone'],
            }
          : null
      )

      const app = makeRuntimeApp(gateway)
      const res = await request(app)
        .get('/workflows')
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .expect(200)

      expect(res.body).toEqual({ items: [], count: 0 })
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('lists only hostRefs allowed by a mcp-host-control token', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      await gateway.createResource(
        'workflowrecipes',
        {
          metadata: { name: 'other-recipe', namespace: RECIPE_NS, uid: 'uid-456' },
          spec: VALID_RECIPE.spec,
        } as never,
        RECIPE_NS
      )

      const app = makeRuntimeApp(gateway)
      const res = await request(app)
        .get('/workflows')
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .expect(200)

      expect(res.body.count).toBe(1)
      expect(res.body.items[0].name).toBe('test-recipe')
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('does not expose runtime runs route', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)

      const app = makeRuntimeApp(gateway)
      await request(app)
        .get(`/workflows/${RECIPE_NS}/test-recipe/runs`)
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .expect(404)
    })

    it('serves runtime status at the real /api/v1/workflows mount with minimized DTOs', async () => {
      await gateway.createResource(
        'workflowrecipes',
        makeRecipe({
          spec: {
            inputContract: {
              required: ['company'],
              properties: {
                company: { type: 'string', description: 'Target company' },
                depth: { type: 'string', enum: ['standard', 'full'], default: 'full' },
              },
            },
          },
          status: {
            phase: 'Ready',
            workflowExecution: { phase: 'Idle' },
            conditions: [{ type: 'LeakyInternalDetail', message: 'do not expose from status DTO' }],
          },
        }),
        RECIPE_NS
      )
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const app = makeApiRuntimeApp(gateway)
      const res = await request(app)
        .get(`/api/v1/workflows/${RECIPE_NS}/test-recipe`)
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .expect(200)

      expect(res.body).toEqual({
        namespace: RECIPE_NS,
        name: 'test-recipe',
        hostRef: `${RECIPE_NS}/test-recipe`,
        phase: 'Ready',
        workflowPhase: 'Idle',
        triggers: { onDemand: { requiresApproval: false } },
        inputContract: {
          required: ['company'],
          properties: {
            company: { type: 'string', description: 'Target company' },
            depth: { type: 'string', enum: ['standard', 'full'], default: 'full' },
          },
        },
        latestRun: null,
      })
      expect(res.body.conditions).toBeUndefined()
      expect(res.body.spec).toBeUndefined()
    })

    it('serves runtime health without raw conditions', async () => {
      await gateway.createResource(
        'workflowrecipes',
        makeRecipe({
          status: {
            phase: 'Ready',
            workflowExecution: { phase: 'Idle' },
            conditions: [{ type: 'InternalFailure', message: 'raw condition text' }],
          },
        }),
        RECIPE_NS
      )
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      const app = makeApiRuntimeApp(gateway)
      const res = await request(app)
        .get(`/api/v1/workflows/${RECIPE_NS}/test-recipe/health`)
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .expect(200)

      expect(res.body).toEqual({
        recipe: `${RECIPE_NS}/test-recipe`,
        phase: 'Ready',
        workflowPhase: 'Idle',
        activeRuns: 0,
        lastRun: null,
      })
      expect(res.body.conditions).toBeUndefined()
    })
  })

  describe('GET /admin/workflows', () => {
    it('returns 401 when no supported caller is present', async () => {
      const app = makeApp(gateway)
      await request(app).get('/admin/workflows').expect(401)
    })

    it('rejects user-session callers on the admin mount', async () => {
      const app = makeApp(gateway)
      await request(app)
        .get('/admin/workflows')
        .set('x-user-session-token', 'user-session-token')
        .expect(401)

      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('rejects mcp-host-control tokens on the admin workflows mount', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)

      const app = makeApp(gateway)
      await request(app)
        .get('/admin/workflows')
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .expect(401)

      expect(mockPoolQuery).not.toHaveBeenCalled()
    })
  })

  describe('POST /admin/workflows/:ns/:name/auth/issue', () => {
    it('does not register admin runtime token issuance in the greenfield lane model', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)

      const app = makeApp(gateway)
      await request(app)
        .post(`/admin/workflows/${RECIPE_NS}/test-recipe/auth/issue`)
        .set('Authorization', 'Bearer admin-token')
        .expect(404)

      expect(mockIssueWorkflowControlToken).not.toHaveBeenCalled()
    })

    it('does not expose admin issuance paths to WRC/HCC provisioners', async () => {
      const app = makeApp(gateway)
      await request(app)
        .post(`/admin/workflows/${RECIPE_NS}/test-recipe/auth/issue`)
        .set('Authorization', 'Bearer internal-control-wrc-token')
        .expect(404)

      await request(app)
        .post('/admin/workflows/mcp-host/standalone/auth/issue')
        .set('Authorization', 'Bearer internal-control-hcc-token')
        .expect(404)
    })
  })

  describe('POST /admin/workflows/:ns/:name/trigger', () => {
    function makeDbRow(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        run_id: 'new-run-uuid',
        recipe_namespace: RECIPE_NS,
        recipe_name: 'test-recipe',
        phase: 'Pending',
        actor_type: 'admin',
        team_id: null,
        usage_team_id: CONTROL_PLANE_ADMIN_USAGE_TEAM_ID,
        actor_id: ADMIN_CLAIMS.sub,
        idempotency_key: 'mcp-host-control-key',
        trigger_source: 'onDemand',
        inputs: { topic: 'alpha' },
        intermediate_parameters: null,
        output_overrides: null,
        child_recipe_name: null,
        child_recipe_namespace: null,
        owner_instance_id: null,
        max_duration_seconds: null,
        ttl_seconds_after_finished: null,
        approval_request_id: null,
        idempotency_payload_hash: null,
        started_at: '2026-04-20T10:00:00.000Z',
        completed_at: null,
        last_reconciled_at: null,
        created_at: '2026-04-20T10:00:00.000Z',
        updated_at: '2026-04-20T10:00:00.000Z',
        ...overrides,
      }
    }

    // Rate limiter (10 req/min per token) runs BEFORE the handler and consumes
    // the first mockPoolQuery call. Every POST /trigger test must mock the
    // rate_limit_buckets INSERT ... RETURNING count first.
    function mockRateLimiterAllowed() {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: 1 }], rowCount: 1 })
    }

    function mockApprovalTriggerBinding(
      callerKey = `${RECIPE_NS}/test-recipe`,
      approvalRequestId = '00000000-0000-4000-8000-000000000123'
    ) {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          {
            status: 'approved',
            triggerNamespace: RECIPE_NS,
            triggerName: 'test-recipe',
            triggerCaller: callerKey,
          },
        ],
        rowCount: 1,
      })
      return approvalRequestId
    }

    function makeTransportRecipe(
      overrides: Partial<typeof VALID_RECIPE> & { status?: Record<string, unknown> } = {}
    ) {
      return makeRecipe({
        ...overrides,
        spec: {
          ...VALID_RECIPE.spec,
          ...(overrides.spec ?? {}),
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
      })
    }

    async function seedReadyTransportRuntime(mcpServerName = 'test-recipe-web-search-a1b2c3d4') {
      await gateway.createResource(
        'mcpservers',
        {
          metadata: { name: mcpServerName, namespace: 'mcp-server' },
          spec: { contextRef: 'wf-test-recipe' },
          status: {
            conditions: [
              { type: 'Ready', status: 'True' },
              { type: 'ExternalEgressReady', status: 'True' },
            ],
          },
        } as never,
        'mcp-server'
      )
      await gateway.createResource(
        'contexts',
        {
          metadata: { name: 'wf-test-recipe', namespace: 'mcp-server' },
          spec: { contextId: 'wf-test-recipe', mcpServers: [mcpServerName] },
        } as never,
        'mcp-server'
      )
      gateway.seedServiceEndpoints(mcpServerName, 'mcp-server', 1)
    }

    function mockApprovedRunTx(row: Record<string, unknown>) {
      const txQuery = vi.fn()
      txQuery
        .mockResolvedValueOnce({ rows: [], rowCount: null })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({
          rows: [
            {
              status: 'approved',
              recipeNamespace: 'mcp-host',
              recipeName: 'standalone',
              isExpired: false,
              targetUserId: '00000000-0000-4000-8000-000000000001',
              targetTeamId: null,
              decidedByUserId: '00000000-0000-4000-8000-000000000001',
              triggerNamespace: RECIPE_NS,
              triggerName: 'test-recipe',
              triggerCaller: `${RECIPE_NS}/test-recipe`,
              targetUserAllowed: true,
              targetTeamAllowed: false,
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ teamId: null }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: null })
      const release = vi.fn()
      mockPoolConnect.mockResolvedValueOnce({ query: txQuery, release })
      return { txQuery, release }
    }

    it('requires the Idempotency-Key header', async () => {
      mockRateLimiterAllowed()
      const app = makeApp(gateway)
      await request(app)
        .post(`/admin/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer admin-token')
        .expect(400)
    })

    it('rejects mcp-host-control tokens on the admin trigger lane', async () => {
      mockRateLimiterAllowed()
      const app = makeApp(gateway)
      await request(app)
        .post(`/admin/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .set('Idempotency-Key', 'mcp-host-control-key')
        .send({ approvalRequestId: '00000000-0000-4000-8000-000000000123' })
        .expect(401)

      expect(mockPoolConnect).not.toHaveBeenCalled()
      expect(mockVerifyWorkflowControlToken).not.toHaveBeenCalled()
    })

    it('creates an approval-bound workflow run for mcp-host-control callers', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const row = makeDbRow({
        actor_type: 'autonomous',
        actor_id: 'autonomous-actor',
        trigger_source: 'autonomous',
        approval_request_id: '00000000-0000-4000-8000-000000000123',
        idempotency_payload_hash: 'hash-1',
      })
      mockRateLimiterAllowed()
      const approvalRequestId = mockApprovalTriggerBinding()
      const { txQuery } = mockApprovedRunTx(row)

      const app = makeApiRuntimeApp(gateway)
      const res = await request(app)
        .post(`/api/v1/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .set('Idempotency-Key', 'mcp-host-control-key')
        .send({
          approvalRequestId,
          inputs: { topic: 'alpha' },
        })
        .expect(201)

      expect(res.body.id).toBe('new-run-uuid')
      expect(res.body.source).toBe('live')
      expect(res.body.phase).toBe('Pending')
      expect(res.body.actor).toEqual({
        type: 'mcp-host',
        hostRef: `${RECIPE_NS}/test-recipe`,
      })
      expect(res.body.executionRef).toBeNull()
      expect(txQuery).toHaveBeenCalledWith(expect.stringContaining("SET status = 'consumed'"), [
        '00000000-0000-4000-8000-000000000123',
        RECIPE_NS,
        'test-recipe',
        `${RECIPE_NS}/test-recipe`,
      ])
    })

    it('creates an approval-bound workflow run through the runtime mount', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const row = makeDbRow({
        actor_type: 'autonomous',
        actor_id: 'autonomous-actor',
        trigger_source: 'autonomous',
        approval_request_id: '00000000-0000-4000-8000-000000000123',
        idempotency_payload_hash: 'hash-1',
      })
      mockRateLimiterAllowed()
      const approvalRequestId = mockApprovalTriggerBinding()
      const { txQuery } = mockApprovedRunTx(row)

      const app = makeApiRuntimeApp(gateway)
      const res = await request(app)
        .post(`/api/v1/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .set('Idempotency-Key', 'mcp-host-control-key')
        .send({
          approvalRequestId,
          inputs: { topic: 'alpha' },
        })
        .expect(201)

      expect(res.body).toMatchObject({
        id: 'new-run-uuid',
        source: 'live',
        phase: 'Pending',
        actor: {
          type: 'mcp-host',
          hostRef: `${RECIPE_NS}/test-recipe`,
        },
      })
      expect(txQuery).toHaveBeenCalledWith(expect.stringContaining("SET status = 'consumed'"), [
        '00000000-0000-4000-8000-000000000123',
        RECIPE_NS,
        'test-recipe',
        `${RECIPE_NS}/test-recipe`,
      ])
    })

    it('rejects mcp-host-control triggers without approvalRequestId', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockRateLimiterAllowed()

      const app = makeApiRuntimeApp(gateway)
      await request(app)
        .post(`/api/v1/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .set('Idempotency-Key', 'mcp-host-control-key')
        .send({ inputs: { topic: 'alpha' } })
        .expect(400)

      expect(mockPoolConnect).not.toHaveBeenCalled()
    })

    it('rejects mcp-host-control triggers when recipe does not declare onDemand trigger', async () => {
      await gateway.createResource(
        'workflowrecipes',
        makeRecipe({
          spec: {
            ...VALID_RECIPE.spec,
            triggers: {} as never,
          },
        }) as never,
        RECIPE_NS
      )
      mockRateLimiterAllowed()
      const approvalRequestId = mockApprovalTriggerBinding()

      const app = makeApiRuntimeApp(gateway)
      const res = await request(app)
        .post(`/api/v1/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .set('Idempotency-Key', 'autonomous-missing-on-demand-key')
        .send({
          approvalRequestId,
          inputs: { topic: 'alpha' },
        })
        .expect(400)

      expect(res.body.error).toBe('Workflow does not declare an onDemand trigger')
      expect(mockPoolConnect).not.toHaveBeenCalled()
    })

    it('maps approval consume failures on runtime trigger to contract 4xx responses', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockRateLimiterAllowed()
      const approvalRequestId = mockApprovalTriggerBinding()
      const txQuery = vi.fn()
      txQuery
        .mockResolvedValueOnce({ rows: [], rowCount: null })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({
          rows: [
            {
              status: 'approved',
              recipeNamespace: 'mcp-host',
              recipeName: 'standalone',
              isExpired: false,
              targetUserId: '00000000-0000-4000-8000-000000000001',
              targetTeamId: null,
              decidedByUserId: '00000000-0000-4000-8000-000000000001',
              triggerNamespace: RECIPE_NS,
              triggerName: 'test-recipe',
              triggerCaller: `${RECIPE_NS}/test-recipe`,
              targetUserAllowed: false,
              targetTeamAllowed: false,
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: null })
      const release = vi.fn()
      mockPoolConnect.mockResolvedValueOnce({ query: txQuery, release })

      const app = makeApiRuntimeApp(gateway)
      const res = await request(app)
        .post(`/api/v1/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .set('Idempotency-Key', 'mcp-host-control-key')
        .send({
          approvalRequestId,
          inputs: { topic: 'alpha' },
        })
        .expect(403)

      expect(res.body).toEqual({
        error: 'approval_target_not_allowed',
        approvalStatus: 'approved',
      })
      expect(txQuery).toHaveBeenLastCalledWith('ROLLBACK')
      expect(release).toHaveBeenCalled()
    })

    it('persists spec.runRetention onto the created run', async () => {
      await gateway.createResource(
        'workflowrecipes',
        makeRecipe({
          spec: {
            ...VALID_RECIPE.spec,
            runRetention: { maxRunDurationSeconds: 7200, ttlSecondsAfterFinished: 3600 },
          },
        }) as never,
        RECIPE_NS
      )
      mockRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeDbRow({ max_duration_seconds: 7200, ttl_seconds_after_finished: 3600 })],
        rowCount: 1,
      })

      const app = makeApp(gateway)
      await request(app)
        .post(`/admin/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer admin-token')
        .set('Idempotency-Key', 'retention-key')
        .send({ inputs: { topic: 'alpha' } })
        .expect(201)

      expect(mockPoolQuery).toHaveBeenCalledTimes(2)
      const insertCall = mockPoolQuery.mock.calls[1] as [string, unknown[]]
      expect(insertCall[0]).toContain('INSERT INTO workflow_runs')
      expect(insertCall[1]?.[2]).toBe('admin')
      expect(insertCall[1]?.[3]).toBeNull()
      expect(insertCall[1]?.[4]).toBe(CONTROL_PLANE_ADMIN_USAGE_TEAM_ID)
      expect(insertCall[1]?.[5]).toBe(ADMIN_CLAIMS.sub)
      expect(insertCall[1]?.[11]).toBe(7200)
      expect(insertCall[1]?.[12]).toBe(3600)
    })

    it('defaults omitted run artifact retention to the 30 day maximum', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeDbRow({ ttl_seconds_after_finished: 2_592_000 })],
        rowCount: 1,
      })

      const app = makeApp(gateway)
      await request(app)
        .post(`/admin/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer admin-token')
        .set('Idempotency-Key', 'retention-default-key')
        .send({ inputs: { topic: 'alpha' } })
        .expect(201)

      const insertCall = mockPoolQuery.mock.calls[1] as [string, unknown[]]
      expect(insertCall[0]).toContain('INSERT INTO workflow_runs')
      expect(insertCall[1]?.[11]).toBeNull()
      expect(insertCall[1]?.[12]).toBe(2_592_000)
    })

    it('keeps admin-ui as a control-plane actor without treating it as a workflow user', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeDbRow()],
        rowCount: 1,
      })

      const app = makeApp(gateway)
      const res = await request(app)
        .post(`/admin/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer admin-token')
        .set('Idempotency-Key', 'admin-ui-key')
        .send({ inputs: { topic: 'alpha' } })
        .expect(201)

      const insertCall = mockPoolQuery.mock.calls[1] as [string, unknown[]]
      expect(insertCall[1]?.[2]).toBe('admin')
      expect(insertCall[1]?.[3]).toBeNull()
      expect(insertCall[1]?.[4]).toBe(CONTROL_PLANE_ADMIN_USAGE_TEAM_ID)
      expect(insertCall[1]?.[5]).toBe(ADMIN_CLAIMS.sub)
      expect(res.body.actor).toEqual({
        type: 'admin-ui',
        adminUserId: ADMIN_CLAIMS.sub,
      })
    })

    it('runs approval-gated workflows as admin without user or team trigger grants', async () => {
      await gateway.createResource(
        'workflowrecipes',
        makeRecipe({
          spec: {
            ...VALID_RECIPE.spec,
            triggers: { onDemand: { requiresApproval: true, allowedActors: ['user'] } },
          },
        }) as never,
        RECIPE_NS
      )
      mockRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeDbRow({ idempotency_key: 'admin-approval-gated-zero-grants-key' })],
        rowCount: 1,
      })

      const app = makeApp(gateway)
      const res = await request(app)
        .post(`/admin/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer admin-token')
        .set('Idempotency-Key', 'admin-approval-gated-zero-grants-key')
        .send({ inputs: { topic: 'alpha' } })
        .expect(201)

      const sqlCalls = mockPoolQuery.mock.calls.map(call => String(call[0]))
      expect(sqlCalls.some(sql => sql.includes('FROM user_workflow_triggers'))).toBe(false)
      expect(sqlCalls.some(sql => sql.includes('FROM team_workflow_triggers'))).toBe(false)
      expect(sqlCalls.some(sql => sql.includes('INSERT INTO workflow_approval_requests'))).toBe(
        false
      )
      expect(sqlCalls.some(sql => sql.includes('INSERT INTO workflow_runs'))).toBe(true)

      const insertCall = mockPoolQuery.mock.calls[1] as [string, unknown[]]
      expect(insertCall[1]?.[2]).toBe('admin')
      expect(insertCall[1]?.[3]).toBeNull()
      expect(insertCall[1]?.[4]).toBe(CONTROL_PLANE_ADMIN_USAGE_TEAM_ID)
      expect(insertCall[1]?.[5]).toBe(ADMIN_CLAIMS.sub)
      expect(res.body.actor).toEqual({
        type: 'admin-ui',
        adminUserId: ADMIN_CLAIMS.sub,
      })
      expect(res.body.approvalRequestId).toBeUndefined()
    })

    it('rejects operator runs before transport MCP runtime endpoints are ready', async () => {
      await gateway.createResource(
        'workflowrecipes',
        makeTransportRecipe({
          status: {
            phase: 'active',
            workloadInstances: { 'web-search': 'test-recipe-web-search-a1b2c3d4' },
          },
        }) as never,
        RECIPE_NS
      )
      await gateway.createResource(
        'mcpservers',
        {
          metadata: { name: 'test-recipe-web-search-a1b2c3d4', namespace: 'mcp-server' },
          spec: { contextRef: 'wf-test-recipe' },
          status: {
            conditions: [
              { type: 'Ready', status: 'True' },
              { type: 'ExternalEgressReady', status: 'True' },
            ],
          },
        } as never,
        'mcp-server'
      )
      await gateway.createResource(
        'contexts',
        {
          metadata: { name: 'wf-test-recipe', namespace: 'mcp-server' },
          spec: { contextId: 'wf-test-recipe', mcpServers: ['test-recipe-web-search-a1b2c3d4'] },
        } as never,
        'mcp-server'
      )
      mockRateLimiterAllowed()

      const app = makeApp(gateway)
      const res = await request(app)
        .post(`/admin/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer admin-token')
        .set('Idempotency-Key', 'transport-not-ready-key')
        .send({ inputs: { topic: 'alpha' } })
        .expect(409)

      expect(res.body).toMatchObject({
        error: 'workflow_runtime_not_ready',
        reason: 'service_endpoints_missing',
      })
      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    })

    it('creates operator runs after transport MCP runtime endpoints are ready', async () => {
      await gateway.createResource(
        'workflowrecipes',
        makeTransportRecipe({
          status: {
            phase: 'active',
            workloadInstances: { 'web-search': 'test-recipe-web-search-a1b2c3d4' },
          },
        }) as never,
        RECIPE_NS
      )
      await seedReadyTransportRuntime()
      mockRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeDbRow({ idempotency_key: 'transport-ready-key' })],
        rowCount: 1,
      })

      const app = makeApp(gateway)
      const res = await request(app)
        .post(`/admin/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer admin-token')
        .set('Idempotency-Key', 'transport-ready-key')
        .send({ inputs: { topic: 'alpha' } })
        .expect(201)

      expect(res.body.id).toBe('new-run-uuid')
      const insertCall = mockPoolQuery.mock.calls[1] as [string, unknown[]]
      expect(insertCall[0]).toContain('INSERT INTO workflow_runs')
      expect(insertCall[1]?.[2]).toBe('admin')
      expect(insertCall[1]?.[4]).toBe(CONTROL_PLANE_ADMIN_USAGE_TEAM_ID)
    })

    it('rejects user/admin triggers when onDemand.allowedActors excludes "user"', async () => {
      await gateway.createResource(
        'workflowrecipes',
        makeRecipe({
          spec: {
            ...VALID_RECIPE.spec,
            triggers: { onDemand: { requiresApproval: false, allowedActors: ['autonomous'] } },
          },
        }) as never,
        RECIPE_NS
      )
      mockRateLimiterAllowed()

      const app = makeApp(gateway)
      await request(app)
        .post(`/admin/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer admin-token')
        .set('Idempotency-Key', 'user-blocked-key')
        .expect(403)

      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    })

    it('does not treat "operator" as a supported onDemand.allowedActors value', async () => {
      await gateway.createResource(
        'workflowrecipes',
        makeRecipe({
          spec: {
            ...VALID_RECIPE.spec,
            triggers: { onDemand: { requiresApproval: false, allowedActors: ['operator'] } },
          },
        }) as never,
        RECIPE_NS
      )
      mockRateLimiterAllowed()

      const app = makeApp(gateway)
      const res = await request(app)
        .post(`/admin/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer admin-token')
        .set('Idempotency-Key', 'operator-actor-key')
        .expect(403)

      expect(res.body.error).toBe('Actor "user" is not allowed to trigger this workflow')
      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    })

    it('rejects mcp-host-control triggers when onDemand.allowedActors excludes "autonomous"', async () => {
      await gateway.createResource(
        'workflowrecipes',
        makeRecipe({
          spec: {
            ...VALID_RECIPE.spec,
            triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
          },
        }) as never,
        RECIPE_NS
      )
      mockRateLimiterAllowed()
      const approvalRequestId = mockApprovalTriggerBinding()

      const app = makeApiRuntimeApp(gateway)
      await request(app)
        .post(`/api/v1/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer mcp-host-workflow-control-token')
        .set('Idempotency-Key', 'autonomous-blocked-key')
        .send({ approvalRequestId })
        .expect(403)

      expect(mockPoolQuery).toHaveBeenCalledTimes(2)
    })

    it('returns 200 with existing run when idempotency key collides', async () => {
      // New flow: INSERT returns rowCount 0 → service does SELECT with the same
      // (recipe_ns, recipe_name, idempotency_key) tuple → existing row is returned.
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const existing = makeDbRow({
        run_id: 'existing-run-uuid',
        phase: 'Running',
        idempotency_key: 'race-winner-visible-key',
      })
      mockRateLimiterAllowed()
      mockPoolQuery
        // 1. INSERT ... ON CONFLICT DO NOTHING → rowCount 0 (conflict)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // 2. Service falls back to SELECT existing row
        .mockResolvedValueOnce({ rows: [existing], rowCount: 1 })

      const app = makeApp(gateway)
      const res = await request(app)
        .post(`/admin/workflows/${RECIPE_NS}/test-recipe/trigger`)
        .set('Authorization', 'Bearer admin-token')
        .set('Idempotency-Key', 'race-winner-visible-key')
        .send({ inputs: { topic: 'alpha' } })
        .expect(200)

      expect(res.body.id).toBe('existing-run-uuid')
      expect(res.body.phase).toBe('Running')
    })
  })

  describe('GET /admin/workflows/:ns/:name/health', () => {
    it('falls back to archived history for lastRun when no live runs remain', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)

      mockPoolQuery
        // 1. listRunsByRecipe → no live workflow_runs
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 0,
        })
        // 2. latest workflow_runs_audit row
        .mockResolvedValueOnce({
          rows: [
            {
              run_id: 'archived-run-id',
              triggerer_user_id: 'user-123',
              triggerer_actor_type: 'user',
              triggerer_host_ref: null,
              triggered_at: '2026-04-18T09:00:00.000Z',
              started_at: '2026-04-18T09:00:05.000Z',
              completed_at: '2026-04-18T09:00:20.000Z',
              final_phase: 'Succeeded',
              error_message: null,
            },
          ],
          rowCount: 1,
        })

      const app = makeApp(gateway)
      const res = await request(app)
        .get(`/admin/workflows/${RECIPE_NS}/test-recipe/health`)
        .set('Authorization', 'Bearer admin-token')
        .expect(200)

      expect(res.body.activeRuns).toBe(0)
      expect(res.body.lastRun).toEqual({
        id: 'archived-run-id',
        source: 'audit',
        phase: 'Succeeded',
        triggeredAt: '2026-04-18T09:00:00.000Z',
        startedAt: '2026-04-18T09:00:05.000Z',
        completedAt: '2026-04-18T09:00:20.000Z',
        message: null,
        actor: { type: 'user-session', userId: 'user-123' },
        executionRef: null,
      })
    })

    it('prefers a newer archived run over an older live run when computing lastRun', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)

      mockPoolQuery
        // 1. listRunsByRecipe → one older live run still present
        .mockResolvedValueOnce({
          rows: [
            {
              run_id: 'old-live-run-id',
              recipe_namespace: RECIPE_NS,
              recipe_name: 'test-recipe',
              phase: 'Running',
              actor_type: 'autonomous',
              actor_id: null,
              idempotency_key: null,
              trigger_source: 'autonomous',
              inputs: null,
              intermediate_parameters: null,
              output_overrides: null,
              child_recipe_name: 'test-recipe-child-1',
              child_recipe_namespace: RECIPE_NS,
              owner_instance_id: null,
              max_duration_seconds: null,
              ttl_seconds_after_finished: null,
              started_at: '2026-04-18T08:00:10.000Z',
              completed_at: null,
              last_reconciled_at: null,
              created_at: '2026-04-18T08:00:00.000Z',
              updated_at: '2026-04-18T08:00:00.000Z',
            },
          ],
          rowCount: 1,
        })
        // 2. newer archived run
        .mockResolvedValueOnce({
          rows: [
            {
              run_id: 'newer-archived-run-id',
              triggerer_user_id: 'user-123',
              triggerer_actor_type: 'user',
              triggerer_host_ref: null,
              triggered_at: '2026-04-18T09:00:00.000Z',
              started_at: '2026-04-18T09:00:05.000Z',
              completed_at: '2026-04-18T09:00:20.000Z',
              final_phase: 'Succeeded',
              error_message: null,
            },
          ],
          rowCount: 1,
        })

      const app = makeApp(gateway)
      const res = await request(app)
        .get(`/admin/workflows/${RECIPE_NS}/test-recipe/health`)
        .set('Authorization', 'Bearer admin-token')
        .expect(200)

      expect(res.body.activeRuns).toBe(1)
      expect(res.body.lastRun.id).toBe('newer-archived-run-id')
      expect(res.body.lastRun.source).toBe('audit')
    })
  })

  describe('GET /admin/workflows/:ns/:name/runs', () => {
    it('returns 404 for a namespace outside the workflow recipe allowlist', async () => {
      const app = makeApp(gateway)
      await request(app)
        .get('/admin/workflows/mcp-server/test-recipe/runs')
        .set('Authorization', 'Bearer admin-token')
        .expect(404)

      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('returns 404 before reading runs when the current recipe is absent', async () => {
      const app = makeApp(gateway)
      await request(app)
        .get(`/admin/workflows/${RECIPE_NS}/test-recipe/runs?limit=10`)
        .set('Authorization', 'Bearer admin-token')
        .expect(404)

      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('returns a canonical DTO merging live DB rows with audit rows', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)

      mockPoolQuery
        // 1. listRunsByRecipe -> live workflow_runs
        .mockResolvedValueOnce({
          rows: [
            {
              run_id: 'live-run-id',
              recipe_namespace: RECIPE_NS,
              recipe_name: 'test-recipe',
              phase: 'Running',
              actor_type: 'autonomous',
              actor_id: null,
              idempotency_key: null,
              trigger_source: 'autonomous',
              inputs: null,
              intermediate_parameters: null,
              output_overrides: null,
              child_recipe_name: 'test-recipe-child-1',
              child_recipe_namespace: RECIPE_NS,
              owner_instance_id: null,
              max_duration_seconds: null,
              ttl_seconds_after_finished: null,
              started_at: '2026-04-18T10:00:10.000Z',
              completed_at: null,
              last_reconciled_at: null,
              created_at: '2026-04-18T10:00:00.000Z',
              updated_at: '2026-04-18T10:00:00.000Z',
            },
          ],
          rowCount: 1,
        })
        // 2. workflow_runs_audit query
        .mockResolvedValueOnce({
          rows: [
            {
              run_id: 'audit-run-id',
              triggerer_user_id: 'user-123',
              triggerer_actor_type: 'user',
              triggerer_host_ref: null,
              triggered_at: '2026-04-18T09:00:00.000Z',
              started_at: '2026-04-18T09:00:05.000Z',
              completed_at: '2026-04-18T09:00:20.000Z',
              final_phase: 'Succeeded',
              error_message: null,
            },
          ],
          rowCount: 1,
        })

      const app = makeApp(gateway)
      const res = await request(app)
        .get(`/admin/workflows/${RECIPE_NS}/test-recipe/runs?limit=10`)
        .set('Authorization', 'Bearer admin-token')
        .expect(200)

      expect(res.body.count).toBe(2)
      // Live row (triggeredAt = created_at = 10:00:00) comes before audit (triggeredAt = 09:00) after sort.
      // NOTE: triggeredAt maps to `created_at` (when the run was enqueued), NOT `started_at`
      // (when the reconciler picked it up). This lets Pending runs surface a meaningful
      // triggeredAt before the reconciler moves them to Running.
      expect(res.body.items[0]).toEqual({
        id: 'live-run-id',
        source: 'live',
        phase: 'Running',
        triggeredAt: '2026-04-18T10:00:00.000Z',
        startedAt: '2026-04-18T10:00:10.000Z',
        completedAt: null,
        message: null,
        actor: { type: 'mcp-host', hostRef: `${RECIPE_NS}/test-recipe` },
        executionRef: { namespace: RECIPE_NS, name: 'test-recipe-child-1' },
      })
      expect(res.body.items[1]).toEqual({
        id: 'audit-run-id',
        source: 'audit',
        phase: 'Succeeded',
        triggeredAt: '2026-04-18T09:00:00.000Z',
        startedAt: '2026-04-18T09:00:05.000Z',
        completedAt: '2026-04-18T09:00:20.000Z',
        message: null,
        actor: { type: 'user-session', userId: 'user-123' },
        executionRef: null,
      })
    })

    it('authenticates an admin caller via the control-ui session cookie (no Authorization header)', async () => {
      // Regression for PR #649: the Control UI moved admin sessions to an HttpOnly
      // cookie and stopped sending the Authorization bearer header. The admin
      // workflow routes bypass requireAuthForControlUI and gate on
      // requireAdminWorkflowCaller, which must accept the `control_ui_admin_session`
      // cookie — otherwise every plugin/workflow-detail call 401s in the browser.
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)

      mockPoolQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // live workflow_runs
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // workflow_runs_audit

      const app = makeApp(gateway)
      const res = await request(app)
        .get(`/admin/workflows/${RECIPE_NS}/test-recipe/runs?limit=10`)
        .set('Cookie', 'control_ui_admin_session=admin-token')
        .expect(200)

      expect(res.body).toEqual({ items: [], count: 0 })
    })
  })

  describe('DELETE /admin/workflows/:ns/:name/runs/:runId/artifacts', () => {
    async function seedArtifactRun(): Promise<void> {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      await gateway.createResource(
        'workflowrecipes',
        {
          metadata: { name: 'test-recipe-child-1', namespace: RECIPE_NS },
          status: {
            artifacts: [
              {
                name: 'report.md',
                format: 'markdown',
                sizeBytes: 128,
                createdAt: '2026-05-13T10:00:00.000Z',
              },
            ],
          },
        } as never,
        RECIPE_NS
      )
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          {
            run_id: 'run-123',
            recipe_namespace: RECIPE_NS,
            recipe_name: 'test-recipe',
            phase: 'Succeeded',
            actor_type: 'user',
            actor_id: 'user-123',
            idempotency_key: null,
            trigger_source: 'onDemand',
            inputs: null,
            intermediate_parameters: null,
            output_overrides: null,
            child_recipe_name: 'test-recipe-child-1',
            child_recipe_namespace: RECIPE_NS,
            owner_instance_id: null,
            max_duration_seconds: null,
            ttl_seconds_after_finished: null,
            approval_request_id: null,
            idempotency_payload_hash: null,
            started_at: '2026-05-13T10:00:00.000Z',
            completed_at: '2026-05-13T10:01:00.000Z',
            last_reconciled_at: null,
            created_at: '2026-05-13T10:00:00.000Z',
            updated_at: '2026-05-13T10:01:00.000Z',
          },
        ],
        rowCount: 1,
      })
    }

    it('routes per-file artifact delete through the admin run-scoped endpoint', async () => {
      await seedArtifactRun()
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
      vi.stubGlobal('fetch', fetchMock)

      const app = makeApp(gateway)
      await request(app)
        .delete(`/admin/workflows/${RECIPE_NS}/test-recipe/runs/run-123/artifacts/report.md`)
        .set('Authorization', 'Bearer admin-token')
        .expect(204)

      expect(fetchMock).toHaveBeenCalledWith(
        'http://workflow-recipes.control-plane.svc.cluster.local:8082/api/v1/workflow/test-recipe-child-1/artifacts/report.md',
        expect.objectContaining({
          method: 'DELETE',
          headers: { authorization: 'Bearer mock-control-to-wrc-token' },
        })
      )
    })

    it('routes bulk artifact delete through the admin run-scoped endpoint', async () => {
      await seedArtifactRun()
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
      vi.stubGlobal('fetch', fetchMock)

      const app = makeApp(gateway)
      await request(app)
        .delete(`/admin/workflows/${RECIPE_NS}/test-recipe/runs/run-123/artifacts`)
        .set('Authorization', 'Bearer admin-token')
        .expect(204)

      expect(fetchMock).toHaveBeenCalledWith(
        'http://workflow-recipes.control-plane.svc.cluster.local:8082/api/v1/workflow/test-recipe-child-1/artifacts',
        expect.objectContaining({
          method: 'DELETE',
          headers: { authorization: 'Bearer mock-control-to-wrc-token' },
        })
      )
    })
  })

  describe('GET /admin/workflows/leader', () => {
    it('returns 401 when no caller is present', async () => {
      const app = makeApp(gateway)
      await request(app).get('/admin/workflows/leader').expect(401)
    })

    it('returns 401 for user-session callers (admin-only)', async () => {
      const app = makeApp(gateway)
      await request(app)
        .get('/admin/workflows/leader')
        .set('x-user-session-token', 'user-session-token')
        .expect(401)
    })

    it('returns held=true with populated payload when a leader holds the lock', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            pid: 42,
            state: 'idle',
            query: "SELECT pg_try_advisory_lock(hashtext('wrc-leader-v1')) AS acquired",
            backend_start: '2026-04-20T10:00:00.000Z',
            application_name: 'wrc-replica-7',
          },
        ],
      })

      const app = makeApp(gateway)
      const res = await request(app)
        .get('/admin/workflows/leader')
        .set('authorization', 'Bearer admin-token')
        .expect(200)

      expect(res.body).toEqual({
        held: true,
        leader_pid: 42,
        leader_instance_id: 'replica-7',
        acquired_at: '2026-04-20T10:00:00.000Z',
        last_query: "SELECT pg_try_advisory_lock(hashtext('wrc-leader-v1')) AS acquired",
      })
    })

    it('returns held=false with nulls when no leader holds the lock', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })

      const app = makeApp(gateway)
      const res = await request(app)
        .get('/admin/workflows/leader')
        .set('authorization', 'Bearer admin-token')
        .expect(200)

      expect(res.body).toEqual({
        held: false,
        leader_pid: null,
        leader_instance_id: null,
        acquired_at: null,
        last_query: null,
      })
    })

    it('returns 500 with opaque error when the DB query throws', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('pg connection terminated'))

      const app = makeApp(gateway)
      const res = await request(app)
        .get('/admin/workflows/leader')
        .set('authorization', 'Bearer admin-token')
        .expect(500)

      // Opaque error message — never leak 'pg connection terminated' etc.
      expect(res.body).toEqual({ error: 'Failed to query leader state' })
    })

    it('leaves leader_instance_id=null when application_name is unset or malformed', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            pid: 99,
            state: 'idle',
            query: null,
            backend_start: '2026-04-20T10:00:00.000Z',
            application_name: null,
          },
        ],
      })

      const app = makeApp(gateway)
      const res = await request(app)
        .get('/admin/workflows/leader')
        .set('authorization', 'Bearer admin-token')
        .expect(200)

      expect(res.body).toMatchObject({
        held: true,
        leader_pid: 99,
        leader_instance_id: null,
      })
    })
  })

  describe('GET /admin/workflows/runs/stream', () => {
    type FakeClient = {
      query: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
      release: ReturnType<typeof vi.fn>
      fire: (channel: string, payload: string) => void
    }

    function makeFakeClient(): FakeClient {
      const notificationHandlers: Array<(msg: { channel: string; payload?: string }) => void> = []
      const errorHandlers: Array<(err: Error) => void> = []
      const client: FakeClient = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        on: vi.fn((event: string, handler: (arg: never) => void) => {
          if (event === 'notification') notificationHandlers.push(handler as never)
          else if (event === 'error') errorHandlers.push(handler as never)
          return client
        }),
        release: vi.fn(),
        fire: (channel, payload) => {
          for (const h of notificationHandlers) h({ channel, payload })
        },
      }
      return client
    }

    function makeStreamApp(opts: { autoCloseMs?: number; keepAliveMs?: number } = {}) {
      const app = express()
      app.use(express.json())
      app.use(
        createWorkflowsAdminRouter(gateway as never, {
          runsStreamAutoCloseMs: opts.autoCloseMs ?? 60,
          runsStreamKeepAliveMs: opts.keepAliveMs ?? 99_999,
        })
      )
      return app
    }

    function makeRunRow(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        run_id: 'run-xyz',
        recipe_namespace: RECIPE_NS,
        recipe_name: 'test-recipe',
        phase: 'Pending',
        actor_type: 'user',
        actor_id: 'admin-1',
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
        started_at: '2026-04-20T10:00:00.000Z',
        completed_at: null,
        last_reconciled_at: null,
        created_at: '2026-04-20T10:00:00.000Z',
        updated_at: '2026-04-20T10:00:00.000Z',
        ...overrides,
      }
    }

    /**
     * Wires a fake client to `pool.connect()` and schedules a single NOTIFY
     * after `on('notification', …)` registers. Returns the fake client so the
     * test can assert on `query`/`release` calls.
     */
    function prepareNotifyingClient(payload: string, delayMs = 5): FakeClient {
      const client = makeFakeClient()
      client.on.mockImplementation((event: string, handler: (arg: never) => void) => {
        if (event === 'notification') {
          setTimeout(() => handler({ channel: 'workflow_run_update', payload } as never), delayMs)
        }
        return client
      })
      mockPoolConnect.mockResolvedValueOnce(client)
      return client
    }

    it('returns 401 when no caller is present', async () => {
      const app = makeStreamApp()
      await request(app).get('/admin/workflows/runs/stream').expect(401)
    })

    it('returns 401 for user-session callers (admin-only)', async () => {
      const app = makeStreamApp()
      await request(app)
        .get('/admin/workflows/runs/stream')
        .set('x-user-session-token', 'user-session-token')
        .expect(401)
    })

    it('returns 400 when namespace query is not in the allowed list', async () => {
      const app = makeStreamApp()
      await request(app)
        .get('/admin/workflows/runs/stream?namespace=evil-ns')
        .set('authorization', 'Bearer admin-token')
        .expect(400)
    })

    it('emits "run" on INSERT (NOTIFY → SELECT → push)', async () => {
      const fakeClient = prepareNotifyingClient('run-xyz', 5)
      // LISTEN response is whatever — first mocked query is the SELECT from the handler
      mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [makeRunRow()] })

      const app = makeStreamApp({ autoCloseMs: 50 })
      const res = await request(app)
        .get('/admin/workflows/runs/stream')
        .set('authorization', 'Bearer admin-token')
        .expect(200)

      expect(res.headers['content-type']).toContain('text/event-stream')
      expect(res.text).toContain('event: open')
      expect(res.text).toContain('event: run')
      expect(res.text).toContain('"id":"run-xyz"')
      expect(res.text).toContain('event: close')
      expect(fakeClient.query).toHaveBeenCalledWith('LISTEN workflow_run_update')
      expect(fakeClient.release).toHaveBeenCalled()
    })

    it('emits "run" on UPDATE phase transition', async () => {
      prepareNotifyingClient('run-abc', 5)
      mockPoolQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [makeRunRow({ run_id: 'run-abc', phase: 'Running' })],
      })

      const app = makeStreamApp({ autoCloseMs: 50 })
      const res = await request(app)
        .get('/admin/workflows/runs/stream')
        .set('authorization', 'Bearer admin-token')
        .expect(200)

      expect(res.text).toContain('"id":"run-abc"')
      expect(res.text).toContain('"phase":"Running"')
    })

    it('filters emitted runs by recipe namespace and name', async () => {
      // Two NOTIFYs in sequence — only the one matching the filter should surface.
      const fakeClient = makeFakeClient()
      fakeClient.on.mockImplementation((event: string, handler: (arg: never) => void) => {
        if (event === 'notification') {
          setTimeout(() => {
            handler({ channel: 'workflow_run_update', payload: 'run-other' } as never)
            setTimeout(
              () => handler({ channel: 'workflow_run_update', payload: 'run-match' } as never),
              5
            )
          }, 5)
        }
        return fakeClient
      })
      mockPoolConnect.mockResolvedValueOnce(fakeClient)
      mockPoolQuery
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [makeRunRow({ run_id: 'run-other', recipe_name: 'some-other-recipe' })],
        })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [makeRunRow({ run_id: 'run-match' })],
        })

      const app = makeStreamApp({ autoCloseMs: 80 })
      const res = await request(app)
        .get(`/admin/workflows/runs/stream?namespace=${RECIPE_NS}&name=test-recipe`)
        .set('authorization', 'Bearer admin-token')
        .expect(200)

      expect(res.text).toContain('"id":"run-match"')
      expect(res.text).not.toContain('"id":"run-other"')
      // Initial open event echoes the filter so the client can confirm server-side wiring.
      expect(res.text).toContain(`"namespace":"${RECIPE_NS}"`)
      expect(res.text).toContain('"name":"test-recipe"')
    })

    it('auto-closes after runsStreamAutoCloseMs and releases the client', async () => {
      const fakeClient = makeFakeClient()
      mockPoolConnect.mockResolvedValueOnce(fakeClient)

      const app = makeStreamApp({ autoCloseMs: 40 })
      const start = Date.now()
      const res = await request(app)
        .get('/admin/workflows/runs/stream')
        .set('authorization', 'Bearer admin-token')
        .expect(200)
      const elapsed = Date.now() - start

      expect(elapsed).toBeGreaterThanOrEqual(30)
      expect(res.text).toContain('event: open')
      expect(res.text).toContain('event: close')
      expect(res.text).toContain('"reason":"auto-close"')
      expect(fakeClient.release).toHaveBeenCalled()
    })
  })

  describe('GET /admin/workflows/:ns/:name/grants', () => {
    // GET is also rate-limited via rateLimitMiddleware, same as PUT. Tests
    // that reach the handler must mock the rate_limit_buckets INSERT first
    // so the mock chain matches the real call order. Without this, the GET
    // tests pass only because the rate limiter is fail-open on `undefined`
    // pool.query results — and a future fail-closed limiter would break them
    // silently.
    function mockGetGrantsRateLimiterAllowed() {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: 1 }], rowCount: 1 })
    }

    it('returns 401 when no supported caller is present', async () => {
      const app = makeApp(gateway)
      await request(app).get(`/admin/workflows/${RECIPE_NS}/test-recipe/grants`).expect(401)
    })

    it('returns opaque 401 for a user-session caller', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const app = makeApp(gateway)
      // Admin workflow lane auth rejects non-admin kinds with 401 (not 403)
      // so the endpoint cannot be used as an auth-probe oracle.
      await request(app)
        .get(`/admin/workflows/${RECIPE_NS}/test-recipe/grants`)
        .set('x-user-session-token', 'user-session-token')
        .expect(401)
    })

    it('returns 404 when recipe lives in a namespace not in the allowlist', async () => {
      mockGetGrantsRateLimiterAllowed()
      const app = makeApp(gateway)
      await request(app)
        .get(`/admin/workflows/not-a-real-ns/test-recipe/grants`)
        .set('Authorization', 'Bearer admin-token')
        .expect(404)
      expect(mockListWorkflowGrants).not.toHaveBeenCalled()
    })

    it('returns 404 when recipe does not exist', async () => {
      mockGetGrantsRateLimiterAllowed()
      const app = makeApp(gateway)
      await request(app)
        .get(`/admin/workflows/${RECIPE_NS}/does-not-exist/grants`)
        .set('Authorization', 'Bearer admin-token')
        .expect(404)
      expect(mockListWorkflowGrants).not.toHaveBeenCalled()
    })

    it('returns the list of authorized users for admin-ui callers', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockGetGrantsRateLimiterAllowed()
      mockListWorkflowGrants.mockResolvedValueOnce([
        { id: 'user-a', email: 'a@example.com', name: 'Alice', displayName: 'Alice A' },
        { id: 'user-b', email: 'b@example.com', name: null, displayName: null },
      ])
      const app = makeApp(gateway)
      const res = await request(app)
        .get(`/admin/workflows/${RECIPE_NS}/test-recipe/grants`)
        .set('Authorization', 'Bearer admin-token')
        .expect(200)
      expect(res.body).toEqual({
        items: [
          { id: 'user-a', email: 'a@example.com', name: 'Alice', displayName: 'Alice A' },
          { id: 'user-b', email: 'b@example.com', name: null, displayName: null },
        ],
      })
      expect(mockListWorkflowGrants).toHaveBeenCalledWith(RECIPE_NS, 'test-recipe')
    })
  })

  describe('PUT /admin/workflows/:ns/:name/grants', () => {
    // Strict v1-5 UUIDs (third group starts with [1-5], fourth with [89ab]).
    // Route now uses the shared `isUuid()` helper which is stricter than
    // the previous lax hex regex.
    const VALID_UUID_A = '11111111-2222-4333-8444-555555555555'
    const VALID_UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

    // The PUT handler is wrapped in rateLimitMiddleware, which calls
    // pool.query (INSERT ... RETURNING count) BEFORE the handler runs and
    // consumes the first queued mockResolvedValueOnce. Tests that set up
    // users-lookup mocks must call this first so the rate limiter gets an
    // "allowed" shape (`count: 1`).
    function mockGrantsRateLimiterAllowed() {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: 1 }], rowCount: 1 })
    }

    it('returns opaque 401 for a user-session caller (allowedKinds filter)', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const app = makeApp(gateway)
      await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/grants`)
        .set('x-user-session-token', 'user-session-token')
        .send({ userIds: [VALID_UUID_A] })
        .expect(401)
      expect(mockSetWorkflowGrants).not.toHaveBeenCalled()
    })

    it('returns 400 when body is missing userIds array', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const app = makeApp(gateway)
      await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/grants`)
        .set('Authorization', 'Bearer admin-token')
        .send({ notAList: 'oops' })
        .expect(400)
      expect(mockSetWorkflowGrants).not.toHaveBeenCalled()
    })

    it('returns 400 when any userId is not a UUID', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const app = makeApp(gateway)
      await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/grants`)
        .set('Authorization', 'Bearer admin-token')
        .send({ userIds: ['not-a-uuid'] })
        .expect(400)
      expect(mockSetWorkflowGrants).not.toHaveBeenCalled()
    })

    it('returns 404 when one or more userIds do not exist', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockGrantsRateLimiterAllowed()
      // users table lookup returns only one of the two requested ids.
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: VALID_UUID_A }], rowCount: 1 })
      const app = makeApp(gateway)
      const res = await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/grants`)
        .set('Authorization', 'Bearer admin-token')
        .send({ userIds: [VALID_UUID_A, VALID_UUID_B] })
        .expect(404)
      expect(res.body.missing).toContain(VALID_UUID_B)
      expect(mockSetWorkflowGrants).not.toHaveBeenCalled()
    })

    it('returns 400 when userIds exceeds MAX_GRANTS_PER_RECIPE (500)', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const bulkIds = Array.from({ length: 501 }, (_, i) => {
        const hex = i.toString(16).padStart(12, '0')
        return `11111111-2222-4333-8444-${hex}`
      })
      const app = makeApp(gateway)
      const res = await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/grants`)
        .set('Authorization', 'Bearer admin-token')
        .send({ userIds: bulkIds })
        .expect(400)
      expect(res.body.error).toContain('500')
      expect(res.body.received).toBe(501)
      expect(mockSetWorkflowGrants).not.toHaveBeenCalled()
    })

    it('normalizes mixed-case UUIDs to lowercase before DB write', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockGrantsRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: VALID_UUID_A }],
        rowCount: 1,
      })
      mockSetWorkflowGrants.mockResolvedValueOnce({
        userIds: [VALID_UUID_A],
        added: [VALID_UUID_A],
        removed: [],
      })
      const app = makeApp(gateway)
      await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/grants`)
        .set('Authorization', 'Bearer admin-token')
        .send({ userIds: [VALID_UUID_A.toUpperCase()] })
        .expect(200)
      // Service called with lowercase — this is what Postgres stores.
      expect(mockSetWorkflowGrants).toHaveBeenCalledWith(
        RECIPE_NS,
        'test-recipe',
        [VALID_UUID_A],
        ADMIN_CLAIMS.sub
      )
    })

    it('replaces grants, returns deduped canonical set + added/removed diffs', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockGrantsRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: VALID_UUID_A }, { id: VALID_UUID_B }],
        rowCount: 2,
      })
      mockSetWorkflowGrants.mockResolvedValueOnce({
        userIds: [VALID_UUID_A, VALID_UUID_B],
        added: [VALID_UUID_B],
        removed: [],
      })
      const app = makeApp(gateway)
      const res = await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/grants`)
        .set('Authorization', 'Bearer admin-token')
        .send({ userIds: [VALID_UUID_A, VALID_UUID_B, VALID_UUID_A] }) // duplicate A
        .expect(200)
      expect(res.body).toEqual({
        userIds: [VALID_UUID_A, VALID_UUID_B],
        added: [VALID_UUID_B],
        removed: [],
      })
      expect(mockSetWorkflowGrants).toHaveBeenCalledWith(
        RECIPE_NS,
        'test-recipe',
        [VALID_UUID_A, VALID_UUID_B],
        ADMIN_CLAIMS.sub
      )
    })

    it('accepts an empty userIds array (clears all grants) without users lookup', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockGrantsRateLimiterAllowed()
      mockSetWorkflowGrants.mockResolvedValueOnce({ userIds: [], added: [], removed: [] })
      const app = makeApp(gateway)
      const res = await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/grants`)
        .set('Authorization', 'Bearer admin-token')
        .send({ userIds: [] })
        .expect(200)
      expect(res.body).toEqual({ userIds: [], added: [], removed: [] })
      // Only the rate limiter call happened on pool.query — no users lookup
      // because the array was empty.
      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
      expect(mockSetWorkflowGrants).toHaveBeenCalledWith(
        RECIPE_NS,
        'test-recipe',
        [],
        ADMIN_CLAIMS.sub
      )
    })
  })

  describe('GET /admin/workflows/:ns/:name/team-grants', () => {
    function mockGetTeamGrantsRateLimiterAllowed() {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: 1 }], rowCount: 1 })
    }

    it('returns 401 when no supported caller is present', async () => {
      const app = makeApp(gateway)
      await request(app).get(`/admin/workflows/${RECIPE_NS}/test-recipe/team-grants`).expect(401)
    })

    it('returns 404 when recipe does not exist', async () => {
      mockGetTeamGrantsRateLimiterAllowed()
      const app = makeApp(gateway)
      await request(app)
        .get(`/admin/workflows/${RECIPE_NS}/does-not-exist/team-grants`)
        .set('Authorization', 'Bearer admin-token')
        .expect(404)
      expect(mockListTeamWorkflowGrants).not.toHaveBeenCalled()
    })

    it('returns the list of authorized teams for admin-ui callers', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockGetTeamGrantsRateLimiterAllowed()
      mockListTeamWorkflowGrants.mockResolvedValueOnce([
        { id: 'team-a', name: 'Alpha' },
        { id: 'team-b', name: 'Beta' },
      ])
      const app = makeApp(gateway)
      const res = await request(app)
        .get(`/admin/workflows/${RECIPE_NS}/test-recipe/team-grants`)
        .set('Authorization', 'Bearer admin-token')
        .expect(200)
      expect(res.body).toEqual({
        items: [
          { id: 'team-a', name: 'Alpha' },
          { id: 'team-b', name: 'Beta' },
        ],
      })
      expect(mockListTeamWorkflowGrants).toHaveBeenCalledWith(RECIPE_NS, 'test-recipe')
    })
  })

  describe('PUT /admin/workflows/:ns/:name/team-grants', () => {
    const VALID_TEAM_UUID_A = '11111111-2222-4333-8444-555555555555'
    const VALID_TEAM_UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

    function mockTeamGrantsRateLimiterAllowed() {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: 1 }], rowCount: 1 })
    }

    it('returns opaque 401 for a user-session caller (allowedKinds filter)', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const app = makeApp(gateway)
      await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/team-grants`)
        .set('x-user-session-token', 'user-session-token')
        .send({ teamIds: [VALID_TEAM_UUID_A] })
        .expect(401)
      expect(mockSetTeamWorkflowGrants).not.toHaveBeenCalled()
    })

    it('returns 400 when body is missing teamIds array', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const app = makeApp(gateway)
      await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/team-grants`)
        .set('Authorization', 'Bearer admin-token')
        .send({ notAList: 'oops' })
        .expect(400)
      expect(mockSetTeamWorkflowGrants).not.toHaveBeenCalled()
    })

    it('returns 400 when any teamId is not a UUID', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const app = makeApp(gateway)
      await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/team-grants`)
        .set('Authorization', 'Bearer admin-token')
        .send({ teamIds: ['not-a-uuid'] })
        .expect(400)
      expect(mockSetTeamWorkflowGrants).not.toHaveBeenCalled()
    })

    it('returns 404 when one or more teamIds do not exist', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockTeamGrantsRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: VALID_TEAM_UUID_A }], rowCount: 1 })
      const app = makeApp(gateway)
      const res = await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/team-grants`)
        .set('Authorization', 'Bearer admin-token')
        .send({ teamIds: [VALID_TEAM_UUID_A, VALID_TEAM_UUID_B] })
        .expect(404)
      expect(res.body.missing).toContain(VALID_TEAM_UUID_B)
      expect(mockSetTeamWorkflowGrants).not.toHaveBeenCalled()
    })

    it('replaces team grants, returns deduped canonical set + added/removed diffs', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockTeamGrantsRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: VALID_TEAM_UUID_A }, { id: VALID_TEAM_UUID_B }],
        rowCount: 2,
      })
      mockSetTeamWorkflowGrants.mockResolvedValueOnce({
        teamIds: [VALID_TEAM_UUID_A, VALID_TEAM_UUID_B],
        added: [VALID_TEAM_UUID_B],
        removed: [],
      })
      const app = makeApp(gateway)
      const res = await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/team-grants`)
        .set('Authorization', 'Bearer admin-token')
        .send({ teamIds: [VALID_TEAM_UUID_A, VALID_TEAM_UUID_B, VALID_TEAM_UUID_A] })
        .expect(200)
      expect(res.body).toEqual({
        teamIds: [VALID_TEAM_UUID_A, VALID_TEAM_UUID_B],
        added: [VALID_TEAM_UUID_B],
        removed: [],
      })
      expect(mockSetTeamWorkflowGrants).toHaveBeenCalledWith(
        RECIPE_NS,
        'test-recipe',
        [VALID_TEAM_UUID_A, VALID_TEAM_UUID_B],
        ADMIN_CLAIMS.sub
      )
    })

    it('accepts an empty teamIds array (clears all grants) without teams lookup', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockTeamGrantsRateLimiterAllowed()
      mockSetTeamWorkflowGrants.mockResolvedValueOnce({ teamIds: [], added: [], removed: [] })
      const app = makeApp(gateway)
      const res = await request(app)
        .put(`/admin/workflows/${RECIPE_NS}/test-recipe/team-grants`)
        .set('Authorization', 'Bearer admin-token')
        .send({ teamIds: [] })
        .expect(200)
      expect(res.body).toEqual({ teamIds: [], added: [], removed: [] })
      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
      expect(mockSetTeamWorkflowGrants).toHaveBeenCalledWith(
        RECIPE_NS,
        'test-recipe',
        [],
        ADMIN_CLAIMS.sub
      )
    })
  })

  describe('/admin/workflow-recipes/:ns/:name/allowed-teams', () => {
    const VALID_TEAM_UUID = '11111111-2222-4333-8444-555555555555'

    function mockApprovalTeamRateLimiterAllowed() {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: 1 }], rowCount: 1 })
    }

    it('returns opaque 401 for non-admin callers', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const app = makeApp(gateway)
      await request(app)
        .put(`/admin/workflow-recipes/${RECIPE_NS}/test-recipe/allowed-teams/${VALID_TEAM_UUID}`)
        .set('x-user-session-token', 'user-session-token')
        .expect(401)
    })

    it('lists approval target teams for admin callers', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockApprovalTeamRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: VALID_TEAM_UUID, name: 'Approvers', createdAt: '2026-05-20T10:00:00.000Z' }],
        rowCount: 1,
      })
      const app = makeApp(gateway)
      const res = await request(app)
        .get(`/admin/workflow-recipes/${RECIPE_NS}/test-recipe/allowed-teams`)
        .set('Authorization', 'Bearer admin-token')
        .expect(200)

      expect(res.body).toEqual({
        items: [{ id: VALID_TEAM_UUID, name: 'Approvers', createdAt: '2026-05-20T10:00:00.000Z' }],
      })
      expect(String(mockPoolQuery.mock.calls[1]?.[0])).toContain(
        'FROM workflow_recipe_allowed_teams'
      )
    })

    it('validates team id format before writing the approval allowlist', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const app = makeApp(gateway)
      await request(app)
        .put(`/admin/workflow-recipes/${RECIPE_NS}/test-recipe/allowed-teams/not-a-uuid`)
        .set('Authorization', 'Bearer admin-token')
        .expect(400)
    })

    it('returns 404 when the team does not exist', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockApprovalTeamRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
      const app = makeApp(gateway)
      await request(app)
        .put(`/admin/workflow-recipes/${RECIPE_NS}/test-recipe/allowed-teams/${VALID_TEAM_UUID}`)
        .set('Authorization', 'Bearer admin-token')
        .expect(404)
    })

    it('allows a team as an approval target for the workflow recipe', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockApprovalTeamRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: VALID_TEAM_UUID }], rowCount: 1 })
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 })
      const app = makeApp(gateway)
      const res = await request(app)
        .put(`/admin/workflow-recipes/${RECIPE_NS}/test-recipe/allowed-teams/${VALID_TEAM_UUID}`)
        .set('Authorization', 'Bearer admin-token')
        .expect(200)
      expect(res.body).toEqual({ teamId: VALID_TEAM_UUID })
      expect(String(mockPoolQuery.mock.calls[2]?.[0])).toContain(
        'INSERT INTO workflow_recipe_allowed_teams'
      )
      expect(String(mockPoolQuery.mock.calls[2]?.[0])).toContain(
        'INSERT INTO workflow_recipe_allowed_teams_audit'
      )
      expect(mockPoolQuery.mock.calls[2]?.[1]).toEqual([
        RECIPE_NS,
        'test-recipe',
        VALID_TEAM_UUID,
        ADMIN_CLAIMS.sub,
      ])
    })

    it('validates team id format before revoking from the approval allowlist', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      const app = makeApp(gateway)
      await request(app)
        .delete(`/admin/workflow-recipes/${RECIPE_NS}/test-recipe/allowed-teams/not-a-uuid`)
        .set('Authorization', 'Bearer admin-token')
        .expect(400)
    })

    it('revokes a team from the approval allowlist idempotently', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockApprovalTeamRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ teamId: VALID_TEAM_UUID }],
        rowCount: 1,
      })
      const app = makeApp(gateway)
      const res = await request(app)
        .delete(`/admin/workflow-recipes/${RECIPE_NS}/test-recipe/allowed-teams/${VALID_TEAM_UUID}`)
        .set('Authorization', 'Bearer admin-token')
        .expect(200)

      expect(res.body).toEqual({ teamId: VALID_TEAM_UUID, removed: true })
      expect(String(mockPoolQuery.mock.calls[1]?.[0])).toContain(
        'DELETE FROM workflow_recipe_allowed_teams'
      )
      expect(String(mockPoolQuery.mock.calls[1]?.[0])).toContain(
        'INSERT INTO workflow_recipe_allowed_teams_audit'
      )
      expect(mockPoolQuery.mock.calls[1]?.[1]).toEqual([
        RECIPE_NS,
        'test-recipe',
        VALID_TEAM_UUID,
        ADMIN_CLAIMS.sub,
      ])
    })

    it('returns removed=false when revoking a team that is not allowlisted', async () => {
      await gateway.createResource('workflowrecipes', VALID_RECIPE as never, RECIPE_NS)
      mockApprovalTeamRateLimiterAllowed()
      mockPoolQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      })
      const app = makeApp(gateway)
      const res = await request(app)
        .delete(`/admin/workflow-recipes/${RECIPE_NS}/test-recipe/allowed-teams/${VALID_TEAM_UUID}`)
        .set('Authorization', 'Bearer admin-token')
        .expect(200)

      expect(res.body).toEqual({ teamId: VALID_TEAM_UUID, removed: false })
    })
  })
})
