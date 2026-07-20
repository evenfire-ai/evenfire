/**
 * Functional tests for restEndpoints.ts
 *
 * Tests the handler functions directly — no HTTP layer. Auth / JWT tests
 * are covered in restEndpoints.security.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  type AuthenticatedRequest,
  createWorkflowEndpointHandlers,
} from '../../../src/workflow/restEndpoints'
import { enqueueSignal } from '../../../src/workflow/signalStore'

// ─── Helpers ────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.WRC_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS
})

function makeClaims(
  overrides: Partial<AuthenticatedRequest['tokenClaims']> = {}
): AuthenticatedRequest['tokenClaims'] {
  return {
    sub: 'coordinator',
    aud: 'clerum-wrc',
    recipeName: 'my-recipe',
    recipeNamespace: 'sandbox-recipes',
    scopes: ['status_write', 'status_read', 'configure_model', 'signal_read', 'health_read'],
    ...overrides,
  }
}

function makeCustomApi(
  overrides: Record<string, ReturnType<typeof vi.fn>> = {}
): k8s.CustomObjectsApi {
  return {
    getNamespacedCustomObject: vi.fn().mockResolvedValue({
      metadata: { name: 'my-recipe', resourceVersion: '1' },
      spec: { steps: [{ id: 's1' }] },
      status: {
        workflowExecution: { phase: 'running', attempt: 1, startedAt: '2026-01-01T00:00:00Z' },
        steps: [],
      },
    }),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as k8s.CustomObjectsApi
}

type JsonPatchOperation = {
  op: 'add' | 'replace' | 'test'
  path: string
  value: unknown
}

function getStatusPatchOps(api: k8s.CustomObjectsApi): JsonPatchOperation[] {
  const patchArg = (api.patchNamespacedCustomObjectStatus as ReturnType<typeof vi.fn>).mock
    .calls[0][0]
  return patchArg.body as JsonPatchOperation[]
}

function childMetadata(runId: string, resourceVersion = '1'): Record<string, unknown> {
  return {
    name: 'my-recipe',
    resourceVersion,
    labels: { 'clerum.io/workflow-run-id': runId },
  }
}

// NOTE: The in-memory `wrcToMcpHostTokenStore` was removed in the
// 2026-04-09 artifact-download refactor. Per-call tokens are now signed
// fresh by the JwtTokenFactory — see jwtTokenFactory.test.ts for coverage.

// ─── postStepStatus — step-level update ─────────────────────────────────────

describe('postStepStatus — step-level update', () => {
  let api: k8s.CustomObjectsApi
  let handlers: ReturnType<typeof createWorkflowEndpointHandlers>

  beforeEach(() => {
    api = makeCustomApi()
    handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')
  })

  it('returns 200 accepted for valid step update', async () => {
    const result = await handlers.postStepStatus('my-recipe', makeClaims(), {
      stepId: 's1',
      phase: 'running',
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ accepted: true })
  })

  it('persists a valid approval binding hash on the exact step status', async () => {
    const hash = 'a'.repeat(64)
    const result = await handlers.postStepStatus('my-recipe', makeClaims(), {
      stepId: 's1',
      phase: 'running',
      approvalBindingSha256: hash,
    })

    expect(result.status).toBe(200)
    const patchOps = getStatusPatchOps(api)
    expect(patchOps.find(op => op.path === '/status/steps/-')?.value).toMatchObject({
      id: 's1',
      phase: 'running',
      approvalBindingSha256: hash,
    })
  })

  it('rejects malformed approval binding hashes before patching Kubernetes', async () => {
    const result = await handlers.postStepStatus('my-recipe', makeClaims(), {
      stepId: 's1',
      phase: 'running',
      approvalBindingSha256: 'not-a-sha256',
    })

    expect(result.status).toBe(422)
    expect(result.body).toEqual({ error: 'approvalBindingSha256 must be sha256 hex' })
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('reads and patches WorkflowRecipes in the token namespace', async () => {
    const getNamespacedCustomObject = vi.fn().mockResolvedValue({
      metadata: { name: 'my-recipe', resourceVersion: '1' },
      spec: { steps: [{ id: 's1' }] },
      status: { steps: [] },
    })
    const patchNamespacedCustomObjectStatus = vi.fn().mockResolvedValue({})
    const api = makeCustomApi({
      getNamespacedCustomObject,
      patchNamespacedCustomObjectStatus,
    })
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.postStepStatus('my-recipe', makeClaims(), {
      stepId: 's1',
      phase: 'completed',
    })

    expect(result.status).toBe(200)
    expect(getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'sandbox-recipes' })
    )
    expect(patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'sandbox-recipes' }),
      expect.anything()
    )
  })

  it('returns 403 before Kubernetes calls when token recipeNamespace does not match sandbox namespace', async () => {
    const result = await handlers.postStepStatus(
      'my-recipe',
      makeClaims({ recipeNamespace: 'mcp-server' }),
      { stepId: 's1', phase: 'running' }
    )

    expect(result.status).toBe(403)
    expect(result.body).toEqual({ error: 'Token recipeNamespace mismatch' })
    expect(api.getNamespacedCustomObject).not.toHaveBeenCalled()
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('returns 403 when token recipeName does not match URL recipeName', async () => {
    const result = await handlers.postStepStatus(
      'other-recipe',
      makeClaims({ recipeName: 'my-recipe' }),
      { stepId: 's1', phase: 'running' }
    )
    expect(result.status).toBe(403)
  })

  it('returns 403 when token lacks status_write scope', async () => {
    const result = await handlers.postStepStatus('my-recipe', makeClaims({ scopes: [] }), {
      stepId: 's1',
      phase: 'running',
    })
    expect(result.status).toBe(403)
  })

  it('returns 404 when recipe not found', async () => {
    const notFoundApi = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
    })
    const h = createWorkflowEndpointHandlers(notFoundApi, 'sandbox-recipes')

    const result = await h.postStepStatus('my-recipe', makeClaims(), {
      stepId: 's1',
      phase: 'running',
    })
    expect(result.status).toBe(404)
  })

  it('calls patchNamespacedCustomObjectStatus with updated steps', async () => {
    await handlers.postStepStatus('my-recipe', makeClaims(), {
      stepId: 's1',
      phase: 'completed',
      output: 'done',
      executor: 'snippet',
    })
    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalled()
    const patchOps = getStatusPatchOps(api)
    expect(patchOps.find(op => op.path === '/status/steps/-')?.value).toMatchObject({
      phase: 'completed',
      executor: 'snippet',
    })
    expect(patchOps.find(op => op.path === '/status/phase')?.value).toBe('active')
    expect(patchOps.find(op => op.path === '/status/workflowExecution')?.value).toMatchObject({
      phase: 'completed',
      message: 'Workflow completed',
    })
  })

  it('stores step output as a bounded preview with truncation metadata', async () => {
    const longOutput = 'x'.repeat(33_000)

    await handlers.postStepStatus('my-recipe', makeClaims(), {
      stepId: 's1',
      phase: 'completed',
      output: longOutput,
    })

    const patchOps = getStatusPatchOps(api)
    const step = patchOps.find(op => op.path === '/status/steps/-')?.value as {
      output?: string
      outputTruncated?: boolean
      outputLength?: number
      outputPreviewMaxChars?: number
    }

    expect(step.output).toHaveLength(32_768)
    expect(step.outputTruncated).toBe(true)
    expect(step.outputLength).toBe(longOutput.length)
    expect(step.outputPreviewMaxChars).toBe(32_768)
  })

  it('honors configured step output preview limits', async () => {
    process.env.WRC_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS = '2048'
    const customApi = makeCustomApi()
    const h = createWorkflowEndpointHandlers(customApi, 'sandbox-recipes')

    await h.postStepStatus('my-recipe', makeClaims(), {
      stepId: 's1',
      phase: 'completed',
      output: 'y'.repeat(3000),
    })

    const patchOps = getStatusPatchOps(customApi)
    const step = patchOps.find(op => op.path === '/status/steps/-')?.value as {
      output?: string
      outputTruncated?: boolean
      outputLength?: number
      outputPreviewMaxChars?: number
    }

    expect(step.output).toHaveLength(2048)
    expect(step.outputTruncated).toBe(true)
    expect(step.outputLength).toBe(3000)
    expect(step.outputPreviewMaxChars).toBe(2048)
  })

  it('keeps toolsCalled args as CRD-compatible objects', async () => {
    await handlers.postStepStatus('my-recipe', makeClaims(), {
      stepId: 's1',
      phase: 'completed',
      toolsCalled: [
        {
          serverName: 'web-research',
          toolName: 'web_search',
          args: { query: 'Mythos vs GPT-5.5', maxResults: 5 },
          result: { ok: true },
          durationMs: 42,
        },
        {
          serverName: 'web-research',
          toolName: 'fetch_page',
          args: { url: 'https://example.test', body: 'x'.repeat(2048) },
          result: 'ok',
          durationMs: 7,
        },
      ],
    })

    const patchOps = getStatusPatchOps(api)
    const step = patchOps.find(op => op.path === '/status/steps/-')?.value as {
      toolsCalled?: Array<{ args?: unknown; result?: unknown }>
    }
    expect(step.toolsCalled?.[0]?.args).toEqual({ query: 'Mythos vs GPT-5.5', maxResults: 5 })
    expect(typeof step.toolsCalled?.[0]?.args).toBe('object')
    expect(step.toolsCalled?.[0]?.result).toEqual({ ok: true })
    expect(step.toolsCalled?.[1]?.args).toMatchObject({ truncated: true })
    expect((step.toolsCalled?.[1]?.args as { preview?: string }).preview).toHaveLength(1024)
    expect(step.toolsCalled?.[1]?.result).toBe('ok')
  })

  it('rejects toolsCalled entries missing CRD-required serverName', async () => {
    const result = await handlers.postStepStatus('my-recipe', makeClaims(), {
      stepId: 's1',
      phase: 'completed',
      toolsCalled: [
        {
          toolName: 'web_search',
          args: { query: 'Mythos vs GPT-5.5' },
          result: { ok: true },
          durationMs: 42,
        },
      ],
    } as never)

    expect(result.status).toBe(422)
    expect(result.body).toEqual({ error: 'toolsCalled[0].serverName is required' })
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('rejects toolsCalled entries missing CRD-required toolName', async () => {
    const result = await handlers.postStepStatus('my-recipe', makeClaims(), {
      stepId: 's1',
      phase: 'completed',
      toolsCalled: [
        {
          serverName: 'web-research',
          toolName: '',
          args: { query: 'Mythos vs GPT-5.5' },
          result: { ok: true },
          durationMs: 42,
        },
      ],
    })

    expect(result.status).toBe(422)
    expect(result.body).toEqual({ error: 'toolsCalled[0].toolName is required' })
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('truncates oversized tool results without forcing all results to strings', async () => {
    await handlers.postStepStatus('my-recipe', makeClaims(), {
      stepId: 's1',
      phase: 'completed',
      toolsCalled: [
        {
          serverName: 'web-research',
          toolName: 'web_search',
          args: { query: 'large result' },
          result: { body: 'x'.repeat(2048) },
          durationMs: 42,
        },
      ],
    })

    const patchOps = getStatusPatchOps(api)
    const step = patchOps.find(op => op.path === '/status/steps/-')?.value as {
      toolsCalled?: Array<{ result?: unknown }>
    }
    const result = step.toolsCalled?.[0]?.result
    expect(result).toMatchObject({ truncated: true })
    expect((result as { preview?: string }).preview).toHaveLength(1024)
  })

  it('patches only the touched step so stale reads cannot overwrite sibling step status', async () => {
    const raceApi = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 'prepare' }, { id: 'calculate' }, { id: 'finalize' }] },
        status: {
          workflowExecution: { phase: 'running', attempt: 1 },
          steps: [
            { id: 'prepare', phase: 'completed', output: 'seed' },
            { id: 'calculate', phase: 'running', startedAt: '2026-05-06T00:00:00.000Z' },
          ],
        },
      }),
    })
    const h = createWorkflowEndpointHandlers(raceApi, 'sandbox-recipes')

    const result = await h.postStepStatus('my-recipe', makeClaims(), {
      stepId: 'finalize',
      phase: 'completed',
      output: 'done',
      executor: 'snippet',
    })

    expect(result.status).toBe(200)
    const patchOps = getStatusPatchOps(raceApi)
    expect(patchOps).toEqual([
      expect.objectContaining({
        op: 'add',
        path: '/status/steps/-',
        value: expect.objectContaining({
          id: 'finalize',
          phase: 'completed',
          executor: 'snippet',
        }),
      }),
    ])
  })

  it('retries bootstrap step patches when status.steps is created concurrently', async () => {
    const getNamespacedCustomObject = vi
      .fn()
      .mockResolvedValueOnce({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 'prepare' }, { id: 'emit' }] },
        status: {
          workflowExecution: { phase: 'running', attempt: 1 },
        },
      })
      .mockResolvedValueOnce({
        metadata: { name: 'my-recipe', resourceVersion: '2' },
        spec: { steps: [{ id: 'prepare' }, { id: 'emit' }] },
        status: {
          workflowExecution: { phase: 'running', attempt: 1 },
          steps: [{ id: 'prepare', phase: 'completed' }],
        },
      })
    const patchNamespacedCustomObjectStatus = vi
      .fn()
      .mockRejectedValueOnce({ code: 409, message: 'json patch test failed' })
      .mockResolvedValueOnce({})
    const conflictApi = makeCustomApi({
      getNamespacedCustomObject,
      patchNamespacedCustomObjectStatus,
    })
    const h = createWorkflowEndpointHandlers(conflictApi, 'sandbox-recipes')

    const result = await h.postStepStatus('my-recipe', makeClaims(), {
      stepId: 'emit',
      phase: 'completed',
      executor: 'custom',
    })

    expect(result.status).toBe(200)
    expect(getNamespacedCustomObject).toHaveBeenCalledTimes(2)
    expect(patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)

    const firstPatch = patchNamespacedCustomObjectStatus.mock.calls[0][0]
      .body as JsonPatchOperation[]
    expect(firstPatch[0]).toMatchObject({ op: 'test', path: '/status' })
    expect(firstPatch.find(op => op.path === '/status/steps')?.value).toEqual([
      expect.objectContaining({ id: 'emit', phase: 'completed' }),
    ])

    const secondPatch = patchNamespacedCustomObjectStatus.mock.calls[1][0]
      .body as JsonPatchOperation[]
    expect(secondPatch.find(op => op.path === '/status/steps/-')?.value).toMatchObject({
      id: 'emit',
      phase: 'completed',
      executor: 'custom',
    })
  })

  it('retries generic Kubernetes 422 responses from stale status test guards', async () => {
    const baseStatus = {
      workflowExecution: {
        phase: 'running',
        attempt: 1,
        startedAt: '2026-05-13T00:00:00.000Z',
      },
      steps: [{ id: 'generate-report', phase: 'running' }],
    }
    const getNamespacedCustomObject = vi
      .fn()
      .mockResolvedValueOnce({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 'generate-report' }] },
        status: baseStatus,
      })
      .mockResolvedValueOnce({
        metadata: { name: 'my-recipe', resourceVersion: '2' },
        spec: { steps: [{ id: 'generate-report' }] },
        status: {
          ...baseStatus,
          message: 'refreshed by reconciler',
        },
      })
    const patchNamespacedCustomObjectStatus = vi
      .fn()
      .mockRejectedValueOnce({
        code: 422,
        body: {
          reason: 'Invalid',
          message: 'the server rejected our request due to an error in our request',
        },
      })
      .mockResolvedValueOnce({})
    const conflictApi = makeCustomApi({
      getNamespacedCustomObject,
      patchNamespacedCustomObjectStatus,
    })
    const h = createWorkflowEndpointHandlers(conflictApi, 'sandbox-recipes')

    const artifact = {
      name: 'competitive-intelligence-report.pdf',
      format: 'pdf',
      path: '/output/competitive-intelligence-report.pdf',
      sizeBytes: 22323,
      createdAt: '2026-05-13T11:31:51.000Z',
    }

    const result = await h.postStepStatus('my-recipe', makeClaims(), {
      stepId: 'generate-report',
      phase: 'completed',
      output: 'report generated',
      executor: 'agentic',
      modelUsed: 'zai/glm-4.7',
      completedAt: '2026-05-13T11:31:51.000Z',
      toolsCalled: [
        {
          serverName: 'clerum',
          toolName: 'generate_pdf',
          args: { filename: artifact.name, body: 'report body' },
          result: { success: true, artifact },
          durationMs: 83,
        },
      ],
    })

    expect(result.status).toBe(200)
    expect(getNamespacedCustomObject).toHaveBeenCalledTimes(2)
    expect(patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)

    const firstPatch = patchNamespacedCustomObjectStatus.mock.calls[0][0]
      .body as JsonPatchOperation[]
    expect(firstPatch).not.toContainEqual(expect.objectContaining({ path: '/status' }))
    expect(firstPatch[0]).toMatchObject({
      op: 'test',
      path: '/status/steps/0/id',
      value: 'generate-report',
    })

    const secondPatch = patchNamespacedCustomObjectStatus.mock.calls[1][0]
      .body as JsonPatchOperation[]
    expect(secondPatch).not.toContainEqual(expect.objectContaining({ path: '/status' }))
    expect(secondPatch[0]).toMatchObject({
      op: 'test',
      path: '/status/steps/0/id',
      value: 'generate-report',
    })
    expect(secondPatch.find(op => op.path === '/status/steps/0')?.value).toMatchObject({
      id: 'generate-report',
      phase: 'completed',
      toolsCalled: [
        expect.objectContaining({
          serverName: 'clerum',
          toolName: 'generate_pdf',
          result: { success: true, artifact },
        }),
      ],
    })
    expect(secondPatch.find(op => op.path === '/status/artifacts')?.value).toEqual([artifact])
  })

  it('returns a clear persistence error when Kubernetes rejects a step status patch', async () => {
    const patchNamespacedCustomObjectStatus = vi
      .fn()
      .mockRejectedValue({ code: 422, message: 'invalid status patch' })
    const api = makeCustomApi({ patchNamespacedCustomObjectStatus })
    const h = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await h.postStepStatus('my-recipe', makeClaims(), {
      stepId: 's1',
      phase: 'completed',
      output: 'done',
    })

    expect(result.status).toBe(422)
    expect(result.body).toEqual({
      error: 'Could not persist workflow step status',
      statusCode: 422,
    })
  })

  it('does not retry non-generic 422 validation errors even when a step id guard is present', async () => {
    const getNamespacedCustomObject = vi.fn().mockResolvedValue({
      metadata: { name: 'my-recipe', resourceVersion: '1' },
      spec: { steps: [{ id: 'generate-report' }] },
      status: {
        workflowExecution: { phase: 'running', attempt: 1 },
        steps: [{ id: 'generate-report', phase: 'running' }],
        artifacts: [],
      },
    })
    const patchNamespacedCustomObjectStatus = vi.fn().mockRejectedValue({
      code: 422,
      message: 'invalid status patch',
    })
    const api = makeCustomApi({
      getNamespacedCustomObject,
      patchNamespacedCustomObjectStatus,
    })
    const h = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await h.postStepStatus('my-recipe', makeClaims(), {
      stepId: 'generate-report',
      phase: 'completed',
      output: 'done',
    })

    expect(result.status).toBe(422)
    expect(result.body).toEqual({
      error: 'Could not persist workflow step status',
      statusCode: 422,
    })
    expect(getNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
  })

  it('accepts safe custom artifact metadata from any declared step output', async () => {
    const customApi = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 'emit' }] },
        status: {
          workflowExecution: { phase: 'running', attempt: 1 },
          steps: [],
          artifacts: [],
        },
      }),
    })
    const h = createWorkflowEndpointHandlers(customApi, 'sandbox-recipes')

    const result = await h.postStepStatus('my-recipe', makeClaims(), {
      stepId: 'emit',
      phase: 'completed',
      executor: 'custom',
      output: {
        artifact: {
          name: 'custom-sdk-result.json',
          format: 'json',
          path: '/output/custom-sdk-result.json',
          sizeBytes: 42,
          createdAt: '2026-05-06T00:00:00.000Z',
        },
      },
    })

    expect(result.status).toBe(200)
    const patchOps = getStatusPatchOps(customApi)
    expect(patchOps.find(op => op.path === '/status/steps/-')?.value).toMatchObject({
      executor: 'custom',
    })
    expect(patchOps.find(op => op.path === '/status/artifacts/-')?.value).toEqual({
      name: 'custom-sdk-result.json',
      format: 'json',
      path: '/output/custom-sdk-result.json',
      sizeBytes: 42,
      createdAt: '2026-05-06T00:00:00.000Z',
    })
  })

  it('accepts multiple safe custom artifact metadata entries from output.artifacts', async () => {
    const customApi = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 'emit' }] },
        status: {
          workflowExecution: { phase: 'running', attempt: 1 },
          steps: [],
          artifacts: [],
        },
      }),
    })
    const h = createWorkflowEndpointHandlers(customApi, 'sandbox-recipes')

    const result = await h.postStepStatus('my-recipe', makeClaims(), {
      stepId: 'emit',
      phase: 'completed',
      executor: 'custom',
      output: {
        artifacts: [
          {
            name: 'custom-sdk-result.json',
            format: 'json',
            path: '/output/custom-sdk-result.json',
            sizeBytes: 42,
            createdAt: '2026-05-06T00:00:00.000Z',
          },
          {
            name: 'custom-risk-summary.md',
            format: 'markdown',
            path: '/output/custom-risk-summary.md',
            sizeBytes: 128,
            createdAt: '2026-05-06T00:00:01.000Z',
          },
        ],
      },
    })

    expect(result.status).toBe(200)
    const patchOps = getStatusPatchOps(customApi)
    const artifactOps = patchOps.filter(op => op.path === '/status/artifacts/-')
    expect(artifactOps.map(op => op.value)).toEqual([
      {
        name: 'custom-sdk-result.json',
        format: 'json',
        path: '/output/custom-sdk-result.json',
        sizeBytes: 42,
        createdAt: '2026-05-06T00:00:00.000Z',
      },
      {
        name: 'custom-risk-summary.md',
        format: 'markdown',
        path: '/output/custom-risk-summary.md',
        sizeBytes: 128,
        createdAt: '2026-05-06T00:00:01.000Z',
      },
    ])
  })

  it('accepts safe custom artifact metadata from stringified step output', async () => {
    const customApi = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 'emit' }] },
        status: {
          workflowExecution: { phase: 'running', attempt: 1 },
          steps: [],
          artifacts: [],
        },
      }),
    })
    const h = createWorkflowEndpointHandlers(customApi, 'sandbox-recipes')

    const result = await h.postStepStatus('my-recipe', makeClaims(), {
      stepId: 'emit',
      phase: 'completed',
      executor: 'snippet',
      output: JSON.stringify({
        artifact: {
          name: 'snippet-result.json',
          format: 'json',
          path: '/output/snippet-result.json',
          sizeBytes: 42,
          createdAt: '2026-05-06T00:00:00.000Z',
        },
      }),
    })

    expect(result.status).toBe(200)
    const patchOps = getStatusPatchOps(customApi)
    expect(patchOps.find(op => op.path === '/status/artifacts/-')?.value).toEqual({
      name: 'snippet-result.json',
      format: 'json',
      path: '/output/snippet-result.json',
      sizeBytes: 42,
      createdAt: '2026-05-06T00:00:00.000Z',
    })
  })

  it('appends artifact status entries without replacing existing siblings', async () => {
    const customApi = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 'emit' }] },
        status: {
          workflowExecution: { phase: 'running', attempt: 1 },
          steps: [],
          artifacts: [
            {
              name: 'prepare.json',
              format: 'json',
              path: '/output/prepare.json',
              sizeBytes: 12,
              createdAt: '2026-05-06T00:00:00.000Z',
            },
          ],
        },
      }),
    })
    const h = createWorkflowEndpointHandlers(customApi, 'sandbox-recipes')

    const result = await h.postStepStatus('my-recipe', makeClaims(), {
      stepId: 'emit',
      phase: 'completed',
      executor: 'custom',
      output: {
        artifact: {
          name: 'emit.json',
          format: 'json',
          path: '/output/emit.json',
          sizeBytes: 18,
          createdAt: '2026-05-06T00:00:01.000Z',
        },
      },
    })

    expect(result.status).toBe(200)
    const patchOps = getStatusPatchOps(customApi)
    expect(patchOps.some(op => op.path === '/status/artifacts' && op.op === 'replace')).toBe(false)
    expect(patchOps.find(op => op.path === '/status/artifacts/-')?.value).toMatchObject({
      name: 'emit.json',
      path: '/output/emit.json',
    })
  })

  it('ignores unsafe custom artifact metadata', async () => {
    const customApi = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 'emit' }] },
        status: {
          workflowExecution: { phase: 'running', attempt: 1 },
          steps: [],
          artifacts: [],
        },
      }),
    })
    const h = createWorkflowEndpointHandlers(customApi, 'sandbox-recipes')

    const result = await h.postStepStatus('my-recipe', makeClaims(), {
      stepId: 'emit',
      phase: 'completed',
      output: {
        artifact: {
          name: '../secret.json',
          format: 'json',
          path: '/etc/secret.json',
          sizeBytes: 42,
        },
      },
    })

    expect(result.status).toBe(200)
    const patchOps = getStatusPatchOps(customApi)
    expect(patchOps.some(op => op.path === '/status/artifacts')).toBe(false)
  })

  it('ignores oversized or negative custom artifact metadata', async () => {
    const customApi = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 'emit' }] },
        status: {
          workflowExecution: { phase: 'running', attempt: 1 },
          steps: [],
          artifacts: [],
        },
      }),
    })
    const h = createWorkflowEndpointHandlers(customApi, 'sandbox-recipes')

    const result = await h.postStepStatus('my-recipe', makeClaims(), {
      stepId: 'emit',
      phase: 'completed',
      output: {
        artifact: {
          name: `${'x'.repeat(129)}.json`,
          format: 'json',
          path: '/output/oversized.json',
          sizeBytes: -1,
        },
      },
    })

    expect(result.status).toBe(200)
    const patchOps = getStatusPatchOps(customApi)
    expect(patchOps.some(op => op.path.startsWith('/status/artifacts'))).toBe(false)
  })
})

// ─── postStepStatus — workflow-level update ──────────────────────────────────

describe('postStepStatus — workflow-level update (no stepId)', () => {
  it('accepts workflowPhase update when stepId is absent', async () => {
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 's1' }] },
        status: {
          workflowExecution: { phase: 'running', attempt: 1 },
          steps: [{ id: 's1', phase: 'completed' }],
        },
      }),
    })
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.postStepStatus('my-recipe', makeClaims(), {
      workflowPhase: 'completed',
    } as never)
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ accepted: true })
    const patchArg = (api.patchNamespacedCustomObjectStatus as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(patchArg.body.status.workflowExecution).toMatchObject({
      phase: 'completed',
      message: 'Workflow completed',
    })
    expect(patchArg.body.status.phase).toBe('active')
  })

  it('rejects workflow completion while declared steps are still non-terminal', async () => {
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 'prepare' }, { id: 'emit' }] },
        status: {
          workflowExecution: { phase: 'running', attempt: 1 },
          steps: [{ id: 'prepare', phase: 'completed' }],
        },
      }),
    })
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.postStepStatus('my-recipe', makeClaims(), {
      workflowPhase: 'completed',
    } as never)

    expect(result.status).toBe(409)
    expect(result.body).toEqual({
      error: 'Cannot mark workflow completed before all declared steps complete',
      incompleteSteps: ['emit'],
    })
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('marks the recipe active when the coordinator reports the workflow running', async () => {
    const api = makeCustomApi()
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.postStepStatus('my-recipe', makeClaims(), {
      workflowPhase: 'running',
    } as never)
    expect(result.status).toBe(200)
    const patchArg = (api.patchNamespacedCustomObjectStatus as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(patchArg.body.status).toMatchObject({
      phase: 'active',
      artifacts: [],
      workflowExecution: {
        phase: 'running',
        message: 'Workflow running',
      },
    })
  })

  it.each(['pending', 'initializing', 'recovering'] as const)(
    'keeps an active recipe active during a new workflow %s phase',
    async workflowPhase => {
      const api = makeCustomApi({
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: { name: 'my-recipe', resourceVersion: '1' },
          spec: { steps: [{ id: 's1' }] },
          status: {
            phase: 'active',
            workflowExecution: { phase: 'completed', attempt: 1 },
            steps: [],
          },
        }),
      })
      const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

      const result = await handlers.postStepStatus('my-recipe', makeClaims(), {
        workflowPhase,
      } as never)
      expect(result.status).toBe(200)
      const patchArg = (api.patchNamespacedCustomObjectStatus as ReturnType<typeof vi.fn>).mock
        .calls[0][0]
      expect(patchArg.body.status).toMatchObject({
        phase: 'active',
        workflowExecution: {
          phase: workflowPhase,
          message: `Workflow ${workflowPhase}`,
        },
      })
    }
  )

  it('marks the recipe failed when a workflow-level failure is reported', async () => {
    const api = makeCustomApi()
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.postStepStatus('my-recipe', makeClaims(), {
      workflowPhase: 'failed',
      failureReason: 'boom',
    } as never)
    expect(result.status).toBe(200)
    const patchArg = (api.patchNamespacedCustomObjectStatus as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(patchArg.body.status).toMatchObject({
      phase: 'failed',
      workflowExecution: {
        phase: 'failed',
        message: 'boom',
      },
    })
  })

  it('rejects stale non-terminal workflow updates after a terminal phase', async () => {
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '2' },
        spec: { steps: [{ id: 's1' }] },
        status: {
          workflowExecution: {
            phase: 'completed',
            completedAt: '2026-05-06T00:00:00.000Z',
          },
        },
      }),
    })
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.postStepStatus('my-recipe', makeClaims(), {
      workflowPhase: 'running',
    } as never)

    expect(result.status).toBe(409)
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })
})

// ─── getWorkflowStatus ───────────────────────────────────────────────────────

describe('getWorkflowStatus', () => {
  it('returns workflowPhase from status', async () => {
    const api = makeCustomApi()
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.getWorkflowStatus('my-recipe', makeClaims())
    expect(result.status).toBe(200)
    expect(result.body.workflowPhase).toBe('running')
  })

  it('returns 403 on recipeName mismatch', async () => {
    const api = makeCustomApi()
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.getWorkflowStatus(
      'my-recipe',
      makeClaims({ recipeName: 'other' })
    )
    expect(result.status).toBe(403)
  })

  it('returns 404 when recipe not found', async () => {
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
    })
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.getWorkflowStatus('my-recipe', makeClaims())
    expect(result.status).toBe(404)
  })
})

// ─── getSignals ──────────────────────────────────────────────────────────────

describe('getSignals', () => {
  it('returns drained signals for the recipe', async () => {
    const api = makeCustomApi()
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    enqueueSignal('my-recipe', {
      type: 'cancel',
      requestId: 'req-1',
      receivedAt: new Date().toISOString(),
    })

    const result = await handlers.getSignals('my-recipe', makeClaims())
    expect(result.status).toBe(200)
    const signals = result.body.signals as Array<{ type: string }>
    expect(signals).toHaveLength(1)
    expect(signals[0].type).toBe('cancel')
  })

  it('returns empty signals array when none queued', async () => {
    const api = makeCustomApi()
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    // Drain any leftovers
    const result = await handlers.getSignals('my-recipe', makeClaims())
    expect(result.status).toBe(200)
    // Could be 0 if no prior enqueue
  })

  it('returns 403 on recipeName mismatch', async () => {
    const api = makeCustomApi()
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.getSignals('my-recipe', makeClaims({ recipeName: 'other' }))
    expect(result.status).toBe(403)
  })
})

// ─── getHealth ───────────────────────────────────────────────────────────────

describe('getHealth', () => {
  it('returns 200 with workflowPhase from recipe status', async () => {
    const api = makeCustomApi()
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.getHealth('my-recipe', makeClaims())
    expect(result.status).toBe(200)
    expect(result.body.workflowPhase).toBe('running')
  })

  it('returns 403 on recipeName mismatch', async () => {
    const api = makeCustomApi()
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.getHealth('my-recipe', makeClaims({ recipeName: 'other' }))
    expect(result.status).toBe(403)
  })

  it('returns 404 when recipe not found', async () => {
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
    })
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.getHealth('my-recipe', makeClaims())
    expect(result.status).toBe(404)
  })
})

// ─── requestModelInjection ──────────────────────────────────────────────────

describe('requestModelInjection', () => {
  function makeBrokerRecipeApi(
    spec: Record<string, unknown> = {
      steps: [
        {
          id: 'broker-review',
          agent: { provider: 'zai', model: 'glm-4.7' },
          instruction: 'Use the brokered model.',
        },
      ],
    }
  ): k8s.CustomObjectsApi {
    return makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec,
        status: {
          workflowExecution: { phase: 'running', attempt: 1 },
          steps: [],
        },
      }),
    })
  }

  it('lets custom coordinators request declared model injection without configure_model', async () => {
    const tokenFactory = {
      signWrcConfigureToken: vi.fn().mockResolvedValue('wrc-configure-token'),
    }
    const modelConfigHandler = {
      handle: vi.fn().mockResolvedValue({ status: 200, body: { configured: true } }),
    }
    const handlers = createWorkflowEndpointHandlers(
      makeBrokerRecipeApi(),
      'sandbox-recipes',
      tokenFactory as never
    )

    const result = await handlers.requestModelInjection(
      'my-recipe',
      makeClaims({
        sub: 'custom-coordinator',
        scopes: ['model_injection_request', 'status_write', 'status_read'],
      }),
      { stepId: 'broker-review', provider: 'zai', model: 'glm-4.7' },
      modelConfigHandler as never
    )

    expect(result).toEqual({ status: 200, body: { configured: true } })
    expect(tokenFactory.signWrcConfigureToken).toHaveBeenCalledWith('my-recipe', 'sandbox-recipes')
    // The SDK injection path validates the declared model upstream, so it passes
    // no degraded-mode validator to the broker (4th arg is undefined).
    expect(modelConfigHandler.handle).toHaveBeenCalledWith(
      { stepId: 'broker-review', provider: 'zai', model: 'glm-4.7' },
      'http://wf-my-recipe-mcp-host.sandbox-recipes.svc.cluster.local:8080',
      'wrc-configure-token',
      undefined
    )
  })

  it('keeps the privileged configure-model route unavailable to custom coordinators', async () => {
    const handlers = createWorkflowEndpointHandlers(makeBrokerRecipeApi(), 'sandbox-recipes', {
      signWrcConfigureToken: vi.fn(),
    } as never)

    const result = await handlers.configureModel(
      'my-recipe',
      makeClaims({
        sub: 'custom-coordinator',
        scopes: ['model_injection_request', 'status_write', 'status_read'],
      }),
      { stepId: 'broker-review', provider: 'zai', model: 'glm-4.7' },
      { handle: vi.fn() } as never
    )

    expect(result.status).toBe(403)
    expect(result.body.error).toBe('Missing scope: configure_model')
  })

  it('rejects model injection requests that do not match the declared step agent', async () => {
    const tokenFactory = {
      signWrcConfigureToken: vi.fn().mockResolvedValue('wrc-configure-token'),
    }
    const modelConfigHandler = {
      handle: vi.fn().mockResolvedValue({ status: 200, body: { configured: true } }),
    }
    const handlers = createWorkflowEndpointHandlers(
      makeBrokerRecipeApi(),
      'sandbox-recipes',
      tokenFactory as never
    )

    const result = await handlers.requestModelInjection(
      'my-recipe',
      makeClaims({
        sub: 'custom-coordinator',
        scopes: ['model_injection_request', 'status_write', 'status_read'],
      }),
      { stepId: 'broker-review', provider: 'openai', model: 'gpt-4o-mini' },
      modelConfigHandler as never
    )

    expect(result.status).toBe(422)
    expect(tokenFactory.signWrcConfigureToken).not.toHaveBeenCalled()
    expect(modelConfigHandler.handle).not.toHaveBeenCalled()
  })

  it('validates model injection against workflow-level agent inheritance', async () => {
    const tokenFactory = {
      signWrcConfigureToken: vi.fn().mockResolvedValue('wrc-configure-token'),
    }
    const modelConfigHandler = {
      handle: vi.fn().mockResolvedValue({ status: 200, body: { configured: true } }),
    }
    const handlers = createWorkflowEndpointHandlers(
      makeBrokerRecipeApi({
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'broker-review', agent: { model: 'glm-4.7' } }],
      }),
      'sandbox-recipes',
      tokenFactory as never
    )

    const result = await handlers.requestModelInjection(
      'my-recipe',
      makeClaims({
        sub: 'custom-coordinator',
        scopes: ['model_injection_request', 'status_write', 'status_read'],
      }),
      { stepId: 'broker-review', provider: 'zai', model: 'glm-4.7' },
      modelConfigHandler as never
    )

    expect(result).toEqual({ status: 200, body: { configured: true } })
    expect(tokenFactory.signWrcConfigureToken).toHaveBeenCalledWith('my-recipe', 'sandbox-recipes')
  })

  it('requires the model_injection_request scope on the SDK route', async () => {
    const tokenFactory = {
      signWrcConfigureToken: vi.fn().mockResolvedValue('wrc-configure-token'),
    }
    const modelConfigHandler = {
      handle: vi.fn().mockResolvedValue({ status: 200, body: { configured: true } }),
    }
    const handlers = createWorkflowEndpointHandlers(
      makeBrokerRecipeApi(),
      'sandbox-recipes',
      tokenFactory as never
    )

    const result = await handlers.requestModelInjection(
      'my-recipe',
      makeClaims({
        scopes: ['configure_model', 'status_write', 'status_read'],
      }),
      { stepId: 'broker-review', provider: 'zai', model: 'glm-4.7' },
      modelConfigHandler as never
    )

    expect(result.status).toBe(403)
    expect(result.body.error).toBe('Missing scope: model_injection_request')
    expect(tokenFactory.signWrcConfigureToken).not.toHaveBeenCalled()
  })
})

// ─── getArtifact ────────────────────────────────────────────────────────────

describe('getArtifact', () => {
  it('routes pure workflow artifact downloads to the platform artifact-reader', async () => {
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: childMetadata('run-1'),
        spec: { steps: [{ id: 'emit' }] },
        status: {
          artifacts: [{ name: 'custom-sdk-result.json', path: '/output/custom-sdk-result.json' }],
        },
      }),
    })
    const tokenFactory = {
      signWrcArtifactToken: vi.fn().mockResolvedValue('wrc-artifact-token'),
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('artifact-bytes', {
        headers: {
          'content-type': 'application/json',
          'content-disposition': 'attachment; filename="custom-sdk-result.json"',
        },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', tokenFactory as never)

    const result = await handlers.getArtifact(
      'my-recipe',
      'custom-sdk-result.json',
      makeClaims({
        scopes: ['artifact_read'],
        runId: 'run-1',
        artifactName: 'custom-sdk-result.json',
      })
    )

    expect(result.status).toBe(200)
    expect(tokenFactory.signWrcArtifactToken).toHaveBeenCalledWith('my-recipe', 'sandbox-recipes', {
      runId: 'run-1',
      artifactName: 'custom-sdk-result.json',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://wf-my-recipe-artifact-reader.sandbox-recipes.svc.cluster.local:8080/api/v1/workflow/artifacts/custom-sdk-result.json',
      expect.objectContaining({
        headers: { authorization: 'Bearer wrc-artifact-token' },
      })
    )
  })

  it('returns 404 when the artifact is no longer present in current status.artifacts', async () => {
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: childMetadata('run-1', '2'),
        spec: { steps: [{ id: 'emit' }] },
        status: { artifacts: [{ name: 'other-artifact.json' }] },
      }),
    })
    const tokenFactory = {
      signWrcArtifactToken: vi.fn().mockResolvedValue('wrc-artifact-token'),
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', tokenFactory as never)

    const result = await handlers.getArtifact(
      'my-recipe',
      'custom-sdk-result.json',
      makeClaims({
        scopes: ['artifact_read'],
        runId: 'run-1',
        artifactName: 'custom-sdk-result.json',
      })
    )

    expect(result.status).toBe(404)
    expect(result.body).toEqual({ error: 'Artifact "custom-sdk-result.json" not found' })
    expect(tokenFactory.signWrcArtifactToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects artifact downloads when runId claim does not match the child recipe label', async () => {
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: childMetadata('run-1'),
        spec: { steps: [{ id: 'emit' }] },
        status: {
          artifacts: [{ name: 'custom-sdk-result.json', path: '/output/custom-sdk-result.json' }],
        },
      }),
    })
    const tokenFactory = {
      signWrcArtifactToken: vi.fn().mockResolvedValue('wrc-artifact-token'),
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', tokenFactory as never)

    const result = await handlers.getArtifact(
      'my-recipe',
      'custom-sdk-result.json',
      makeClaims({
        scopes: ['artifact_read'],
        runId: 'run-2',
        artifactName: 'custom-sdk-result.json',
      })
    )

    expect(result.status).toBe(403)
    expect(result.body).toEqual({ error: 'Token runId mismatch' })
    expect(tokenFactory.signWrcArtifactToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries transient artifact-reader 404s before surfacing download failure', async () => {
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: childMetadata('run-1'),
        spec: { steps: [{ id: 'emit' }] },
        status: {
          artifacts: [{ name: 'custom-sdk-result.json', path: '/output/custom-sdk-result.json' }],
        },
      }),
    })
    const tokenFactory = {
      signWrcArtifactToken: vi.fn().mockResolvedValue('wrc-artifact-token'),
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('not visible yet', { status: 404 }))
      .mockResolvedValueOnce(new Response('artifact-bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', tokenFactory as never)

    const result = await handlers.getArtifact(
      'my-recipe',
      'custom-sdk-result.json',
      makeClaims({
        scopes: ['artifact_read'],
        runId: 'run-1',
        artifactName: 'custom-sdk-result.json',
      })
    )

    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('maps declared artifact bytes missing from the PVC to artifact_gone', async () => {
    vi.useFakeTimers()
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: childMetadata('run-1'),
        spec: { steps: [{ id: 'emit' }] },
        status: {
          artifacts: [{ name: 'custom-sdk-result.json', path: '/output/custom-sdk-result.json' }],
        },
      }),
    })
    const tokenFactory = {
      signWrcArtifactToken: vi.fn().mockResolvedValue('wrc-artifact-token'),
    }
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'artifact_gone',
            code: 'artifact_gone',
            message:
              'Artifact "custom-sdk-result.json" is no longer available on the workflow output PVC',
          }),
          { status: 404, headers: { 'content-type': 'application/json' } }
        )
      )
    )
    vi.stubGlobal('fetch', fetchMock)
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', tokenFactory as never)

    const resultPromise = handlers.getArtifact(
      'my-recipe',
      'custom-sdk-result.json',
      makeClaims({
        scopes: ['artifact_read'],
        runId: 'run-1',
        artifactName: 'custom-sdk-result.json',
      })
    )
    await vi.runAllTimersAsync()
    const result = await resultPromise
    vi.useRealTimers()

    expect(result.status).toBe(410)
    expect(result.body).toEqual({
      error: 'artifact_gone',
      message:
        'Artifact "custom-sdk-result.json" is no longer available on the workflow output PVC',
    })
  })

  it('retries transient artifact-reader connection failures before surfacing download failure', async () => {
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: childMetadata('run-1'),
        spec: { steps: [{ id: 'emit' }] },
        status: {
          artifacts: [{ name: 'custom-sdk-result.json', path: '/output/custom-sdk-result.json' }],
        },
      }),
    })
    const tokenFactory = {
      signWrcArtifactToken: vi.fn().mockResolvedValue('wrc-artifact-token'),
    }
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce(new Response('artifact-bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', tokenFactory as never)

    const result = await handlers.getArtifact(
      'my-recipe',
      'custom-sdk-result.json',
      makeClaims({
        scopes: ['artifact_read'],
        runId: 'run-1',
        artifactName: 'custom-sdk-result.json',
      })
    )

    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('routes broker-backed mcp-host-owned artifact downloads to mcp-host', async () => {
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: childMetadata('run-2'),
        spec: { steps: [{ id: 'call-tool', mcpServers: ['mock-tools'] }] },
        status: {
          artifacts: [
            { name: 'custom-risk-summary.md', path: '/artifacts/custom-risk-summary.md' },
          ],
        },
      }),
    })
    const tokenFactory = {
      signWrcArtifactToken: vi.fn().mockResolvedValue('wrc-artifact-token'),
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response('# Risk', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', tokenFactory as never)

    const result = await handlers.getArtifact(
      'my-recipe',
      'custom-risk-summary.md',
      makeClaims({
        scopes: ['artifact_read'],
        runId: 'run-2',
        artifactName: 'custom-risk-summary.md',
      })
    )

    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://wf-my-recipe-mcp-host.sandbox-recipes.svc.cluster.local:8080/api/v1/workflow/artifacts/custom-risk-summary.md',
      expect.any(Object)
    )
  })

  it('routes agentic mcp-host /output artifact downloads to the platform artifact-reader', async () => {
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: childMetadata('run-3'),
        spec: {
          agent: { provider: 'zai', model: 'glm-5-turbo' },
          steps: [{ id: 'weekly-report', instruction: 'Generate a report' }],
        },
        status: {
          artifacts: [
            {
              name: 'weekly-summary-report.pdf',
              format: 'pdf',
              sizeBytes: 256,
              path: '/output/weekly-summary-report.pdf',
              createdAt: '2026-05-12T00:00:00.000Z',
            },
          ],
        },
      }),
    })
    const tokenFactory = {
      signWrcArtifactToken: vi.fn().mockResolvedValue('wrc-artifact-token'),
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response('pdf-bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', tokenFactory as never)

    const result = await handlers.getArtifact(
      'my-recipe',
      'weekly-summary-report.pdf',
      makeClaims({
        scopes: ['artifact_read'],
        runId: 'run-3',
        artifactName: 'weekly-summary-report.pdf',
      })
    )

    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://wf-my-recipe-artifact-reader.sandbox-recipes.svc.cluster.local:8080/api/v1/workflow/artifacts/weekly-summary-report.pdf',
      expect.any(Object)
    )
  })

  it('routes broker-backed custom coordinator /output artifacts to the artifact-reader', async () => {
    const api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: childMetadata('run-2'),
        spec: {
          coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
          output: { destination: 'pvc' },
          steps: [{ id: 'call-tool', mcpServers: ['mock-tools'] }],
        },
        status: {
          artifacts: [
            {
              name: 'custom-risk-summary.md',
              format: 'md',
              sizeBytes: 128,
              path: '/output/custom-risk-summary.md',
              createdAt: '2026-05-07T00:00:00.000Z',
            },
          ],
        },
      }),
    })
    const tokenFactory = {
      signWrcArtifactToken: vi.fn().mockResolvedValue('wrc-artifact-token'),
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response('# Risk', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', tokenFactory as never)

    const result = await handlers.getArtifact(
      'my-recipe',
      'custom-risk-summary.md',
      makeClaims({
        scopes: ['artifact_read'],
        runId: 'run-2',
        artifactName: 'custom-risk-summary.md',
      })
    )

    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://wf-my-recipe-artifact-reader.sandbox-recipes.svc.cluster.local:8080/api/v1/workflow/artifacts/custom-risk-summary.md',
      expect.any(Object)
    )
  })

  it('rejects artifact downloads when the delegated token is bound to a different artifact', async () => {
    const api = makeCustomApi()
    const tokenFactory = {
      signWrcArtifactToken: vi.fn().mockResolvedValue('wrc-artifact-token'),
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', tokenFactory as never)

    const result = await handlers.getArtifact(
      'my-recipe',
      'custom-sdk-result.json',
      makeClaims({
        scopes: ['artifact_read'],
        artifactName: 'custom-risk-summary.md',
      })
    )

    expect(result.status).toBe(403)
    expect(tokenFactory.signWrcArtifactToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects artifact downloads when the delegated token has no artifact binding', async () => {
    const api = makeCustomApi()
    const tokenFactory = {
      signWrcArtifactToken: vi.fn().mockResolvedValue('wrc-artifact-token'),
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', tokenFactory as never)

    const result = await handlers.getArtifact(
      'my-recipe',
      'custom-sdk-result.json',
      makeClaims({
        scopes: ['artifact_read'],
      })
    )

    expect(result.status).toBe(403)
    expect(result.body).toEqual({ error: 'Missing artifactName binding' })
    expect(tokenFactory.signWrcArtifactToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─── postTrigger legacy direct path ────────────────────────────────────────

describe('postTrigger — legacy direct path', () => {
  const ORIGINAL_FLAG = process.env.WRC_ENABLE_LEGACY_DIRECT_TRIGGER

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.WRC_ENABLE_LEGACY_DIRECT_TRIGGER
    else process.env.WRC_ENABLE_LEGACY_DIRECT_TRIGGER = ORIGINAL_FLAG
  })

  it('is disabled by default so runtime triggers must use control-api broker', async () => {
    delete process.env.WRC_ENABLE_LEGACY_DIRECT_TRIGGER
    const api = makeCustomApi()
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.postTrigger(
      'my-recipe',
      'sandbox-recipes',
      makeClaims({ sub: 'cronjob', scopes: ['trigger_write'] })
    )

    expect(result.status).toBe(410)
    expect(result.body.error).toContain('control-api workflow broker')
  })

  it('returns precise 403 when a runtime token lacks trigger_write even if legacy trigger is disabled', async () => {
    delete process.env.WRC_ENABLE_LEGACY_DIRECT_TRIGGER
    const api = makeCustomApi()
    const handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes')

    const result = await handlers.postTrigger(
      'my-recipe',
      'sandbox-recipes',
      makeClaims({ sub: 'custom-coordinator', scopes: ['status_write', 'status_read'] })
    )

    expect(result.status).toBe(403)
    expect(result.body.error).toContain('trigger_write')
  })
})

// ─── deleteArtifact (bulk) ─────────────────────────────────────────────────

describe('deleteArtifact — bulk artifact cleanup', () => {
  let api: k8s.CustomObjectsApi
  let handlers: ReturnType<typeof createWorkflowEndpointHandlers>
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 's1' }] },
        status: {
          artifacts: [{ name: 'report.pdf', path: '/output/report.pdf', format: 'pdf' }],
        },
      }),
    })
    handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', {
      signWrcArtifactDeleteToken: vi.fn().mockResolvedValue('mock-delete-token'),
    } as never)
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 403 on recipeName mismatch', async () => {
    const result = await handlers.deleteArtifact(
      'other-recipe',
      makeClaims({
        sub: 'admin:admin-bob',
        iss: 'control-api',
        recipeName: 'my-recipe',
        scopes: ['admin:artifact_delete'],
      })
    )
    expect(result.status).toBe(403)
  })

  it('returns 403 when missing admin:artifact_delete scope', async () => {
    const result = await handlers.deleteArtifact(
      'my-recipe',
      makeClaims({
        sub: 'admin:admin-bob',
        iss: 'control-api',
        scopes: ['admin:artifact_read'],
      })
    )
    expect(result.status).toBe(403)
    expect(result.body.error).toMatch(/Missing scope/)
  })

  it('returns 403 when issuer is clerum-wrc with admin scope (wrong issuer)', async () => {
    const result = await handlers.deleteArtifact(
      'my-recipe',
      makeClaims({
        sub: 'admin:admin-bob',
        iss: 'clerum-wrc',
        scopes: ['admin:artifact_delete'],
      })
    )
    expect(result.status).toBe(403)
  })

  it('returns 204 on successful proxy', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as Response)

    const result = await handlers.deleteArtifact(
      'my-recipe',
      makeClaims({
        sub: 'admin:admin-alice',
        iss: 'control-api',
        scopes: ['admin:artifact_delete'],
      })
    )
    expect(result.status).toBe(204)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('wf-my-recipe-artifact-reader')
  })

  it('cleans every artifact backend before clearing status on mixed output and legacy artifacts', async () => {
    api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 'agent', instruction: 'write a report' }] },
        status: {
          artifacts: [
            {
              name: 'report.pdf',
              path: '/output/report.pdf',
              format: 'pdf',
              sizeBytes: 1,
              createdAt: 'now',
            },
            {
              name: 'legacy.txt',
              path: '/artifacts/legacy.txt',
              format: 'txt',
              sizeBytes: 1,
              createdAt: 'now',
            },
          ],
        },
      }),
    })
    handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', {
      signWrcArtifactDeleteToken: vi.fn().mockResolvedValue('mock-delete-token'),
    } as never)
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 204 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 204 } as Response)

    const result = await handlers.deleteArtifact(
      'my-recipe',
      makeClaims({
        sub: 'admin:admin-alice',
        iss: 'control-api',
        scopes: ['admin:artifact_delete'],
      })
    )

    expect(result.status).toBe(204)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toContain('wf-my-recipe-artifact-reader')
    expect(String(fetchMock.mock.calls[1][0])).toContain('wf-my-recipe-mcp-host')
    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({ body: { status: { artifacts: [] } } }),
      expect.anything()
    )
  })

  it('does not clear status.artifacts when one mixed backend cleanup fails', async () => {
    api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 'agent', instruction: 'write a report' }] },
        status: {
          artifacts: [
            {
              name: 'report.pdf',
              path: '/output/report.pdf',
              format: 'pdf',
              sizeBytes: 1,
              createdAt: 'now',
            },
            {
              name: 'legacy.txt',
              path: '/artifacts/legacy.txt',
              format: 'txt',
              sizeBytes: 1,
              createdAt: 'now',
            },
          ],
        },
      }),
    })
    handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', {
      signWrcArtifactDeleteToken: vi.fn().mockResolvedValue('mock-delete-token'),
    } as never)
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 204 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 502 } as Response)

    const result = await handlers.deleteArtifact(
      'my-recipe',
      makeClaims({
        sub: 'admin:admin-alice',
        iss: 'control-api',
        scopes: ['admin:artifact_delete'],
      })
    )

    expect(result.status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })
})

// ─── deleteArtifactFile (per-file) ──────────────────────────────────────────

describe('deleteArtifactFile — per-file artifact delete', () => {
  let api: k8s.CustomObjectsApi
  let handlers: ReturnType<typeof createWorkflowEndpointHandlers>
  let tokenFactory: { signWrcArtifactDeleteToken: ReturnType<typeof vi.fn> }
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'my-recipe', resourceVersion: '1' },
        spec: { steps: [{ id: 's1' }] },
        status: {
          artifacts: [{ name: 'report.pdf', path: '/output/report.pdf', format: 'pdf' }],
        },
      }),
    })
    tokenFactory = {
      signWrcArtifactDeleteToken: vi.fn().mockResolvedValue('mock-delete-token'),
    }
    handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', tokenFactory as never)
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 400 when filename contains path traversal (../)', async () => {
    const result = await handlers.deleteArtifactFile(
      'my-recipe',
      '../etc/passwd',
      makeClaims({
        sub: 'admin:admin-alice',
        iss: 'control-api',
        scopes: ['admin:artifact_delete'],
      })
    )
    expect(result.status).toBe(400)
    expect(result.body.error).toMatch(/Invalid filename/)
  })

  it('returns 204 on successful per-file delete', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as Response)

    const result = await handlers.deleteArtifactFile(
      'my-recipe',
      'report.pdf',
      makeClaims({
        sub: 'admin:admin-alice',
        iss: 'control-api',
        scopes: ['admin:artifact_delete'],
        artifactName: 'report.pdf',
      })
    )
    expect(result.status).toBe(204)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('wf-my-recipe-artifact-reader')
    expect(tokenFactory.signWrcArtifactDeleteToken).toHaveBeenCalledWith(
      'my-recipe',
      'sandbox-recipes',
      { artifactName: 'report.pdf' }
    )
  })

  it('returns 403 when the admin delete token has no artifactName binding', async () => {
    const result = await handlers.deleteArtifactFile(
      'my-recipe',
      'report.pdf',
      makeClaims({
        sub: 'admin:admin-alice',
        iss: 'control-api',
        scopes: ['admin:artifact_delete'],
      })
    )
    expect(result.status).toBe(403)
    expect(result.body).toEqual({ error: 'Missing artifactName binding' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(tokenFactory.signWrcArtifactDeleteToken).not.toHaveBeenCalled()
  })

  it('returns 403 when the admin delete token targets a different artifact', async () => {
    const result = await handlers.deleteArtifactFile(
      'my-recipe',
      'report.pdf',
      makeClaims({
        sub: 'admin:admin-alice',
        iss: 'control-api',
        scopes: ['admin:artifact_delete'],
        artifactName: 'other.pdf',
      })
    )
    expect(result.status).toBe(403)
    expect(result.body).toEqual({ error: 'artifactName mismatch' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(tokenFactory.signWrcArtifactDeleteToken).not.toHaveBeenCalled()
  })

  it('returns 403 when runId claim does not match the child recipe label', async () => {
    api = makeCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: childMetadata('run-1'),
        spec: { steps: [{ id: 's1' }] },
        status: {
          artifacts: [{ name: 'report.pdf', path: '/output/report.pdf', format: 'pdf' }],
        },
      }),
    })
    tokenFactory = {
      signWrcArtifactDeleteToken: vi.fn().mockResolvedValue('mock-delete-token'),
    }
    handlers = createWorkflowEndpointHandlers(api, 'sandbox-recipes', tokenFactory as never)

    const result = await handlers.deleteArtifactFile(
      'my-recipe',
      'report.pdf',
      makeClaims({
        sub: 'admin:admin-alice',
        iss: 'control-api',
        scopes: ['admin:artifact_delete'],
        runId: 'run-2',
        artifactName: 'report.pdf',
      })
    )

    expect(result.status).toBe(403)
    expect(result.body).toEqual({ error: 'Token runId mismatch' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(tokenFactory.signWrcArtifactDeleteToken).not.toHaveBeenCalled()
  })

  it('returns 403 on recipeName mismatch', async () => {
    const result = await handlers.deleteArtifactFile(
      'other-recipe',
      'report.pdf',
      makeClaims({
        sub: 'admin:admin-alice',
        iss: 'control-api',
        recipeName: 'my-recipe',
        scopes: ['admin:artifact_delete'],
      })
    )
    expect(result.status).toBe(403)
  })

  it('returns 403 when missing admin:artifact_delete scope', async () => {
    const result = await handlers.deleteArtifactFile(
      'my-recipe',
      'report.pdf',
      makeClaims({
        sub: 'admin:admin-alice',
        iss: 'control-api',
        scopes: ['artifact_read'],
      })
    )
    expect(result.status).toBe(403)
  })

  it('returns 403 when issuer is clerum-wrc (wrong issuer for admin scope)', async () => {
    const result = await handlers.deleteArtifactFile(
      'my-recipe',
      'report.pdf',
      makeClaims({
        sub: 'admin:admin-alice',
        iss: 'clerum-wrc',
        scopes: ['admin:artifact_delete'],
      })
    )
    expect(result.status).toBe(403)
  })
})
