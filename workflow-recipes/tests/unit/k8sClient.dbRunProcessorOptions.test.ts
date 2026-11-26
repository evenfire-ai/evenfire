import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import type { Pool, PoolClient } from 'pg'
import { loadConfig } from '../../src/config'
import { buildDbRunProcessorOptions } from '../../src/k8sClient'
import { createDbRunProcessor } from '../../src/reconciler/dbRunProcessor'
import { createWorkflowEndpointHandlers } from '../../src/workflow/restEndpoints'
import { drainSignals } from '../../src/workflow/signalStore'
import type { AuthenticatedRequest } from '../../src/workflow/workflowAuth'

// The production composition of the run processor: the options the watcher
// builds (k8sClient.ts) with a fake pool, a real signal store and the real
// REST signal endpoint.

const RECIPE_NAME = 'echo'
const CHILD_RECIPE_NAME = 'echo-0a1b2c3d'
const RUN_ID = '0a1b2c3d-1111-4222-8333-444455556666'
const SANDBOX_NAMESPACE = 'sandbox-recipes'

function claimsFor(recipeName: string): AuthenticatedRequest['tokenClaims'] {
  return {
    sub: 'coordinator',
    aud: 'clerum-wrc',
    recipeName,
    recipeNamespace: SANDBOX_NAMESPACE,
    scopes: ['signal_read'],
  }
}

interface RecordedQuery {
  text: string
  values: unknown[] | undefined
}

function fakePool(rowsFor: (text: string) => Record<string, unknown>[]) {
  const queries: RecordedQuery[] = []
  const query = async (text: string, values?: unknown[]) => {
    queries.push({ text, values })
    const rows = rowsFor(text)
    return { rows, rowCount: rows.length }
  }
  const client = { query, release: () => undefined } as unknown as PoolClient
  const pool = { query, connect: async () => client } as unknown as Pool
  return { pool, queries }
}

function hooks() {
  return {
    createChildRecipe: async () => {
      throw new Error('no child is created by this test')
    },
  }
}

describe('production run processor options', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    drainSignals(CHILD_RECIPE_NAME)
    drainSignals(RECIPE_NAME)
  })

  it('the processor is built with cancel delivery under the child name and with the configured cap', async () => {
    vi.stubEnv('WRC_INSTANCE_ID', 'wrc-options-test')
    vi.stubEnv('WRC_WORKFLOW_MAX_RUN_DURATION_SECONDS', '600')
    const config = loadConfig()
    if (!config.db) throw new Error('loadConfig must return the database config')
    const { pool, queries } = fakePool(text =>
      text.includes('cancel_requested_at IS NOT NULL')
        ? [
            {
              run_id: RUN_ID,
              child_recipe_name: CHILD_RECIPE_NAME,
              cancel_requested_key: '2026-11-26 10:00:00.123456+00',
            },
          ]
        : []
    )
    const processor = createDbRunProcessor(
      buildDbRunProcessorOptions(
        { db: config.db, workflowMaxRunDurationSeconds: config.workflowMaxRunDurationSeconds },
        pool,
        hooks()
      )
    )
    const handlers = createWorkflowEndpointHandlers({} as k8s.CustomObjectsApi, SANDBOX_NAMESPACE)

    // The outcome is kept and asserted after the signal, so a processor built
    // without the option fails on the missing signal.
    const delivery = await processor.deliverCancelRequests().then(
      () => null,
      (error: unknown) => error
    )

    const childSignals = await handlers.getSignals(CHILD_RECIPE_NAME, claimsFor(CHILD_RECIPE_NAME))
    expect(childSignals.status).toBe(200)
    expect(childSignals.body.signals).toEqual([
      { type: 'cancel', requestId: `cancel:${RUN_ID}`, receivedAt: expect.any(String) },
    ])
    expect(delivery).toBeNull()
    const recipeSignals = await handlers.getSignals(RECIPE_NAME, claimsFor(RECIPE_NAME))
    expect(recipeSignals).toEqual({ status: 200, body: { signals: [] } })

    // The lowered cap reaches the stuck sweep's bound parameter.
    await expect(processor.checkStuckRuns()).resolves.toBe(0)
    const sweep = queries.find(query => query.text.includes('make_interval(secs => LEAST'))
    expect(sweep?.values).toEqual(['wrc-options-test', 600])
  })
})
