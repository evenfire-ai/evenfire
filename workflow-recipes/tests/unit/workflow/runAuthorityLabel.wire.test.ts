/**
 * Wiring of the run authority label from its producer to its consumer: the
 * real DB-run child creator builds the child recipe from a run row, and that
 * exact object is served to the real status handlers backed by the real run
 * processor over a real `pg.Pool`. A child of a run without an authority
 * binding must be decided by recipe status without asking the pool for a
 * client; a child of a bound run must reach the run store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import net from 'node:net'
import { Pool, type PoolClient } from 'pg'
import { createDbRunProcessor } from '../../../src/reconciler/dbRunProcessor'
import { createDbRunChildRecipe } from '../../../src/workflow/dbRunChildRecipeCreator'
import { makeParent, makeRun } from '../../../src/workflow/dbRunChildRecipeCreator.testFixtures'
import {
  type AuthenticatedRequest,
  createWorkflowEndpointHandlers,
} from '../../../src/workflow/restEndpoints'

const CHILD_NAME = 'demo-parent-00000000'
const NAMESPACE = 'sandbox-recipes'

type Report = { stepId: string; phase: 'running' } | { workflowPhase: 'running' }
const REPORTS: Array<[string, Report]> = [
  ['step-level', { stepId: 'step-1', phase: 'running' }],
  ['workflow-level', { workflowPhase: 'running' }],
]

const pools: Pool[] = []

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.end()
  vi.restoreAllMocks()
})

/** A real pool pointed at a loopback port nobody listens on. */
async function poolOnClosedPort(): Promise<Pool> {
  const probe = net.createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('no loopback port')
  await new Promise<void>(resolve => probe.close(() => resolve()))
  const pool = new Pool({
    host: '127.0.0.1',
    port: address.port,
    user: 'x',
    database: 'x',
    connectionTimeoutMillis: 2_000,
  })
  pool.on('error', () => {})
  pools.push(pool)
  return pool
}

/** The child recipe the real creator sends to Kubernetes for this run row. */
async function producedChild(bound: boolean): Promise<Record<string, unknown>> {
  const customApi = {
    getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
    createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  }
  await createDbRunChildRecipe(
    customApi as unknown as k8s.CustomObjectsApi,
    makeRun(
      bound
        ? {
            authority_binding: { operationId: 'workflow.trigger' } as never,
            authority_binding_id: 'binding-1',
          }
        : {}
    )
  )
  expect(customApi.createNamespacedCustomObject).toHaveBeenCalledOnce()
  const created = structuredClone(
    (customApi.createNamespacedCustomObject.mock.calls[0]?.[0] as { body: Record<string, unknown> })
      .body
  )
  // What the API server returns: the created object plus a status.
  return {
    ...created,
    status: {
      phase: 'active',
      steps: [],
      workflowExecution: { phase: 'running', attempt: 1, startedAt: '2026-01-01T00:00:00Z' },
    },
  }
}

function claims(): AuthenticatedRequest['tokenClaims'] {
  return {
    sub: 'coordinator',
    aud: 'clerum-wrc',
    iss: 'clerum-wrc',
    recipeName: CHILD_NAME,
    recipeNamespace: NAMESPACE,
    scopes: ['status_write', 'status_read'],
  }
}

async function report(child: Record<string, unknown>, pool: Pool, body: Report) {
  const api = {
    getNamespacedCustomObject: vi.fn(async () => structuredClone(child)),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  }
  const processor = createDbRunProcessor({
    instanceId: 'wire-label',
    pool,
    runPollMs: 60_000,
    maxRunDurationCapSeconds: 86_400,
    deliverCancelSignal: () => {
      throw new Error('no cancel is delivered by this test')
    },
    checkpointAuthority: vi.fn(),
    createChildRecipe: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withStep: vi.fn() },
  })
  const handlers = createWorkflowEndpointHandlers(
    api as unknown as k8s.CustomObjectsApi,
    NAMESPACE,
    undefined,
    { dbRunProcessor: processor }
  )
  const outcome = await handlers.postStepStatus(CHILD_NAME, claims(), body as never).then(
    result => ({ result, error: undefined as unknown }),
    (error: unknown) => ({ result: undefined, error })
  )
  return { ...outcome, api }
}

function undefinedTableClient(): PoolClient {
  return {
    query: vi.fn(async () => {
      throw Object.assign(new Error('relation "workflow_authority_bindings" does not exist'), {
        code: '42P01',
      })
    }),
    release: vi.fn(),
  } as unknown as PoolClient
}

describe('run authority label from the child creator to the running boundary', () => {
  describe.each(REPORTS)('%s running report', (_level, body) => {
    it('decides a V1 child by recipe status while the run store refuses connections', async () => {
      const pool = await poolOnClosedPort()
      const connect = vi.spyOn(pool, 'connect')
      const child = await producedChild(false)

      const { result, error, api } = await report(child, pool, body)

      expect(error).toBeUndefined()
      expect(result).toEqual({ status: 200, body: { accepted: true } })
      // Liveness witness: the report reached the recipe-status patch.
      expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledOnce()
      expect(connect).not.toHaveBeenCalled()
    })

    it('answers 503 for a bound child while the run store refuses connections', async () => {
      const pool = await poolOnClosedPort()
      const connect = vi.spyOn(pool, 'connect')
      const child = await producedChild(true)

      const { result, error, api } = await report(child, pool, body)

      expect(error).toBeUndefined()
      expect(result).toEqual({ status: 503, body: { code: 'workflow_run_state_unavailable' } })
      expect(connect).toHaveBeenCalledOnce()
      expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    })

    it('decides a V1 child by recipe status when the run read fails with 42P01', async () => {
      const pool = await poolOnClosedPort()
      const connect = vi.spyOn(pool, 'connect').mockResolvedValue(undefinedTableClient() as never)
      const child = await producedChild(false)

      const { result, error, api } = await report(child, pool, body)

      expect(error).toBeUndefined()
      expect(result).toEqual({ status: 200, body: { accepted: true } })
      expect(api.patchNamespacedCustomObjectStatus).toHaveBeenCalledOnce()
      expect(connect).not.toHaveBeenCalled()
    })

    it('throws for a bound child when the run read fails with 42P01', async () => {
      const pool = await poolOnClosedPort()
      const connect = vi.spyOn(pool, 'connect').mockResolvedValue(undefinedTableClient() as never)
      const child = await producedChild(true)

      const { result, error, api } = await report(child, pool, body)

      expect(result).toBeUndefined()
      expect((error as { code?: unknown }).code).toBe('42P01')
      expect(connect).toHaveBeenCalledOnce()
      expect(api.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    })
  })
})
