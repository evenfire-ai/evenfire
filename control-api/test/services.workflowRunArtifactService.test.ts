import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorkflowArtifactHttpError,
  deleteWorkflowRunArtifact,
  deleteWorkflowRunArtifacts,
  downloadWorkflowRunArtifact,
  listWorkflowRunArtifacts,
} from '../src/services/workflows/workflowRunArtifactService.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()
const mockSignWrcDelegationToken = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

vi.mock('../src/config.js', () => ({
  config: {
    hostsNamespace: 'mcp-host',
    sandboxNamespace: 'sandbox-recipes',
    mcpServersNamespace: 'mcp-server',
  },
}))

vi.mock('../src/utils/auth/delegationToken.js', () => ({
  signWrcDelegationToken: (...args: unknown[]) => mockSignWrcDelegationToken(...args),
}))

vi.mock('../src/utils/auth/mcpHostJwtToken.js', () => ({
  isHostRefAuthorized: vi.fn((claims: { hostRefs?: string[] }, ns: string, name: string) =>
    Array.isArray(claims.hostRefs) ? claims.hostRefs.includes(`${ns}/${name}`) : false
  ),
}))

const RECIPE_NS = 'sandbox-recipes'
const PARENT_RECIPE = {
  metadata: { name: 'parent-workflow', namespace: RECIPE_NS },
  spec: { steps: [{ id: 'trigger' }] },
}
const CHILD_RECIPE = {
  metadata: {
    name: 'child-run-recipe',
    namespace: RECIPE_NS,
    labels: { 'clerum.io/workflow-run-id': 'run-123' },
  },
  spec: { steps: [{ id: 'emit' }] },
  status: {
    artifacts: [
      {
        name: 'custom-sdk-result.json',
        format: 'json',
        path: '/output/custom-sdk-result.json',
        sizeBytes: 42,
        createdAt: '2026-05-06T00:00:00.000Z',
      },
      {
        name: '../secret.json',
        format: 'json',
        path: '/output/../secret.json',
        sizeBytes: 1,
        createdAt: '2026-05-06T00:00:01.000Z',
      },
    ],
  },
}
const CHILD_RECIPE_WITHOUT_RUN_LABEL = {
  ...CHILD_RECIPE,
  metadata: { name: 'child-run-recipe', namespace: RECIPE_NS },
}
const CHILD_RECIPE_WITH_CONFLICTING_RUN_LABEL = {
  ...CHILD_RECIPE,
  metadata: {
    name: 'child-run-recipe',
    namespace: RECIPE_NS,
    labels: { 'clerum.io/workflow-run-id': 'run-other' },
  },
}

const RUN_ROW = {
  run_id: 'run-123',
  recipe_namespace: RECIPE_NS,
  recipe_name: 'parent-workflow',
  phase: 'Succeeded',
  actor_type: 'user',
  actor_id: 'user-123',
  idempotency_key: 'key-1',
  trigger_source: 'onDemand',
  inputs: null,
  intermediate_parameters: null,
  output_overrides: null,
  child_recipe_name: 'child-run-recipe',
  child_recipe_namespace: RECIPE_NS,
  owner_instance_id: null,
  max_duration_seconds: null,
  ttl_seconds_after_finished: null,
  approval_request_id: null,
  idempotency_payload_hash: null,
  started_at: '2026-05-06T00:00:00.000Z',
  completed_at: '2026-05-06T00:00:10.000Z',
  last_reconciled_at: '2026-05-06T00:00:11.000Z',
  created_at: '2026-05-06T00:00:00.000Z',
  updated_at: '2026-05-06T00:00:11.000Z',
}

const caller = {
  kind: 'user-session' as const,
  claims: {
    userId: 'user-123',
    email: 'test@clerum.io',
    teamId: 'team-1',
    role: 'member' as const,
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
}

const adminCaller = {
  kind: 'admin-ui' as const,
  userId: 'admin-123',
}

const mcpHostCaller = {
  kind: 'mcp-host-control' as const,
  claims: {
    sub: 'mcp-host/standalone',
    recipeNamespace: 'mcp-host',
    recipeName: 'standalone',
    hostRefs: [`${RECIPE_NS}/parent-workflow`],
    typ: 'service',
    scopes: ['workflow:read', 'workflow:trigger'],
    iss: 'test',
    aud: 'mcp-host',
    jti: 'mcp-host-control-jti',
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
}

function makeGateway(): MockGateway {
  const gateway = new MockGateway(RECIPE_NS)
  return gateway
}

async function seedRecipes(gateway: MockGateway, childRecipe = CHILD_RECIPE): Promise<void> {
  await gateway.createResource('workflowrecipes', PARENT_RECIPE as never, RECIPE_NS)
  await gateway.createResource('workflowrecipes', childRecipe as never, RECIPE_NS)
}

describe('workflowRunArtifactService', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockSignWrcDelegationToken.mockReset()
    mockSignWrcDelegationToken.mockReturnValue('control-to-wrc-token')
    vi.unstubAllGlobals()
  })

  it('lists artifacts for the exact child run and does not expose storage paths', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [RUN_ROW], rowCount: 1 })

    const artifacts = await listWorkflowRunArtifacts({
      gateway: gateway as never,
      caller,
      recipeNamespace: RECIPE_NS,
      recipeName: 'parent-workflow',
      runId: 'run-123',
    })

    expect(artifacts).toEqual([
      {
        name: 'custom-sdk-result.json',
        format: 'json',
        sizeBytes: 42,
        createdAt: '2026-05-06T00:00:00.000Z',
      },
    ])
    expect(JSON.stringify(artifacts)).not.toContain('/output/')
  })

  it('allows the target user to read artifacts for an approval-bound autonomous run', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    const approvalBoundRun = {
      ...RUN_ROW,
      actor_type: 'autonomous',
      actor_id: 'mcp-host-principal',
      team_id: null,
      usage_team_id: null,
      approval_request_id: '00000000-0000-4000-8000-000000000123',
    }
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [approvalBoundRun], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })

    const artifacts = await listWorkflowRunArtifacts({
      gateway: gateway as never,
      caller,
      recipeNamespace: RECIPE_NS,
      recipeName: 'parent-workflow',
      runId: 'run-123',
    })

    expect(artifacts.map(artifact => artifact.name)).toEqual(['custom-sdk-result.json'])
    expect(String(mockPoolQuery.mock.calls[2][0])).toContain('workflow_approval_requests')
    expect(String(mockPoolQuery.mock.calls[2][0])).toContain('team_workflow_triggers')
  })

  it('downloads a run-scoped artifact through WRC with run and artifact token bindings', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [RUN_ROW], rowCount: 1 })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('artifact-bytes', {
        headers: {
          'content-type': 'application/json',
          'content-disposition': 'attachment; filename="custom-sdk-result.json"',
        },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadWorkflowRunArtifact({
      gateway: gateway as never,
      caller,
      recipeNamespace: RECIPE_NS,
      recipeName: 'parent-workflow',
      runId: 'run-123',
      artifactName: 'custom-sdk-result.json',
    })

    expect(result.status).toBe(200)
    expect(result.body).toBeInstanceOf(Buffer)
    expect(mockSignWrcDelegationToken).toHaveBeenCalledWith({
      adminUserId: 'user-123',
      subject: 'user:user-123',
      recipeName: 'child-run-recipe',
      recipeNamespace: RECIPE_NS,
      runId: 'run-123',
      artifactName: 'custom-sdk-result.json',
      scope: 'artifact_read',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://workflow-recipes.control-plane.svc.cluster.local:8082/api/v1/workflow/child-run-recipe/artifacts/custom-sdk-result.json',
      expect.objectContaining({
        headers: { authorization: 'Bearer control-to-wrc-token' },
      })
    )
  })

  it('downloads legacy child artifacts without a runId claim when the child recipe has no run label', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway, CHILD_RECIPE_WITHOUT_RUN_LABEL)
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [RUN_ROW], rowCount: 1 })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('artifact-bytes', {
          headers: {
            'content-type': 'application/json',
            'content-disposition': 'attachment; filename="custom-sdk-result.json"',
          },
        })
      )
    )

    const result = await downloadWorkflowRunArtifact({
      gateway: gateway as never,
      caller,
      recipeNamespace: RECIPE_NS,
      recipeName: 'parent-workflow',
      runId: 'run-123',
      artifactName: 'custom-sdk-result.json',
    })

    expect(result.status).toBe(200)
    expect(mockSignWrcDelegationToken).toHaveBeenCalledWith({
      adminUserId: 'user-123',
      subject: 'user:user-123',
      recipeName: 'child-run-recipe',
      recipeNamespace: RECIPE_NS,
      artifactName: 'custom-sdk-result.json',
      scope: 'artifact_read',
    })
  })

  it('rejects artifacts when the child run label conflicts with the requested run', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway, CHILD_RECIPE_WITH_CONFLICTING_RUN_LABEL)
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [RUN_ROW], rowCount: 1 })
    vi.stubGlobal('fetch', vi.fn())

    await expect(
      downloadWorkflowRunArtifact({
        gateway: gateway as never,
        caller,
        recipeNamespace: RECIPE_NS,
        recipeName: 'parent-workflow',
        runId: 'run-123',
        artifactName: 'custom-sdk-result.json',
      })
    ).rejects.toMatchObject({ status: 404 })
    expect(mockSignWrcDelegationToken).not.toHaveBeenCalled()
  })

  it('downloads bounded workflow artifacts without upstream content length', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [RUN_ROW], rowCount: 1 })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('artifact-bytes', {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="custom-sdk-result.pdf"',
          },
        })
      )
    )

    const result = await downloadWorkflowRunArtifact({
      gateway: gateway as never,
      caller,
      recipeNamespace: RECIPE_NS,
      recipeName: 'parent-workflow',
      runId: 'run-123',
      artifactName: 'custom-sdk-result.json',
      maxBytes: 64,
    })

    expect(result.status).toBe(200)
    expect(result.body).toBeInstanceOf(Buffer)
    expect((result.body as Buffer).toString('utf8')).toBe('artifact-bytes')
    expect(result.headers['content-length']).toBe('14')
  })

  it('rejects bounded workflow artifact downloads when streamed body exceeds max bytes', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [RUN_ROW], rowCount: 1 })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('artifact-bytes', {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="custom-sdk-result.pdf"',
          },
        })
      )
    )

    await expect(
      downloadWorkflowRunArtifact({
        gateway: gateway as never,
        caller,
        recipeNamespace: RECIPE_NS,
        recipeName: 'parent-workflow',
        runId: 'run-123',
        artifactName: 'custom-sdk-result.json',
        maxBytes: 4,
      })
    ).rejects.toMatchObject({ status: 413 })
  })

  it('downloads artifacts for mcp-host-control callers with artifact_read scope', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery.mockResolvedValueOnce({ rows: [RUN_ROW], rowCount: 1 })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('artifact-bytes', {
        headers: {
          'content-type': 'application/json',
          'content-disposition': 'attachment; filename="custom-sdk-result.json"',
        },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadWorkflowRunArtifact({
      gateway: gateway as never,
      caller: mcpHostCaller,
      recipeNamespace: RECIPE_NS,
      recipeName: 'parent-workflow',
      runId: 'run-123',
      artifactName: 'custom-sdk-result.json',
    })

    expect(result.status).toBe(200)
    expect(mockSignWrcDelegationToken).toHaveBeenCalledWith({
      adminUserId: 'mcp-host/standalone',
      subject: 'mcp-host:mcp-host/standalone',
      recipeName: 'child-run-recipe',
      recipeNamespace: RECIPE_NS,
      runId: 'run-123',
      artifactName: 'custom-sdk-result.json',
      scope: 'artifact_read',
    })
  })

  it('deletes a run-scoped artifact through WRC with run and artifact token bindings', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery.mockResolvedValueOnce({ rows: [RUN_ROW], rowCount: 1 })
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await deleteWorkflowRunArtifact({
      gateway: gateway as never,
      caller: adminCaller,
      recipeNamespace: RECIPE_NS,
      recipeName: 'parent-workflow',
      runId: 'run-123',
      artifactName: 'custom-sdk-result.json',
    })

    expect(result.status).toBe(204)
    expect(mockSignWrcDelegationToken).toHaveBeenCalledWith({
      adminUserId: 'admin-123',
      subject: 'admin:admin-123',
      recipeName: 'child-run-recipe',
      recipeNamespace: RECIPE_NS,
      runId: 'run-123',
      artifactName: 'custom-sdk-result.json',
      scope: 'admin:artifact_delete',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://workflow-recipes.control-plane.svc.cluster.local:8082/api/v1/workflow/child-run-recipe/artifacts/custom-sdk-result.json',
      expect.objectContaining({
        method: 'DELETE',
        headers: { authorization: 'Bearer control-to-wrc-token' },
      })
    )
  })

  it('bulk deletes run-scoped artifacts without binding a single artifactName', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery.mockResolvedValueOnce({ rows: [RUN_ROW], rowCount: 1 })
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await deleteWorkflowRunArtifacts({
      gateway: gateway as never,
      caller: adminCaller,
      recipeNamespace: RECIPE_NS,
      recipeName: 'parent-workflow',
      runId: 'run-123',
    })

    expect(result.status).toBe(204)
    expect(mockSignWrcDelegationToken).toHaveBeenCalledWith({
      adminUserId: 'admin-123',
      subject: 'admin:admin-123',
      recipeName: 'child-run-recipe',
      recipeNamespace: RECIPE_NS,
      runId: 'run-123',
      scope: 'admin:artifact_delete',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://workflow-recipes.control-plane.svc.cluster.local:8082/api/v1/workflow/child-run-recipe/artifacts',
      expect.objectContaining({
        method: 'DELETE',
        headers: { authorization: 'Bearer control-to-wrc-token' },
      })
    )
  })

  it('rejects non-admin artifact deletes before signing a WRC delegation token', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [RUN_ROW], rowCount: 1 })

    await expect(
      deleteWorkflowRunArtifact({
        gateway: gateway as never,
        caller,
        recipeNamespace: RECIPE_NS,
        recipeName: 'parent-workflow',
        runId: 'run-123',
        artifactName: 'custom-sdk-result.json',
      })
    ).rejects.toMatchObject({
      status: 403,
      message: 'Only admin callers may delete workflow artifacts',
    })
    expect(mockSignWrcDelegationToken).not.toHaveBeenCalled()
  })

  it('returns 410 when run artifact child recipe metadata has been pruned', async () => {
    const gateway = makeGateway()
    await gateway.createResource('workflowrecipes', PARENT_RECIPE as never, RECIPE_NS)
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [RUN_ROW], rowCount: 1 })

    await expect(
      listWorkflowRunArtifacts({
        gateway: gateway as never,
        caller,
        recipeNamespace: RECIPE_NS,
        recipeName: 'parent-workflow',
        runId: 'run-123',
      })
    ).rejects.toMatchObject({ status: 410 })
  })

  it('returns a timeout-specific status when WRC artifact fetch times out', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [RUN_ROW], rowCount: 1 })
    const err = new Error('deadline exceeded')
    err.name = 'TimeoutError'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err))

    await expect(
      downloadWorkflowRunArtifact({
        gateway: gateway as never,
        caller,
        recipeNamespace: RECIPE_NS,
        recipeName: 'parent-workflow',
        runId: 'run-123',
        artifactName: 'custom-sdk-result.json',
      })
    ).rejects.toMatchObject({ status: 504 })
  })

  it('rejects unsafe artifact names before resolving runs or calling WRC', async () => {
    const gateway = makeGateway()

    await expect(
      downloadWorkflowRunArtifact({
        gateway: gateway as never,
        caller,
        recipeNamespace: RECIPE_NS,
        recipeName: 'parent-workflow',
        runId: 'run-123',
        artifactName: '../secret.json',
      })
    ).rejects.toMatchObject({ status: 400 })
    expect(mockPoolQuery).not.toHaveBeenCalled()
    expect(mockSignWrcDelegationToken).not.toHaveBeenCalled()
  })

  it('returns 403 when the user lacks a grant on the parent recipe', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const result = listWorkflowRunArtifacts({
      gateway: gateway as never,
      caller,
      recipeNamespace: RECIPE_NS,
      recipeName: 'parent-workflow',
      runId: 'run-123',
    })

    await expect(result).rejects.toBeInstanceOf(WorkflowArtifactHttpError)
    await expect(result).rejects.toMatchObject({ status: 403 })
  })

  it('does not expose another user artifact even when caller has a grant to the same recipe', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            ...RUN_ROW,
            actor_id: 'other-user',
            team_id: 'team-1',
            usage_team_id: 'team-1',
          },
        ],
        rowCount: 1,
      })
      // The token still names team-1, but the current membership/grant no longer exists.
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const result = listWorkflowRunArtifacts({
      gateway: gateway as never,
      caller,
      recipeNamespace: RECIPE_NS,
      recipeName: 'parent-workflow',
      runId: 'run-123',
    })

    await expect(result).rejects.toBeInstanceOf(WorkflowArtifactHttpError)
    await expect(result).rejects.toMatchObject({ status: 404 })
    expect(mockSignWrcDelegationToken).not.toHaveBeenCalled()
  })

  it('returns 404 when runId belongs to a different parent recipe', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 }).mockResolvedValueOnce({
      rows: [{ ...RUN_ROW, recipe_name: 'other-workflow' }],
      rowCount: 1,
    })

    await expect(
      listWorkflowRunArtifacts({
        gateway: gateway as never,
        caller,
        recipeNamespace: RECIPE_NS,
        recipeName: 'parent-workflow',
        runId: 'run-123',
      })
    ).rejects.toMatchObject({ status: 404 })
  })

  it('rejects child WorkflowRecipe namespaces outside the sandbox invariant', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 }).mockResolvedValueOnce({
      rows: [{ ...RUN_ROW, child_recipe_namespace: 'mcp-server' }],
      rowCount: 1,
    })

    await expect(
      listWorkflowRunArtifacts({
        gateway: gateway as never,
        caller,
        recipeNamespace: RECIPE_NS,
        recipeName: 'parent-workflow',
        runId: 'run-123',
      })
    ).rejects.toMatchObject({ status: 404 })
    expect(mockSignWrcDelegationToken).not.toHaveBeenCalled()
  })

  it('returns 404 for audit or pending runs without executionRef', async () => {
    const gateway = makeGateway()
    await seedRecipes(gateway)
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 }).mockResolvedValueOnce({
      rows: [{ ...RUN_ROW, child_recipe_name: null, child_recipe_namespace: null }],
      rowCount: 1,
    })

    await expect(
      listWorkflowRunArtifacts({
        gateway: gateway as never,
        caller,
        recipeNamespace: RECIPE_NS,
        recipeName: 'parent-workflow',
        runId: 'run-123',
      })
    ).rejects.toMatchObject({ status: 404 })
  })
})
