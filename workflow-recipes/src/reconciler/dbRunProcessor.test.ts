import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import type { WorkflowRecipeCRD } from '../types.js'
import {
  type ChildRecipeCreator,
  type DbRunProcessor,
  type DbRunRow,
  createDbRunProcessor,
  hasCompletedAllDeclaredSteps,
  mapStepPhase,
  mapWorkflowExecutionPhase,
} from './dbRunProcessor.js'

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
      if (/FROM workflow_runs[\s\S]*FOR UPDATE/i.test(sql)) {
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
    expect(client.release).toHaveBeenCalledTimes(1)

    const sqlTrail = client.calls.map(c => c.sql.trim().slice(0, 40))
    expect(sqlTrail[0]).toBe('BEGIN')
    expect(sqlTrail.some(s => /pg_advisory_xact_lock/.test(s))).toBe(true)
    expect(sqlTrail[sqlTrail.length - 1]).toBe('COMMIT')

    const claim = client.calls.find(c => /SET phase = 'Running'/.test(c.sql))
    expect(claim).toBeDefined()
    expect(claim?.sql).toContain('started_at = now()')
    expect(claim?.params).toEqual(['wrc-1', 'child-run-1', 'sandbox-recipes', run.run_id])
  })

  // ─── 2) idempotency: if the row is already Running, skip child creation
  it('processPending is a no-op when the row is no longer Pending', async () => {
    const run = baseRun({ phase: 'Running', owner_instance_id: 'wrc-other' })
    const client = makeClient(async sql => {
      if (/^BEGIN$/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 }
      if (/FOR UPDATE/.test(sql)) return { rows: [run], rowCount: 1 }
      if (/^ROLLBACK$/i.test(sql)) return { rows: [], rowCount: 0 }
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

    expect(createChildRecipe).not.toHaveBeenCalled()
    const hasRollback = client.calls.some(c => /^ROLLBACK$/i.test(c.sql))
    expect(hasRollback).toBe(true)
  })

  // ─── 3) child recipe name+namespace land on claim UPDATE params (labels source)
  it('stamps child name/namespace into workflow_runs and preserves owner_instance_id', async () => {
    const run = baseRun({ run_id: 'aaaaaaaa-0000-0000-0000-000000000001' })
    const client = makeClient(async sql => {
      if (/FOR UPDATE/.test(sql)) return { rows: [run], rowCount: 1 }
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
    expect(upserts[1]?.params?.[2]).toBe('Running')
    expect(upserts[1]?.params?.[6]).toBeNull()
    expect(client.calls.indexOf(upserts[0]!)).toBeLessThan(client.calls.indexOf(terminalUpdate!))

    expect(onRunTerminal).toHaveBeenCalledWith('run-1', 'Succeeded')
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
      if (/FOR UPDATE/.test(sql) && !/SKIP LOCKED/.test(sql)) {
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
          if (/FOR UPDATE\s*$/i.test(sql.trim())) {
            // SELECT_RUN_FOR_UPDATE — gate by param so only the orphan matches.
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
})

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
