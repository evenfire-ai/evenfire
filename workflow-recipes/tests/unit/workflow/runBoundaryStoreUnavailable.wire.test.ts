/**
 * Wire test for the run-store wait (C13 spec §4.5 T-4j): the real
 * StatusReporter talks HTTP to a loopback server that forwards to the real
 * WRC status handlers, which use the real DB run processor. Faked: the
 * processor's `connect` (the Postgres checkout) and its `pool.query` (the
 * status read), its logger, the Kubernetes custom objects API, the signal
 * poller and the snippet runner. For a bound run (authority binding on the row,
 * run authority label on the child), the step `running` report meets an
 * unreachable run store on all three client attempts, gets 503
 * `workflow_run_state_unavailable` three times, waits once, and then succeeds;
 * the step runs once, after that. A V1 run never asks the run store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { Pool, type PoolClient } from 'pg'
import {
  type SignalPoller,
  StatusReporter,
  StepCoordinator,
  createStaticRuntimeTokenProvider,
} from '@clerum/workflow-runtime-core'
import { RUN_AUTHORITY_BOUND, RUN_AUTHORITY_LABEL } from '../../../src/reconciler/crdConstants'
import { type DbRunRow, createDbRunProcessor } from '../../../src/reconciler/dbRunProcessor'
import {
  type AuthenticatedRequest,
  createWorkflowEndpointHandlers,
} from '../../../src/workflow/restEndpoints'
import { runWorkflowRuntime } from '../../../src/workflow/sdkRuntime'

const RUN_ID = '33333333-3333-4333-8333-333333333333'
const RECIPE = 'wire-recipe'
const NAMESPACE = 'sandbox-recipes'
const WAIT_LINE = 'Workflow run state unavailable at a running boundary; waiting before retry'

type Recipe = {
  metadata: Record<string, unknown>
  spec: Record<string, unknown>
  status: Record<string, unknown>
}

/** The error the real `pg` driver raises for a closed loopback port. */
async function captureConnectionRefused(): Promise<Error> {
  const probe = net.createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('no loopback port')
  await new Promise<void>(resolve => probe.close(() => resolve()))
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

function mergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    // The code under test never sends these keys; fail instead of writing
    // through an object prototype.
    if (key === '__proto__' || key === 'constructor') {
      throw new Error(`unexpected merge-patch key ${key}`)
    }
    const current = target[key]
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      mergePatch(current as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      target[key] = value
    }
  }
}

function jsonPatch(
  target: Record<string, unknown>,
  ops: Array<{ op: string; path: string; value?: unknown }>
): void {
  for (const op of ops) {
    const parts = op.path.split('/').slice(1)
    const last = parts.pop()
    if (last === undefined) throw new Error(`unsupported patch path ${op.path}`)
    let parent: Record<string, unknown> | unknown[] = target
    for (const part of parts) {
      parent = (parent as Record<string, unknown>)[part] as Record<string, unknown>
    }
    if (op.op === 'test') {
      const current = (parent as Record<string, unknown>)[last]
      if (JSON.stringify(current) !== JSON.stringify(op.value)) {
        throw Object.assign(new Error('the server rejected our request'), { statusCode: 422 })
      }
      continue
    }
    if (Array.isArray(parent) && last === '-') parent.push(op.value)
    else (parent as Record<string, unknown>)[last] = op.value
  }
}

type WireRun = {
  result: unknown
  responses: Array<{ report: string; status: number; code?: unknown }>
  order: string[]
  connect: ReturnType<typeof vi.fn>
  checkpointAuthority: ReturnType<typeof vi.fn>
  statusPatches: unknown[]
  waitLines: string[]
  snippetRuns: number
}

/**
 * Runs the real runtime against the real status handlers and the real run
 * processor. `bound` decides both the run row (authority binding or none)
 * and the child recipe (run authority label or none), as the DB-run child
 * creator does. `refuse(n)` says whether the n-th Postgres checkout fails
 * with a refused connection.
 */
async function runWire(
  closers: Array<() => Promise<void>>,
  options: { bound: boolean; refuse: (connectNumber: number) => boolean }
): Promise<WireRun> {
  const refused = await captureConnectionRefused()
  const write = vi.spyOn(process.stdout, 'write')

  let recipe: Recipe = {
    metadata: {
      name: RECIPE,
      namespace: NAMESPACE,
      labels: {
        'clerum.io/workflow-run-id': RUN_ID,
        ...(options.bound ? { [RUN_AUTHORITY_LABEL]: RUN_AUTHORITY_BOUND } : {}),
      },
    },
    spec: {
      steps: [{ id: 'emit', run: { type: 'snippet', language: 'typescript', code: 'return 1' } }],
    },
    status: { phase: 'deploying', steps: [], workflowExecution: { phase: 'initializing' } },
  }
  const statusPatches: unknown[] = []
  const customApi = {
    getNamespacedCustomObject: vi.fn(async () => structuredClone(recipe)),
    patchNamespacedCustomObjectStatus: vi.fn(async ({ body }: { body: unknown }) => {
      statusPatches.push(structuredClone(body))
      const next = structuredClone(recipe)
      if (Array.isArray(body)) jsonPatch(next as unknown as Record<string, unknown>, body)
      else mergePatch(next as unknown as Record<string, unknown>, body as Record<string, unknown>)
      recipe = next
      return { body: recipe }
    }),
  }

  // Running row; bound or V1. A bound row goes through the checkpoint and the
  // locked re-read; a V1 row would answer from the unlocked read alone.
  const row: DbRunRow = {
    run_id: RUN_ID,
    recipe_namespace: NAMESPACE,
    recipe_name: 'parent-recipe',
    phase: 'Running',
    team_id: null,
    usage_team_id: null,
    actor_type: 'user',
    actor_id: null,
    inputs: null,
    intermediate_parameters: null,
    output_overrides: null,
    trigger_source: 'onDemand',
    owner_instance_id: 'wire',
    max_duration_seconds: null,
    started_at: new Date().toISOString(),
    child_recipe_name: RECIPE,
    child_recipe_namespace: NAMESPACE,
    failure_reason: null,
    authority_binding: options.bound ? ({ operationId: 'workflow.trigger' } as never) : null,
    authority_binding_id: options.bound ? 'binding-1' : null,
  }
  const client = {
    query: vi.fn(async (sql: string) => {
      if (/FROM workflow_runs run[\s\S]*WHERE run\.run_id = \$1/.test(sql)) {
        return { rows: [row], rowCount: 1 }
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`unexpected query on the run client: ${sql.slice(0, 60)}`)
    }),
    release: vi.fn(),
  }
  let connects = 0
  const connect = vi.fn(async () => {
    connects += 1
    if (options.refuse(connects)) throw refused
    return client as unknown as PoolClient
  })
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (/AS has_authority/.test(sql)) {
        return {
          rows: [{ phase: 'Running', failure_reason: null, has_authority: options.bound }],
          rowCount: 1,
        }
      }
      throw new Error(`unexpected pool query: ${sql.slice(0, 60)}`)
    }),
    connect,
  }
  const checkpointAuthority = vi.fn(async () => undefined)
  const processor = createDbRunProcessor({
    instanceId: 'wire',
    pool: pool as never,
    connect,
    runPollMs: 60_000,
    checkpointAuthority,
    createChildRecipe: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withStep: vi.fn() },
  })
  const handlers = createWorkflowEndpointHandlers(customApi as never, NAMESPACE, undefined, {
    dbRunProcessor: processor,
  })
  const claims: AuthenticatedRequest['tokenClaims'] = {
    sub: 'coordinator',
    aud: 'clerum-wrc',
    iss: 'clerum-wrc',
    recipeName: RECIPE,
    recipeNamespace: NAMESPACE,
    scopes: ['status_write', 'status_read'],
  }

  const order: string[] = []
  const responses: Array<{ report: string; status: number; code?: unknown }> = []
  const statusPath = `/api/v1/workflow/${RECIPE}/status`
  const server = http.createServer((req, res) => {
    const respond = async () => {
      if (req.url !== statusPath) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      if (req.method === 'GET') {
        const result = await handlers.getWorkflowStatus(RECIPE, claims)
        res.writeHead(result.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result.body))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const report =
        typeof body.stepId === 'string'
          ? `step:${body.stepId}:${String(body.phase)}`
          : `workflow:${String(body.workflowPhase)}`
      try {
        const result = await handlers.postStepStatus(RECIPE, claims, body as never)
        responses.push({ report, status: result.status, code: result.body.code })
        order.push(`${report}:${result.status}`)
        res.writeHead(result.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result.body))
      } catch (error) {
        responses.push({ report, status: 500 })
        order.push(`${report}:500`)
        throw error
      }
    }
    // Same answer as workflow-recipes/src/mcp/server.ts for a rejected handler.
    respond().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal server error' }))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no loopback port')

  const status = new StatusReporter({
    wrcUrl: `http://127.0.0.1:${address.port}`,
    workflowName: RECIPE,
    tokenProvider: createStaticRuntimeTokenProvider({ wrcToken: 'wrc-token' }),
  })
  const signals = {
    pollSignals: vi.fn().mockReturnValue(vi.fn()),
    hasSignal: vi.fn().mockReturnValue(false),
  }
  let snippetRuns = 0
  const snippetRunner = {
    healthCheck: vi.fn().mockResolvedValue({ status: 'healthy' }),
    execute: vi.fn(async () => {
      snippetRuns += 1
      order.push('snippet')
      return { status: 'completed', output: { ok: true } }
    }),
  }

  const result = await runWorkflowRuntime({
    config: {
      workflowName: RECIPE,
      namespace: NAMESPACE,
      wrcUrl: `http://127.0.0.1:${address.port}`,
      tokenProvider: createStaticRuntimeTokenProvider({ wrcToken: 'wrc-token' }),
      wrcTokenFile: '/var/run/clerum/workflow-tokens/wrc-token',
      correlationId: 'corr-wire',
      signalPollIntervalMs: 1,
      restPort: 8090,
    } as never,
    spec: { name: RECIPE, namespace: NAMESPACE, steps: recipe.spec.steps } as never,
    coordinator: new StepCoordinator(),
    status,
    signals: signals as unknown as SignalPoller,
    mcpHost: null,
    snippetRunner: snippetRunner as never,
    modelInjection: vi.fn(),
  })

  const waitLines = write.mock.calls
    .map(call => String(call[0]))
    .filter(line => line.includes(`"message":"${WAIT_LINE}"`))
  return {
    result,
    responses,
    order,
    connect,
    checkpointAuthority,
    statusPatches,
    waitLines,
    snippetRuns,
  }
}

describe('running boundary over the wire: run store unavailable', () => {
  const closers: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
    vi.restoreAllMocks()
  })

  it('T-4j: a bound run gets three 503 answers, one wait, then the step runs once', async () => {
    // Checkouts 1-2: the workflow-level running report (unlocked read, then
    // the locked re-read). Checkouts 3-5: the step running report's three
    // client attempts, each refused at the unlocked read. Checkouts 6-7: the
    // retry after the wait.
    const run = await runWire(closers, { bound: true, refuse: n => n >= 3 && n <= 5 })

    expect(run.result).toEqual({ exitCode: 0, workflowPhase: 'completed' })
    expect(run.responses.filter(r => r.report === 'step:emit:running')).toEqual([
      { report: 'step:emit:running', status: 503, code: 'workflow_run_state_unavailable' },
      { report: 'step:emit:running', status: 503, code: 'workflow_run_state_unavailable' },
      { report: 'step:emit:running', status: 503, code: 'workflow_run_state_unavailable' },
      { report: 'step:emit:running', status: 200, code: undefined },
    ])
    // Witness: the boundary read the run store on every running report.
    expect(run.connect).toHaveBeenCalledTimes(7)
    expect(run.checkpointAuthority).toHaveBeenCalledTimes(2)
    expect(run.waitLines).toHaveLength(1)
    expect(run.snippetRuns).toBe(1)
    expect(run.order.indexOf('snippet')).toBe(run.order.indexOf('step:emit:running:200') + 1)
    expect(run.responses.some(r => r.report === 'workflow:failed')).toBe(false)
    expect(run.responses.at(-1)).toEqual({
      report: 'workflow:completed',
      status: 200,
      code: undefined,
    })
  })

  it('a V1 run is decided by recipe status and never asks the run store for a client', async () => {
    // Every checkout would be refused, so any read of the run store would
    // answer 503 and make the runtime wait.
    const run = await runWire(closers, { bound: false, refuse: () => true })

    expect(run.result).toEqual({ exitCode: 0, workflowPhase: 'completed' })
    expect(run.responses.filter(r => r.report === 'step:emit:running')).toEqual([
      { report: 'step:emit:running', status: 200, code: undefined },
    ])
    expect(run.responses.filter(r => r.report === 'workflow:running')).toEqual([
      { report: 'workflow:running', status: 200, code: undefined },
    ])
    // Liveness witness: the step running report reached the recipe-status patch.
    expect(
      run.statusPatches.some(body =>
        JSON.stringify(body).includes('"value":{"id":"emit","phase":"running"')
      )
    ).toBe(true)
    expect(run.connect).not.toHaveBeenCalled()
    expect(run.checkpointAuthority).not.toHaveBeenCalled()
    expect(run.waitLines).toHaveLength(0)
    expect(run.snippetRuns).toBe(1)
  })
})
