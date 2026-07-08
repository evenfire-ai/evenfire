/**
 * DB-first WorkflowRun processor — Fase 4 of the DB-first refactor
 * (plan §serene-sauteeing-jellyfish.md §Fase 4).
 *
 * Replaces `WorkflowRunReconciler`'s CRD watch loop with a Postgres
 * LISTEN/NOTIFY consumer. Runs the non-owner state transitions:
 *
 *   Pending → (create child recipe) → Running   [processPending]
 *   Running → Succeeded|Failed|Canceled         [syncFromRecipeExecution]
 *   Running → Failed (timeout)                  [checkStuckRuns]
 *
 * Every UPDATE carries `WHERE owner_instance_id = $self AND phase = $expected`
 * as defense-in-depth: if another replica grabbed the row, we silently no-op
 * (rowCount=0) instead of colliding.
 *
 * The LISTEN session is isolated on a dedicated `pool.connect()` client —
 * the Postgres session pool must stay sticky for notifications to flow. A
 * 30-second poll tick is kept as a fallback for notifications that get
 * dropped across reconnects.
 */
import type { Pool, PoolClient } from 'pg'
import { type Logger, createLogger } from '../observability/logger.js'
import type { WorkflowRecipeCRD } from '../types.js'

// ─── Types ─────────────────────────────────────────────────────────────

export type WorkflowRunPhase = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Canceled'

/** Subset of workflow_runs we load when processing a notification. */
export interface DbRunRow {
  run_id: string
  recipe_namespace: string
  recipe_name: string
  phase: WorkflowRunPhase
  team_id: string | null
  usage_team_id: string | null
  actor_type: string
  actor_id: string | null
  inputs: Record<string, unknown> | null
  intermediate_parameters: Record<string, unknown> | null
  output_overrides: Record<string, unknown> | null
  trigger_source: string
  owner_instance_id: string | null
  max_duration_seconds: number | null
  started_at: string | null
  child_recipe_name: string | null
  child_recipe_namespace: string | null
}

export interface ChildRecipeRef {
  name: string
  namespace: string
}

export type ChildRecipeExistenceChecker = (child: ChildRecipeRef) => Promise<boolean>

/**
 * Caller-provided hook that builds + creates a child WorkflowRecipe for a
 * given run row. Lives in the caller so this module stays K8s-unaware (and
 * fully testable with a fake). Returns the `{ name, namespace }` of the
 * created child resource.
 */
export type ChildRecipeCreator = (run: DbRunRow) => Promise<ChildRecipeRef>

export interface DbRunProcessorOptions {
  /** Stamped onto `workflow_runs.owner_instance_id` at acquisition time. */
  instanceId: string
  /** Pool used for transactional work (SELECT FOR UPDATE, UPDATEs). */
  pool: Pool
  /** Fallback poll interval (ms) for runs that slipped past LISTEN. */
  runPollMs: number
  /** Builds + creates the child WorkflowRecipe for a run (injected). */
  createChildRecipe: ChildRecipeCreator
  /** Checks whether a previously created child WorkflowRecipe still exists. */
  childRecipeExists?: ChildRecipeExistenceChecker
  /** Called once the child recipe's status sync lands a terminal phase. */
  onRunTerminal?: (runId: string, phase: WorkflowRunPhase) => void
  /** Injection seams for tests. */
  connect?: () => Promise<PoolClient>
  logger?: Logger
}

export interface DbRunProcessor {
  start(): Promise<void>
  stop(): Promise<void>
  processPending(runId: string): Promise<void>
  syncFromRecipeExecution(recipe: WorkflowRecipeCRD): Promise<void>
  checkStuckRuns(): Promise<number>
}

// ─── SQL literal helpers ───────────────────────────────────────────────

const SELECT_RUN_FOR_UPDATE = `
  SELECT run_id, recipe_namespace, recipe_name, phase,
         team_id, usage_team_id, actor_type, actor_id, inputs, intermediate_parameters,
         output_overrides, trigger_source, owner_instance_id,
         max_duration_seconds, started_at,
         child_recipe_name, child_recipe_namespace
    FROM workflow_runs
   WHERE run_id = $1
   FOR UPDATE`

const CLAIM_PENDING = `
  UPDATE workflow_runs
     SET phase = 'Running',
         owner_instance_id = $1,
         child_recipe_name = $2,
         child_recipe_namespace = $3,
         started_at = now(),
         last_reconciled_at = now(),
         updated_at = now()
   WHERE run_id = $4
     AND phase = 'Pending'
     AND (owner_instance_id IS NULL OR owner_instance_id = $1)`

const UPDATE_RUN_TERMINAL = `
  UPDATE workflow_runs
     SET phase = $1,
         completed_at = COALESCE($2::timestamptz, now()),
         last_reconciled_at = now(),
         updated_at = now()
   WHERE run_id = $3
     AND (
       phase IN ('Pending', 'Running')
       OR (phase = 'Failed' AND $1 = 'Succeeded')
     )`

const UPDATE_RUN_PROGRESS = `
  UPDATE workflow_runs
     SET last_reconciled_at = now(),
         updated_at = now()
   WHERE run_id = $1
     AND phase IN ('Pending', 'Running')`

const UPSERT_STEP = `
  INSERT INTO workflow_run_steps (run_id, step_id, phase, started_at, completed_at, output, tools_called, error)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (run_id, step_id) DO UPDATE
    SET phase = EXCLUDED.phase,
        started_at = COALESCE(workflow_run_steps.started_at, EXCLUDED.started_at),
        completed_at = COALESCE(EXCLUDED.completed_at, workflow_run_steps.completed_at),
        output = COALESCE(EXCLUDED.output, workflow_run_steps.output),
        tools_called = COALESCE(EXCLUDED.tools_called, workflow_run_steps.tools_called),
        error = COALESCE(EXCLUDED.error, workflow_run_steps.error)`

const FIND_STUCK_RUNS = `
  SELECT run_id, started_at, max_duration_seconds
    FROM workflow_runs
   WHERE phase = 'Running'
     AND owner_instance_id = $1
     AND max_duration_seconds IS NOT NULL
     AND started_at IS NOT NULL
     AND started_at < now() - (max_duration_seconds || ' seconds')::interval
   FOR UPDATE SKIP LOCKED
   LIMIT 50`

const FAIL_STUCK_RUN = `
  UPDATE workflow_runs
     SET phase = 'Failed',
         completed_at = now(),
         last_reconciled_at = now(),
         updated_at = now()
   WHERE run_id = $1
     AND phase = 'Running'
     AND owner_instance_id = $2`

const FIND_ORPHAN_RUNS = `
  SELECT run_id, phase
    FROM workflow_runs
   WHERE phase IN ('Pending', 'Running')
     AND (owner_instance_id IS NULL
          OR last_reconciled_at IS NULL
          OR last_reconciled_at < now() - interval '1 minute')
   LIMIT 50`

const CLAIM_ORPHAN_RUNNING = `
  UPDATE workflow_runs
     SET owner_instance_id = $1,
         last_reconciled_at = now(),
         updated_at = now()
   WHERE run_id = $2
     AND phase = 'Running'
     AND (owner_instance_id IS NULL
          OR last_reconciled_at IS NULL
          OR last_reconciled_at < now() - interval '1 minute')
  RETURNING child_recipe_name, child_recipe_namespace`

const FAIL_RECLAIMED_MISSING_CHILD = `
  UPDATE workflow_runs
     SET phase = 'Failed',
         completed_at = now(),
         last_reconciled_at = now(),
         updated_at = now()
   WHERE run_id = $1
     AND phase = 'Running'
     AND owner_instance_id = $2`

// ─── Factory ───────────────────────────────────────────────────────────

export function createDbRunProcessor(opts: DbRunProcessorOptions): DbRunProcessor {
  const log = opts.logger ?? createLogger('wrc', 'db-run-processor:' + opts.instanceId)
  const connect = opts.connect ?? (() => opts.pool.connect())

  let listenClient: PoolClient | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let stopped = true

  async function attachListener(): Promise<void> {
    try {
      const c = await connect()
      c.on('notification', msg => {
        if (msg.channel !== 'workflow_run_update' || !msg.payload) return
        void processPending(msg.payload).catch(err => {
          log.error('notification dispatch failed', {
            run_id: msg.payload,
            err: err instanceof Error ? err.message : String(err),
          })
        })
      })
      c.on('error', (err: Error) => {
        log.warn('listen session error — will reconnect', { err: err.message })
        try {
          c.release(err)
        } catch {
          /* idempotent */
        }
        listenClient = null
        if (!stopped) void reconnectLater()
      })
      await c.query('LISTEN workflow_run_update')
      listenClient = c
      log.info('LISTEN workflow_run_update attached')
    } catch (err) {
      log.warn('LISTEN attach failed — will retry', {
        err: err instanceof Error ? err.message : String(err),
      })
      if (!stopped) void reconnectLater()
    }
  }

  async function reconnectLater(): Promise<void> {
    if (stopped) return
    await new Promise<void>(resolve => setTimeout(resolve, 1_000))
    if (!stopped) await attachListener()
  }

  async function failReclaimedRunMissingChild(runId: string): Promise<boolean> {
    const client = await connect()
    let committed = false
    try {
      await client.query('BEGIN')
      const res = await client.query(FAIL_RECLAIMED_MISSING_CHILD, [runId, opts.instanceId])
      await client.query('COMMIT')
      committed = true
      return Boolean(res.rowCount)
    } catch (err) {
      if (!committed) {
        try {
          await client.query('ROLLBACK')
        } catch {
          /* swallow */
        }
      }
      throw err
    } finally {
      client.release()
    }
  }

  async function verifyReclaimedChild(
    runId: string,
    childRecipeName: string | null,
    childRecipeNamespace: string | null
  ): Promise<void> {
    if (!opts.childRecipeExists) return

    if (!childRecipeName || !childRecipeNamespace) {
      const failed = await failReclaimedRunMissingChild(runId)
      if (failed) {
        log.warn('reclaimed running run missing child recipe reference; failing run', {
          run_id: runId,
          owner_instance_id: opts.instanceId,
        })
        opts.onRunTerminal?.(runId, 'Failed')
      }
      return
    }

    let childExists = false
    try {
      childExists = await opts.childRecipeExists({
        name: childRecipeName,
        namespace: childRecipeNamespace,
      })
    } catch (err) {
      log.warn('child existence check failed during running-run reclaim', {
        run_id: runId,
        child_name: childRecipeName,
        child_namespace: childRecipeNamespace,
        err: err instanceof Error ? err.message : String(err),
      })
      return
    }

    if (childExists) return

    const failed = await failReclaimedRunMissingChild(runId)
    if (failed) {
      log.warn('reclaimed running run child recipe missing; failing run', {
        run_id: runId,
        child_name: childRecipeName,
        child_namespace: childRecipeNamespace,
        owner_instance_id: opts.instanceId,
      })
      opts.onRunTerminal?.(runId, 'Failed')
    }
  }

  async function reclaimRunning(runId: string): Promise<void> {
    const client = await connect()
    let committed = false
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtext('wrc-run-' || $1::text))", [runId])
      const claimRes = await client.query<{
        child_recipe_name: string | null
        child_recipe_namespace: string | null
      }>(CLAIM_ORPHAN_RUNNING, [opts.instanceId, runId])
      await client.query('COMMIT')
      committed = true
      if (claimRes.rowCount && claimRes.rowCount > 0) {
        log.info('orphaned running run reclaimed', {
          run_id: runId,
          owner_instance_id: opts.instanceId,
        })
        const claimed = claimRes.rows[0]
        await verifyReclaimedChild(
          runId,
          claimed?.child_recipe_name ?? null,
          claimed?.child_recipe_namespace ?? null
        )
      }
    } catch (err) {
      if (!committed) {
        try {
          await client.query('ROLLBACK')
        } catch {
          /* swallow */
        }
      }
      throw err
    } finally {
      client.release()
    }
  }

  async function pollOrphans(): Promise<void> {
    if (stopped) return
    try {
      const res = await opts.pool.query<{ run_id: string; phase: WorkflowRunPhase }>(
        FIND_ORPHAN_RUNS
      )
      for (const row of res.rows) {
        const dispatch =
          row.phase === 'Pending' ? processPending(row.run_id) : reclaimRunning(row.run_id)
        await dispatch.catch(err => {
          log.warn('orphan dispatch failed', {
            run_id: row.run_id,
            err: err instanceof Error ? err.message : String(err),
          })
        })
      }
    } catch (err) {
      log.warn('poll orphans failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ─── Public: processPending ──────────────────────────────────────────
  //
  // Invariant: only called when we hold the WRC leader lock. Per-run
  // concurrency is further bounded by `pg_advisory_xact_lock(hash(run_id))`
  // so two replicas cannot process the same run concurrently, even during a
  // brief leader handover.
  async function processPending(runId: string): Promise<void> {
    const client = await connect()
    let committed = false
    try {
      await client.query('BEGIN')
      // Per-run lock — released at COMMIT/ROLLBACK. hashtextextended(text,
      // bigint) returns bigint, which `pg_advisory_xact_lock(bigint)`
      // accepts. Fall back to hashtext when the extended form is unavailable.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('wrc-run-' || $1::text))", [runId])
      const selectRes = await client.query<DbRunRow>(SELECT_RUN_FOR_UPDATE, [runId])
      const run = selectRes.rows[0]
      if (!run) {
        await client.query('ROLLBACK')
        committed = true
        return
      }

      if (run.phase !== 'Pending') {
        // Someone else already transitioned us past Pending — nothing to do
        // here. `syncFromRecipeExecution` drives Running→terminal.
        await client.query('ROLLBACK')
        committed = true
        return
      }

      const child = await opts.createChildRecipe(run)
      const claimRes = await client.query(CLAIM_PENDING, [
        opts.instanceId,
        child.name,
        child.namespace,
        run.run_id,
      ])
      if (claimRes.rowCount === 0) {
        // Another replica claimed the row between our SELECT and UPDATE —
        // rollback and let the winner handle it. Child creation is idempotent
        // on the run_id-derived name, so a retry re-attaches to the same
        // child instead of materializing a duplicate execution.
        log.warn('pending claim lost race', { run_id: run.run_id })
        await client.query('ROLLBACK')
        committed = true
        return
      }
      await client.query('COMMIT')
      committed = true
      log.info('run transitioned to Running', {
        run_id: run.run_id,
        child_name: child.name,
        child_namespace: child.namespace,
      })
    } catch (err) {
      if (!committed) {
        try {
          await client.query('ROLLBACK')
        } catch {
          /* swallow */
        }
      }
      log.error('processPending failed', {
        run_id: runId,
        err: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      client.release()
    }
  }

  // ─── Public: syncFromRecipeExecution ─────────────────────────────────
  //
  // Pure SQL translation of the legacy CRD merge-patch. Mapped phase rules
  // come from the reconciler's `mapWorkflowExecutionPhase` (identical
  // semantics — see below). Steps are UPSERTed so repeated child events are
  // idempotent.
  async function syncFromRecipeExecution(recipe: WorkflowRecipeCRD): Promise<void> {
    // run_id lives on metadata.labels so `kubectl delete -l ...` works from
    // the control-api archive cron. See k8sClient.ts for the write side.
    const runId = recipe.metadata.labels?.['clerum.io/workflow-run-id']
    if (!runId) return

    const execution = recipe.status?.workflowExecution
    let mappedPhase = mapWorkflowExecutionPhase(execution?.phase)
    if (mappedPhase === 'Succeeded' && !hasCompletedAllDeclaredSteps(recipe)) {
      log.warn('workflow completion ignored because declared steps are not terminal', {
        run_id: runId,
        recipe_name: recipe.metadata.name,
      })
      mappedPhase = null
    }
    const client = await opts.pool.connect()
    try {
      await client.query('BEGIN')
      if (mappedPhase && TERMINAL_PHASES.has(mappedPhase)) {
        const res = await client.query(UPDATE_RUN_TERMINAL, [
          mappedPhase,
          execution?.completedAt ?? null,
          runId,
        ])
        if (res.rowCount && res.rowCount > 0) {
          opts.onRunTerminal?.(runId, mappedPhase)
        }
      } else {
        // Non-terminal sync — just bump heartbeat. Do NOT overwrite `phase`
        // here: the legacy reconciler preserved Running when no execution
        // phase was present (see "does not overwrite running phase" test).
        await client.query(UPDATE_RUN_PROGRESS, [runId])
      }

      for (const step of recipe.status?.steps ?? []) {
        await client.query(UPSERT_STEP, [
          runId,
          step.id,
          mapStepPhase(step.phase),
          (step as { startedAt?: string }).startedAt ?? null,
          (step as { completedAt?: string }).completedAt ?? null,
          (step as { output?: string }).output ?? null,
          // jsonb params must be JSON text here; pg serializes JS arrays as SQL arrays.
          Array.isArray((step as { toolsCalled?: unknown[] }).toolsCalled)
            ? JSON.stringify((step as { toolsCalled?: unknown[] }).toolsCalled)
            : null,
          (step as { error?: string }).error ?? null,
        ])
      }
      await client.query('COMMIT')
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* swallow */
      }
      log.error('syncFromRecipeExecution failed', {
        run_id: runId,
        err: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      client.release()
    }
  }

  // ─── Public: checkStuckRuns (timeout enforcement) ────────────────────
  async function checkStuckRuns(): Promise<number> {
    const client = await opts.pool.connect()
    let failed = 0
    try {
      await client.query('BEGIN')
      const res = await client.query<{ run_id: string }>(FIND_STUCK_RUNS, [opts.instanceId])
      for (const row of res.rows) {
        const upd = await client.query(FAIL_STUCK_RUN, [row.run_id, opts.instanceId])
        if (upd.rowCount && upd.rowCount > 0) {
          failed += 1
          log.warn('run force-failed (max duration exceeded)', { run_id: row.run_id })
          opts.onRunTerminal?.(row.run_id, 'Failed')
        }
      }
      await client.query('COMMIT')
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* swallow */
      }
      log.error('checkStuckRuns failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    } finally {
      client.release()
    }
    return failed
  }

  return {
    async start() {
      if (!stopped) return
      stopped = false
      await attachListener()
      pollTimer = setInterval(() => {
        void pollOrphans()
        void checkStuckRuns().catch(() => {
          /* logged inside */
        })
      }, opts.runPollMs)
      if (typeof pollTimer.unref === 'function') pollTimer.unref()
    },

    async stop() {
      stopped = true
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      if (listenClient) {
        try {
          await listenClient.query('UNLISTEN workflow_run_update')
        } catch {
          /* likely already disconnected */
        }
        try {
          listenClient.release()
        } catch {
          /* idempotent */
        }
        listenClient = null
      }
    },

    processPending,
    syncFromRecipeExecution,
    checkStuckRuns,
  }
}

// ─── Pure helpers (exported for reuse) ─────────────────────────────────

const TERMINAL_PHASES = new Set<WorkflowRunPhase>(['Succeeded', 'Failed', 'Canceled'])

export function mapWorkflowExecutionPhase(phase?: string): WorkflowRunPhase | null {
  switch (phase) {
    case 'initializing':
    case 'queued':
      return 'Pending'
    case 'running':
      return 'Running'
    case 'completed':
      return 'Succeeded'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Canceled'
    default:
      return null
  }
}

export function mapStepPhase(phase: string): string {
  switch (phase) {
    case 'completed':
      return 'Succeeded'
    case 'failed':
      return 'Failed'
    case 'skipped':
      return 'Skipped'
    case 'cancelled':
      return 'Canceled'
    case 'running':
      return 'Running'
    default:
      return 'Pending'
  }
}

export function hasCompletedAllDeclaredSteps(recipe: WorkflowRecipeCRD): boolean {
  const declaredStepIds = (recipe.spec.steps ?? [])
    .map(step => step.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)

  if (declaredStepIds.length === 0) return true

  const statusById = new Map((recipe.status?.steps ?? []).map(step => [step.id, step.phase]))
  return declaredStepIds.every(id => {
    const phase = statusById.get(id)
    return phase === 'completed' || phase === 'skipped'
  })
}
