import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import { Pool as PgPool, type Pool, type PoolClient } from 'pg'
import type { WorkflowRecipeCRD } from '../types.js'
import {
  type ChildRecipeCreator,
  type DbRunProcessor,
  type DbRunRow,
  type RunningBoundaryOutcome,
  type WorkflowRunAuthorityBinding,
  createDbRunProcessor,
  hasCompletedAllDeclaredSteps,
  mapStepPhase,
  mapWorkflowExecutionPhase,
} from './dbRunProcessor.js'
import {
  WorkflowAuthorityCheckpointError,
  createWorkflowRunAuthorityCheckpointer,
} from './workflowActionCheckpointClient.js'

/**
 * Tests for `createDbRunProcessor` — the DB-first replacement for
 * `WorkflowRunReconciler` (plan §serene-sauteeing-jellyfish.md §Fase 4).
 *
 * Scope:
 *  - Seven cases migrated from `workflowRunReconciler.test.ts` translated from
 *    CRD merge-patch assertions to SQL state assertions.
 *  - Three additional cases specific to the DB-first architecture (LISTEN
 *    reconnect, advisory-lock split-brain, orphan poll fallback).
 *
 * Design notes:
 *  - We drive a programmable fake `Pool`/`PoolClient` that matches SQL by
 *    regex. No real Postgres.
 *  - We intentionally do NOT mock the K8s client — the module consumes a
 *    `ChildRecipeCreator` callback so tests can spy on child creation without
 *    touching kubernetes.
 *  - `process.nextTick` is used to flush microtasks because `vi.useFakeTimers`
 *    fakes `setImmediate`/`queueMicrotask` but not `process.nextTick`.
 */

type QueryHandler = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: unknown[]; rowCount: number }>

interface FakeClient {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  listeners: Record<string, Array<(...args: unknown[]) => void>>
  emit: (event: string, ...args: unknown[]) => void
  calls: Array<{ sql: string; params?: unknown[] }>
}

function makeClient(handler: QueryHandler): FakeClient {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const client: FakeClient = {
    query: vi.fn(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql)
      calls.push({ sql: text, params })
      return handler(text, params)
    }),
    release: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(listener)
    }),
    listeners,
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners[event] ?? []) l(...args)
    },
    calls,
  }
  return client
}

function silentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withStep: () => silentLogger(),
  }
}

const flush = () => new Promise<void>(resolve => process.nextTick(resolve))

function baseRun(overrides: Partial<DbRunRow> = {}): DbRunRow {
  return {
    run_id: '00000000-0000-0000-0000-000000000001',
    recipe_namespace: 'demo',
    recipe_name: 'echo',
    phase: 'Pending',
    team_id: null,
    usage_team_id: null,
    actor_type: 'user',
    actor_id: null,
    inputs: null,
    intermediate_parameters: null,
    output_overrides: null,
    trigger_source: 'onDemand',
    owner_instance_id: null,
    max_duration_seconds: 600,
    // Pending runs carry a NULL started_at until CLAIM_PENDING sets it.
    // Overrides can still populate this for Running/terminal-phase fixtures.
    started_at: null,
    child_recipe_name: null,
    child_recipe_namespace: null,
    ...overrides,
  }
}

/**
 * The run is read twice: once without a transaction (before the authority
 * checkpoint) and once under the row lock. RUN_READ_SQL matches both reads;
 * LOCKED_RUN_READ_SQL matches only the locked one.
 */
const RUN_READ_SQL = /FROM workflow_runs run[\s\S]*WHERE run\.run_id = \$1/i
const LOCKED_RUN_READ_SQL = /FROM workflow_runs run[\s\S]*FOR UPDATE OF run\s*$/i

const V2_BINDING: WorkflowRunAuthorityBinding = {
  version: 2,
  userId: '11111111-1111-4111-8111-111111111111',
  sid: '22222222-2222-4222-8222-222222222222',
  sessionVersion: 1,
  delegationJti: '33333333-3333-4333-8333-333333333333',
  operationId: 'workflow.trigger',
  resource: { type: 'workflow_recipe', logicalId: 'demo/echo' },
  target: { recipeNamespace: 'demo', recipeName: 'echo' },
  targetHash: 'ath2_test',
  accessPathId: 'ap1_test',
  authorizationRevision: 'ar1_test',
  pathKind: 'direct',
  effectiveTeamId: null,
  behaviorBindingHash: 'bh2_test',
}

/** A run row as SELECT_RUN returns it; a null binding id is a V1 run. */
function runWithBinding(bindingId: string | null, overrides: Partial<DbRunRow> = {}): DbRunRow {
  return baseRun({
    authority_binding: bindingId ? V2_BINDING : null,
    authority_binding_id: bindingId,
    ...overrides,
  })
}

/**
 * T-L8-style transaction tripwire for this suite's fake pool (plan r6 §10 L12).
 *
 * `pool()` hands out tracked clients: every `connect()` checks a client out
 * and every `release()` checks it back in; `BEGIN` opens a transaction on the
 * client, `COMMIT` / `ROLLBACK` close it, and a release while it is open is
 * counted. `guard()` wraps a network fake (the authority checkpoint, or the
 * checkpoint client's `fetch`): a call made while any tracked client is
 * between `BEGIN` and `COMMIT`/`ROLLBACK`, or while any client of the pool is
 * checked out, is recorded as a violation and throws. Tests assert
 * `violations` is empty together with a liveness witness (`guardedCalls` > 0,
 * or the guarded fake's own call count).
 */
function createTransactionTripwire() {
  const open = new Set<FakeClient>()
  const tracked = new Set<FakeClient>()
  const violations: string[] = []
  let guardedCalls = 0
  let releasedInTransaction = 0
  let checkedOut = 0
  let checkouts = 0

  function track(client: FakeClient): FakeClient {
    if (tracked.has(client)) return client
    tracked.add(client)
    const handle = client.query.getMockImplementation()
    if (!handle) throw new Error('tripwire: fake client has no query implementation')
    client.query.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql).trim()
      if (/^BEGIN\b/i.test(text)) open.add(client)
      try {
        return await handle(sql, params)
      } finally {
        if (/^(COMMIT|ROLLBACK)\b/i.test(text)) open.delete(client)
      }
    })
    client.release.mockImplementation(() => {
      if (checkedOut === 0) throw new Error('tripwire: release without a matching connect')
      checkedOut -= 1
      if (open.has(client)) {
        releasedInTransaction += 1
        open.delete(client)
      }
    })
    return client
  }

  return {
    pool(client: FakeClient): Pool {
      return {
        connect: vi.fn(async () => {
          track(client)
          checkedOut += 1
          checkouts += 1
          return client as unknown as PoolClient
        }),
      } as unknown as Pool
    },
    guard<A extends unknown[], R>(fn: (...args: A) => Promise<R>, label: string) {
      return async (...args: A): Promise<R> => {
        guardedCalls += 1
        if (open.size > 0) {
          violations.push(`${label}: inside a transaction`)
          throw new Error(`tripwire: ${label} called inside a Postgres transaction`)
        }
        if (checkedOut > 0) {
          violations.push(`${label}: pooled client held`)
          throw new Error(`tripwire: ${label} called while a pooled client is checked out`)
        }
        return fn(...args)
      }
    },
    get violations(): readonly string[] {
      return violations
    },
    get guardedCalls(): number {
      return guardedCalls
    },
    get openTransactions(): number {
      return open.size
    },
    get releasedInTransaction(): number {
      return releasedInTransaction
    },
    get checkedOut(): number {
      return checkedOut
    },
    get checkouts(): number {
      return checkouts
    },
  }
}

function makeRecipeWithAnnotation(
  runId: string,
  executionPhase?: string,
  steps: WorkflowRecipeCRD['status'] extends infer S ? S : never = undefined as never
): WorkflowRecipeCRD {
  const statusSteps = (steps ?? undefined) as WorkflowRecipeCRD['status']
  const rec: WorkflowRecipeCRD = {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: 'child-xyz',
      namespace: 'sandbox-recipes',
      labels: { 'clerum.io/workflow-run-id': runId },
    },
    spec: {},
    status: {
      phase: 'active',
      workflowExecution: executionPhase ? { phase: executionPhase } : undefined,
      ...(statusSteps ?? {}),
    },
  }
  return rec
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe('createDbRunProcessor', () => {
  let instances: DbRunProcessor[] = []

  beforeEach(() => {
    instances = []
  })

  afterEach(async () => {
    for (const inst of instances) {
      try {
        await inst.stop()
      } catch {
        /* best-effort */
      }
    }
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  function spawn(opts: Parameters<typeof createDbRunProcessor>[0]): DbRunProcessor {
    const p = createDbRunProcessor(opts)
    instances.push(p)
    return p
  }

  // ─── 1) processPending happy path: creates child + claims Pending → Running
  it('processPending creates child and transitions Pending → Running atomically', async () => {
    const run = baseRun()
    const client = makeClient(async sql => {
      if (/^BEGIN$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 }
      if (RUN_READ_SQL.test(sql)) {
        return { rows: [run], rowCount: 1 }
      }
      if (/UPDATE workflow_runs[\s\S]*SET phase = 'Running'/i.test(sql)) {
        return { rows: [], rowCount: 1 }
      }
      if (/^COMMIT$/i.test(sql)) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })
    const pool = { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool

    const createChildRecipe: ChildRecipeCreator = vi.fn(async () => ({
      name: 'child-run-1',
      namespace: 'sandbox-recipes',
    }))

    const proc = spawn({
      instanceId: 'wrc-1',
      pool,
      runPollMs: 30_000,
      createChildRecipe,
      logger: silentLogger(),
    })

    await proc.processPending(run.run_id)

    expect(createChildRecipe).toHaveBeenCalledWith(run)
    // Two acquisitions: the unlocked read's client is released before the
    // transaction's client is acquired.
    expect(pool.connect).toHaveBeenCalledTimes(2)
    expect(client.release).toHaveBeenCalledTimes(2)

    // Unlocked read first, then BEGIN → advisory lock → locked read → claim → COMMIT.
    const sqlTrail = client.calls.map(c => c.sql)
    expect(RUN_READ_SQL.test(sqlTrail[0]!)).toBe(true)
    expect(LOCKED_RUN_READ_SQL.test(sqlTrail[0]!)).toBe(false)
    expect(sqlTrail[1]).toBe('BEGIN')
    expect(sqlTrail[2]).toMatch(/pg_advisory_xact_lock/)
    expect(LOCKED_RUN_READ_SQL.test(sqlTrail[3]!)).toBe(true)
    expect(sqlTrail[sqlTrail.length - 1]).toBe('COMMIT')

    const claim = client.calls.find(c => /SET phase = 'Running'/.test(c.sql))
    expect(claim).toBeDefined()
    expect(claim?.sql).toContain('started_at = now()')
    expect(claim?.params).toEqual(['wrc-1', 'child-run-1', 'sandbox-recipes', run.run_id])
  })

  it('checkpoints a persisted v2 trigger binding before creating the child', async () => {
    const run = baseRun({
      authority_binding: {
        userId: '11111111-1111-4111-8111-111111111111',
        sid: '22222222-2222-4222-8222-222222222222',
        sessionVersion: 1,
        delegationJti: '33333333-3333-4333-8333-333333333333',
        operationId: 'workflow.trigger',
        resource: { type: 'workflow_recipe', logicalId: 'demo/echo' },
        target: { recipeNamespace: 'demo', recipeName: 'echo' },
        targetHash: 'ath2_test',
        accessPathId: 'ap1_test',
        authorizationRevision: 'ar1_test',
        behaviorBindingHash: 'bh2_test',
      },
    })
    const client = makeClient(async sql => {
      if (RUN_READ_SQL.test(sql)) {
        return { rows: [run], rowCount: 1 }
      }
      if (/SET phase = 'Running'/.test(sql)) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const order: string[] = []
    const tripwire = createTransactionTripwire()
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: tripwire.pool(client),
      runPollMs: 30_000,
      checkpointAuthority: vi.fn(
        tripwire.guard(async () => {
          order.push('checkpoint')
        }, 'checkpoint')
      ),
      createChildRecipe: vi.fn(async () => {
        order.push('child')
        return { name: 'child', namespace: 'sandbox-recipes' }
      }),
      logger: silentLogger(),
    })

    await proc.processPending(run.run_id)

    expect(order).toEqual(['checkpoint', 'child'])
    expect(tripwire.guardedCalls).toBe(1)
    expect(tripwire.violations).toEqual([])
  })

  it('pauses a bound run when no authority checkpointer is mounted', async () => {
    const run = baseRun({
      authority_binding: {
        userId: '11111111-1111-4111-8111-111111111111',
        sid: '22222222-2222-4222-8222-222222222222',
        sessionVersion: 1,
        delegationJti: '33333333-3333-4333-8333-333333333333',
        operationId: 'workflow.trigger',
        resource: { type: 'workflow_recipe', logicalId: 'demo/echo' },
        target: { recipeNamespace: 'demo', recipeName: 'echo' },
        targetHash: 'ath2_test',
        accessPathId: 'ap1_test',
        authorizationRevision: 'ar1_test',
        behaviorBindingHash: 'bh2_test',
      },
    })
    const client = makeClient(async sql =>
      RUN_READ_SQL.test(sql) ? { rows: [run], rowCount: 1 } : { rows: [], rowCount: 0 }
    )
    const createChildRecipe = vi.fn()
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool,
      runPollMs: 30_000,
      createChildRecipe,
      logger: silentLogger(),
    })

    await expect(proc.processPending(run.run_id)).resolves.toBeUndefined()
    expect(createChildRecipe).not.toHaveBeenCalled()
    const pause = client.calls.find(call => /SET phase = 'AuthorizationPaused'/.test(call.sql))
    expect(pause?.params).toEqual([run.run_id, 'workflow_authority_unavailable'])
    expect(client.calls.some(call => /^COMMIT$/i.test(call.sql))).toBe(true)
    expect(client.calls.some(call => /SET phase = 'Running'/.test(call.sql))).toBe(false)
  })

  it.each([
    ['denied', 'workflow_authority_denied'],
    ['not_found', 'workflow_authority_not_found'],
    ['access_path_stale', 'workflow_authority_access_path_stale'],
    ['invalid_binding', 'workflow_authority_invalid_binding'],
  ] as const)(
    'pauses before creating a child when authority is %s',
    async (failure, failureReason) => {
      const run = baseRun({
        authority_binding: {
          userId: '11111111-1111-4111-8111-111111111111',
          sid: '22222222-2222-4222-8222-222222222222',
          sessionVersion: 1,
          delegationJti: '33333333-3333-4333-8333-333333333333',
          operationId: 'workflow.trigger',
          resource: { type: 'workflow_recipe', logicalId: 'demo/echo' },
          target: { recipeNamespace: 'demo', recipeName: 'echo' },
          targetHash: 'ath2_test',
          accessPathId: 'ap1_test',
          authorizationRevision: 'ar1_test',
          behaviorBindingHash: 'bh2_test',
        },
      })
      let phase: 'Pending' | 'AuthorizationPaused' = 'Pending'
      const client = makeClient(async sql => {
        if (RUN_READ_SQL.test(sql)) {
          return phase === 'Pending' ? { rows: [run], rowCount: 1 } : { rows: [], rowCount: 0 }
        }
        if (/SET phase = 'AuthorizationPaused'/.test(sql)) phase = 'AuthorizationPaused'
        return { rows: [], rowCount: 0 }
      })
      const createChildRecipe = vi.fn()
      const tripwire = createTransactionTripwire()
      const checkpointAuthority = vi.fn(
        tripwire.guard(async () => {
          throw new WorkflowAuthorityCheckpointError(failure, false)
        }, 'checkpoint')
      )
      const proc = spawn({
        instanceId: 'wrc-1',
        pool: tripwire.pool(client),
        runPollMs: 30_000,
        checkpointAuthority,
        createChildRecipe,
        logger: silentLogger(),
      })

      await expect(proc.processPending(run.run_id)).resolves.toBeUndefined()
      expect(createChildRecipe).not.toHaveBeenCalled()
      const pause = client.calls.find(call => /SET phase = 'AuthorizationPaused'/.test(call.sql))
      expect(pause?.sql).toContain('failure_reason = $2')
      expect(pause?.params).toEqual([run.run_id, failureReason])
      expect(client.calls.some(call => /^COMMIT$/i.test(call.sql))).toBe(true)
      await expect(proc.processPending(run.run_id)).resolves.toBeUndefined()
      expect(checkpointAuthority).toHaveBeenCalledOnce()
      expect(phase).toBe('AuthorizationPaused')
      expect(tripwire.violations).toEqual([])
    }
  )

  it.each(['authority_unavailable', 'invalid_response', 'timeout'] as const)(
    'durably pauses on retryable authority %s before child creation',
    async failure => {
      const run = baseRun({
        authority_binding: {
          version: 2,
          userId: '11111111-1111-4111-8111-111111111111',
          sid: '22222222-2222-4222-8222-222222222222',
          sessionVersion: 1,
          delegationJti: '33333333-3333-4333-8333-333333333333',
          operationId: 'workflow.trigger',
          resource: { type: 'workflow_recipe', logicalId: 'demo/echo' },
          target: { recipeNamespace: 'demo', recipeName: 'echo' },
          targetHash: 'ath2_test',
          accessPathId: 'ap1_test',
          authorizationRevision: 'ar1_test',
          behaviorBindingHash: 'bh2_test',
          pathKind: 'direct',
          effectiveTeamId: null,
        },
      })
      const client = makeClient(async sql =>
        RUN_READ_SQL.test(sql) ? { rows: [run], rowCount: 1 } : { rows: [], rowCount: 0 }
      )
      const createChildRecipe = vi.fn()
      const tripwire = createTransactionTripwire()
      const proc = spawn({
        instanceId: 'wrc-1',
        pool: tripwire.pool(client),
        runPollMs: 30_000,
        checkpointAuthority: vi.fn(
          tripwire.guard(async () => {
            throw new WorkflowAuthorityCheckpointError(failure, true)
          }, 'checkpoint')
        ),
        createChildRecipe,
        logger: silentLogger(),
      })

      await expect(proc.processPending(run.run_id)).resolves.toBeUndefined()
      const pause = client.calls.find(call => /SET phase = 'AuthorizationPaused'/.test(call.sql))
      expect(pause?.params).toEqual([run.run_id, 'workflow_authority_unavailable'])
      expect(client.calls.some(call => /^COMMIT$/i.test(call.sql))).toBe(true)
      expect(createChildRecipe).not.toHaveBeenCalled()
      expect(tripwire.guardedCalls).toBe(1)
      expect(tripwire.violations).toEqual([])
    }
  )

  it('mounts the real checkpoint client and pauses on authority outages before child creation', async () => {
    vi.stubEnv('INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET', 'round-five-workflow-checkpoint-test-secret')
    const run = baseRun({
      actor_id: '11111111-1111-4111-8111-111111111111',
      authority_binding: {
        version: 2,
        userId: '11111111-1111-4111-8111-111111111111',
        sid: '22222222-2222-4222-8222-222222222222',
        sessionVersion: 1,
        delegationJti: '33333333-3333-4333-8333-333333333333',
        operationId: 'workflow.trigger',
        resource: { environmentId: 'local', type: 'workflow_recipe', logicalId: 'demo/echo' },
        target: { recipeNamespace: 'demo', recipeName: 'echo' },
        targetHash: `ath2_${'a'.repeat(43)}`,
        accessPathId: `ap1_${'b'.repeat(43)}`,
        authorizationRevision: `ar1_${'c'.repeat(43)}`,
        behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
        pathKind: 'direct',
        effectiveTeamId: null,
      },
    })
    const client = makeClient(async sql =>
      RUN_READ_SQL.test(sql) ? { rows: [run], rowCount: 1 } : { rows: [], rowCount: 0 }
    )
    const tripwire = createTransactionTripwire()
    const fetchImpl = vi.fn(
      tripwire.guard(
        async () =>
          new Response(
            JSON.stringify({
              version: 2,
              status: 'authority_unavailable',
              code: 'authority_unavailable',
              retryable: true,
            }),
            { status: 503 }
          ),
        'checkpoint fetch'
      )
    )
    const checkpointAuthority = createWorkflowRunAuthorityCheckpointer({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const createChildRecipe = vi.fn()
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: tripwire.pool(client),
      runPollMs: 30_000,
      checkpointAuthority,
      createChildRecipe,
      logger: silentLogger(),
    })

    await expect(proc.processPending(run.run_id)).resolves.toBeUndefined()
    expect(createChildRecipe).not.toHaveBeenCalled()
    expect(client.calls.some(call => /SET phase = 'AuthorizationPaused'/.test(call.sql))).toBe(true)
    expect(client.calls.some(call => /^COMMIT$/i.test(call.sql))).toBe(true)
    expect(fetchImpl).toHaveBeenCalled()
    expect(tripwire.violations).toEqual([])
  })

  it('pauses a persisted binding for another run actor before child creation', async () => {
    vi.stubEnv('INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET', 'round-five-workflow-checkpoint-test-secret')
    const run = baseRun({
      actor_type: 'user',
      actor_id: '44444444-4444-4444-8444-444444444444',
      authority_binding: {
        version: 2,
        userId: '11111111-1111-4111-8111-111111111111',
        sid: '22222222-2222-4222-8222-222222222222',
        sessionVersion: 1,
        delegationJti: '33333333-3333-4333-8333-333333333333',
        operationId: 'workflow.trigger',
        resource: { environmentId: 'local', type: 'workflow_recipe', logicalId: 'demo/echo' },
        target: { recipeNamespace: 'demo', recipeName: 'echo' },
        targetHash: `ath2_${'a'.repeat(43)}`,
        accessPathId: `ap1_${'b'.repeat(43)}`,
        authorizationRevision: `ar1_${'c'.repeat(43)}`,
        behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
        pathKind: 'direct',
        effectiveTeamId: null,
      },
    })
    const client = makeClient(async sql =>
      RUN_READ_SQL.test(sql) ? { rows: [run], rowCount: 1 } : { rows: [], rowCount: 0 }
    )
    const fetchImpl = vi.fn()
    const createChildRecipe = vi.fn()
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool,
      runPollMs: 30_000,
      checkpointAuthority: createWorkflowRunAuthorityCheckpointer({
        fetchImpl: fetchImpl as typeof fetch,
      }),
      createChildRecipe,
      logger: silentLogger(),
    })

    await expect(proc.processPending(run.run_id)).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(createChildRecipe).not.toHaveBeenCalled()
    expect(client.calls.some(call => /SET phase = 'AuthorizationPaused'/.test(call.sql))).toBe(true)
  })

  it('requires explicit resume after a checkpoint outage before creating the child', async () => {
    const run = baseRun({
      authority_binding: {
        userId: '11111111-1111-4111-8111-111111111111',
        sid: '22222222-2222-4222-8222-222222222222',
        sessionVersion: 1,
        delegationJti: '33333333-3333-4333-8333-333333333333',
        operationId: 'workflow.trigger',
        resource: { type: 'workflow_recipe', logicalId: 'demo/echo' },
        target: { recipeNamespace: 'demo', recipeName: 'echo' },
        targetHash: 'ath2_test',
        accessPathId: 'ap1_test',
        authorizationRevision: 'ar1_test',
        behaviorBindingHash: 'bh2_test',
      },
    })
    let phase: 'Pending' | 'AuthorizationPaused' = 'Pending'
    const client = makeClient(async sql => {
      if (RUN_READ_SQL.test(sql)) {
        return phase === 'Pending'
          ? { rows: [{ ...run, phase }], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      }
      if (/SET phase = 'AuthorizationPaused'/.test(sql)) phase = 'AuthorizationPaused'
      if (/SET phase = 'Running'/.test(sql)) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const createChildRecipe = vi.fn(async () => ({ name: 'child', namespace: 'sandbox-recipes' }))
    const tripwire = createTransactionTripwire()
    const checkpointOutcomes = vi
      .fn()
      .mockRejectedValueOnce(new Error('workflow_authority_unavailable'))
      .mockResolvedValueOnce(undefined)
    const checkpointAuthority = vi.fn(
      tripwire.guard(async (checkedRun: DbRunRow) => checkpointOutcomes(checkedRun), 'checkpoint')
    )
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: tripwire.pool(client),
      runPollMs: 30_000,
      checkpointAuthority,
      createChildRecipe,
      logger: silentLogger(),
    })

    await expect(proc.processPending(run.run_id)).resolves.toBeUndefined()
    expect(phase).toBe('AuthorizationPaused')
    expect(createChildRecipe).not.toHaveBeenCalled()
    await expect(proc.processPending(run.run_id)).resolves.toBeUndefined()
    expect(checkpointAuthority).toHaveBeenCalledOnce()

    // Model the resume route's committed AuthorizationPaused -> Pending write.
    phase = 'Pending'
    await expect(proc.processPending(run.run_id)).resolves.toBeUndefined()

    expect(checkpointAuthority).toHaveBeenCalledTimes(2)
    expect(createChildRecipe).toHaveBeenCalledTimes(1)
    expect(tripwire.violations).toEqual([])
  })

  it('does not fail processPending when the post-commit run-start callback throws', async () => {
    const run = baseRun({ run_id: 'run-callback-start' })
    const client = makeClient(async sql => {
      if (/^BEGIN$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 }
      if (RUN_READ_SQL.test(sql)) return { rows: [run], rowCount: 1 }
      if (/SET phase = 'Running'/.test(sql)) return { rows: [], rowCount: 1 }
      if (/^COMMIT$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/^ROLLBACK$/i.test(sql)) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })
    const pool = { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool
    const logger = silentLogger()

    const proc = spawn({
      instanceId: 'wrc-1',
      pool,
      runPollMs: 30_000,
      createChildRecipe: vi.fn(async () => ({
        name: 'child-callback-start',
        namespace: 'sandbox-recipes',
      })),
      logger,
      onRunStarted: vi.fn(() => {
        throw new Error('trace callback failed')
      }),
    })

    await expect(proc.processPending(run.run_id)).resolves.toBeUndefined()

    expect(client.calls.some(c => /^COMMIT$/i.test(c.sql))).toBe(true)
    expect(client.calls.some(c => /^ROLLBACK$/i.test(c.sql))).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      'run-start lifecycle callback failed after committed transition',
      expect.objectContaining({ run_id: run.run_id, err: 'trace callback failed' })
    )
  })

  // ─── 2) idempotency: if the row is already Running, skip child creation
  it('processPending is a no-op when the row is no longer Pending', async () => {
    const run = baseRun({ phase: 'Running', owner_instance_id: 'wrc-other' })
    const client = makeClient(async sql => {
      if (RUN_READ_SQL.test(sql)) return { rows: [run], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const pool = { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool
    const createChildRecipe = vi.fn(async () => ({ name: 'x', namespace: 'y' }))

    const proc = spawn({
      instanceId: 'wrc-1',
      pool,
      runPollMs: 30_000,
      createChildRecipe,
      logger: silentLogger(),
    })

    await proc.processPending(run.run_id)

    // Witness: the unlocked read ran and saw Running; nothing else followed.
    expect(client.calls).toHaveLength(1)
    expect(RUN_READ_SQL.test(client.calls[0]!.sql)).toBe(true)
    expect(createChildRecipe).not.toHaveBeenCalled()
    expect(client.calls.some(c => /^BEGIN$/i.test(c.sql))).toBe(false)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('processPending rolls back when the locked read no longer sees Pending', async () => {
    const pending = baseRun()
    const client = makeClient(async sql => {
      if (LOCKED_RUN_READ_SQL.test(sql)) {
        return {
          rows: [{ ...pending, phase: 'Running', owner_instance_id: 'wrc-other' }],
          rowCount: 1,
        }
      }
      if (RUN_READ_SQL.test(sql)) return { rows: [pending], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const createChildRecipe = vi.fn(async () => ({ name: 'x', namespace: 'y' }))
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool,
      runPollMs: 30_000,
      createChildRecipe,
      logger: silentLogger(),
    })

    await proc.processPending(pending.run_id)

    // Witness: the locked read ran inside the transaction.
    expect(client.calls.some(c => LOCKED_RUN_READ_SQL.test(c.sql))).toBe(true)
    expect(client.calls.some(c => /^ROLLBACK$/i.test(c.sql))).toBe(true)
    expect(createChildRecipe).not.toHaveBeenCalled()
    expect(client.calls.some(c => /SET phase = 'Running'/.test(c.sql))).toBe(false)
    expect(client.calls.some(c => /^COMMIT$/i.test(c.sql))).toBe(false)
  })

  // ─── 3) child recipe name+namespace land on claim UPDATE params (labels source)
  it('stamps child name/namespace into workflow_runs and preserves owner_instance_id', async () => {
    const run = baseRun({ run_id: 'aaaaaaaa-0000-0000-0000-000000000001' })
    const client = makeClient(async sql => {
      if (RUN_READ_SQL.test(sql)) return { rows: [run], rowCount: 1 }
      if (/SET phase = 'Running'/.test(sql)) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const pool = { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool
    const createChildRecipe: ChildRecipeCreator = vi.fn(async () => ({
      name: 'child-labelled',
      namespace: 'sandbox-recipes',
    }))

    const proc = spawn({
      instanceId: 'wrc-owner-xyz',
      pool,
      runPollMs: 30_000,
      createChildRecipe,
      logger: silentLogger(),
    })
    await proc.processPending(run.run_id)

    const claim = client.calls.find(c => /SET phase = 'Running'/.test(c.sql))
    expect(claim?.sql).toContain('started_at = now()')
    expect(claim?.params).toEqual([
      'wrc-owner-xyz',
      'child-labelled',
      'sandbox-recipes',
      run.run_id,
    ])
  })

  // ─── 4) syncFromRecipeExecution writes terminal phase + fires onRunTerminal
  it('syncFromRecipeExecution transitions Running → Succeeded and upserts steps', async () => {
    const client = makeClient(async sql => {
      if (/^BEGIN$/i.test(sql) || /^COMMIT$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/UPDATE workflow_runs[\s\S]*completed_at/i.test(sql)) {
        return { rows: [], rowCount: 1 }
      }
      if (/INSERT INTO workflow_run_steps/i.test(sql)) {
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const pool = {
      connect: vi.fn(async () => client as unknown as PoolClient),
    } as unknown as Pool

    const onRunTerminal = vi.fn()
    const proc = spawn({
      instanceId: 'wrc-1',
      pool,
      runPollMs: 30_000,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
      onRunTerminal,
    })

    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: 'child-xyz',
        namespace: 'sandbox-recipes',
        labels: { 'clerum.io/workflow-run-id': 'run-1' },
      },
      spec: {},
      status: {
        phase: 'active',
        workflowExecution: {
          phase: 'completed',
          completedAt: '2026-04-20T12:05:00Z',
        },
        steps: [
          {
            id: 'step-1',
            phase: 'completed',
            output: 'hello',
            toolsCalled: [{ serverName: 'clerum', toolName: 'generate_docx' }],
            approvalBindingSha256: 'b'.repeat(64),
          },
          { id: 'step-2', phase: 'running' },
        ],
      },
    }

    await proc.syncFromRecipeExecution(recipe)

    const terminalUpdate = client.calls.find(c =>
      /UPDATE workflow_runs[\s\S]*completed_at/i.test(c.sql)
    )
    expect(terminalUpdate?.params).toEqual(['Succeeded', '2026-04-20T12:05:00Z', 'run-1'])

    const upserts = client.calls.filter(c => /INSERT INTO workflow_run_steps/i.test(c.sql))
    expect(upserts).toHaveLength(2)
    expect(upserts[0]?.params?.[1]).toBe('step-1')
    expect(upserts[0]?.params?.[2]).toBe('Succeeded')
    expect(upserts[0]?.params?.[6]).toBe(
      JSON.stringify([{ serverName: 'clerum', toolName: 'generate_docx' }])
    )
    expect(upserts[0]?.params?.[8]).toBe('b'.repeat(64))
    expect(upserts[1]?.params?.[2]).toBe('Running')
    expect(upserts[1]?.params?.[6]).toBeNull()
    expect(upserts[1]?.params?.[8]).toBeNull()
    expect(client.calls.indexOf(upserts[0]!)).toBeLessThan(client.calls.indexOf(terminalUpdate!))

    expect(onRunTerminal).toHaveBeenCalledWith('run-1', 'Succeeded')
  })

  it('does not fail syncFromRecipeExecution when the post-commit terminal callback throws', async () => {
    const client = makeClient(async sql => {
      if (/^BEGIN$/i.test(sql) || /^COMMIT$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/UPDATE workflow_runs[\s\S]*completed_at/i.test(sql)) return { rows: [], rowCount: 1 }
      if (/^ROLLBACK$/i.test(sql)) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })
    const pool = {
      connect: vi.fn(async () => client as unknown as PoolClient),
    } as unknown as Pool
    const logger = silentLogger()

    const proc = spawn({
      instanceId: 'wrc-1',
      pool,
      runPollMs: 30_000,
      createChildRecipe: vi.fn(),
      logger,
      onRunTerminal: vi.fn(() => {
        throw new Error('terminal trace callback failed')
      }),
    })

    await expect(
      proc.syncFromRecipeExecution({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: {
          name: 'child-callback-terminal',
          namespace: 'sandbox-recipes',
          labels: { 'clerum.io/workflow-run-id': 'run-callback-terminal' },
        },
        spec: {},
        status: {
          phase: 'active',
          workflowExecution: {
            phase: 'completed',
            completedAt: '2026-04-20T12:05:00Z',
          },
        },
      })
    ).resolves.toBeUndefined()

    expect(client.calls.some(c => /^COMMIT$/i.test(c.sql))).toBe(true)
    expect(client.calls.some(c => /^ROLLBACK$/i.test(c.sql))).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      'run-terminal lifecycle callback failed after committed transition',
      expect.objectContaining({
        run_id: 'run-callback-terminal',
        phase: 'Succeeded',
        err: 'terminal trace callback failed',
      })
    )
  })

  it('syncFromRecipeExecution lets a recovered child recipe correct Failed → Succeeded', async () => {
    let sawRecoveredTerminalPredicate = false
    const client = makeClient(async (sql, params) => {
      if (/^BEGIN$/i.test(sql) || /^COMMIT$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/UPDATE workflow_runs[\s\S]*completed_at/i.test(sql)) {
        sawRecoveredTerminalPredicate =
          /phase = 'Failed' AND \$1 = 'Succeeded'/.test(sql) &&
          params?.[0] === 'Succeeded' &&
          params?.[2] === 'run-recovered'
        return { rows: [], rowCount: sawRecoveredTerminalPredicate ? 1 : 0 }
      }
      return { rows: [], rowCount: 0 }
    })
    const pool = {
      connect: vi.fn(async () => client as unknown as PoolClient),
    } as unknown as Pool

    const onRunTerminal = vi.fn()
    const proc = spawn({
      instanceId: 'wrc-1',
      pool,
      runPollMs: 30_000,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
      onRunTerminal,
    })

    await proc.syncFromRecipeExecution({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: 'child-recovered',
        namespace: 'sandbox-recipes',
        labels: { 'clerum.io/workflow-run-id': 'run-recovered' },
      },
      spec: {},
      status: {
        phase: 'active',
        workflowExecution: {
          phase: 'completed',
          completedAt: '2026-04-20T12:09:00Z',
        },
      },
    })

    expect(sawRecoveredTerminalPredicate).toBe(true)
    expect(onRunTerminal).toHaveBeenCalledWith('run-recovered', 'Succeeded')
  })

  it('does not mark a run Succeeded when workflowExecution is completed but declared steps are open', async () => {
    const client = makeClient(async sql => {
      if (/^BEGIN$/i.test(sql) || /^COMMIT$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/SET last_reconciled_at = now\(\)/i.test(sql)) return { rows: [], rowCount: 1 }
      if (/INSERT INTO workflow_run_steps/i.test(sql)) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const pool = {
      connect: vi.fn(async () => client as unknown as PoolClient),
    } as unknown as Pool
    const onRunTerminal = vi.fn()

    const proc = spawn({
      instanceId: 'wrc-1',
      pool,
      runPollMs: 30_000,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
      onRunTerminal,
    })

    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: 'child-xyz',
        namespace: 'sandbox-recipes',
        labels: { 'clerum.io/workflow-run-id': 'run-inconsistent' },
      },
      spec: { steps: [{ id: 'prepare' }, { id: 'emit' }] },
      status: {
        phase: 'active',
        workflowExecution: {
          phase: 'completed',
          completedAt: '2026-04-20T12:05:00Z',
        },
        steps: [
          { id: 'prepare', phase: 'completed' },
          { id: 'emit', phase: 'running' },
        ],
      },
    }

    expect(hasCompletedAllDeclaredSteps(recipe)).toBe(false)
    await proc.syncFromRecipeExecution(recipe)

    const terminalUpdate = client.calls.find(c =>
      /UPDATE workflow_runs[\s\S]*completed_at/i.test(c.sql)
    )
    expect(terminalUpdate).toBeUndefined()
    expect(client.calls.find(c => /SET last_reconciled_at = now\(\)/i.test(c.sql))).toBeDefined()
    expect(onRunTerminal).not.toHaveBeenCalled()
  })

  // ─── 5) heartbeat-only path (no execution phase) — DO NOT overwrite phase
  it('syncFromRecipeExecution preserves Running when execution phase is missing', async () => {
    const client = makeClient(async sql => {
      if (/^BEGIN$/i.test(sql) || /^COMMIT$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/SET last_reconciled_at = now\(\)/i.test(sql)) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const pool = {
      connect: vi.fn(async () => client as unknown as PoolClient),
    } as unknown as Pool
    const onRunTerminal = vi.fn()

    const proc = spawn({
      instanceId: 'wrc-1',
      pool,
      runPollMs: 30_000,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
      onRunTerminal,
    })

    const recipe = makeRecipeWithAnnotation('run-heartbeat')
    await proc.syncFromRecipeExecution(recipe)

    const terminalCall = client.calls.find(c => /completed_at/i.test(c.sql))
    expect(terminalCall).toBeUndefined()

    const heartbeat = client.calls.find(c => /SET last_reconciled_at = now\(\)/i.test(c.sql))
    expect(heartbeat).toBeDefined()
    expect(heartbeat?.params).toEqual(['run-heartbeat'])

    expect(onRunTerminal).not.toHaveBeenCalled()
  })

  // ─── 6) checkStuckRuns no-op when no rows match the timeout predicate
  it('checkStuckRuns is a no-op when no run exceeds max_duration_seconds', async () => {
    const client = makeClient(async sql => {
      if (/^BEGIN$/i.test(sql) || /^COMMIT$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/FROM workflow_runs[\s\S]*FOR UPDATE SKIP LOCKED/i.test(sql)) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    })
    const pool = {
      connect: vi.fn(async () => client as unknown as PoolClient),
    } as unknown as Pool

    const proc = spawn({
      instanceId: 'wrc-1',
      pool,
      runPollMs: 30_000,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
    })

    const failed = await proc.checkStuckRuns()
    expect(failed).toBe(0)

    const anyFail = client.calls.find(c =>
      /UPDATE workflow_runs[\s\S]*SET phase = 'Failed'/i.test(c.sql)
    )
    expect(anyFail).toBeUndefined()
  })

  // ─── 7) checkStuckRuns flips to Failed when started_at + max_duration elapsed
  it('checkStuckRuns force-fails stuck runs and notifies onRunTerminal', async () => {
    const stuckRows = [{ run_id: 'run-stuck-1' }]
    const client = makeClient(async sql => {
      if (/^BEGIN$/i.test(sql) || /^COMMIT$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/FROM workflow_runs[\s\S]*FOR UPDATE SKIP LOCKED/i.test(sql)) {
        return { rows: stuckRows, rowCount: stuckRows.length }
      }
      if (/UPDATE workflow_runs[\s\S]*SET phase = 'Failed'/i.test(sql)) {
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const pool = {
      connect: vi.fn(async () => client as unknown as PoolClient),
    } as unknown as Pool

    const onRunTerminal = vi.fn()
    const proc = spawn({
      instanceId: 'wrc-1',
      pool,
      runPollMs: 30_000,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
      onRunTerminal,
    })

    const failed = await proc.checkStuckRuns()
    expect(failed).toBe(1)
    expect(onRunTerminal).toHaveBeenCalledWith('run-stuck-1', 'Failed')

    const failUpdate = client.calls.find(c =>
      /UPDATE workflow_runs[\s\S]*SET phase = 'Failed'/i.test(c.sql)
    )
    expect(failUpdate?.params).toEqual(['run-stuck-1', 'wrc-1'])
  })

  // ─── 8) LISTEN reconnect: on session error, a new LISTEN session is
  //    attempted after the backoff.
  it('re-attaches LISTEN after the listener session errors', async () => {
    vi.useFakeTimers()

    let sessionIdx = 0
    const sessions: FakeClient[] = []

    const pool = {
      connect: vi.fn(async () => {
        const s = makeClient(async sql => {
          if (/^LISTEN workflow_run_update$/i.test(sql)) return { rows: [], rowCount: 0 }
          return { rows: [], rowCount: 0 }
        })
        sessions.push(s)
        sessionIdx += 1
        return s as unknown as PoolClient
      }),
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as unknown as Pool

    const proc = spawn({
      instanceId: 'wrc-1',
      pool,
      runPollMs: 60_000,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
    })

    await proc.start()
    await flush()

    expect(sessionIdx).toBe(1)

    // Emit a session error on the listener — the module should release and
    // schedule a reconnect in 1 second.
    sessions[0]!.emit('error', new Error('connection terminated'))
    expect(sessions[0]!.release).toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    await flush()

    expect(sessionIdx).toBeGreaterThanOrEqual(2)
  })

  // ─── 9) Advisory-lock split-brain: if another replica claims during SELECT
  //    FOR UPDATE→UPDATE window, the lost claim ends in ROLLBACK and does NOT
  //    stamp owner_instance_id.
  it('rolls back when another replica wins the claim (rowCount = 0 on CLAIM_PENDING)', async () => {
    const run = baseRun()
    let beginCount = 0
    let rollbackCount = 0
    let commitCount = 0

    const client = makeClient(async sql => {
      if (/^BEGIN$/i.test(sql)) {
        beginCount += 1
        return { rows: [], rowCount: 0 }
      }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 }
      if (RUN_READ_SQL.test(sql)) {
        return { rows: [run], rowCount: 1 }
      }
      if (/SET phase = 'Running'/.test(sql)) {
        // Simulate a winning concurrent UPDATE that already flipped phase away
        // from Pending, so our WHERE clause matches zero rows.
        return { rows: [], rowCount: 0 }
      }
      if (/^ROLLBACK$/i.test(sql)) {
        rollbackCount += 1
        return { rows: [], rowCount: 0 }
      }
      if (/^COMMIT$/i.test(sql)) {
        commitCount += 1
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    })
    const pool = { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool

    const proc = spawn({
      instanceId: 'wrc-loser',
      pool,
      runPollMs: 30_000,
      createChildRecipe: vi.fn(async () => ({ name: 'c', namespace: 'sandbox-recipes' })),
      logger: silentLogger(),
    })

    await proc.processPending(run.run_id)

    expect(beginCount).toBe(1)
    expect(rollbackCount).toBe(1)
    expect(commitCount).toBe(0)
  })

  // ─── 10) Poll fallback picks up runs that missed LISTEN
  it('poll loop invokes processPending for orphan runs found via FIND_ORPHAN_RUNS', async () => {
    vi.useFakeTimers()

    const orphanRow = baseRun({ run_id: 'run-orphan-1' })

    const pool = {
      connect: vi.fn(async () => {
        const c = makeClient(async (sql, params) => {
          if (/^LISTEN/i.test(sql)) return { rows: [], rowCount: 0 }
          if (/^BEGIN$/i.test(sql) || /^COMMIT$/i.test(sql) || /^ROLLBACK$/i.test(sql)) {
            return { rows: [], rowCount: 0 }
          }
          if (/pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 }
          if (RUN_READ_SQL.test(sql)) {
            // SELECT_RUN and SELECT_RUN_FOR_UPDATE — gate by param so only the orphan matches.
            expect(params).toEqual(['run-orphan-1'])
            return { rows: [orphanRow], rowCount: 1 }
          }
          if (/SET phase = 'Running'/.test(sql)) return { rows: [], rowCount: 1 }
          return { rows: [], rowCount: 0 }
        })
        return c as unknown as PoolClient
      }),
      query: vi.fn(async (sql: string) => {
        if (/FROM workflow_runs[\s\S]*LIMIT 50/i.test(sql)) {
          return { rows: [{ run_id: 'run-orphan-1', phase: 'Pending' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
    } as unknown as Pool

    const childSpy = vi.fn(async (_run: DbRunRow) => ({
      name: 'child-orphan',
      namespace: 'sandbox-recipes',
    }))
    const createChildRecipe: ChildRecipeCreator = childSpy

    const proc = spawn({
      instanceId: 'wrc-1',
      pool,
      runPollMs: 30_000,
      createChildRecipe,
      logger: silentLogger(),
    })

    await proc.start()
    await flush()

    // Advance to the next poll tick.
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    await flush()
    await flush()

    expect(childSpy).toHaveBeenCalledTimes(1)
    expect(childSpy.mock.calls[0]?.[0]?.run_id).toBe('run-orphan-1')
  })

  it('poll loop reclaims orphaned Running runs without recreating the child', async () => {
    vi.useFakeTimers()

    const createChildRecipe = vi.fn(async () => ({
      name: 'should-not-run',
      namespace: 'sandbox-recipes',
    }))

    const reclaimClient = makeClient(async (sql, params) => {
      if (/^BEGIN$/i.test(sql) || /^COMMIT$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 }
      if (/RETURNING child_recipe_name,\s*child_recipe_namespace/i.test(sql)) {
        expect(params).toEqual(['wrc-2', 'run-orphan-running-1'])
        return {
          rows: [{ child_recipe_name: 'child-orphan', child_recipe_namespace: 'sandbox-recipes' }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })
    const listenClient = makeClient(async sql => {
      if (/^LISTEN/i.test(sql)) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })

    let connectCount = 0
    const pool = {
      connect: vi.fn(async () => {
        connectCount += 1
        return (connectCount === 1 ? listenClient : reclaimClient) as unknown as PoolClient
      }),
      query: vi.fn(async (sql: string) => {
        if (/FROM workflow_runs[\s\S]*LIMIT 50/i.test(sql)) {
          return {
            rows: [{ run_id: 'run-orphan-running-1', phase: 'Running' }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      }),
    } as unknown as Pool

    const proc = spawn({
      instanceId: 'wrc-2',
      pool,
      runPollMs: 30_000,
      createChildRecipe,
      childRecipeExists: vi.fn(async () => true),
      logger: silentLogger(),
    })

    await proc.start()
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    await flush()

    expect(createChildRecipe).not.toHaveBeenCalled()
    const reclaim = reclaimClient.calls.find(c => /owner_instance_id = \$1/i.test(c.sql))
    expect(reclaim).toBeDefined()
  })

  it('reclaimed Running runs become eligible for timeout enforcement on the new owner', async () => {
    vi.useFakeTimers()

    const listenClient = makeClient(async sql => {
      if (/^LISTEN/i.test(sql)) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })
    const reclaimClient = makeClient(async sql => {
      if (/^BEGIN$/i.test(sql) || /^COMMIT$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 }
      if (/RETURNING child_recipe_name,\s*child_recipe_namespace/i.test(sql)) {
        return {
          rows: [{ child_recipe_name: 'child-orphan', child_recipe_namespace: 'sandbox-recipes' }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })
    const stuckClient = makeClient(async sql => {
      if (/^BEGIN$/i.test(sql) || /^COMMIT$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/FROM workflow_runs[\s\S]*FOR UPDATE SKIP LOCKED/i.test(sql)) {
        return { rows: [{ run_id: 'run-orphan-running-2' }], rowCount: 1 }
      }
      if (/UPDATE workflow_runs[\s\S]*SET phase = 'Failed'/i.test(sql)) {
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })

    let connectCount = 0
    const pool = {
      connect: vi.fn(async () => {
        connectCount += 1
        if (connectCount === 1) return listenClient as unknown as PoolClient
        if (connectCount === 2) return reclaimClient as unknown as PoolClient
        return stuckClient as unknown as PoolClient
      }),
      query: vi.fn(async (sql: string) => {
        if (/FROM workflow_runs[\s\S]*LIMIT 50/i.test(sql)) {
          return {
            rows: [{ run_id: 'run-orphan-running-2', phase: 'Running' }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      }),
    } as unknown as Pool

    const onRunTerminal = vi.fn()
    const proc = spawn({
      instanceId: 'wrc-3',
      pool,
      runPollMs: 30_000,
      createChildRecipe: vi.fn(),
      childRecipeExists: vi.fn(async () => true),
      logger: silentLogger(),
      onRunTerminal,
    })

    await proc.start()
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    await flush()

    const failed = await proc.checkStuckRuns()
    expect(failed).toBe(1)
    expect(onRunTerminal).toHaveBeenCalledWith('run-orphan-running-2', 'Failed')
    const failUpdate = stuckClient.calls.find(c =>
      /UPDATE workflow_runs[\s\S]*SET phase = 'Failed'/i.test(c.sql)
    )
    expect(failUpdate?.params).toEqual(['run-orphan-running-2', 'wrc-3'])
  })

  it('fails a reclaimed Running run when its child recipe no longer exists', async () => {
    vi.useFakeTimers()

    const listenClient = makeClient(async sql => {
      if (/^LISTEN/i.test(sql)) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })
    const workerClient = makeClient(async (sql, params) => {
      if (/^BEGIN$/i.test(sql) || /^COMMIT$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 }
      if (/RETURNING child_recipe_name,\s*child_recipe_namespace/i.test(sql)) {
        return {
          rows: [{ child_recipe_name: 'child-missing', child_recipe_namespace: 'sandbox-recipes' }],
          rowCount: 1,
        }
      }
      if (/SET phase = 'Failed'/.test(sql)) {
        expect(params).toEqual(['run-orphan-running-3', 'wrc-4'])
        return { rows: [], rowCount: 1 }
      }
      if (/FROM workflow_runs[\s\S]*FOR UPDATE SKIP LOCKED/i.test(sql)) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    })

    let connectCount = 0
    const pool = {
      connect: vi.fn(async () => {
        connectCount += 1
        if (connectCount === 1) return listenClient as unknown as PoolClient
        return workerClient as unknown as PoolClient
      }),
      query: vi.fn(async (sql: string) => {
        if (/FROM workflow_runs[\s\S]*LIMIT 50/i.test(sql)) {
          return {
            rows: [{ run_id: 'run-orphan-running-3', phase: 'Running' }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      }),
    } as unknown as Pool

    const childRecipeExists = vi.fn(async () => false)
    const onRunTerminal = vi.fn()
    const proc = spawn({
      instanceId: 'wrc-4',
      pool,
      runPollMs: 30_000,
      createChildRecipe: vi.fn(),
      childRecipeExists,
      logger: silentLogger(),
      onRunTerminal,
    })

    await proc.start()
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    await flush()
    await flush()

    expect(childRecipeExists).toHaveBeenCalledWith({
      name: 'child-missing',
      namespace: 'sandbox-recipes',
    })
    const failUpdate = workerClient.calls.find(c =>
      /UPDATE workflow_runs[\s\S]*SET phase = 'Failed'/i.test(c.sql)
    )
    expect(failUpdate).toBeDefined()
    expect(onRunTerminal).toHaveBeenCalledWith('run-orphan-running-3', 'Failed')
  })

  it('durably pauses a Running V2 run on checkpoint outage before the next boundary', async () => {
    let phase: DbRunRow['phase'] = 'Running'
    let failureReason: string | null = null
    const run = baseRun({
      phase,
      started_at: new Date(),
      actor_id: '11111111-1111-4111-8111-111111111111',
      authority_binding: {
        userId: '11111111-1111-4111-8111-111111111111',
        sid: '22222222-2222-4222-8222-222222222222',
        sessionVersion: 1,
        delegationJti: '33333333-3333-4333-8333-333333333333',
        operationId: 'workflow.trigger',
        resource: { type: 'workflow_recipe', logicalId: 'demo/echo' },
        target: { recipeNamespace: 'demo', recipeName: 'echo' },
        targetHash: 'ath2_test',
        accessPathId: 'ap1_test',
        authorizationRevision: 'ar1_test',
        behaviorBindingHash: 'bh2_test',
      },
    })
    const client = makeClient(async (sql, params) => {
      if (RUN_READ_SQL.test(sql)) {
        return { rows: [{ ...run, phase, failure_reason: failureReason }], rowCount: 1 }
      }
      if (/SET phase = 'AuthorizationPaused'/.test(sql)) {
        phase = 'AuthorizationPaused'
        failureReason = String(params?.[1])
        expect(params).toEqual([run.run_id, 'workflow_authority_unavailable'])
      }
      return { rows: [], rowCount: 1 }
    })
    const checkpointAuthority = vi.fn(async () => {
      throw new WorkflowAuthorityCheckpointError('authority_unavailable', true)
    })
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool,
      runPollMs: 30_000,
      checkpointAuthority,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
    })

    // Fresh pause: the reason is the string just written.
    await expect(proc.checkpointRunningBoundary(run.run_id)).resolves.toEqual({
      outcome: 'paused',
      failureReason: 'workflow_authority_unavailable',
    })
    expect(phase).toBe('AuthorizationPaused')
    expect(checkpointAuthority).toHaveBeenCalledOnce()
    expect(client.calls.some(call => /^COMMIT$/i.test(call.sql))).toBe(true)
    // Observed-paused exit: the reason is read back from the paused row.
    await expect(proc.checkpointRunningBoundary(run.run_id)).resolves.toEqual({
      outcome: 'paused',
      failureReason: 'workflow_authority_unavailable',
    })
    expect(checkpointAuthority).toHaveBeenCalledOnce()
  })

  it('keeps a legacy Running run outside V2 checkpoints', async () => {
    const run = baseRun({ phase: 'Running', started_at: new Date() })
    const client = makeClient(async sql =>
      RUN_READ_SQL.test(sql) ? { rows: [run], rowCount: 1 } : { rows: [], rowCount: 1 }
    )
    const checkpointAuthority = vi.fn()
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool,
      runPollMs: 30_000,
      checkpointAuthority,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
    })

    await expect(proc.checkpointRunningBoundary(run.run_id)).resolves.toEqual({
      outcome: 'allowed',
    })
    expect(checkpointAuthority).not.toHaveBeenCalled()
    expect(client.calls.some(call => /SET phase = 'AuthorizationPaused'/.test(call.sql))).toBe(
      false
    )
  })

  // A13 A-1 (owner decision A16 X1): a run with no authority binding is a
  // legacy V1 run; its row phase does not decide the running boundary, as at
  // dev, so a latched or force-failed run can still recover and finish.
  it.each(['Failed', 'Succeeded', 'Canceled', 'Pending'] as const)(
    'lets a legacy %s run with no authority binding pass the running boundary',
    async phase => {
      const run = baseRun({ phase })
      const client = makeClient(async sql =>
        RUN_READ_SQL.test(sql) ? { rows: [run], rowCount: 1 } : { rows: [], rowCount: 0 }
      )
      const checkpointAuthority = vi.fn()
      const proc = spawn({
        instanceId: 'wrc-1',
        pool: { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool,
        runPollMs: 30_000,
        checkpointAuthority,
        createChildRecipe: vi.fn(),
        logger: silentLogger(),
      })

      await expect(proc.checkpointRunningBoundary(run.run_id)).resolves.toEqual({
        outcome: 'allowed',
      })
      // Liveness witness: the boundary made its one read of the run.
      expect(client.calls.filter(call => RUN_READ_SQL.test(call.sql))).toHaveLength(1)
      expect(client.calls.some(call => /^\s*BEGIN/i.test(call.sql))).toBe(false)
      expect(checkpointAuthority).not.toHaveBeenCalled()
      expect(client.calls.some(call => /SET phase = 'AuthorizationPaused'/.test(call.sql))).toBe(
        false
      )
    }
  )

  it('still answers not_running for a bound Failed run without a checkpoint', async () => {
    const run = runWithBinding('binding-1', { phase: 'Failed' })
    const client = makeClient(async sql =>
      RUN_READ_SQL.test(sql) ? { rows: [run], rowCount: 1 } : { rows: [], rowCount: 0 }
    )
    const checkpointAuthority = vi.fn()
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool,
      runPollMs: 30_000,
      checkpointAuthority,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
    })

    await expect(proc.checkpointRunningBoundary(run.run_id)).resolves.toEqual({
      outcome: 'not_running',
    })
    expect(client.calls.filter(call => RUN_READ_SQL.test(call.sql))).toHaveLength(1)
    expect(checkpointAuthority).not.toHaveBeenCalled()
  })

  it('still answers not_running for a run with no row', async () => {
    const client = makeClient(async sql =>
      RUN_READ_SQL.test(sql) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }
    )
    const checkpointAuthority = vi.fn()
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool,
      runPollMs: 30_000,
      checkpointAuthority,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
    })

    await expect(proc.checkpointRunningBoundary('missing-run')).resolves.toEqual({
      outcome: 'not_running',
    })
    expect(client.calls.filter(call => RUN_READ_SQL.test(call.sql))).toHaveLength(1)
    expect(checkpointAuthority).not.toHaveBeenCalled()
  })

  it('keeps the AuthorizationPaused answer ahead of the V1 exit (row unreachable for bindingless runs)', async () => {
    const run = baseRun({ phase: 'AuthorizationPaused', failure_reason: 'authority_revoked' })
    const client = makeClient(async sql =>
      RUN_READ_SQL.test(sql) ? { rows: [run], rowCount: 1 } : { rows: [], rowCount: 0 }
    )
    const checkpointAuthority = vi.fn()
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool,
      runPollMs: 30_000,
      checkpointAuthority,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
    })

    await expect(proc.checkpointRunningBoundary(run.run_id)).resolves.toEqual({
      outcome: 'paused',
      failureReason: 'authority_revoked',
    })
    expect(client.calls.filter(call => RUN_READ_SQL.test(call.sql))).toHaveLength(1)
    expect(checkpointAuthority).not.toHaveBeenCalled()
  })

  // ─── Authority checkpoint outside the run transaction (plan r6 §3.2, §5.3)

  it('T-R1: checkpoints a bound Pending run outside any transaction, then claims it', async () => {
    const run = runWithBinding('binding-1')
    const client = makeClient(async sql => {
      if (RUN_READ_SQL.test(sql)) return { rows: [run], rowCount: 1 }
      if (/SET phase = 'Running'/.test(sql)) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const tripwire = createTransactionTripwire()
    const checkpointAuthority = vi.fn(tripwire.guard(async (_run: DbRunRow) => {}, 'checkpoint'))
    const createChildRecipe = vi.fn(async () => ({
      name: 'child-r1',
      namespace: 'sandbox-recipes',
    }))
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: tripwire.pool(client),
      runPollMs: 30_000,
      checkpointAuthority,
      createChildRecipe,
      logger: silentLogger(),
    })

    await expect(proc.processPending(run.run_id)).resolves.toBeUndefined()

    // Witness: the checkpoint ran once, on the row read without a transaction,
    // with no pooled client checked out (read client released, transaction
    // client not yet acquired: two checkouts in all).
    expect(checkpointAuthority).toHaveBeenCalledOnce()
    expect(checkpointAuthority).toHaveBeenCalledWith(run)
    expect(tripwire.violations).toEqual([])
    expect(tripwire.checkouts).toBe(2)
    expect(tripwire.checkedOut).toBe(0)
    // Then the claim committed under the advisory and row locks.
    const claim = client.calls.find(call => /SET phase = 'Running'/.test(call.sql))
    expect(claim?.params).toEqual(['wrc-1', 'child-r1', 'sandbox-recipes', run.run_id])
    expect(client.calls.some(call => LOCKED_RUN_READ_SQL.test(call.sql))).toBe(true)
    expect(client.calls[client.calls.length - 1]?.sql).toBe('COMMIT')
    expect(createChildRecipe).toHaveBeenCalledOnce()
    expect(tripwire.openTransactions).toBe(0)
    expect(tripwire.releasedInTransaction).toBe(0)
  })

  it.each([
    ['a different binding', 'binding-1', 'binding-2'],
    ['a binding where none was checked', null, 'binding-2'],
    ['no binding where one was checked', 'binding-1', null],
  ] as const)(
    'T-R2: rolls back without claiming when the locked read carries %s',
    async (_label, checkedBindingId, lockedBindingId) => {
      const observed = runWithBinding(checkedBindingId)
      const locked = runWithBinding(lockedBindingId)
      const client = makeClient(async sql => {
        if (LOCKED_RUN_READ_SQL.test(sql)) return { rows: [locked], rowCount: 1 }
        if (RUN_READ_SQL.test(sql)) return { rows: [observed], rowCount: 1 }
        if (/SET phase = 'Running'/.test(sql)) return { rows: [], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      })
      const tripwire = createTransactionTripwire()
      const checkpointAuthority = vi.fn(tripwire.guard(async (_run: DbRunRow) => {}, 'checkpoint'))
      const createChildRecipe = vi.fn(async () => ({
        name: 'child-r2',
        namespace: 'sandbox-recipes',
      }))
      const proc = spawn({
        instanceId: 'wrc-1',
        pool: tripwire.pool(client),
        runPollMs: 30_000,
        checkpointAuthority,
        createChildRecipe,
        logger: silentLogger(),
      })

      await expect(proc.processPending(observed.run_id)).resolves.toBeUndefined()

      // Witness: the locked read ran, and the checkpoint ran when a binding was read.
      expect(client.calls.some(call => LOCKED_RUN_READ_SQL.test(call.sql))).toBe(true)
      expect(checkpointAuthority).toHaveBeenCalledTimes(checkedBindingId ? 1 : 0)
      expect(tripwire.violations).toEqual([])
      expect(client.calls.some(call => /^ROLLBACK$/i.test(call.sql))).toBe(true)
      expect(client.calls.some(call => /SET phase = 'Running'/.test(call.sql))).toBe(false)
      expect(client.calls.some(call => /SET phase = 'AuthorizationPaused'/.test(call.sql))).toBe(
        false
      )
      expect(client.calls.some(call => /^COMMIT$/i.test(call.sql))).toBe(false)
      expect(createChildRecipe).not.toHaveBeenCalled()
      expect(tripwire.openTransactions).toBe(0)
    }
  )

  it('T-R3: answers paused when the run is paused while the boundary checkpoint runs', async () => {
    const observed = runWithBinding('binding-1', { phase: 'Running', failure_reason: null })
    const locked = runWithBinding('binding-1', {
      phase: 'AuthorizationPaused',
      failure_reason: 'workflow_authority_denied',
    })
    const client = makeClient(async sql => {
      if (LOCKED_RUN_READ_SQL.test(sql)) return { rows: [locked], rowCount: 1 }
      if (RUN_READ_SQL.test(sql)) return { rows: [observed], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    const tripwire = createTransactionTripwire()
    const checkpointAuthority = vi.fn(tripwire.guard(async (_run: DbRunRow) => {}, 'checkpoint'))
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: tripwire.pool(client),
      runPollMs: 30_000,
      checkpointAuthority,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
    })

    // The reason comes from the locked row, not from the observed one.
    await expect(proc.checkpointRunningBoundary(observed.run_id)).resolves.toEqual({
      outcome: 'paused',
      failureReason: 'workflow_authority_denied',
    })

    // Witness: the checkpoint answered allowed, and the locked re-read ran.
    expect(checkpointAuthority).toHaveBeenCalledOnce()
    expect(client.calls.some(call => LOCKED_RUN_READ_SQL.test(call.sql))).toBe(true)
    expect(tripwire.violations).toEqual([])
    expect(tripwire.checkouts).toBe(2)
    expect(tripwire.checkedOut).toBe(0)
    expect(client.calls.some(call => /SET phase = 'AuthorizationPaused'/.test(call.sql))).toBe(
      false
    )
    expect(tripwire.openTransactions).toBe(0)
  })

  it.each([
    ['allowed', async () => {}],
    [
      'rejected',
      async () => {
        throw new WorkflowAuthorityCheckpointError('denied', false)
      },
    ],
  ] as const)(
    'T-R3: throws a retryable authority_unavailable when the binding changes during a %s boundary checkpoint',
    async (_label, outcome) => {
      const observed = runWithBinding('binding-1', { phase: 'Running' })
      const locked = runWithBinding('binding-2', { phase: 'Running' })
      const client = makeClient(async sql => {
        if (LOCKED_RUN_READ_SQL.test(sql)) return { rows: [locked], rowCount: 1 }
        if (RUN_READ_SQL.test(sql)) return { rows: [observed], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      })
      const tripwire = createTransactionTripwire()
      const checkpointAuthority = vi.fn(tripwire.guard(outcome, 'checkpoint'))
      const proc = spawn({
        instanceId: 'wrc-1',
        pool: tripwire.pool(client),
        runPollMs: 30_000,
        checkpointAuthority,
        createChildRecipe: vi.fn(),
        logger: silentLogger(),
      })

      const failure = await proc.checkpointRunningBoundary(observed.run_id).then(
        () => null,
        (error: unknown) => error
      )

      expect(failure).toBeInstanceOf(WorkflowAuthorityCheckpointError)
      expect(failure).toMatchObject({ failure: 'authority_unavailable', retryable: true })
      // Witness: one checkpoint (no retry) and the locked re-read that saw the new binding.
      expect(checkpointAuthority).toHaveBeenCalledOnce()
      expect(client.calls.some(call => LOCKED_RUN_READ_SQL.test(call.sql))).toBe(true)
      expect(tripwire.violations).toEqual([])
      expect(tripwire.checkouts).toBe(2)
      expect(tripwire.checkedOut).toBe(0)
      expect(client.calls.some(call => /^ROLLBACK$/i.test(call.sql))).toBe(true)
      expect(client.calls.some(call => /^COMMIT$/i.test(call.sql))).toBe(false)
      expect(client.calls.some(call => /SET phase = 'AuthorizationPaused'/.test(call.sql))).toBe(
        false
      )
      expect(tripwire.openTransactions).toBe(0)
    }
  )

  // Each early return of the locked boundary step ends its transaction before
  // the client goes back to the pool (`releasedInTransaction` stays 0).
  const BOUNDARY_TRANSACTION_ENDINGS: ReadonlyArray<
    readonly [string, Partial<DbRunRow> | null, 'COMMIT' | 'ROLLBACK', RunningBoundaryOutcome]
  > = [
    ['the locked row is gone', null, 'ROLLBACK', { outcome: 'not_running' }],
    [
      'the locked row is already paused',
      { phase: 'AuthorizationPaused', failure_reason: 'workflow_authority_denied' },
      'ROLLBACK',
      { outcome: 'paused', failureReason: 'workflow_authority_denied' },
    ],
    [
      'the checkpoint allows the locked run',
      { phase: 'Running' },
      'COMMIT',
      { outcome: 'allowed' },
    ],
  ]

  it.each(BOUNDARY_TRANSACTION_ENDINGS)(
    'ends the boundary transaction before release when %s',
    async (_label, lockedOverrides, closing, expected) => {
      const observed = runWithBinding('binding-1', { phase: 'Running', failure_reason: null })
      const locked = lockedOverrides ? runWithBinding('binding-1', lockedOverrides) : null
      const client = makeClient(async sql => {
        if (LOCKED_RUN_READ_SQL.test(sql)) {
          return locked ? { rows: [locked], rowCount: 1 } : { rows: [], rowCount: 0 }
        }
        if (RUN_READ_SQL.test(sql)) return { rows: [observed], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      })
      const tripwire = createTransactionTripwire()
      const checkpointAuthority = vi.fn(tripwire.guard(async (_run: DbRunRow) => {}, 'checkpoint'))
      const proc = spawn({
        instanceId: 'wrc-1',
        pool: tripwire.pool(client),
        runPollMs: 30_000,
        checkpointAuthority,
        createChildRecipe: vi.fn(),
        logger: silentLogger(),
      })

      await expect(proc.checkpointRunningBoundary(observed.run_id)).resolves.toEqual(expected)

      // Witness: the checkpoint ran, the locked re-read ran, and exactly one
      // statement ended the transaction.
      expect(checkpointAuthority).toHaveBeenCalledOnce()
      expect(client.calls.some(call => LOCKED_RUN_READ_SQL.test(call.sql))).toBe(true)
      expect(
        client.calls.filter(call => /^(COMMIT|ROLLBACK)$/i.test(call.sql)).map(call => call.sql)
      ).toEqual([closing])
      expect(tripwire.violations).toEqual([])
      expect(tripwire.checkouts).toBe(2)
      expect(tripwire.checkedOut).toBe(0)
      expect(tripwire.releasedInTransaction).toBe(0)
    }
  )

  // ─── Running boundary outcomes (C13 spec §3, §4) ─────────────────────────

  it('answers paused with the reason stored on an already paused row, without a checkpoint', async () => {
    const observed = runWithBinding('binding-1', {
      phase: 'AuthorizationPaused',
      failure_reason: 'workflow_authority_denied',
    })
    const client = makeClient(async sql =>
      RUN_READ_SQL.test(sql) ? { rows: [observed], rowCount: 1 } : { rows: [], rowCount: 1 }
    )
    const checkpointAuthority = vi.fn()
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool,
      runPollMs: 30_000,
      checkpointAuthority,
      createChildRecipe: vi.fn(),
      logger: silentLogger(),
    })

    await expect(proc.checkpointRunningBoundary(observed.run_id)).resolves.toEqual({
      outcome: 'paused',
      failureReason: 'workflow_authority_denied',
    })

    // Witness: the unlocked read ran once and answered from its phase.
    expect(client.calls.filter(call => RUN_READ_SQL.test(call.sql))).toHaveLength(1)
    expect(client.calls.some(call => LOCKED_RUN_READ_SQL.test(call.sql))).toBe(false)
    expect(checkpointAuthority).not.toHaveBeenCalled()
  })

  it('T-4b: answers run_state_unavailable when the read stage cannot reach the run store', async () => {
    const refused = await captureConnectionRefused()
    const logger = silentLogger()
    const connect = vi.fn(async () => {
      throw refused
    })
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: { connect } as unknown as Pool,
      connect,
      runPollMs: 30_000,
      checkpointAuthority: vi.fn(),
      createChildRecipe: vi.fn(),
      logger,
    })

    await expect(proc.checkpointRunningBoundary('run-store-read')).resolves.toEqual({
      outcome: 'run_state_unavailable',
    })

    expect(connect).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledOnce()
    // Exact field set: neither the message nor the address/port keys of the
    // driver error are logged.
    expect(logger.error).toHaveBeenCalledWith(
      'workflow run store unreachable at running boundary',
      {
        run_id: 'run-store-read',
        stage: 'read',
        kind: 'network',
        code: 'ECONNREFUSED',
        name: 'Error',
      }
    )
  })

  it('T-4b: answers run_state_unavailable when the lock stage cannot reach the run store', async () => {
    const refused = await captureConnectionRefused()
    const logger = silentLogger()
    const observed = runWithBinding('binding-1', { phase: 'Running' })
    const client = makeClient(async sql =>
      RUN_READ_SQL.test(sql) ? { rows: [observed], rowCount: 1 } : { rows: [], rowCount: 1 }
    )
    let connects = 0
    const connect = vi.fn(async () => {
      connects += 1
      if (connects === 1) return client as unknown as PoolClient
      throw refused
    })
    const checkpointAuthority = vi.fn(async () => {})
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: { connect } as unknown as Pool,
      connect,
      runPollMs: 30_000,
      checkpointAuthority,
      createChildRecipe: vi.fn(),
      logger,
    })

    await expect(proc.checkpointRunningBoundary(observed.run_id)).resolves.toEqual({
      outcome: 'run_state_unavailable',
    })

    // Witness: the read stage ran and the checkpoint passed before the lock stage failed.
    expect(connect).toHaveBeenCalledTimes(2)
    expect(client.calls.filter(call => RUN_READ_SQL.test(call.sql))).toHaveLength(1)
    expect(checkpointAuthority).toHaveBeenCalledOnce()
    // No client was acquired for the lock stage, so nothing is rolled back.
    expect(client.calls.some(call => /^ROLLBACK$/i.test(call.sql))).toBe(false)
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(
      'workflow run store unreachable at running boundary',
      {
        run_id: observed.run_id,
        stage: 'lock',
        kind: 'network',
        code: 'ECONNREFUSED',
        name: 'Error',
      }
    )
  })

  it('T-4c: rethrows a run store error that is not an outage', async () => {
    const missingTable = Object.assign(new Error('relation "workflow_runs" does not exist'), {
      code: '42P01',
    })
    const logger = silentLogger()
    const client = makeClient(async () => {
      throw missingTable
    })
    const proc = spawn({
      instanceId: 'wrc-1',
      pool: { connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool,
      runPollMs: 30_000,
      checkpointAuthority: vi.fn(),
      createChildRecipe: vi.fn(),
      logger,
    })

    const failure = await proc.checkpointRunningBoundary('run-sql-defect').then(
      () => null,
      (error: unknown) => error
    )

    expect(failure).toBe(missingTable)
    // Witness: the read query was issued and rejected.
    expect(client.calls.filter(call => RUN_READ_SQL.test(call.sql))).toHaveLength(1)
    expect(logger.error).not.toHaveBeenCalled()
  })
})

/** The error the real `pg` driver raises for a closed loopback port. */
async function captureConnectionRefused(): Promise<Error> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no loopback port')
  await new Promise<void>(resolve => server.close(() => resolve()))
  const pool = new PgPool({
    host: '127.0.0.1',
    port: address.port,
    user: 'x',
    database: 'x',
    connectionTimeoutMillis: 2_000,
  })
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

// ─── Pure helper tests ─────────────────────────────────────────────────────

describe('mapWorkflowExecutionPhase', () => {
  it.each([
    ['initializing', 'Pending'],
    ['queued', 'Pending'],
    ['running', 'Running'],
    ['completed', 'Succeeded'],
    ['failed', 'Failed'],
    ['cancelled', 'Canceled'],
  ] as const)('maps %s → %s', (input, expected) => {
    expect(mapWorkflowExecutionPhase(input)).toBe(expected)
  })

  it('returns null for unknown phases', () => {
    expect(mapWorkflowExecutionPhase(undefined)).toBeNull()
    expect(mapWorkflowExecutionPhase('bogus')).toBeNull()
  })
})

describe('mapStepPhase', () => {
  it.each([
    ['completed', 'Succeeded'],
    ['failed', 'Failed'],
    ['skipped', 'Skipped'],
    ['cancelled', 'Canceled'],
    ['running', 'Running'],
    ['anything-else', 'Pending'],
  ])('maps %s → %s', (input, expected) => {
    expect(mapStepPhase(input)).toBe(expected)
  })
})
