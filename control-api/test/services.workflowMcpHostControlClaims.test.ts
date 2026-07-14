import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowRouteCaller } from '../src/services/workflows/types.js'
import {
  getCallerDisplayId,
  getTriggerActorForCaller,
  getWorkflowPrincipalId,
} from '../src/services/workflows/workflowCallerService.js'
import {
  ensureRecipeAuthorized,
  getAuthorizedRecipeResources,
} from '../src/services/workflows/workflowRecipeAccessService.js'
import { triggerWorkflow } from '../src/services/workflows/workflowTriggerService.js'
import type {
  McpHostControlClaims,
  McpHostControlScope,
} from '../src/utils/auth/mcpHostJwtToken.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()
const mockCreateApprovedRun = vi.fn()
const mockCreateRun = vi.fn()
const mockComputeWorkflowRunPayloadHash = vi.fn(() => 'payload-hash')

vi.mock('../src/config.js', () => ({
  config: {
    hostsNamespace: 'mcp-host',
    sandboxNamespace: 'sandbox-recipes',
  },
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/workflowRunService.js', () => ({
  WorkflowRunIdempotencyConflictError: class WorkflowRunIdempotencyConflictError extends Error {},
  computeWorkflowRunPayloadHash: (...args: unknown[]) => mockComputeWorkflowRunPayloadHash(...args),
  createApprovedRun: (...args: unknown[]) => mockCreateApprovedRun(...args),
  createRun: (...args: unknown[]) => mockCreateRun(...args),
}))

vi.mock('../src/utils/auth/mcpHostJwtToken.js', () => ({
  isHostRefAuthorized: (claims: { hostRefs?: string[] }, ns: string, name: string) =>
    Array.isArray(claims.hostRefs) && claims.hostRefs.includes(`${ns}/${name}`),
  getMcpHostCallerKey: (claims: { hostRefs?: string[]; sub: string }) => {
    const hostRef = claims.hostRefs?.[0]?.trim()
    if (!hostRef) throw new Error('mcp-host JWT missing canonical hostRefs[0] caller binding')
    return hostRef
  },
}))

const CONTROL_SCOPES: McpHostControlScope[] = ['workflow:list', 'workflow:read', 'workflow:trigger']

function controlClaims(overrides: Partial<McpHostControlClaims> = {}): McpHostControlClaims {
  return {
    sub: 'sandbox-recipes/test-recipe',
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'test-recipe',
    hostRefs: ['sandbox-recipes/test-recipe'],
    typ: 'service',
    scopes: CONTROL_SCOPES,
    iss: 'test',
    aud: 'mcp-host',
    jti: 'control-jti',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  }
}

function controlCaller(overrides: Partial<McpHostControlClaims> = {}): WorkflowRouteCaller {
  return { kind: 'mcp-host-control', claims: controlClaims(overrides) }
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

function mockApprovalTriggerBinding(
  callerKey = 'sandbox-recipes/test-recipe',
  recipeName = 'test-recipe'
) {
  mockPoolQuery.mockResolvedValueOnce({
    rows: [
      {
        status: 'approved',
        triggerNamespace: 'sandbox-recipes',
        triggerName: recipeName,
        triggerCaller: callerKey,
      },
    ],
    rowCount: 1,
  })
}

async function makeGateway() {
  const gateway = new MockGateway('sandbox-recipes')
  await gateway.createResource('workflowrecipes', {
    metadata: { name: 'test-recipe', creationTimestamp: '2026-05-03T00:00:00.000Z' },
    spec: {
      triggers: { onDemand: { requiresApproval: true } },
      workloads: [{ id: 'svc', type: 'deployment', image: 'test:latest' }],
    },
    status: { phase: 'Ready' },
  })
  await gateway.createResource('workflowrecipes', {
    metadata: { name: 'other-recipe', creationTimestamp: '2026-05-03T00:00:00.000Z' },
    spec: { triggers: { onDemand: { requiresApproval: true } } },
    status: { phase: 'Ready' },
  })
  return gateway
}

describe('mcp-host-control claims downstream workflow services', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockCreateApprovedRun.mockResolvedValue({ row: makeRunRow(), created: true })
  })

  it('workflow caller helpers consume service claims without requiring the legacy scope field', () => {
    const caller = controlCaller()

    expect('scope' in caller.claims).toBe(false)
    expect(caller.claims.typ).toBe('service')
    expect(caller.claims.scopes).toEqual(CONTROL_SCOPES)
    expect(getCallerDisplayId(caller)).toBe('sandbox-recipes/test-recipe')
    expect(getTriggerActorForCaller(caller)).toBe('autonomous')
    expect(getWorkflowPrincipalId(caller)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('workflow caller helpers identify shared HCC hosts by hostRefs[0]', () => {
    const caller = controlCaller({
      sub: 'mcp-host/standalone',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      hostRefs: ['trader'],
    })

    expect(getCallerDisplayId(caller)).toBe('trader')
    expect(getWorkflowPrincipalId(caller)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('workflow recipe access stays bound to hostRefs on normalized service claims', async () => {
    const gateway = await makeGateway()
    const caller = controlCaller({
      hostRefs: [
        'sandbox-recipes/test-recipe',
        'sandbox-recipes/missing-recipe',
        'mcp-server/not-a-workflow-recipe',
      ],
    })

    const recipes = await getAuthorizedRecipeResources(caller, gateway as never)

    expect(recipes).toHaveLength(1)
    expect(recipes[0]?.metadata).toMatchObject({
      namespace: 'sandbox-recipes',
      name: 'test-recipe',
    })
    await expect(ensureRecipeAuthorized(caller, 'sandbox-recipes', 'test-recipe')).resolves.toBe(
      true
    )
    await expect(ensureRecipeAuthorized(caller, 'sandbox-recipes', 'other-recipe')).resolves.toBe(
      false
    )
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('shared 1st-party mcp-host control callers require approval target grants to read sandbox workflows', async () => {
    const gateway = await makeGateway()
    const caller = controlCaller({
      sub: 'mcp-host/standalone',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      hostRefs: ['trader'],
    })

    const recipes = await getAuthorizedRecipeResources(caller, gateway as never)

    expect(recipes).toEqual([])
    await expect(ensureRecipeAuthorized(caller, 'sandbox-recipes', 'test-recipe')).resolves.toBe(
      false
    )
    await expect(ensureRecipeAuthorized(caller, 'sandbox-recipes', 'other-recipe')).resolves.toBe(
      false
    )
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('shared 1st-party mcp-host control callers read only workflows granted to the approval target', async () => {
    const gateway = await makeGateway()
    const caller = controlCaller({
      sub: 'mcp-host/standalone',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      hostRefs: ['trader'],
    })
    mockPoolQuery.mockImplementation((_sql: string, params: unknown[]) => {
      const recipeName = params[1]
      if (recipeName && recipeName !== 'test-recipe') {
        return Promise.resolve({ rows: [], rowCount: 0 })
      }
      return Promise.resolve({
        rows: [{ recipe_namespace: 'sandbox-recipes', recipe_name: 'test-recipe' }],
        rowCount: 1,
      })
    })

    const approvalTarget = { targetUserId: '00000000-0000-4000-8000-000000000001' }
    const recipes = await getAuthorizedRecipeResources(caller, gateway as never, approvalTarget)

    expect(
      recipes.map(recipe => recipe.metadata).map(metadata => (metadata as { name: string }).name)
    ).toEqual(['test-recipe'])
    await expect(
      ensureRecipeAuthorized(caller, 'sandbox-recipes', 'test-recipe', approvalTarget)
    ).resolves.toBe(true)
    await expect(
      ensureRecipeAuthorized(caller, 'sandbox-recipes', 'other-recipe', approvalTarget)
    ).resolves.toBe(false)
  })

  it('does not grant shared HCC recipe access to non-sentinel mcp-host namespace callers', async () => {
    const gateway = await makeGateway()
    const caller = controlCaller({
      sub: 'mcp-host/custom-runtime',
      recipeNamespace: 'mcp-host',
      recipeName: 'custom-runtime',
      hostRefs: ['trader'],
    })

    const recipes = await getAuthorizedRecipeResources(caller, gateway as never)

    expect(recipes).toEqual([])
    await expect(ensureRecipeAuthorized(caller, 'sandbox-recipes', 'test-recipe')).resolves.toBe(
      false
    )
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('keeps direct user-session team grant checks explicitly scoped to claims.teamId', async () => {
    const gateway = await makeGateway()
    const caller: WorkflowRouteCaller = {
      kind: 'user-session',
      claims: {
        userId: 'user-123',
        email: 'user@example.com',
        teamId: null as unknown as string,
        role: 'member',
        exp: Math.floor(Date.now() / 1000) + 600,
      },
    }

    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(getAuthorizedRecipeResources(caller, gateway as never)).resolves.toEqual([])

    expect(String(mockPoolQuery.mock.calls[0]?.[0])).toContain('WHERE $2::uuid IS NOT NULL')
    expect(mockPoolQuery.mock.calls[0]?.[1]).toEqual(['user-123', null])

    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(ensureRecipeAuthorized(caller, 'sandbox-recipes', 'test-recipe')).resolves.toBe(
      false
    )

    expect(String(mockPoolQuery.mock.calls[1]?.[0])).toContain('FROM user_workflow_triggers')
    expect(String(mockPoolQuery.mock.calls[1]?.[0])).not.toContain('team_workflow_triggers')
    expect(mockPoolQuery.mock.calls[1]?.[1]).toEqual(['user-123', 'sandbox-recipes', 'test-recipe'])
  })

  it('workflow trigger service preserves approval-bound mcp-host semantics with scoped claims', async () => {
    const gateway = await makeGateway()
    const caller = controlCaller()
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    mockApprovalTriggerBinding()

    await expect(
      triggerWorkflow({
        gateway: gateway as never,
        caller,
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'test-recipe',
        body: { approvalRequestId, inputs: { topic: 'scoped claims' } },
        idempotencyKey: 'idem-scoped-claims',
        correlationId: 'corr-scoped-claims',
      })
    ).resolves.toEqual({ kind: 'run', row: makeRunRow(), created: true })

    expect(mockComputeWorkflowRunPayloadHash).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'autonomous',
        triggerSource: 'autonomous',
        callerKey: 'sandbox-recipes/test-recipe',
        approvalRequestId,
      })
    )
    expect(mockCreateApprovedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe_namespace: 'sandbox-recipes',
        recipe_name: 'test-recipe',
        actor_type: 'autonomous',
        trigger_source: 'autonomous',
        approval_request_id: approvalRequestId,
        approval_caller_key: 'sandbox-recipes/test-recipe',
        correlation_id: 'corr-scoped-claims',
      })
    )
    expect(mockCreateRun).not.toHaveBeenCalled()
  })

  it('workflow trigger service rejects autonomous callers when onDemand trigger is missing', async () => {
    const gateway = new MockGateway('sandbox-recipes')
    await gateway.createResource('workflowrecipes', {
      metadata: { name: 'test-recipe', creationTimestamp: '2026-05-03T00:00:00.000Z' },
      spec: {
        triggers: {},
        workloads: [{ id: 'svc', type: 'deployment', image: 'test:latest' }],
      },
      status: { phase: 'Ready' },
    })
    mockApprovalTriggerBinding()

    await expect(
      triggerWorkflow({
        gateway: gateway as never,
        caller: controlCaller(),
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'test-recipe',
        body: {
          approvalRequestId: '00000000-0000-4000-8000-000000000123',
          inputs: { topic: 'missing trigger' },
        },
        idempotencyKey: 'idem-missing-on-demand',
      })
    ).rejects.toMatchObject({
      status: 400,
      body: { error: 'Workflow does not declare an onDemand trigger' },
    })

    expect(mockCreateApprovedRun).not.toHaveBeenCalled()
    expect(mockCreateRun).not.toHaveBeenCalled()
  })

  it('workflow trigger service binds shared 1st-party approvals to hostRefs[0]', async () => {
    const gateway = await makeGateway()
    const caller = controlCaller({
      sub: 'mcp-host/standalone',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      hostRefs: ['trader'],
    })
    const approvalRequestId = '00000000-0000-4000-8000-000000000123'
    mockApprovalTriggerBinding('trader')

    await triggerWorkflow({
      gateway: gateway as never,
      caller,
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'test-recipe',
      body: { approvalRequestId },
      idempotencyKey: 'idem-shared-host',
      correlationId: 'corr-shared-host',
    })

    expect(mockComputeWorkflowRunPayloadHash).toHaveBeenCalledWith(
      expect.objectContaining({
        callerKey: 'trader',
        approvalRequestId,
      })
    )
    expect(mockCreateApprovedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        approval_caller_key: 'trader',
        correlation_id: 'corr-shared-host',
      })
    )
  })
})
