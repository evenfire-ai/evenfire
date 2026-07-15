import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMcpHostWorkflowRoutes } from '../src/routes/mcp-host/workflows/index.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()
const mockVerifyMcpHostControlJwt = vi.fn()
const mockVerifyAdminToken = vi.fn()
const mockVerifyExternalSessionToken = vi.fn()
const mockVerifyInternalControlJwt = vi.fn()
const mockIsAdminTokenRevoked = vi.fn()
const mockIsHostRefAuthorized = vi.fn()
const mockCreateApprovedWorkflowRun = vi.fn()
const mockCreateWorkflowRun = vi.fn()
const mockGetRun = vi.fn()
const mockListRunsByRecipe = vi.fn()

type ControlScope = 'workflow:list' | 'workflow:read' | 'workflow:trigger'
const ALL_CONTROL_SCOPES: ControlScope[] = ['workflow:list', 'workflow:read', 'workflow:trigger']

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

vi.mock('../src/utils/auth/mcpHostJwtToken.js', () => ({
  issueMcpHostControlJwt: vi.fn(),
  verifyMcpHostControlJwt: (...args: unknown[]) => mockVerifyMcpHostControlJwt(...args),
  isHostRefAuthorized: (...args: unknown[]) => mockIsHostRefAuthorized(...args),
  getMcpHostCallerKey: (claims: { hostRefs?: string[]; sub: string }) => {
    const hostRef = claims.hostRefs?.[0]?.trim()
    if (!hostRef) throw new Error('mcp-host JWT missing canonical hostRefs[0] caller binding')
    return hostRef
  },
}))

vi.mock('../src/utils/auth/adminAuthToken.js', () => ({
  verifyAdminToken: (...args: unknown[]) => mockVerifyAdminToken(...args),
}))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  verifyExternalSessionToken: (...args: unknown[]) => mockVerifyExternalSessionToken(...args),
}))

vi.mock('../src/utils/auth/internalControlToken.js', () => ({
  verifyInternalControlJwt: (...args: unknown[]) => mockVerifyInternalControlJwt(...args),
}))

vi.mock('../src/utils/auth/delegationToken.js', () => ({
  signWrcDelegationToken: vi.fn(() => 'delegation-token'),
}))

vi.mock('../src/services/adminAuthService.js', () => ({
  isAdminTokenRevoked: (...args: unknown[]) => mockIsAdminTokenRevoked(...args),
}))

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 10,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  }),
}))

vi.mock('../src/services/workflowRunService.js', () => ({
  WorkflowRunIdempotencyConflictError: class WorkflowRunIdempotencyConflictError extends Error {},
  computeWorkflowRunPayloadHash: vi.fn(() => 'payload-hash'),
  createApprovedRun: (...args: unknown[]) => mockCreateApprovedWorkflowRun(...args),
  createRun: (...args: unknown[]) => mockCreateWorkflowRun(...args),
  getRun: (...args: unknown[]) => mockGetRun(...args),
  listRunsByRecipe: (...args: unknown[]) => mockListRunsByRecipe(...args),
}))

vi.mock('../src/config.js', () => ({
  config: {
    hostsNamespace: 'mcp-host',
    mcpServersNamespace: 'mcp-server',
    sandboxNamespace: 'sandbox-recipes',
    approvalRlRequestPerMin: 10,
    approvalRlExternalPerMin: 60,
    workflowArtifactDownloadMaxBytes: 50 * 1024 * 1024,
  },
}))

const CONTROL_CLAIMS = {
  sub: 'sandbox-recipes/test-recipe',
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'test-recipe',
  hostRefs: ['sandbox-recipes/test-recipe'],
  typ: 'service' as const,
  scopes: ALL_CONTROL_SCOPES,
  iss: 'test',
  aud: 'mcp-host',
  jti: 'control-jti',
  exp: Math.floor(Date.now() / 1000) + 600,
}

const SHARED_HOST_CONTROL_CLAIMS = {
  ...CONTROL_CLAIMS,
  sub: 'mcp-host/standalone',
  recipeNamespace: 'mcp-host',
  recipeName: 'standalone',
  hostRefs: ['chatllm'],
}

const SANDBOX_CALLER_CONTROL_CLAIMS = {
  ...CONTROL_CLAIMS,
  sub: 'sandbox-recipes/caller-recipe',
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'caller-recipe',
  hostRefs: ['sandbox-recipes/caller-recipe'],
}

const WORKFLOW_CALLER_ALPHA_CONTROL_CLAIMS = {
  ...CONTROL_CLAIMS,
  sub: 'sandbox-recipes/workflow-caller-alpha',
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'workflow-caller-alpha',
  hostRefs: ['sandbox-recipes/workflow-caller-alpha'],
}

const WORKFLOW_CALLER_BETA_CONTROL_CLAIMS = {
  ...CONTROL_CLAIMS,
  sub: 'sandbox-recipes/workflow-caller-beta',
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'workflow-caller-beta',
  hostRefs: ['sandbox-recipes/workflow-caller-beta'],
}

function claimsWithScopes(scopes: ControlScope[]) {
  return { ...CONTROL_CLAIMS, scopes }
}

function callerClaimsWithScopes(
  claims: typeof WORKFLOW_CALLER_ALPHA_CONTROL_CLAIMS,
  scopes: ControlScope[]
) {
  return { ...claims, scopes }
}

function makeRunRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 'run-1',
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'test-recipe',
    phase: 'Pending',
    actor_type: 'autonomous',
    actor_id: 'actor-1',
    idempotency_key: 'idem-1',
    trigger_source: 'autonomous',
    inputs: {},
    intermediate_parameters: null,
    output_overrides: null,
    child_recipe_name: null,
    child_recipe_namespace: null,
    owner_instance_id: null,
    max_duration_seconds: null,
    ttl_seconds_after_finished: null,
    approval_request_id: '00000000-0000-4000-8000-000000000123',
    idempotency_payload_hash: 'payload-hash',
    started_at: null,
    completed_at: null,
    last_reconciled_at: null,
    created_at: '2026-05-03T00:00:00.000Z',
    updated_at: '2026-05-03T00:00:00.000Z',
    ...overrides,
  }
}

function mockTypedApprovalBinding(
  triggerName = 'test-recipe',
  triggerCaller = 'sandbox-recipes/test-recipe'
) {
  mockPoolQuery.mockResolvedValueOnce({
    rows: [
      {
        status: 'approved',
        triggerNamespace: 'sandbox-recipes',
        triggerName,
        triggerCaller,
      },
    ],
    rowCount: 1,
  })
}

function makeApp(
  recipeNames = ['test-recipe'],
  artifactsByRecipeName: Record<string, Array<Record<string, unknown>>> = {},
  recipeSpecByName: Record<string, Record<string, unknown>> = {}
) {
  const gateway = new MockGateway('sandbox-recipes')
  for (const recipeName of recipeNames) {
    void gateway.createResource('workflowrecipes', {
      metadata: {
        name: recipeName,
        creationTimestamp: '2026-05-03T00:00:00.000Z',
      },
      spec: {
        triggers: { onDemand: { requiresApproval: true } },
        workloads: [{ id: 'svc', type: 'deployment', image: 'test:latest' }],
        ...(recipeSpecByName[recipeName] ?? {}),
      },
      status: { phase: 'Ready', artifacts: artifactsByRecipeName[recipeName] ?? [] },
    })
  }
  const app = express()
  app.use(express.json())
  app.use(createMcpHostWorkflowRoutes(gateway as never))
  return app
}

describe('routes/mcp-host/workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockIsAdminTokenRevoked.mockResolvedValue(false)
    mockVerifyMcpHostControlJwt.mockImplementation(token =>
      token === 'mcp-host-workflow-control-token'
        ? CONTROL_CLAIMS
        : token === 'shared-host-control-token'
          ? SHARED_HOST_CONTROL_CLAIMS
          : token === 'shared-read-token'
            ? { ...SHARED_HOST_CONTROL_CLAIMS, scopes: ['workflow:read'] }
            : token === 'sandbox-caller-control-token'
              ? SANDBOX_CALLER_CONTROL_CLAIMS
              : token === 'workflow-caller-alpha-token'
                ? WORKFLOW_CALLER_ALPHA_CONTROL_CLAIMS
                : token === 'workflow-caller-beta-token'
                  ? WORKFLOW_CALLER_BETA_CONTROL_CLAIMS
                  : token === 'workflow-caller-beta-read-token'
                    ? callerClaimsWithScopes(WORKFLOW_CALLER_BETA_CONTROL_CLAIMS, [
                        'workflow:list',
                        'workflow:read',
                      ])
                    : token === 'workflow-list-token'
                      ? claimsWithScopes(['workflow:list'])
                      : token === 'workflow-read-token'
                        ? claimsWithScopes(['workflow:read'])
                        : token === 'workflow-trigger-token'
                          ? claimsWithScopes(['workflow:trigger'])
                          : null
    )
    mockVerifyAdminToken.mockImplementation(token =>
      token === 'admin-token'
        ? {
            sub: 'admin-1',
            typ: 'user',
            role: 'admin',
            jti: 'admin-jti',
            exp: Math.floor(Date.now() / 1000) + 600,
          }
        : null
    )
    mockVerifyExternalSessionToken.mockReturnValue(null)
    mockVerifyInternalControlJwt.mockImplementation(token =>
      token === 'internal-control-token'
        ? {
            iss: 'wrc',
            aud: 'control-api',
            sub: 'wrc',
            jti: 'wrc-jti',
            iat: 1,
            exp: 9999999999,
          }
        : null
    )
    mockIsHostRefAuthorized.mockImplementation(
      (claims: { hostRefs?: string[] }, ns: string, name: string) =>
        Array.isArray(claims.hostRefs) && claims.hostRefs.includes(`${ns}/${name}`)
    )
    mockCreateApprovedWorkflowRun.mockResolvedValue({
      row: makeRunRow(),
      created: true,
    })
    mockCreateWorkflowRun.mockResolvedValue({
      row: makeRunRow({ actor_type: 'user', trigger_source: 'onDemand' }),
      created: true,
    })
    mockGetRun.mockResolvedValue(makeRunRow())
    mockListRunsByRecipe.mockResolvedValue([])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists runtime workflows with mcpHost control JWT', async () => {
    const res = await request(makeApp())
      .get('/workflows')
      .set('Authorization', 'Bearer mcp-host-workflow-control-token')

    expect(res.status).toBe(200)
    expect(res.body.items[0]).toMatchObject({
      namespace: 'sandbox-recipes',
      name: 'test-recipe',
      hostRef: 'sandbox-recipes/test-recipe',
    })
  })

  it('requires workflow:list scope to list runtime workflows', async () => {
    const res = await request(makeApp())
      .get('/workflows')
      .set('Authorization', 'Bearer workflow-read-token')

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'insufficient_scope' })
  })

  it('does not list sandbox workflows for a shared 1st-party mcp-host without approval target context', async () => {
    const list = await request(makeApp())
      .get('/workflows')
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([])
    expect(list.body.count).toBe(0)

    const detail = await request(makeApp())
      .get('/workflows/sandbox-recipes/test-recipe')
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(detail.status).toBe(403)
    expect(detail.body).toEqual({ error: 'Not authorized to view this recipe' })
  })

  it('lists and reads sandbox workflows for a shared 1st-party mcp-host only through a granted approval target', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    mockPoolQuery.mockResolvedValue({
      rows: [{ recipe_namespace: 'sandbox-recipes', recipe_name: 'test-recipe' }],
      rowCount: 1,
    })

    const list = await request(makeApp())
      .get(`/workflows?targetUserId=${targetUserId}`)
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([
      expect.objectContaining({
        namespace: 'sandbox-recipes',
        name: 'test-recipe',
      }),
    ])
    expect(list.body.count).toBe(1)

    const detail = await request(makeApp())
      .get(`/workflows/sandbox-recipes/test-recipe?targetUserId=${targetUserId}`)
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({
      namespace: 'sandbox-recipes',
      name: 'test-recipe',
    })
    expect(detail.body.latestRun).toBeNull()
    expect(mockListRunsByRecipe).not.toHaveBeenCalled()
  })

  it('does not let a sandbox caller read a cross-target workflow without explicit approval target context', async () => {
    const res = await request(makeApp())
      .get('/workflows/sandbox-recipes/test-recipe')
      .set('Authorization', 'Bearer sandbox-caller-control-token')

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Not authorized to view this recipe' })
    expect(mockPoolQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('user_workflow_triggers'),
      expect.anything()
    )
  })

  it('allows sandbox caller read/list of a cross-target workflow only through the target user grant context', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    mockPoolQuery.mockResolvedValue({
      rows: [{ recipe_namespace: 'sandbox-recipes', recipe_name: 'test-recipe' }],
      rowCount: 1,
    })

    const list = await request(makeApp())
      .get(`/workflows?targetUserId=${targetUserId}`)
      .set('Authorization', 'Bearer sandbox-caller-control-token')

    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([
      expect.objectContaining({
        namespace: 'sandbox-recipes',
        name: 'test-recipe',
      }),
    ])

    const detail = await request(makeApp())
      .get(`/workflows/sandbox-recipes/test-recipe?targetUserId=${targetUserId}`)
      .set('Authorization', 'Bearer sandbox-caller-control-token')

    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({
      namespace: 'sandbox-recipes',
      name: 'test-recipe',
    })
    expect(detail.body.latestRun).toBeNull()
    expect(mockListRunsByRecipe).not.toHaveBeenCalled()
    const sql = mockPoolQuery.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).toContain('FROM user_workflow_triggers')
    expect(sql).not.toContain('FROM team_members')
  })

  it('lets an alternate sandbox caller with list/read scopes view only the granted target context', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    mockPoolQuery.mockResolvedValue({
      rows: [{ recipe_namespace: 'sandbox-recipes', recipe_name: 'test-recipe' }],
      rowCount: 1,
    })

    const list = await request(makeApp())
      .get(`/workflows?targetUserId=${targetUserId}`)
      .set('Authorization', 'Bearer workflow-caller-beta-read-token')

    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([
      expect.objectContaining({
        namespace: 'sandbox-recipes',
        name: 'test-recipe',
      }),
    ])

    const detail = await request(makeApp())
      .get(`/workflows/sandbox-recipes/test-recipe?targetUserId=${targetUserId}`)
      .set('Authorization', 'Bearer workflow-caller-beta-read-token')

    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({
      namespace: 'sandbox-recipes',
      name: 'test-recipe',
    })
    const sql = mockPoolQuery.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).toContain('FROM user_workflow_triggers')
    expect(sql).not.toContain('FROM team_workflow_triggers')
  })

  it('batches approval-target list authorization instead of querying per recipe', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    mockPoolQuery.mockResolvedValue({
      rows: [{ recipe_namespace: 'sandbox-recipes', recipe_name: 'test-recipe' }],
      rowCount: 1,
    })

    const list = await request(makeApp(['test-recipe', 'other-recipe']))
      .get(`/workflows?targetUserId=${targetUserId}`)
      .set('Authorization', 'Bearer sandbox-caller-control-token')

    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([
      expect.objectContaining({
        namespace: 'sandbox-recipes',
        name: 'test-recipe',
      }),
    ])
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    expect(String(mockPoolQuery.mock.calls[0][0])).toContain('FROM user_workflow_triggers')
  })

  it('rejects malformed approval target context on sandbox workflow reads', async () => {
    const res = await request(makeApp())
      .get('/workflows/sandbox-recipes/test-recipe?targetUserId=not-a-uuid')
      .set('Authorization', 'Bearer sandbox-caller-control-token')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Invalid targetUserId format, expected UUID' })
  })

  it('allows sandbox caller read/list of a team-target workflow only with same-team allowlist and trigger grant', async () => {
    const targetTeamId = '00000000-0000-4000-8000-0000000000aa'
    mockPoolQuery.mockResolvedValue({ rows: [{ ok: 1 }], rowCount: 1 })

    const res = await request(makeApp())
      .get(`/workflows/sandbox-recipes/test-recipe/health?targetTeamId=${targetTeamId}`)
      .set('Authorization', 'Bearer sandbox-caller-control-token')

    expect(res.status).toBe(200)
    expect(res.body.activeRuns).toBeNull()
    expect(res.body.lastRun).toBeNull()
    expect(mockListRunsByRecipe).not.toHaveBeenCalled()
    const sql = mockPoolQuery.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).toContain('FROM workflow_recipe_allowed_teams wat')
    expect(sql).toContain('JOIN team_workflow_triggers twt')
  })

  it('reads runtime workflow detail and health with workflow:read scope', async () => {
    const detail = await request(makeApp())
      .get('/workflows/sandbox-recipes/test-recipe')
      .set('Authorization', 'Bearer workflow-read-token')

    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({
      namespace: 'sandbox-recipes',
      name: 'test-recipe',
      hostRef: 'sandbox-recipes/test-recipe',
    })

    const health = await request(makeApp())
      .get('/workflows/sandbox-recipes/test-recipe/health')
      .set('Authorization', 'Bearer workflow-read-token')

    expect(health.status).toBe(200)
    expect(health.body).toMatchObject({
      recipe: 'sandbox-recipes/test-recipe',
      activeRuns: 0,
    })
  })

  it('requires workflow:read scope to read runtime workflow detail and health', async () => {
    const detail = await request(makeApp())
      .get('/workflows/sandbox-recipes/test-recipe')
      .set('Authorization', 'Bearer workflow-list-token')

    expect(detail.status).toBe(403)
    expect(detail.body).toEqual({ error: 'insufficient_scope' })

    const health = await request(makeApp())
      .get('/workflows/sandbox-recipes/test-recipe/health')
      .set('Authorization', 'Bearer workflow-trigger-token')

    expect(health.status).toBe(403)
    expect(health.body).toEqual({ error: 'insufficient_scope' })
  })

  it('lists latest workflow run artifacts for a shared mcp-host only through the granted approval target and conversation', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    const latestRun = makeRunRow({
      run_id: 'latest-run-1',
      child_recipe_name: 'test-recipe-run-1',
      child_recipe_namespace: 'sandbox-recipes',
      approval_request_id: '00000000-0000-4000-8000-000000000123',
    })
    mockPoolQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM workflow_runs wr')) {
        return Promise.resolve({
          rows: [latestRun],
          rowCount: 1,
        })
      }
      return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 })
    })
    mockGetRun.mockResolvedValue(
      makeRunRow({
        run_id: 'latest-run-1',
        child_recipe_name: 'test-recipe-run-1',
        child_recipe_namespace: 'sandbox-recipes',
        approval_request_id: '00000000-0000-4000-8000-000000000123',
      })
    )

    const app = makeApp(['test-recipe', 'test-recipe-run-1'], {
      'test-recipe-run-1': [
        {
          name: 'seed-result.json',
          format: 'json',
          sizeBytes: 123,
          createdAt: '2026-05-26T12:01:00.000Z',
        },
      ],
    })
    const res = await request(app)
      .get(
        `/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts?targetUserId=${targetUserId}&workflowConversationId=thread-1`
      )
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(res.status).toBe(200)
    expect(res.body.artifacts).toEqual([
      expect.objectContaining({
        name: 'seed-result.json',
        format: 'json',
      }),
    ])
    const latestRunQuery = mockPoolQuery.mock.calls.find(call =>
      String(call[0]).includes('FROM workflow_runs wr')
    )
    expect(String(latestRunQuery?.[0])).toContain(
      "war.payload->'metadata'->'workflowTrigger'->>'conversationId' = $6"
    )
    expect(latestRunQuery?.[1]).toContain('thread-1')
  })

  it('rejects shared mcp-host latest artifact reads without conversation or approval target context', async () => {
    const res = await request(makeApp(['test-recipe', 'test-recipe-run-1']))
      .get('/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts')
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'workflowConversationId is required' })
    expect(mockGetRun).not.toHaveBeenCalled()
  })

  it('lists artifacts for the exact provider workflow run and conversation', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    const workflowRunId = '11111111-2222-4333-8444-555555555555'
    const teamsConversationId = `a:${'A'.repeat(129)}`
    const exactRun = makeRunRow({
      run_id: workflowRunId,
      child_recipe_name: 'test-recipe-run-1',
      child_recipe_namespace: 'sandbox-recipes',
      approval_target_user_id: targetUserId,
      approval_target_team_id: null,
    })
    mockPoolQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM workflow_runs wr')) {
        return Promise.resolve({ rows: [exactRun], rowCount: 1 })
      }
      return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 })
    })
    mockGetRun.mockResolvedValue(exactRun)

    const app = makeApp(['test-recipe', 'test-recipe-run-1'], {
      'test-recipe-run-1': [
        {
          name: 'result.pdf',
          format: 'pdf',
          sizeBytes: 123,
          createdAt: '2026-07-14T12:01:00.000Z',
        },
      ],
    })
    const res = await request(app)
      .get(
        `/workflows/runs/${workflowRunId}/artifacts?targetUserId=${targetUserId}&workflowConversationId=${teamsConversationId}`
      )
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      workflowRunId,
      workflowName: 'test-recipe',
      artifacts: [{ name: 'result.pdf', format: 'pdf' }],
    })
    const exactRunQuery = mockPoolQuery.mock.calls.find(call =>
      String(call[0]).includes('WHERE wr.run_id = $1')
    )
    expect(exactRunQuery?.[1]).toEqual([
      workflowRunId,
      targetUserId,
      null,
      'chatllm',
      teamsConversationId,
    ])
  })

  it('accepts a maximum-length Teams channel thread conversation', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    const workflowRunId = '11111111-2222-4333-8444-555555555555'
    const teamsConversationId = `19:${'A'.repeat(479)}@thread.tacv2;messageid=post-1`

    const res = await request(makeApp(['test-recipe']))
      .get(
        `/workflows/runs/${workflowRunId}/artifacts?targetUserId=${targetUserId}&workflowConversationId=${teamsConversationId}`
      )
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(res.status).toBe(404)
    const exactRunQuery = mockPoolQuery.mock.calls.find(call =>
      String(call[0]).includes('WHERE wr.run_id = $1')
    )
    expect(exactRunQuery?.[1]).toEqual([
      workflowRunId,
      targetUserId,
      null,
      'chatllm',
      teamsConversationId,
    ])
  })

  it('returns parsed JSON artifact content for agent workflow result reads', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    const latestRun = makeRunRow({
      run_id: 'run-1',
      child_recipe_name: 'test-recipe-run-1',
      child_recipe_namespace: 'sandbox-recipes',
      approval_request_id: '00000000-0000-4000-8000-000000000123',
    })
    mockPoolQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM workflow_runs wr')) {
        return Promise.resolve({ rows: [latestRun], rowCount: 1 })
      }
      return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 })
    })
    mockGetRun.mockResolvedValue(latestRun)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type'
            ? 'application/json'
            : name.toLowerCase() === 'content-disposition'
              ? 'attachment; filename="seed-result.json"'
              : null,
      },
      arrayBuffer: async () => {
        const body = Buffer.from(
          JSON.stringify({
            marker: 'agent-chat-mongo-mcp-test',
            status: 'ready-for-mcp-read',
          }),
          'utf8'
        )
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      },
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const app = makeApp(['test-recipe', 'test-recipe-run-1'], {
      'test-recipe-run-1': [
        {
          name: 'seed-result.json',
          format: 'json',
          sizeBytes: 123,
          createdAt: '2026-05-26T12:01:00.000Z',
        },
      ],
    })
    const res = await request(app)
      .get(
        `/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts/seed-result.json/content?targetUserId=${targetUserId}&workflowConversationId=thread-1`
      )
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      artifactName: 'seed-result.json',
      contentType: 'application/json',
      content: {
        marker: 'agent-chat-mongo-mcp-test',
        status: 'ready-for-mcp-read',
      },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://workflow-recipes.control-plane.svc.cluster.local:8082/api/v1/workflow/test-recipe-run-1/artifacts/seed-result.json',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('returns binary latest artifact download for mcp-host workflow_result attachments', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    const latestRun = makeRunRow({
      run_id: 'run-1',
      child_recipe_name: 'test-recipe-run-1',
      child_recipe_namespace: 'sandbox-recipes',
      approval_request_id: '00000000-0000-4000-8000-000000000123',
    })
    mockPoolQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM workflow_runs wr')) {
        return Promise.resolve({ rows: [latestRun], rowCount: 1 })
      }
      return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 })
    })
    mockGetRun.mockResolvedValue(latestRun)
    const body = Buffer.from('artifact-only-download-proof', 'utf8')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type'
            ? 'application/pdf'
            : name.toLowerCase() === 'content-disposition'
              ? 'attachment; filename="risk-review.pdf"'
              : name.toLowerCase() === 'content-length'
                ? String(body.byteLength)
                : null,
      },
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const app = makeApp(['test-recipe', 'test-recipe-run-1'], {
      'test-recipe-run-1': [
        {
          name: 'risk-review.pdf',
          format: 'pdf',
          sizeBytes: body.byteLength,
          createdAt: '2026-05-30T12:01:00.000Z',
        },
      ],
    })
    const res = await request(app)
      .get(
        `/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts/risk-review.pdf/download?targetUserId=${targetUserId}&workflowConversationId=thread-1`
      )
      .set('Author' + 'ization', ['Bear', 'er shared-host-control-token'].join(''))

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    expect(res.headers['content-length']).toBe(String(body.byteLength))
    expect(res.headers['content-disposition']).toBe('attachment; filename="risk-review.pdf"')
    expect(res.headers['x-clerum-artifact-name']).toBe('risk-review.pdf')
    expect(res.headers['x-clerum-artifact-filename']).toBe('risk-review.pdf')
    expect(Buffer.from(res.body).toString('utf8')).toBe('artifact-only-download-proof')
    expect(res.text ?? '').not.toContain('encodedBody')
  })

  it('rejects latest artifact download without auth', async () => {
    const res = await request(makeApp(['test-recipe'])).get(
      '/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts/report.pdf/download?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1'
    )

    expect(res.status).toBe(401)
    expect(mockGetRun).not.toHaveBeenCalled()
  })

  it('rejects latest artifact download without workflow read scope', async () => {
    const res = await request(makeApp(['test-recipe']))
      .get(
        '/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts/report.pdf/download?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1'
      )
      .set('Author' + 'ization', ['Bear', 'er workflow-list-token'].join(''))

    expect(res.status).toBe(403)
    expect(mockGetRun).not.toHaveBeenCalled()
  })

  it('rejects latest artifact download with invalid target or conversation context', async () => {
    const bothTargets = await request(makeApp(['test-recipe']))
      .get(
        '/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts/report.pdf/download?targetUserId=00000000-0000-4000-8000-000000000001&targetTeamId=00000000-0000-4000-8000-0000000000aa&workflowConversationId=thread-1'
      )
      .set('Author' + 'ization', ['Bear', 'er shared-read-token'].join(''))
    const badConversation = await request(makeApp(['test-recipe']))
      .get(
        '/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts/report.pdf/download?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=bad/../thread'
      )
      .set('Author' + 'ization', ['Bear', 'er shared-read-token'].join(''))
    const oversizedDirectTeamsConversation = await request(makeApp(['test-recipe']))
      .get(
        `/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts/report.pdf/download?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=a:${'A'.repeat(511)}`
      )
      .set('Author' + 'ization', ['Bear', 'er shared-read-token'].join(''))
    const oversizedChannelTeamsConversation = await request(makeApp(['test-recipe']))
      .get(
        `/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts/report.pdf/download?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=19:${'A'.repeat(510)}`
      )
      .set('Author' + 'ization', ['Bear', 'er shared-read-token'].join(''))

    expect(bothTargets.status).toBe(400)
    expect(badConversation.status).toBe(400)
    expect(oversizedDirectTeamsConversation.status).toBe(400)
    expect(oversizedChannelTeamsConversation.status).toBe(400)
    expect(mockGetRun).not.toHaveBeenCalled()
  })

  it('returns 404 for latest artifact download when no conversation-owned run exists', async () => {
    const res = await request(makeApp(['test-recipe']))
      .get(
        '/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts/report.pdf/download?targetUserId=00000000-0000-4000-8000-000000000001&workflowConversationId=thread-1'
      )
      .set('Author' + 'ization', ['Bear', 'er shared-read-token'].join(''))

    expect(res.status).toBe(404)
    expect(mockGetRun).not.toHaveBeenCalled()
  })

  it('sanitizes upstream content-disposition for latest artifact download', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    const latestRun = makeRunRow({
      run_id: 'run-1',
      child_recipe_name: 'test-recipe-run-1',
      child_recipe_namespace: 'sandbox-recipes',
      approval_request_id: '00000000-0000-4000-8000-000000000123',
    })
    mockPoolQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM workflow_runs wr')) {
        return Promise.resolve({ rows: [latestRun], rowCount: 1 })
      }
      return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 })
    })
    mockGetRun.mockResolvedValue(latestRun)
    const body = Buffer.from('artifact-only-download-proof', 'utf8')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type'
              ? 'application/pdf'
              : name.toLowerCase() === 'content-disposition'
                ? 'attachment; filename="../../evil report.pdf"'
                : name.toLowerCase() === 'content-length'
                  ? String(body.byteLength)
                  : null,
        },
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      } as Response)
    )

    const res = await request(
      makeApp(['test-recipe', 'test-recipe-run-1'], {
        'test-recipe-run-1': [
          { name: 'risk-review.pdf', format: 'pdf', sizeBytes: body.byteLength },
        ],
      })
    )
      .get(
        `/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts/risk-review.pdf/download?targetUserId=${targetUserId}&workflowConversationId=thread-1`
      )
      .set('Author' + 'ization', ['Bear', 'er shared-read-token'].join(''))

    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="evil_report.pdf"')
    expect(res.headers['x-clerum-artifact-filename']).toBe('evil_report.pdf')
  })

  it('resolves latest workflow run artifacts for a shared mcp-host through the approval target', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    const latestRun = makeRunRow({
      run_id: 'latest-run-1',
      child_recipe_name: 'test-recipe-run-1',
      child_recipe_namespace: 'sandbox-recipes',
      approval_request_id: '00000000-0000-4000-8000-000000000123',
    })
    mockPoolQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM workflow_runs wr')) {
        return Promise.resolve({
          rows: [latestRun],
          rowCount: 1,
        })
      }
      return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 })
    })
    mockGetRun.mockResolvedValueOnce(latestRun)

    const app = makeApp(['test-recipe', 'test-recipe-run-1'], {
      'test-recipe-run-1': [
        {
          name: 'seed-result.json',
          format: 'json',
          sizeBytes: 123,
          createdAt: '2026-05-26T12:01:00.000Z',
        },
      ],
    })
    const res = await request(app)
      .get(
        `/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts?targetUserId=${targetUserId}&workflowConversationId=thread-1`
      )
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(res.status).toBe(200)
    expect(res.body.artifacts).toEqual([
      expect.objectContaining({
        name: 'seed-result.json',
        format: 'json',
      }),
    ])
    expect(mockGetRun).toHaveBeenCalledWith('latest-run-1')
    const sql = mockPoolQuery.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).toContain('JOIN workflow_approval_requests war')
    expect(sql).toContain('JOIN workflow_approval_trigger_intents wati')
    expect(sql).toContain('war.target_user_id')
    const latestRunQuery = mockPoolQuery.mock.calls.find(call =>
      String(call[0]).includes('FROM workflow_runs wr')
    )
    expect(latestRunQuery?.[1]).toContain('chatllm')
  })

  it('resolves latest artifacts through a child recipe alias only when the approval target matches', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    const latestRun = makeRunRow({
      run_id: 'latest-run-1',
      child_recipe_name: 'test-recipe-run-1',
      child_recipe_namespace: 'sandbox-recipes',
      approval_request_id: '00000000-0000-4000-8000-000000000123',
    })
    mockPoolQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (String(sql).includes('FROM workflow_runs wr')) {
        return Promise.resolve({
          rows: params?.[2] === targetUserId ? [latestRun] : [],
          rowCount: params?.[2] === targetUserId ? 1 : 0,
        })
      }
      return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 })
    })
    mockGetRun.mockResolvedValueOnce(latestRun)

    const app = makeApp(['test-recipe', 'test-recipe-run-1'], {
      'test-recipe-run-1': [
        {
          name: 'seed-result.json',
          format: 'json',
          sizeBytes: 123,
          createdAt: '2026-05-26T12:01:00.000Z',
        },
      ],
    })
    const res = await request(app)
      .get(
        `/workflows/sandbox-recipes/test-recipe-run-1/runs/latest/artifacts?targetUserId=${targetUserId}&workflowConversationId=thread-1`
      )
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(res.status).toBe(200)
    expect(res.body.workflowName).toBe('test-recipe')
    expect(res.body.artifacts).toEqual([
      expect.objectContaining({
        name: 'seed-result.json',
        format: 'json',
      }),
    ])
    expect(mockGetRun).toHaveBeenCalledWith('latest-run-1')
    const sql = mockPoolQuery.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).toContain('wr.child_recipe_name = $2')
    expect(sql).toContain('JOIN workflow_approval_requests war')
    expect(sql).toContain('JOIN workflow_approval_trigger_intents wati')

    const denied = await request(app)
      .get(
        '/workflows/sandbox-recipes/test-recipe-run-1/runs/latest/artifacts?targetUserId=00000000-0000-4000-8000-000000000099&workflowConversationId=thread-1'
      )
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(denied.status).toBe(404)
  })

  it('does not resolve approval-bound latest artifacts for a different mcp-host caller key', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    const latestRun = makeRunRow({
      run_id: 'latest-run-1',
      child_recipe_name: 'test-recipe-run-1',
      child_recipe_namespace: 'sandbox-recipes',
      approval_request_id: '00000000-0000-4000-8000-000000000123',
    })
    mockPoolQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (String(sql).includes('FROM workflow_runs wr')) {
        const callerKey = params?.[4]
        const allowed = callerKey === 'sandbox-recipes/workflow-caller-alpha'
        return Promise.resolve({ rows: allowed ? [latestRun] : [], rowCount: allowed ? 1 : 0 })
      }
      return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 })
    })
    mockGetRun.mockResolvedValueOnce(latestRun)

    const app = makeApp(['test-recipe', 'test-recipe-run-1'], {
      'test-recipe-run-1': [
        {
          name: 'seed-result.json',
          format: 'json',
          sizeBytes: 123,
          createdAt: '2026-05-26T12:01:00.000Z',
        },
      ],
    })

    const denied = await request(app)
      .get(
        `/workflows/sandbox-recipes/test-recipe-run-1/runs/latest/artifacts?targetUserId=${targetUserId}&workflowConversationId=thread-1`
      )
      .set('Authorization', 'Bearer workflow-caller-beta-token')
    expect(denied.status).toBe(404)
    expect(mockGetRun).not.toHaveBeenCalled()

    const allowed = await request(app)
      .get(
        `/workflows/sandbox-recipes/test-recipe-run-1/runs/latest/artifacts?targetUserId=${targetUserId}&workflowConversationId=thread-1`
      )
      .set('Authorization', 'Bearer workflow-caller-alpha-token')
    expect(allowed.status).toBe(200)
    expect(allowed.body.workflowName).toBe('test-recipe')
  })

  it('does not resolve workflow health through an approval-bound child recipe alias without granting the child', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    const res = await request(makeApp(['test-recipe', 'test-recipe-run-1']))
      .get(`/workflows/sandbox-recipes/test-recipe-run-1/health?targetUserId=${targetUserId}`)
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Not authorized to view this recipe health' })
    const sql = mockPoolQuery.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).not.toContain('FROM workflow_runs wr')
  })

  it('resolves latest workflow run artifact content for a shared mcp-host through the approval target', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    const latestRun = makeRunRow({
      run_id: 'latest-run-1',
      child_recipe_name: 'test-recipe-run-1',
      child_recipe_namespace: 'sandbox-recipes',
      approval_request_id: '00000000-0000-4000-8000-000000000123',
    })
    mockPoolQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM workflow_runs wr')) {
        return Promise.resolve({ rows: [latestRun], rowCount: 1 })
      }
      return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 })
    })
    mockGetRun.mockResolvedValueOnce(latestRun)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type'
            ? 'application/json'
            : name.toLowerCase() === 'content-disposition'
              ? 'attachment; filename="seed-result.json"'
              : null,
      },
      arrayBuffer: async () => {
        const body = Buffer.from(JSON.stringify({ marker: 'latest-run-marker' }), 'utf8')
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      },
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const app = makeApp(['test-recipe', 'test-recipe-run-1'], {
      'test-recipe-run-1': [
        {
          name: 'seed-result.json',
          format: 'json',
          sizeBytes: 123,
          createdAt: '2026-05-26T12:01:00.000Z',
        },
      ],
    })
    const res = await request(app)
      .get(
        `/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts/seed-result.json/content?targetUserId=${targetUserId}&workflowConversationId=thread-1`
      )
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(res.status).toBe(200)
    expect(res.body.content).toEqual({ marker: 'latest-run-marker' })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://workflow-recipes.control-plane.svc.cluster.local:8082/api/v1/workflow/test-recipe-run-1/artifacts/seed-result.json',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('does not resolve latest workflow run artifacts for a different approval target', async () => {
    const targetUserId = '00000000-0000-4000-8000-000000000001'
    mockPoolQuery.mockImplementation((_sql: string, params?: unknown[]) => {
      const requestedTarget = params?.[2]
      return Promise.resolve({
        rows: requestedTarget === targetUserId ? [makeRunRow()] : [],
        rowCount: requestedTarget === targetUserId ? 1 : 0,
      })
    })

    const res = await request(makeApp(['test-recipe']))
      .get(
        '/workflows/sandbox-recipes/test-recipe/runs/latest/artifacts?targetUserId=00000000-0000-4000-8000-000000000099&workflowConversationId=thread-1'
      )
      .set('Authorization', 'Bearer shared-host-control-token')

    expect(res.status).toBe(404)
    expect(mockGetRun).not.toHaveBeenCalled()
  })

  it('rejects admin JWT on runtime lane', async () => {
    const res = await request(makeApp())
      .get('/workflows')
      .set('Authorization', 'Bearer admin-token')
    expect(res.status).toBe(401)
  })

  it('rejects InternalControl JWT on runtime lane', async () => {
    const res = await request(makeApp())
      .get('/workflows')
      .set('Authorization', 'Bearer internal-control-token')
    expect(res.status).toBe(401)
  })

  it('rejects user-session tokens on runtime lane', async () => {
    mockVerifyExternalSessionToken.mockReturnValueOnce({
      userId: 'user-1',
      email: 'user@example.com',
      teamId: 'team-1',
      role: 'member',
      exp: Math.floor(Date.now() / 1000) + 600,
    })

    const res = await request(makeApp())
      .get('/workflows')
      .set('x-user-session-token', 'user-session-token')

    expect(res.status).toBe(401)
    expect(mockVerifyExternalSessionToken).not.toHaveBeenCalled()
  })

  it('requires a shared mcp-host control JWT for effective target resolution', async () => {
    const userId = '00000000-0000-4000-8000-000000000001'

    const noToken = await request(makeApp()).post('/workflows/effective-targets/resolve').send({
      purpose: 'list',
      userId,
    })
    expect(noToken.status).toBe(401)

    const wrongScope = await request(makeApp())
      .post('/workflows/effective-targets/resolve')
      .set('Authorization', 'Bearer shared-read-token')
      .send({ purpose: 'list', userId })
    expect(wrongScope.status).toBe(403)
    expect(wrongScope.body).toEqual({ error: 'insufficient_scope' })

    const wrongCaller = await request(makeApp())
      .post('/workflows/effective-targets/resolve')
      .set('Authorization', 'Bearer sandbox-caller-control-token')
      .send({ purpose: 'list', userId })
    expect(wrongCaller.status).toBe(403)
    expect(wrongCaller.body).toEqual({ error: 'mcp_host_caller_not_allowed' })

    const internalToken = await request(makeApp())
      .post('/workflows/effective-targets/resolve')
      .set('Authorization', 'Bearer internal-control-token')
      .send({ purpose: 'list', userId })
    expect(internalToken.status).toBe(401)
  })

  it('lists effective workflows for direct user and team grants without treating membership as a grant', async () => {
    const userId = '00000000-0000-4000-8000-000000000001'
    const treasuryTeamId = '00000000-0000-4000-8000-0000000000aa'
    const operationsTeamId = '00000000-0000-4000-8000-0000000000bb'
    mockPoolQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM teams t')) {
        return Promise.resolve({
          rows: [
            { id: treasuryTeamId, name: 'Treasury' },
            { id: operationsTeamId, name: 'Operations' },
          ],
          rowCount: 2,
        })
      }
      if (sql.includes('FROM user_workflow_triggers')) {
        expect(params).toEqual([userId])
        return Promise.resolve({
          rows: [{ recipe_namespace: 'sandbox-recipes', recipe_name: 'personal-review' }],
          rowCount: 1,
        })
      }
      if (sql.includes('FROM workflow_recipe_allowed_teams wat')) {
        return Promise.resolve({
          rows:
            params?.[0] === treasuryTeamId
              ? [{ recipe_namespace: 'sandbox-recipes', recipe_name: 'treasury-review' }]
              : [],
          rowCount: params?.[0] === treasuryTeamId ? 1 : 0,
        })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    const res = await request(makeApp(['personal-review', 'treasury-review', 'ops-review']))
      .post('/workflows/effective-targets/resolve')
      .set('Authorization', 'Bearer shared-host-control-token')
      .send({ purpose: 'list', userId })

    expect(res.status).toBe(200)
    expect(res.body.items).toEqual([
      {
        namespace: 'sandbox-recipes',
        name: 'personal-review',
        inputContract: null,
        targets: [{ kind: 'user', label: 'Personal' }],
      },
      {
        namespace: 'sandbox-recipes',
        name: 'treasury-review',
        inputContract: null,
        targets: [{ kind: 'team', label: 'Treasury' }],
      },
    ])
    const sql = mockPoolQuery.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).toContain('JOIN team_members tm')
    expect(sql).toContain('JOIN team_workflow_triggers twt')
  })

  it('requires active membership plus paired team allowlist and trigger grant for team targets', async () => {
    const userId = '00000000-0000-4000-8000-000000000001'
    const allowlistOnlyTeamId = '00000000-0000-4000-8000-0000000000aa'
    const triggerOnlyTeamId = '00000000-0000-4000-8000-0000000000bb'
    const fullGrantTeamId = '00000000-0000-4000-8000-0000000000cc'
    mockPoolQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM teams t')) {
        expect(sql).toContain("tm.status = 'active'")
        return Promise.resolve({
          rows: [
            { id: allowlistOnlyTeamId, name: 'Allowlist Only' },
            { id: triggerOnlyTeamId, name: 'Trigger Only' },
            { id: fullGrantTeamId, name: 'Fully Granted' },
          ],
          rowCount: 3,
        })
      }
      if (sql.includes('FROM user_workflow_triggers')) {
        return Promise.resolve({ rows: [], rowCount: 0 })
      }
      if (sql.includes('FROM workflow_recipe_allowed_teams wat')) {
        expect(sql).toContain('JOIN team_workflow_triggers twt')
        return Promise.resolve({
          rows:
            params?.[0] === fullGrantTeamId
              ? [{ recipe_namespace: 'sandbox-recipes', recipe_name: 'full-team-review' }]
              : [],
          rowCount: params?.[0] === fullGrantTeamId ? 1 : 0,
        })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    const res = await request(
      makeApp(['allowlist-only-review', 'trigger-only-review', 'full-team-review'])
    )
      .post('/workflows/effective-targets/resolve')
      .set('Authorization', 'Bearer shared-host-control-token')
      .send({ purpose: 'list', userId })

    expect(res.status).toBe(200)
    expect(res.body.items).toEqual([
      {
        namespace: 'sandbox-recipes',
        name: 'full-team-review',
        inputContract: null,
        targets: [{ kind: 'team', label: 'Fully Granted' }],
      },
    ])
  })

  it('resolves a unique team target for workflow trigger without requiring the user to supply a team label', async () => {
    const userId = '00000000-0000-4000-8000-000000000001'
    const treasuryTeamId = '00000000-0000-4000-8000-0000000000aa'
    mockPoolQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM teams t')) {
        return Promise.resolve({
          rows: [{ id: treasuryTeamId, name: 'Treasury' }],
          rowCount: 1,
        })
      }
      if (sql.includes('FROM user_workflow_triggers')) {
        return Promise.resolve({ rows: [], rowCount: 0 })
      }
      if (sql.includes('FROM workflow_recipe_allowed_teams wat')) {
        return Promise.resolve({
          rows:
            params?.[0] === treasuryTeamId
              ? [{ recipe_namespace: 'sandbox-recipes', recipe_name: 'treasury-review' }]
              : [],
          rowCount: params?.[0] === treasuryTeamId ? 1 : 0,
        })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    const res = await request(makeApp(['treasury-review']))
      .post('/workflows/effective-targets/resolve')
      .set('Authorization', 'Bearer shared-host-control-token')
      .send({
        purpose: 'trigger',
        userId,
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'treasury-review',
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: 'unique',
      target: { kind: 'team', label: 'Treasury', teamId: treasuryTeamId },
    })
  })

  it('asks for human-label clarification when a workflow is valid for personal and team targets', async () => {
    const userId = '00000000-0000-4000-8000-000000000001'
    const treasuryTeamId = '00000000-0000-4000-8000-0000000000aa'
    mockPoolQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM teams t')) {
        return Promise.resolve({
          rows: [{ id: treasuryTeamId, name: 'Treasury' }],
          rowCount: 1,
        })
      }
      if (sql.includes('FROM user_workflow_triggers')) {
        return Promise.resolve({
          rows: [{ recipe_namespace: 'sandbox-recipes', recipe_name: 'risk-review' }],
          rowCount: 1,
        })
      }
      if (sql.includes('FROM workflow_recipe_allowed_teams wat')) {
        return Promise.resolve({
          rows:
            params?.[0] === treasuryTeamId
              ? [{ recipe_namespace: 'sandbox-recipes', recipe_name: 'risk-review' }]
              : [],
          rowCount: params?.[0] === treasuryTeamId ? 1 : 0,
        })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    const ambiguous = await request(makeApp(['risk-review']))
      .post('/workflows/effective-targets/resolve')
      .set('Authorization', 'Bearer shared-host-control-token')
      .send({
        purpose: 'trigger',
        userId,
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
      })

    expect(ambiguous.status).toBe(200)
    expect(ambiguous.body).toEqual({
      status: 'ambiguous',
      targets: [
        { kind: 'user', label: 'Personal' },
        { kind: 'team', label: 'Treasury' },
      ],
    })
    expect(JSON.stringify(ambiguous.body)).not.toContain(treasuryTeamId)

    const clarified = await request(makeApp(['risk-review']))
      .post('/workflows/effective-targets/resolve')
      .set('Authorization', 'Bearer shared-host-control-token')
      .send({
        purpose: 'trigger',
        userId,
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
        targetLabel: 'Treasury',
      })

    expect(clarified.status).toBe(200)
    expect(clarified.body).toEqual({
      status: 'unique',
      target: { kind: 'team', label: 'Treasury', teamId: treasuryTeamId },
    })
  })

  it('fails closed when duplicated human labels cannot identify a single effective target', async () => {
    const userId = '00000000-0000-4000-8000-000000000001'
    const treasuryA = '00000000-0000-4000-8000-0000000000aa'
    const treasuryB = '00000000-0000-4000-8000-0000000000bb'
    mockPoolQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM teams t')) {
        return Promise.resolve({
          rows: [
            { id: treasuryA, name: 'Treasury' },
            { id: treasuryB, name: 'Treasury' },
          ],
          rowCount: 2,
        })
      }
      if (sql.includes('FROM user_workflow_triggers')) {
        return Promise.resolve({ rows: [], rowCount: 0 })
      }
      if (sql.includes('FROM workflow_recipe_allowed_teams wat')) {
        return Promise.resolve({
          rows: [{ recipe_namespace: 'sandbox-recipes', recipe_name: 'risk-review' }],
          rowCount: 1,
        })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    const res = await request(makeApp(['risk-review']))
      .post('/workflows/effective-targets/resolve')
      .set('Authorization', 'Bearer shared-host-control-token')
      .send({
        purpose: 'trigger',
        userId,
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'risk-review',
        targetLabel: 'Treasury',
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: 'ambiguous',
      duplicateLabels: true,
      targets: [
        { kind: 'team', label: 'Treasury' },
        { kind: 'team', label: 'Treasury' },
      ],
    })
    expect(JSON.stringify(res.body)).not.toContain(treasuryA)
    expect(JSON.stringify(res.body)).not.toContain(treasuryB)
  })

  it('rejects non-sandbox recipe namespaces on runtime trigger before creating a run', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'

    const res = await request(makeApp())
      .post('/workflows/mcp-server/test-recipe/trigger')
      .set('Authorization', 'Bearer mcp-host-workflow-control-token')
      .set('Idempotency-Key', 'idem-1')
      .send({
        approvalRequestId,
        inputs: { topic: 'approval contract' },
      })

    expect(res.status).toBe(404)
    expect(mockCreateApprovedWorkflowRun).not.toHaveBeenCalled()
  })

  it('triggers through the runtime lane only with mcpHost control claims and an approval id', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    mockTypedApprovalBinding()

    const res = await request(makeApp())
      .post('/workflows/sandbox-recipes/test-recipe/trigger')
      .set('Authorization', 'Bearer mcp-host-workflow-control-token')
      .set('Idempotency-Key', 'idem-1')
      .send({
        approvalRequestId,
        inputs: { topic: 'approval contract' },
      })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      id: 'run-1',
      phase: 'Pending',
      actor: { type: 'mcp-host', hostRef: 'sandbox-recipes/test-recipe' },
    })
    expect(mockCreateApprovedWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe_namespace: 'sandbox-recipes',
        recipe_name: 'test-recipe',
        actor_type: 'autonomous',
        idempotency_key: 'idem-1',
        trigger_source: 'autonomous',
        approval_request_id: approvalRequestId,
        approval_caller_key: 'sandbox-recipes/test-recipe',
        inputs: { topic: 'approval contract' },
      })
    )
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled()
  })

  it('triggers through the runtime lane with workflow:trigger scope only', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    mockTypedApprovalBinding()

    const res = await request(makeApp())
      .post('/workflows/sandbox-recipes/test-recipe/trigger')
      .set('Authorization', 'Bearer workflow-trigger-token')
      .set('Idempotency-Key', 'idem-trigger-scope')
      .send({ approvalRequestId })

    expect(res.status).toBe(201)
    expect(mockCreateApprovedWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe_namespace: 'sandbox-recipes',
        recipe_name: 'test-recipe',
        idempotency_key: 'idem-trigger-scope',
        approval_request_id: approvalRequestId,
      })
    )
  })

  it('requires workflow:trigger scope to trigger runtime workflows', async () => {
    const res = await request(makeApp())
      .post('/workflows/sandbox-recipes/test-recipe/trigger')
      .set('Authorization', 'Bearer workflow-read-token')
      .set('Idempotency-Key', 'idem-read-only')
      .send({ approvalRequestId: '00000000-0000-4000-8000-000000000123' })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'insufficient_scope' })
    expect(mockCreateApprovedWorkflowRun).not.toHaveBeenCalled()
  })

  it('allows a shared mcp-host control token when the durable approval binds the host caller', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    mockTypedApprovalBinding('test-recipe', 'chatllm')

    const res = await request(makeApp())
      .post('/workflows/sandbox-recipes/test-recipe/trigger')
      .set('Authorization', 'Bearer shared-host-control-token')
      .set('Idempotency-Key', 'idem-shared-host')
      .send({ approvalRequestId })

    expect(res.status).toBe(201)
    expect(mockCreateApprovedWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe_namespace: 'sandbox-recipes',
        recipe_name: 'test-recipe',
        actor_type: 'autonomous',
        idempotency_key: 'idem-shared-host',
        trigger_source: 'autonomous',
        approval_request_id: approvalRequestId,
        approval_caller_key: 'chatllm',
      })
    )
  })

  it('rejects runtime trigger attempts without approvalRequestId before creating a run', async () => {
    const res = await request(makeApp())
      .post('/workflows/sandbox-recipes/test-recipe/trigger')
      .set('Authorization', 'Bearer mcp-host-workflow-control-token')
      .set('Idempotency-Key', 'idem-2')
      .send({ inputs: { topic: 'missing approval' } })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('approvalRequestId is required for mcp-host-control triggers')
    expect(mockCreateApprovedWorkflowRun).not.toHaveBeenCalled()
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled()
  })

  it('rejects sandbox mcp-host caller trigger attempts without approvalRequestId before creating a run', async () => {
    const res = await request(makeApp())
      .post('/workflows/sandbox-recipes/test-recipe/trigger')
      .set('Authorization', 'Bearer sandbox-caller-control-token')
      .set('Idempotency-Key', 'idem-sandbox-caller-missing-approval')
      .send({ inputs: { topic: 'missing approval' } })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('approvalRequestId is required for mcp-host-control triggers')
    expect(mockCreateApprovedWorkflowRun).not.toHaveBeenCalled()
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled()
  })

  it('allows approval-bound triggers from a sandbox mcp-host caller whose hostRefs do not include the target recipe', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    mockTypedApprovalBinding('test-recipe', 'sandbox-recipes/caller-recipe')

    const res = await request(makeApp())
      .post('/workflows/sandbox-recipes/test-recipe/trigger')
      .set('Authorization', 'Bearer sandbox-caller-control-token')
      .set('Idempotency-Key', 'idem-3')
      .send({ approvalRequestId })

    expect(res.status).toBe(201)
    expect(mockCreateApprovedWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe_namespace: 'sandbox-recipes',
        recipe_name: 'test-recipe',
        idempotency_key: 'idem-3',
        approval_request_id: approvalRequestId,
        approval_caller_key: 'sandbox-recipes/caller-recipe',
      })
    )
  })

  it('allows approval-bound triggers from an alternate sandbox caller by caller key', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    mockTypedApprovalBinding('test-recipe', 'sandbox-recipes/workflow-caller-alpha')

    const res = await request(makeApp())
      .post('/workflows/sandbox-recipes/test-recipe/trigger')
      .set('Authorization', 'Bearer workflow-caller-alpha-token')
      .set('Idempotency-Key', 'idem-alpha-caller')
      .send({ approvalRequestId })

    expect(res.status).toBe(201)
    expect(mockCreateApprovedWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe_namespace: 'sandbox-recipes',
        recipe_name: 'test-recipe',
        idempotency_key: 'idem-alpha-caller',
        approval_request_id: approvalRequestId,
        approval_caller_key: 'sandbox-recipes/workflow-caller-alpha',
      })
    )
  })

  it('rejects caller swap when beta tries to consume an approval bound to alpha', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    mockTypedApprovalBinding('test-recipe', 'sandbox-recipes/workflow-caller-alpha')

    const res = await request(makeApp())
      .post('/workflows/sandbox-recipes/test-recipe/trigger')
      .set('Authorization', 'Bearer workflow-caller-beta-token')
      .set('Idempotency-Key', 'idem-beta-swap')
      .send({ approvalRequestId })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({
      error: 'approval_trigger_binding_mismatch',
      approvalStatus: 'approved',
    })
    expect(mockCreateApprovedWorkflowRun).not.toHaveBeenCalled()
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled()
  })

  it('rejects an alternate sandbox caller without workflow:trigger before typed intent lookup', async () => {
    const res = await request(makeApp())
      .post('/workflows/sandbox-recipes/test-recipe/trigger')
      .set('Authorization', 'Bearer workflow-caller-beta-read-token')
      .set('Idempotency-Key', 'idem-beta-read-only')
      .send({ approvalRequestId: '00000000-0000-4000-8000-000000000123' })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'insufficient_scope' })
    expect(mockPoolQuery).not.toHaveBeenCalled()
    expect(mockCreateApprovedWorkflowRun).not.toHaveBeenCalled()
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled()
  })

  it('returns the existing run on mcp-host idempotent retry without creating a duplicate', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    mockTypedApprovalBinding('test-recipe', 'sandbox-recipes/workflow-caller-alpha')
    mockCreateApprovedWorkflowRun.mockResolvedValueOnce({
      row: makeRunRow({
        run_id: 'existing-run',
        idempotency_key: 'idem-alpha-retry',
        approval_request_id: approvalRequestId,
      }),
      created: false,
    })

    const res = await request(makeApp())
      .post('/workflows/sandbox-recipes/test-recipe/trigger')
      .set('Authorization', 'Bearer workflow-caller-alpha-token')
      .set('Idempotency-Key', 'idem-alpha-retry')
      .send({ approvalRequestId })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 'existing-run' })
    expect(mockCreateApprovedWorkflowRun).toHaveBeenCalledTimes(1)
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled()
  })

  it('rejects sandbox mcp-host caller trigger before workflow preflight when approval binding mismatches', async () => {
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          status: 'approved',
          triggerNamespace: 'sandbox-recipes',
          triggerName: 'other-recipe',
          triggerCaller: 'sandbox-recipes/caller-recipe',
        },
      ],
      rowCount: 1,
    })

    const res = await request(makeApp())
      .post('/workflows/sandbox-recipes/test-recipe/trigger')
      .set('Authorization', 'Bearer sandbox-caller-control-token')
      .set('Idempotency-Key', 'idem-binding-mismatch')
      .send({ approvalRequestId })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({
      error: 'approval_trigger_binding_mismatch',
      approvalStatus: 'approved',
    })
    expect(mockCreateApprovedWorkflowRun).not.toHaveBeenCalled()
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled()
  })
})
