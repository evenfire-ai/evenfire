/**
 * Durable running boundary and status GET of restEndpoints.ts (C13 spec v2):
 * pause projection publish (catch A, Q4 terminal skip), its re-publish on the
 * status GET (D1), the durable read failure log (catch B), the run-store 503,
 * the outcome switch, and the pause clear on an allowed step report (§10).
 *
 * restEndpoints.ts creates its logger at module load and the logger is silent
 * under NODE_ENV=test, so the logger module is mocked with shared spies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import net from 'node:net'
import { Pool } from 'pg'
import type { DbRunProcessor } from '../../../src/reconciler/dbRunProcessor'
import {
  type AuthenticatedRequest,
  createWorkflowEndpointHandlers,
} from '../../../src/workflow/restEndpoints'

const { logSpies } = vi.hoisted(() => ({
  logSpies: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../../src/observability/logger', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/observability/logger')>()
  const logger = { ...logSpies, withStep: () => logger }
  return { ...actual, createLogger: () => logger }
})

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const CLAIMS_RUN_ID = '22222222-2222-4222-8222-222222222222'
const STARTED_AT = '2026-01-01T00:00:00Z'
const PAUSE_PUBLISH_FAILED =
  'Failed to publish durable workflow authorization pause to recipe status'
const TERMINAL_SKIP = 'Recipe status already terminal; durable authorization pause not published'
const CATCH_B = 'Failed to read durable workflow phase; using recipe status projection'
const STEP_PATCH_RETRY = 'Retrying workflow step status patch after concurrent status update'

type JsonPatchOperation = { op: string; path: string; value?: unknown }
type FakeApi = {
  getNamespacedCustomObject: ReturnType<typeof vi.fn>
  patchNamespacedCustomObjectStatus: ReturnType<typeof vi.fn>
}
type FakeProcessor = {
  checkpointRunningBoundary: ReturnType<typeof vi.fn>
  getRunStatus: ReturnType<typeof vi.fn>
}

function claims(
  overrides: Partial<AuthenticatedRequest['tokenClaims']> = {}
): AuthenticatedRequest['tokenClaims'] {
  return {
    sub: 'coordinator',
    aud: 'clerum-wrc',
    iss: 'clerum-wrc',
    recipeName: 'my-recipe',
    recipeNamespace: 'sandbox-recipes',
    scopes: ['status_write', 'status_read'],
    ...overrides,
  }
}

function execution(phase: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { phase, attempt: 1, startedAt: STARTED_AT, ...extra }
}

function childRecipe(
  workflowExecution: Record<string, unknown> | undefined,
  options: { label?: boolean; specSteps?: string[]; statusSteps?: unknown[] } = {}
): Record<string, unknown> {
  return {
    metadata: {
      name: 'my-recipe',
      resourceVersion: '7',
      ...(options.label === false ? {} : { labels: { 'clerum.io/workflow-run-id': RUN_ID } }),
    },
    spec: { steps: (options.specSteps ?? ['s1', 's2']).map(id => ({ id })) },
    status: {
      phase: 'active',
      steps: options.statusSteps ?? [{ id: 's1', phase: 'completed' }],
      ...(workflowExecution ? { workflowExecution } : {}),
    },
  }
}

function makeApi(...recipes: Array<Record<string, unknown>>): FakeApi {
  const read = vi.fn()
  for (const recipe of recipes) read.mockResolvedValueOnce(structuredClone(recipe))
  read.mockImplementation(async () => structuredClone(recipes[recipes.length - 1]))
  return {
    getNamespacedCustomObject: read,
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  }
}

function makeProcessor(): FakeProcessor {
  return { checkpointRunningBoundary: vi.fn(), getRunStatus: vi.fn() }
}

function handlersFor(api: FakeApi, processor: FakeProcessor | null) {
  return createWorkflowEndpointHandlers(
    api as unknown as k8s.CustomObjectsApi,
    'sandbox-recipes',
    undefined,
    processor ? { dbRunProcessor: processor as unknown as DbRunProcessor } : {}
  )
}

function patchCall(api: FakeApi, index = 0): { body: unknown; contentType: string | undefined } {
  const [request, options] = api.patchNamespacedCustomObjectStatus.mock.calls[index] as [
    { body: unknown },
    { middleware?: Array<{ pre: (request: unknown) => unknown }> },
  ]
  let contentType: string | undefined
  for (const middleware of options?.middleware ?? []) {
    middleware.pre({
      setHeaderParam: (key: string, value: string) => {
        if (key === 'Content-Type') contentType = value
      },
    })
  }
  return { body: request.body, contentType }
}

function logCalls(level: keyof typeof logSpies, message: string): unknown[][] {
  return logSpies[level].mock.calls.filter(call => call[0] === message)
}

/** The error the real `pg` driver raises for a closed loopback port. */
async function captureConnectionRefused(): Promise<Error> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no loopback port')
  await new Promise<void>(resolve => server.close(() => resolve()))
  const pool = new Pool({ host: '127.0.0.1', port: address.port, user: 'x', database: 'x' })
  pool.on('error', () => {})
  try {
    const failure = await pool.connect().then(
      client => {
        client.release()
        return null
      },
      (error: unknown) => error
    )
    if (!(failure instanceof Error) || (failure as { code?: unknown }).code !== 'ECONNREFUSED') {
      throw new Error(`expected ECONNREFUSED from a closed port, got ${String(failure)}`)
    }
    return failure
  } finally {
    await pool.end()
  }
}

beforeEach(() => {
  for (const spy of Object.values(logSpies)) spy.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── Catch A: the boundary publishes the pause projection ──────────────────

describe('running boundary: pause projection publish', () => {
  it('T-A1: keeps the 423 and logs at error when the projection patch fails', async () => {
    const api = makeApi(childRecipe(execution('running')))
    api.patchNamespacedCustomObjectStatus.mockRejectedValue(
      Object.assign(new Error('apiserver unavailable'), { statusCode: 500 })
    )
    const processor = makeProcessor()
    processor.checkpointRunningBoundary.mockResolvedValue({
      outcome: 'paused',
      failureReason: 'workflow_authority_access_path_stale',
    })

    const result = await handlersFor(api, processor).postStepStatus('my-recipe', claims(), {
      stepId: 's2',
      phase: 'running',
    })

    // Witness: the merge patch was sent once with the pause projection.
    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledOnce()
    expect(patchCall(api)).toEqual({
      body: {
        status: {
          phase: 'active',
          workflowExecution: execution('authorization_paused', {
            message: 'workflow_authority_access_path_stale',
          }),
        },
      },
      contentType: 'application/merge-patch+json',
    })
    expect(result).toEqual({ status: 423, body: { code: 'workflow_authorization_paused' } })
    expect(logCalls('error', PAUSE_PUBLISH_FAILED)).toEqual([
      [
        PAUSE_PUBLISH_FAILED,
        { recipeName: 'my-recipe', runId: RUN_ID, statusCode: 500, error: 'apiserver unavailable' },
      ],
    ])
    expect(logCalls('warn', PAUSE_PUBLISH_FAILED)).toEqual([])
  })

  it('T-A2: answers 423 only after the patch settles, with the boundary reason and no second read', async () => {
    const api = makeApi(childRecipe(execution('running')))
    let resolvePatch: (() => void) | undefined
    api.patchNamespacedCustomObjectStatus.mockImplementation(
      () =>
        new Promise(resolve => {
          resolvePatch = () => resolve({})
        })
    )
    const processor = makeProcessor()
    processor.checkpointRunningBoundary.mockResolvedValue({
      outcome: 'paused',
      failureReason: 'workflow_authority_access_path_stale',
    })
    // A second read would see a different reason.
    processor.getRunStatus.mockResolvedValue({
      phase: 'AuthorizationPaused',
      failureReason: 'workflow_authority_denied',
      hasAuthority: true,
    })

    let settled = false
    const pending = handlersFor(api, processor)
      .postStepStatus('my-recipe', claims(), { stepId: 's2', phase: 'running' })
      .finally(() => {
        settled = true
      })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    if (!resolvePatch) throw new Error('the projection patch was not sent')
    resolvePatch()
    await expect(pending).resolves.toEqual({
      status: 423,
      body: { code: 'workflow_authorization_paused' },
    })

    expect(processor.checkpointRunningBoundary).toHaveBeenCalledOnce()
    expect(processor.checkpointRunningBoundary).toHaveBeenCalledWith(RUN_ID)
    const body = patchCall(api).body as {
      status: { workflowExecution: { message: string } }
    }
    expect(body.status.workflowExecution.message).toBe('workflow_authority_access_path_stale')
    expect(processor.getRunStatus).not.toHaveBeenCalled()
  })

  it('uses the phase message when the paused row carries no reason', async () => {
    const api = makeApi(childRecipe(execution('running')))
    const processor = makeProcessor()
    processor.checkpointRunningBoundary.mockResolvedValue({
      outcome: 'paused',
      failureReason: null,
    })

    const result = await handlersFor(api, processor).postStepStatus('my-recipe', claims(), {
      stepId: 's2',
      phase: 'running',
    })

    expect(result.status).toBe(423)
    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledOnce()
    const body = patchCall(api).body as {
      status: { workflowExecution: { message: string } }
    }
    expect(body.status.workflowExecution.message).toBe(
      'Workflow paused until initiating authority is restored'
    )
  })

  describe.each(['failed', 'completed', 'cancelled'])('T-A3: recipe phase %s', terminalPhase => {
    it.each([
      ['workflow-level', { workflowPhase: 'running' }],
      ['step-level', { stepId: 's2', phase: 'running' }],
    ] as const)(
      'skips the projection on a %s running report and keeps the 423',
      async (_l, body) => {
        const api = makeApi(childRecipe(execution(terminalPhase)))
        const processor = makeProcessor()
        processor.checkpointRunningBoundary.mockResolvedValue({
          outcome: 'paused',
          failureReason: 'workflow_authority_denied',
        })

        const result = await handlersFor(api, processor).postStepStatus(
          'my-recipe',
          claims(),
          body as never
        )

        expect(processor.checkpointRunningBoundary).toHaveBeenCalledOnce()
        expect(result).toEqual({ status: 423, body: { code: 'workflow_authorization_paused' } })
        expect(logCalls('info', TERMINAL_SKIP)).toEqual([
          [TERMINAL_SKIP, { recipeName: 'my-recipe', runId: RUN_ID, workflowPhase: terminalPhase }],
        ])
        expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
      }
    )
  })
})

// ─── D1: the status GET re-publishes a missing pause projection ────────────

describe('status GET: pause projection re-publish (D1)', () => {
  function pausedRow(extra: Record<string, unknown> = {}) {
    return {
      phase: 'AuthorizationPaused',
      failureReason: 'workflow_authority_denied',
      hasAuthority: true,
      ...extra,
    }
  }

  it('T-D1a: patches the projection with a test-guarded JSON patch when the recipe says running', async () => {
    const api = makeApi(childRecipe(execution('running')))
    const processor = makeProcessor()
    processor.getRunStatus.mockResolvedValue(pausedRow())

    const result = await handlersFor(api, processor).getWorkflowStatus('my-recipe', claims())

    expect(processor.getRunStatus).toHaveBeenCalledOnce()
    expect(processor.getRunStatus).toHaveBeenCalledWith(RUN_ID, 'sandbox-recipes', 'my-recipe')
    expect(api.getNamespacedCustomObject).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 200, body: { workflowPhase: 'authorization_paused' } })
    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledOnce()
    expect(patchCall(api)).toEqual({
      body: [
        { op: 'test', path: '/status/workflowExecution', value: execution('running') },
        { op: 'replace', path: '/status/phase', value: 'active' },
        {
          op: 'replace',
          path: '/status/workflowExecution',
          value: execution('authorization_paused', { message: 'workflow_authority_denied' }),
        },
      ],
      contentType: 'application/json-patch+json',
    })
  })

  it('T-D1b: sends no patch when the recipe already says authorization_paused', async () => {
    const api = makeApi(childRecipe(execution('authorization_paused')))
    const processor = makeProcessor()
    processor.getRunStatus.mockResolvedValue(pausedRow())

    const result = await handlersFor(api, processor).getWorkflowStatus('my-recipe', claims())

    expect(processor.getRunStatus).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 200, body: { workflowPhase: 'authorization_paused' } })
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it.each(['failed', 'cancelled', 'completed'])(
    'T-D1c: never overwrites the terminal recipe phase %s',
    async terminalPhase => {
      const api = makeApi(childRecipe(execution(terminalPhase)))
      const processor = makeProcessor()
      processor.getRunStatus.mockResolvedValue(pausedRow())

      const result = await handlersFor(api, processor).getWorkflowStatus('my-recipe', claims())

      expect(processor.getRunStatus).toHaveBeenCalledOnce()
      expect(result).toMatchObject({ status: 200, body: { workflowPhase: 'authorization_paused' } })
      expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    }
  )

  it('T-D1i: never overwrites a recovering recipe phase', async () => {
    const api = makeApi(childRecipe(execution('recovering')))
    const processor = makeProcessor()
    processor.getRunStatus.mockResolvedValue(pausedRow())

    const result = await handlersFor(api, processor).getWorkflowStatus('my-recipe', claims())

    expect(processor.getRunStatus).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 200, body: { workflowPhase: 'authorization_paused' } })
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('T-D1j: repairs a recipe still initializing (first workflow-level pause)', async () => {
    const api = makeApi(childRecipe(execution('initializing')))
    const processor = makeProcessor()
    processor.getRunStatus.mockResolvedValue(pausedRow())

    await handlersFor(api, processor).getWorkflowStatus('my-recipe', claims())

    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledOnce()
    const ops = patchCall(api).body as JsonPatchOperation[]
    expect(ops[0]).toEqual({
      op: 'test',
      path: '/status/workflowExecution',
      value: execution('initializing'),
    })
  })

  it('T-D1d: sends no patch when the run is Running in the DB', async () => {
    const api = makeApi(childRecipe(execution('running')))
    const processor = makeProcessor()
    processor.getRunStatus.mockResolvedValue({
      phase: 'Running',
      failureReason: null,
      hasAuthority: true,
    })

    const result = await handlersFor(api, processor).getWorkflowStatus('my-recipe', claims())

    expect(processor.getRunStatus).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 200, body: { workflowPhase: 'running' } })
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('T-D1e: sends no patch for a run without durable authority', async () => {
    const api = makeApi(childRecipe(execution('running')))
    const processor = makeProcessor()
    processor.getRunStatus.mockResolvedValue(pausedRow({ hasAuthority: false }))

    const result = await handlersFor(api, processor).getWorkflowStatus('my-recipe', claims())

    expect(processor.getRunStatus).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 200, body: { workflowPhase: 'running' } })
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('T-D1f: serves the overlay but writes nothing when the run id comes from the claims only', async () => {
    const api = makeApi(childRecipe(execution('running'), { label: false }))
    const processor = makeProcessor()
    processor.getRunStatus.mockResolvedValue(pausedRow())

    const result = await handlersFor(api, processor).getWorkflowStatus(
      'my-recipe',
      claims({ runId: CLAIMS_RUN_ID })
    )

    expect(processor.getRunStatus).toHaveBeenCalledWith(
      CLAIMS_RUN_ID,
      'sandbox-recipes',
      'my-recipe'
    )
    expect(result).toMatchObject({ status: 200, body: { workflowPhase: 'authorization_paused' } })
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('T-D1g: writes nothing for a caller without status_write', async () => {
    const api = makeApi(childRecipe(execution('running')))
    const processor = makeProcessor()
    processor.getRunStatus.mockResolvedValue(pausedRow())

    const result = await handlersFor(api, processor).getWorkflowStatus(
      'my-recipe',
      claims({ scopes: ['status_read'] })
    )

    expect(processor.getRunStatus).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 200, body: { workflowPhase: 'authorization_paused' } })
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('T-D1h: keeps the 200 body and logs at error when the re-publish patch fails', async () => {
    const api = makeApi(childRecipe(execution('running')))
    api.patchNamespacedCustomObjectStatus.mockRejectedValue(
      Object.assign(new Error('the server rejected our request'), { statusCode: 422 })
    )
    const processor = makeProcessor()
    processor.getRunStatus.mockResolvedValue(pausedRow())

    const result = await handlersFor(api, processor).getWorkflowStatus('my-recipe', claims())

    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledOnce()
    expect(result).toEqual({
      status: 200,
      body: {
        workflowPhase: 'authorization_paused',
        steps: expect.any(Array),
        attempt: 1,
        startedAt: STARTED_AT,
      },
    })
    expect(logCalls('error', PAUSE_PUBLISH_FAILED)).toEqual([
      [
        PAUSE_PUBLISH_FAILED,
        {
          recipeName: 'my-recipe',
          runId: RUN_ID,
          statusCode: 422,
          error: 'the server rejected our request',
        },
      ],
    ])
    expect(logCalls('error', CATCH_B)).toEqual([])
    expect(logCalls('warn', CATCH_B)).toEqual([])
  })
})

// ─── Catch B: the durable read of the status GET fails ─────────────────────

describe('status GET: durable read failure (catch B)', () => {
  it('T-B1: answers the recipe phase and logs structural fields only for a refused connection', async () => {
    const refused = await captureConnectionRefused()
    const api = makeApi(childRecipe(execution('running')))
    const processor = makeProcessor()
    processor.getRunStatus.mockRejectedValue(refused)

    const result = await handlersFor(api, processor).getWorkflowStatus('my-recipe', claims())

    expect(processor.getRunStatus).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 200, body: { workflowPhase: 'running' } })
    const logged = logCalls('error', CATCH_B)
    expect(logged).toEqual([
      [
        CATCH_B,
        {
          recipeName: 'my-recipe',
          runId: RUN_ID,
          name: 'Error',
          code: 'ECONNREFUSED',
          kind: 'network',
        },
      ],
    ])
    const address = refused as Error & { address?: string; port?: number }
    const fields = JSON.stringify(logged[0][1])
    expect(fields).not.toContain(String(address.address))
    expect(fields).not.toContain(String(address.port))
    expect(fields).not.toContain(refused.message)
    expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('T-B2: logs the error name and kind other for a TypeError', async () => {
    const api = makeApi(childRecipe(execution('running')))
    const processor = makeProcessor()
    processor.getRunStatus.mockRejectedValue(new TypeError('cannot read properties of undefined'))

    const result = await handlersFor(api, processor).getWorkflowStatus('my-recipe', claims())

    expect(processor.getRunStatus).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 200, body: { workflowPhase: 'running' } })
    expect(logCalls('error', CATCH_B)).toEqual([
      [
        CATCH_B,
        {
          recipeName: 'my-recipe',
          runId: RUN_ID,
          name: 'TypeError',
          code: undefined,
          kind: 'other',
        },
      ],
    ])
  })
})

// ─── Item 4 and H2: the outcome switch ─────────────────────────────────────

describe('running boundary: outcome switch', () => {
  it.each([
    ['workflow-level', { workflowPhase: 'running' }],
    ['step-level', { stepId: 's2', phase: 'running' }],
  ] as const)(
    'T-4d: answers 503 workflow_run_state_unavailable on a %s report',
    async (_l, body) => {
      const api = makeApi(childRecipe(execution('running')))
      const processor = makeProcessor()
      processor.checkpointRunningBoundary.mockResolvedValue({ outcome: 'run_state_unavailable' })

      const result = await handlersFor(api, processor).postStepStatus(
        'my-recipe',
        claims(),
        body as never
      )

      expect(processor.checkpointRunningBoundary).toHaveBeenCalledWith(RUN_ID)
      expect(result).toEqual({ status: 503, body: { code: 'workflow_run_state_unavailable' } })
      expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['workflow-level', { workflowPhase: 'running' }],
    ['step-level', { stepId: 's2', phase: 'running' }],
  ] as const)(
    'T-3b: rejects a %s report when the processor answers an unknown shape',
    async (_l, body) => {
      const api = makeApi(childRecipe(execution('running')))
      const processor = makeProcessor()
      // The pre-C13 string shape: no `outcome` field.
      processor.checkpointRunningBoundary.mockResolvedValue('allowed')

      const failure = await handlersFor(api, processor)
        .postStepStatus('my-recipe', claims(), body as never)
        .then(
          () => null,
          (error: unknown) => error
        )

      expect(processor.checkpointRunningBoundary).toHaveBeenCalledOnce()
      expect(processor.checkpointRunningBoundary).toHaveBeenCalledWith(RUN_ID)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toMatch(/^Unexpected running boundary outcome/)
      expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    }
  )
})

// ─── §10: an allowed step report clears the pause projection ───────────────

describe('step running report: pause projection clear (§10)', () => {
  const pausedExecution = () =>
    execution('authorization_paused', { message: 'workflow_authority_denied' })
  const stepOp = { op: 'add', path: '/status/steps/-', value: { id: 's2', phase: 'running' } }

  function allowedProcessor(): FakeProcessor {
    const processor = makeProcessor()
    processor.checkpointRunningBoundary.mockResolvedValue({ outcome: 'allowed' })
    return processor
  }

  it('T-Q2a: appends the test-guarded clear ops to the step patch', async () => {
    const api = makeApi(childRecipe(pausedExecution()))
    const processor = allowedProcessor()

    const result = await handlersFor(api, processor).postStepStatus('my-recipe', claims(), {
      stepId: 's2',
      phase: 'running',
    })

    expect(processor.checkpointRunningBoundary).toHaveBeenCalledOnce()
    expect(processor.checkpointRunningBoundary).toHaveBeenCalledWith(RUN_ID)
    expect(result).toEqual({ status: 200, body: { accepted: true } })
    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledOnce()
    expect(patchCall(api)).toEqual({
      body: [
        stepOp,
        { op: 'test', path: '/status/workflowExecution', value: pausedExecution() },
        { op: 'replace', path: '/status/phase', value: 'active' },
        {
          op: 'replace',
          path: '/status/workflowExecution',
          value: execution('running', { message: 'Workflow running' }),
        },
      ],
      contentType: 'application/json-patch+json',
    })
  })

  it('T-Q2b: sends only the step op when the recipe already says running', async () => {
    const api = makeApi(childRecipe(execution('running')))
    const processor = allowedProcessor()

    await handlersFor(api, processor).postStepStatus('my-recipe', claims(), {
      stepId: 's2',
      phase: 'running',
    })

    expect(processor.checkpointRunningBoundary).toHaveBeenCalledOnce()
    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledOnce()
    expect(patchCall(api).body).toEqual([stepOp])
  })

  it('T-Q2c: never clears the pause without a durable boundary', async () => {
    const api = makeApi(childRecipe(pausedExecution()))

    await handlersFor(api, null).postStepStatus('my-recipe', claims(), {
      stepId: 's2',
      phase: 'running',
    })

    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledOnce()
    expect(patchCall(api).body).toEqual([stepOp])
  })

  it('T-Q2d: re-evaluates the clear on the fresh read after a conflict', async () => {
    const api = makeApi(childRecipe(pausedExecution()), childRecipe(execution('running')))
    api.patchNamespacedCustomObjectStatus
      .mockRejectedValueOnce({
        statusCode: 422,
        body: { message: 'the server rejected our request' },
      })
      .mockResolvedValueOnce({})
    const processor = allowedProcessor()

    const result = await handlersFor(api, processor).postStepStatus('my-recipe', claims(), {
      stepId: 's2',
      phase: 'running',
    })

    expect(result).toEqual({ status: 200, body: { accepted: true } })
    expect(api.getNamespacedCustomObject).toHaveBeenCalledTimes(2)
    expect(processor.checkpointRunningBoundary).toHaveBeenCalledTimes(2)
    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
    const firstOps = patchCall(api, 0).body as JsonPatchOperation[]
    expect(firstOps.filter(op => op.path === '/status/workflowExecution').map(op => op.op)).toEqual(
      ['test', 'replace']
    )
    expect(firstOps.some(op => op.path === '/status/phase')).toBe(true)
    expect(patchCall(api, 1).body).toEqual([stepOp])
    expect(logCalls('warn', STEP_PATCH_RETRY)).toHaveLength(1)
  })

  it('T-Q2e: leaves the auto-transition as the only workflowExecution op', async () => {
    const api = makeApi(
      childRecipe(pausedExecution(), {
        specSteps: ['s1', 's2', 's3'],
        statusSteps: [{ id: 's1', phase: 'failed' }],
      })
    )
    const processor = allowedProcessor()

    await handlersFor(api, processor).postStepStatus('my-recipe', claims(), {
      stepId: 's2',
      phase: 'running',
    })

    expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledOnce()
    const ops = patchCall(api).body as JsonPatchOperation[]
    const executionOps = ops.filter(op => op.path === '/status/workflowExecution')
    expect(executionOps).toHaveLength(1)
    expect(executionOps[0]).toMatchObject({ op: 'replace', value: { phase: 'failed' } })
  })
})
