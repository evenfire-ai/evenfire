import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient, type QueryResult } from 'pg'
import {
  SignalPoller,
  StepCoordinator,
  createStaticRuntimeTokenProvider,
} from '@clerum/workflow-runtime-core'
import { buildDbRunProcessorOptions } from '../../workflow-recipes/src/k8sClient.js'
import {
  type DbRunProcessor,
  type WorkflowRunPhase,
  createDbRunProcessor,
} from '../../workflow-recipes/src/reconciler/dbRunProcessor.js'
import { WorkflowAuthorityCheckpointError } from '../../workflow-recipes/src/reconciler/workflowActionCheckpointClient.js'
import type { WorkflowRecipeCRD } from '../../workflow-recipes/src/types.js'
import { createWorkflowEndpointHandlers } from '../../workflow-recipes/src/workflow/restEndpoints.js'
import { drainSignals } from '../../workflow-recipes/src/workflow/signalStore.js'
import type { AuthenticatedRequest } from '../../workflow-recipes/src/workflow/workflowAuth.js'
import { initDb, pool } from '../src/db.js'
import { createRun } from '../src/services/workflowRunService.js'
import type { WorkflowAuthorityBinding } from '../src/services/workflows/workflowAuthorityBindingService.js'
import { getWorkflowPrincipalId } from '../src/services/workflows/workflowCallerService.js'
import {
  WorkflowRunCancelError,
  cancelWorkflowRun,
} from '../src/services/workflows/workflowRunCancelService.js'
import { RESUME_PAUSED_RUN } from '../src/services/workflows/workflowRunResumeService.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

// S30: model-based test of the cancel lifecycle (C6 "Model-based test").
//
// System under test: the workflow-recipes run processor, built with the
// production option builder (so cancel delivery and the duration cap come
// from it), on real PostgreSQL with the control-api schema; the real signal
// store and REST signal endpoint; the runtime's real StepCoordinator and
// SignalPoller; control-api's run producer (createRun), the X7 cancel service
// (which runs the X7 statements, approval cancel included) and the X8 resume
// statement, all imported, none retyped.
//
// Mocks only at the boundaries: the K8s child creator and existence check,
// the authority checkpoint (answers the model's current answer), the status
// reporter transport (calls syncFromRecipeExecution with the recipe status
// the runtime's report produces) and fetch of the signal GET (answered by the
// REST endpoint). `fc.scheduler()` gates the processor pool's autocommit
// queries, the checkpoint and the signal fetch, so the interleaving inside a
// tick is chosen by fast-check; every command ends at rest (nothing scheduled,
// no statement in flight) before the invariants are read.
//
// The LISTEN session is not attached: a notification arrives on the socket at
// a time no command controls. The tick fallback and the per-run DeliverTick
// cover the two calls a notification makes.
//
// One run per command sequence; its Trigger is the sequence's first step.

// A pass-through spy on the signal store, so SAF-h reads what is queued
// without draining it (a drain is itself the LoseSignalResponse event).
const queued = vi.hoisted(() => new Map<string, Set<string>>())
vi.mock('../../workflow-recipes/src/workflow/signalStore.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../workflow-recipes/src/workflow/signalStore.js')>()
  return {
    ...actual,
    enqueueSignal: (recipeName: string, signal: Parameters<typeof actual.enqueueSignal>[1]) => {
      actual.enqueueSignal(recipeName, signal)
      const ids = queued.get(recipeName) ?? new Set<string>()
      ids.add(signal.requestId)
      queued.set(recipeName, ids)
    },
    drainSignals: (recipeName: string) => {
      queued.delete(recipeName)
      return actual.drainSignals(recipeName)
    },
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const NS = 'model-recipes'
const SANDBOX = 'model-sandbox'
/** Operator cap (`workflowMaxRunDurationSeconds`) given to the option builder. */
const CAP_SECONDS = 3_600
/** control-api's stored duration when the trigger gives none. */
const STORED_DEFAULT_SECONDS = 86_400
const RUN_POLL_MS = 1_000
/** Runtime signal poll interval; one SignalPoll advances the fake clock by it. */
const SIGNAL_POLL_MS = 3_600_000
const NUM_RUNS = Number(process.env.WORKFLOW_CANCEL_MODEL_RUNS ?? 200)
const MAX_COMMANDS = 30
// A fixed default seed: the run asserts that every state of `reached` was
// visited, and about one random seed in three misses a rare one (a reclaimed
// or swept cancel, a paused run with a request). The scheduler makes a seed
// replay exactly. Set WORKFLOW_CANCEL_MODEL_SEED to explore other seeds.
const DEFAULT_SEED = 210
const SEED = process.env.WORKFLOW_CANCEL_MODEL_SEED
  ? Number(process.env.WORKFLOW_CANCEL_MODEL_SEED)
  : DEFAULT_SEED
const REPLAY_PATH = process.env.WORKFLOW_CANCEL_MODEL_PATH

type Phase = WorkflowRunPhase
type Actor = 'user' | 'scheduled'
type CallerName = 'launcher' | 'admin' | 'admin2' | 'member'
type Outcome = 'completed' | 'failed' | 'cancelled'
const TERMINAL: ReadonlySet<Phase> = new Set(['Succeeded', 'Failed', 'Canceled'])

const STEP_RUN = { type: 'snippet' as const, language: 'typescript' as const, code: 'return {}' }

interface TriggerParams {
  actor: Actor
  bound: boolean
  maxDuration: number | null
}

/** Reference model of the run (C0) and of its runtime pod. */
interface Model {
  runId: string
  childName: string
  actor: Actor
  bound: boolean
  maxDuration: number
  phase: Phase
  hasChild: boolean
  started: boolean
  owner: string | null
  cancelRequested: boolean
  canceledBy: string | null
  /** Seconds the clock was moved since the claim. */
  ageSeconds: number
  authority: 'allowed' | 'denied'
  instance: string
  /** A cancel signal is queued under the child name. */
  signalQueued: boolean
  everCanceled: boolean
  rtAlive: boolean
  rtCurrent: string | null
  rtHeld: boolean
  rtSeen: boolean
  rtOutcome: Outcome | null
  rtReported: boolean
}

/** States the runs must reach, so the invariants are not vacuous. */
const reached = {
  requestWithChild: 0,
  signalSeen: 0,
  canceledNoChild: 0,
  canceledBySync: 0,
  failedRelabeledBySync: 0,
  canceledBySweep: 0,
  canceledByReclaim: 0,
  pausedWithCancel: 0,
  resumeRefusedAfterRequest: 0,
  resumed: 0,
  stepFailedAfterRequest: 0,
  cancelRefused: 0,
}

let inflight = 0

async function tracked<T>(work: Promise<T>): Promise<T> {
  inflight += 1
  try {
    return await work
  } finally {
    inflight -= 1
  }
}

function gate(s: fc.Scheduler, label: string): Promise<string> {
  return s.schedule(Promise.resolve(label), label)
}

/** Releases scheduled tasks one by one until nothing is scheduled or in flight. */
async function settle(s: fc.Scheduler): Promise<void> {
  for (let round = 0; round < 20_000; round += 1) {
    if (s.count() > 0) {
      await s.waitNext(1)
      continue
    }
    await new Promise(resolve => setImmediate(resolve))
    if (s.count() === 0 && inflight === 0) {
      await new Promise(resolve => setImmediate(resolve))
      if (s.count() === 0 && inflight === 0) return
    }
  }
  throw new Error(`no rest: ${s.count()} scheduled, ${inflight} statements in flight`)
}

class HeldStepCancelled extends Error {}

/** The child pod: the real StepCoordinator and SignalPoller; steps end on commands. */
class Runtime {
  readonly poller: SignalPoller
  readonly coordinator = new StepCoordinator()
  readonly started: string[] = []
  readonly startedAfterSeen: string[] = []
  readonly completed: string[] = []
  current: { id: string; resolve: () => void; reject: (error: Error) => void } | null = null
  held = false
  outcome: Outcome | null = null
  failedStep: string | null = null
  dead = false

  constructor(
    readonly runId: string,
    readonly childName: string
  ) {
    this.poller = new SignalPoller({
      wrcUrl: 'http://wrc.model.test',
      workflowName: childName,
      tokenProvider: createStaticRuntimeTokenProvider({ wrcToken: 'wrc-model-token' }),
      intervalMs: SIGNAL_POLL_MS,
      runId,
    })
  }

  start(): void {
    this.poller.pollSignals(signal => {
      this.coordinator.injectSignal(signal)
      // The pause wait honours a cancel (sdkRuntime waitForAuthorizationResume).
      if (signal.type === 'cancel' && this.held) this.cancelHeldStep()
    })
    this.coordinator
      .runWorkflow(
        {
          name: this.childName,
          namespace: SANDBOX,
          steps: [
            { id: 's1', run: STEP_RUN },
            { id: 's2', dependsOn: ['s1'], run: STEP_RUN },
          ],
        } as unknown as Parameters<StepCoordinator['runWorkflow']>[0],
        step =>
          new Promise<unknown>((resolve, reject) => {
            this.started.push(step.id)
            if (this.poller.hasSignal('cancel')) this.startedAfterSeen.push(step.id)
            this.current = { id: step.id, resolve: () => resolve({ step: step.id }), reject }
          })
      )
      .then(
        () => {
          this.outcome = this.poller.hasSignal('cancel') ? 'cancelled' : 'completed'
        },
        (error: unknown) => {
          this.outcome = error instanceof HeldStepCancelled ? 'cancelled' : 'failed'
        }
      )
  }

  completeCurrent(): void {
    const step = this.current
    if (!step) throw new Error('no step is running')
    this.current = null
    this.completed.push(step.id)
    step.resolve()
  }

  failCurrent(): void {
    const step = this.current
    if (!step) throw new Error('no step is running')
    this.current = null
    this.failedStep = step.id
    step.reject(new Error(`step ${step.id} failed`))
  }

  cancelHeldStep(): void {
    const step = this.current
    if (!step) throw new Error('a held runtime has a running step')
    this.held = false
    this.current = null
    step.reject(new HeldStepCancelled('cancelled while paused'))
  }

  /** The child recipe the runtime's status report produces. */
  report(executionPhase: 'running' | Outcome): WorkflowRecipeCRD {
    const steps: { id: string; phase: string; error?: string }[] = this.completed.map(id => ({
      id,
      phase: 'completed',
    }))
    if (executionPhase === 'running' && this.current) {
      steps.push({ id: this.current.id, phase: 'running' })
    }
    if (executionPhase === 'failed' && this.failedStep) {
      steps.push({ id: this.failedStep, phase: 'failed', error: `step ${this.failedStep} failed` })
      if (this.failedStep === 's1') steps.push({ id: 's2', phase: 'skipped' })
    }
    return {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: this.childName,
        namespace: SANDBOX,
        labels: { 'clerum.io/workflow-run-id': this.runId },
      },
      spec: { steps: [{ id: 's1' }, { id: 's2' }] },
      status: { phase: 'active', workflowExecution: { phase: executionPhase }, steps },
    } as unknown as WorkflowRecipeCRD
  }

  kill(): void {
    this.dead = true
    this.poller.stop()
  }
}

interface Real {
  s: fc.Scheduler
  processor: DbRunProcessor
  runtime: Runtime | null
  authority: 'allowed' | 'denied'
  childExists: boolean
  childExistsAnsweredFalse: boolean
  notified: Phase[]
  processorErrors: string[]
}

function signalClaims(recipeName: string): AuthenticatedRequest['tokenClaims'] {
  return {
    sub: 'runtime',
    aud: 'clerum-wrc',
    iss: 'clerum-wrc',
    recipeName,
    recipeNamespace: SANDBOX,
    scopes: ['signal_read'],
  }
}

const handlers = createWorkflowEndpointHandlers(
  {} as Parameters<typeof createWorkflowEndpointHandlers>[0],
  SANDBOX
)

type CancelCaller = Parameters<typeof cancelWorkflowRun>[0]['caller']

describeRealPostgres('workflow run cancel lifecycle model (S30)', () => {
  const database = `workflow_cancel_model_${randomBytes(6).toString('hex')}`
  const recipe = `model-${randomBytes(4).toString('hex')}`
  const team = randomUUID()
  const users: Record<CallerName, { id: string; email: string }> = {
    launcher: { id: randomUUID(), email: `launcher-${randomUUID()}@example.test` },
    admin: { id: randomUUID(), email: `admin-${randomUUID()}@example.test` },
    admin2: { id: randomUUID(), email: `admin2-${randomUUID()}@example.test` },
    member: { id: randomUUID(), email: `member-${randomUUID()}@example.test` },
  }
  let adminPool: Pool
  let databasePool: Pool
  let current: Real | null = null
  let instanceCounter = 0

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    databasePool = new Pool({ connectionString: url.toString() })
    await initDb({ connect: () => databasePool.connect() })
    // control-api's producers use the core pool.
    vi.spyOn(pool, 'connect').mockImplementation((() =>
      databasePool.connect()) as unknown as typeof pool.connect)
    vi.spyOn(pool, 'query').mockImplementation(((...args: Parameters<typeof pool.query>) =>
      (databasePool.query as typeof pool.query)(...args)) as typeof pool.query)

    for (const [name, user] of Object.entries(users)) {
      await databasePool.query(`INSERT INTO users(id, email, name) VALUES ($1, $2, $3)`, [
        user.id,
        user.email,
        `Model ${name}`,
      ])
    }
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Model team')`, [team])
    for (const [name, role] of [
      ['admin', 'admin'],
      ['admin2', 'admin'],
      ['member', 'member'],
    ] as const) {
      await databasePool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
        [team, users[name].id, role]
      )
    }
    await databasePool.query(
      `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3)`,
      [team, NS, recipe]
    )

    // The runtime's signal GET, answered by the REST endpoint. A plain
    // response object keeps the body read off the I/O queue.
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const real = current
      if (!real) throw new Error('signal fetch outside a model run')
      await gate(real.s, 'signal fetch')
      const url = new URL(String(input))
      const match = /^\/api\/v1\/workflow\/([^/]+)\/signals$/.exec(url.pathname)
      if (!match) throw new Error(`unexpected fetch ${url.pathname}`)
      const name = decodeURIComponent(match[1])
      const answer = await handlers.getSignals(name, signalClaims(name))
      return {
        ok: answer.status === 200,
        status: answer.status,
        json: async () => answer.body,
      } as unknown as Response
    })
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    try {
      await endPoolAndWaitForClients(databasePool)
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await adminPool.end()
    }
  })

  // ── processor wiring ──────────────────────────────────────────────────

  /** A client in the workflow-recipes runtime role; LISTEN is not attached (see header). */
  async function runtimeClient(): Promise<PoolClient> {
    const client = await databasePool.connect()
    const statement = (args: unknown[]) => (typeof args[0] === 'string' ? args[0].trim() : '')
    return {
      query: async (...args: Parameters<PoolClient['query']>) => {
        const text = statement(args)
        if (/^(UN)?LISTEN\s/i.test(text))
          return { rows: [], rowCount: null } as unknown as QueryResult
        return tracked(
          (async () => {
            const result = await client.query(...args)
            if (text.toUpperCase() === 'BEGIN') {
              await client.query('SET LOCAL ROLE workflow_recipes_runtime')
            }
            return result
          })()
        )
      },
      on: (event: string, listener: (...values: unknown[]) => void) => {
        if (event !== 'notification') client.on(event as 'error', listener as () => void)
      },
      release: client.release.bind(client),
    } as unknown as PoolClient
  }

  /** The processor's pool: autocommit statements are scheduled, then run in the runtime role. */
  function processorPool(s: fc.Scheduler): Pool {
    return {
      connect: () => tracked(runtimeClient()),
      query: async (text: string, values?: unknown[]) => {
        await gate(s, `query ${text.trim().split(/\s+/).slice(0, 6).join(' ')}`)
        const client = await tracked(runtimeClient())
        try {
          await client.query('BEGIN')
          const result = (await client.query(text, values)) as QueryResult
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally {
          client.release()
        }
      },
    } as unknown as Pool
  }

  function buildProcessor(real: Real, instance: string): DbRunProcessor {
    const record = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
      if (level === 'error') real.processorErrors.push(`${msg} ${JSON.stringify(fields ?? {})}`)
    }
    const logger = {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      withStep: () => logger,
    }
    return createDbRunProcessor({
      ...buildDbRunProcessorOptions(
        {
          db: { instanceId: instance, runPollMs: RUN_POLL_MS },
          workflowMaxRunDurationSeconds: CAP_SECONDS,
        },
        processorPool(real.s),
        {
          createChildRecipe: async run => {
            const child = { name: `model-${run.run_id.slice(0, 8)}`, namespace: SANDBOX }
            if (real.runtime) throw new Error(`second child for run ${run.run_id}`)
            real.runtime = new Runtime(run.run_id, child.name)
            real.runtime.start()
            return child
          },
          checkpointAuthority: async () => {
            await gate(real.s, 'authority checkpoint')
            if (real.authority === 'denied') {
              throw new WorkflowAuthorityCheckpointError('denied', false)
            }
          },
          childRecipeExists: async child => {
            if (!real.childExists && real.runtime?.childName === child.name) {
              real.childExistsAnsweredFalse = true
              real.runtime.kill()
            }
            return real.childExists
          },
          onRunTerminal: (_runId, phase) => {
            real.notified.push(phase)
          },
        }
      ),
      logger,
    })
  }

  // ── control-api side ──────────────────────────────────────────────────

  function callerFor(name: CallerName): CancelCaller {
    const user = users[name]
    return {
      kind: 'user-session',
      claims: {
        userId: user.id,
        email: user.email,
        teamId: name === 'launcher' ? null : team,
        role: 'member',
        authGeneration: 1,
        exp: Math.floor(Date.now() / 1000) + 3_600,
      },
      session: { contract: 'v1', userId: user.id },
    } as unknown as CancelCaller
  }

  /** canCancel: the launcher of a user run; a live team admin of a scheduled run. */
  function mayCancel(actor: Actor, caller: CallerName): boolean {
    return actor === 'user' ? caller === 'launcher' : caller === 'admin' || caller === 'admin2'
  }

  function authorityFor(actor: Actor): WorkflowAuthorityBinding {
    const issuedAt = Math.floor(Date.now() / 1000)
    const target = { recipeNamespace: NS, recipeName: recipe }
    const binding = {
      version: 2,
      userId: users.launcher.id,
      sid: randomUUID(),
      sessionVersion: 1,
      delegationJti: randomUUID(),
      operationId: 'workflow.trigger',
      resource: { environmentId: 'model', type: 'workflow_recipe', logicalId: `${NS}/${recipe}` },
      target,
      targetHash: createHash('sha256').update(JSON.stringify(target)).digest('hex'),
      accessPathId: `ap1_${'a'.repeat(43)}`,
      authorizationRevision: `ar1_${'b'.repeat(43)}`,
      pathKind: actor === 'user' ? 'direct' : 'team',
      effectiveTeamId: actor === 'user' ? null : team,
      behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
    }
    return {
      binding: binding as unknown as WorkflowAuthorityBinding['binding'],
      sourceIssuedAt: issuedAt,
      sourceExpiresAt: issuedAt + 600,
      bindingHash: createHash('sha256').update(JSON.stringify(binding)).digest('hex'),
    }
  }

  async function trigger(params: TriggerParams, real: Real): Promise<Model> {
    const authority = params.bound ? authorityFor(params.actor) : null
    const { row } = await createRun({
      recipe_namespace: NS,
      recipe_name: recipe,
      actor_type: params.actor,
      team_id: params.actor === 'scheduled' ? team : null,
      actor_id: params.actor === 'user' ? getWorkflowPrincipalId(callerFor('launcher')) : null,
      idempotency_key: null,
      trigger_source: params.actor === 'user' ? 'onDemand' : 'schedule',
      inputs: {},
      max_duration_seconds: params.maxDuration,
      ttl_seconds_after_finished: 3_600,
      authority,
      // The trigger route's current-authority row check is outside this
      // model; the persisted binding is what the processor reads.
      validateCurrentInTransaction: authority ? async (_db, checked) => checked : undefined,
    })
    const runId = String(row.run_id)
    return {
      runId,
      childName: `model-${runId.slice(0, 8)}`,
      actor: params.actor,
      bound: params.bound,
      maxDuration: params.maxDuration ?? STORED_DEFAULT_SECONDS,
      phase: 'Pending',
      hasChild: false,
      started: false,
      owner: null,
      cancelRequested: false,
      canceledBy: null,
      ageSeconds: 0,
      authority: real.authority,
      instance: '',
      signalQueued: false,
      everCanceled: false,
      rtAlive: false,
      rtCurrent: null,
      rtHeld: false,
      rtSeen: false,
      rtOutcome: null,
      rtReported: false,
    }
  }

  /** Moves the run's clock back, as if `seconds` had passed. */
  async function advanceClock(m: Model, seconds: number): Promise<void> {
    if (seconds === 0) return
    await databasePool.query(
      `UPDATE workflow_runs
          SET started_at = started_at - make_interval(secs => $2),
              last_reconciled_at = last_reconciled_at - make_interval(secs => $2)
        WHERE run_id = $1`,
      [m.runId, seconds]
    )
    if (m.started) m.ageSeconds += seconds
  }

  // ── model transitions shared by commands ──────────────────────────────

  function claimed(m: Model): void {
    m.phase = 'Running'
    m.hasChild = true
    m.started = true
    m.owner = m.instance
    m.ageSeconds = 0
    m.rtAlive = true
    m.rtCurrent = 's1'
  }

  /** The phase UPDATE_RUN_TERMINAL writes for a terminal report, or null when its WHERE refuses. */
  function reportedPhase(m: Model, outcome: Outcome): Phase | null {
    const mapped: Phase =
      outcome === 'completed' ? 'Succeeded' : outcome === 'failed' ? 'Failed' : 'Canceled'
    const matches =
      m.phase === 'Pending' ||
      m.phase === 'Running' ||
      (m.phase === 'AuthorizationPaused' && (mapped === 'Failed' || mapped === 'Canceled')) ||
      (m.phase === 'Failed' && mapped === 'Succeeded')
    if (!matches) return null
    return mapped === 'Failed' && m.cancelRequested ? 'Canceled' : mapped
  }

  function runtimeCancelled(m: Model): void {
    m.rtHeld = false
    m.rtCurrent = null
    m.rtOutcome = 'cancelled'
  }

  // ── at-rest check after every command ─────────────────────────────────

  async function checkAtRest(m: Model, real: Real): Promise<void> {
    const { rows } = await databasePool.query<{
      phase: Phase
      requested: boolean
      canceled_by: string | null
      child_recipe_name: string | null
      owner_instance_id: string | null
      started: boolean
      max_duration_seconds: number | null
    }>(
      `SELECT phase, cancel_requested_at IS NOT NULL AS requested, canceled_by::text AS canceled_by,
              child_recipe_name, owner_instance_id, started_at IS NOT NULL AS started,
              max_duration_seconds
         FROM workflow_runs WHERE run_id = $1`,
      [m.runId]
    )
    expect(rows).toHaveLength(1)
    const row = rows[0]

    // The row the model predicts.
    expect({
      phase: row.phase,
      requested: row.requested,
      canceledBy: row.canceled_by,
      child: row.child_recipe_name,
      owner: row.owner_instance_id,
      started: row.started,
    }).toEqual({
      phase: m.phase,
      requested: m.cancelRequested,
      canceledBy: m.canceledBy,
      child: m.hasChild ? m.childName : null,
      owner: m.owner,
      started: m.started,
    })
    // L4: the inserted row is bounded.
    expect(row.max_duration_seconds).toBe(m.maxDuration)
    // SAF-c: the request and its canceller are set together (and the model
    // never rewrites canceledBy once set, so the row comparison above pins it).
    expect(row.requested).toBe(row.canceled_by !== null)
    // SAF-d: a run with a request that ended is Canceled or Succeeded.
    if (row.requested && TERMINAL.has(row.phase)) {
      expect(['Canceled', 'Succeeded']).toContain(row.phase)
    }
    // SAF-g: a row seen Canceled stays Canceled.
    if (m.everCanceled) expect(row.phase).toBe('Canceled')
    if (row.phase === 'Canceled') m.everCanceled = true
    // SAF-h: every queued cancel signal is this run's, under its child name, after a request.
    for (const [name, ids] of queued) {
      expect({ name, ids: [...ids], requested: row.requested }).toEqual({
        name: m.childName,
        ids: [`cancel:${m.runId}`],
        requested: true,
      })
    }
    expect(queued.has(m.childName)).toBe(m.signalQueued)
    // The terminal notification names the phase written.
    if (real.notified.length > 0) expect(real.notified.at(-1)).toBe(row.phase)
    expect(real.processorErrors).toEqual([])

    const runtime = real.runtime
    expect(Boolean(runtime && !runtime.dead)).toBe(m.rtAlive)
    if (runtime && m.rtAlive) {
      // SAF-e: no step starts after the runtime saw the cancel signal.
      expect(runtime.startedAfterSeen).toEqual([])
      expect({
        current: runtime.current?.id ?? null,
        held: runtime.held,
        seen: runtime.poller.hasSignal('cancel'),
        outcome: runtime.outcome,
      }).toEqual({
        current: m.rtCurrent,
        held: m.rtHeld,
        seen: m.rtSeen,
        outcome: m.rtOutcome,
      })
    }

    if (m.cancelRequested && m.hasChild) reached.requestWithChild += 1
    if (m.rtSeen) reached.signalSeen += 1
    if (m.phase === 'AuthorizationPaused' && m.cancelRequested) reached.pausedWithCancel += 1
  }

  // ── commands (C2 events) ──────────────────────────────────────────────

  class ModelCommand implements fc.AsyncCommand<Model, Real> {
    constructor(
      private readonly label: string,
      private readonly allowed: (m: Model) => boolean,
      private readonly apply: (m: Model, real: Real) => Promise<void>
    ) {}

    check(m: Readonly<Model>): boolean {
      return this.allowed(m as Model)
    }

    async run(m: Model, real: Real): Promise<void> {
      await this.apply(m, real)
      await checkAtRest(m, real)
    }

    toString(): string {
      return this.label
    }
  }

  const always = () => true
  const runtimeStep = (m: Model) =>
    m.rtAlive && m.rtCurrent !== null && !m.rtHeld && m.rtOutcome === null

  const processPending = new ModelCommand('ProcessPending', always, async (m, real) => {
    const op = real.processor.processPending(m.runId)
    await settle(real.s)
    await op
    if (m.phase !== 'Pending') return
    if (m.bound && m.authority === 'denied') {
      m.phase = 'AuthorizationPaused'
      m.owner = null
    } else {
      claimed(m)
    }
  })

  const cancel = (caller: CallerName) =>
    new ModelCommand(`Cancel(${caller})`, always, async (m, real) => {
      let status = 200
      await cancelWorkflowRun({
        runId: m.runId,
        recipeNamespace: NS,
        recipeName: recipe,
        caller: callerFor(caller),
        db: databasePool,
      }).catch((error: unknown) => {
        if (!(error instanceof WorkflowRunCancelError)) throw error
        status = error.status
      })
      await settle(real.s)
      let expected: number
      if (!mayCancel(m.actor, caller)) expected = 404
      else if (m.phase === 'Succeeded' || m.phase === 'Failed') expected = 409
      else expected = 200
      expect(status).toBe(expected)
      if (expected !== 200) {
        reached.cancelRefused += 1
        return
      }
      if (m.phase === 'Canceled' || m.cancelRequested) return
      m.cancelRequested = true
      m.canceledBy = users[caller].id
      if (!m.hasChild) {
        // L2: a 200 cancel of a run without a child ends it.
        m.phase = 'Canceled'
        reached.canceledNoChild += 1
      }
    })

  const resume = new ModelCommand('Resume', always, async (m, real) => {
    const client = await databasePool.connect()
    let resumed: number
    try {
      await client.query('BEGIN')
      const result = await client.query(RESUME_PAUSED_RUN, [m.runId, NS, recipe])
      await client.query('COMMIT')
      resumed = result.rowCount ?? 0
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    await settle(real.s)
    const expected = m.phase === 'AuthorizationPaused' && !m.cancelRequested
    if (m.phase === 'AuthorizationPaused' && m.cancelRequested) {
      reached.resumeRefusedAfterRequest += 1
    }
    // SAF-d: no resume succeeds after a cancel request.
    expect(resumed).toBe(expected ? 1 : 0)
    if (!expected) return
    reached.resumed += 1
    if (!m.started && !m.hasChild) {
      m.phase = 'Pending'
      m.owner = null
    } else {
      m.phase = 'Running'
    }
  })

  const boundaryReport = new ModelCommand('BoundaryReport', runtimeStep, async (m, real) => {
    const op = real.processor.checkpointRunningBoundary(m.runId)
    await settle(real.s)
    const answer = await op
    let expected: 'allowed' | 'paused' | 'not_running'
    if (!m.bound) expected = 'allowed'
    else if (m.phase === 'AuthorizationPaused') expected = 'paused'
    else if (m.phase !== 'Running') expected = 'not_running'
    else if (m.authority === 'denied') expected = 'paused'
    else expected = 'allowed'
    expect(answer.outcome).toBe(expected)
    if (expected === 'paused') {
      if (m.phase === 'Running') m.phase = 'AuthorizationPaused'
      const runtime = real.runtime!
      // The runtime waits in the pause loop; a cancel it already saw ends it.
      if (runtime.poller.hasSignal('cancel')) {
        runtime.held = true
        runtime.cancelHeldStep()
        await settle(real.s)
        runtimeCancelled(m)
      } else {
        runtime.held = true
        m.rtHeld = true
      }
      return
    }
    if (expected === 'allowed') {
      // The runtime's running report (UPDATE_RUN_PROGRESS: no phase change).
      const sync = real.processor.syncFromRecipeExecution(real.runtime!.report('running'))
      await settle(real.s)
      await sync
    }
  })

  /** The pause wait's status read: a run back to Running releases the held runtime. */
  const pauseWait = new ModelCommand(
    'PauseWait',
    m => m.rtAlive && m.rtHeld,
    async (m, real) => {
      if (m.phase === 'Running') {
        real.runtime!.held = false
        m.rtHeld = false
      }
    }
  )

  const stepCompleted = new ModelCommand('StepCompleted', runtimeStep, async (m, real) => {
    real.runtime!.completeCurrent()
    await settle(real.s)
    // The coordinator checks the signal at the next step boundary.
    if (m.rtCurrent === 's1' && !m.rtSeen) {
      m.rtCurrent = 's2'
      return
    }
    m.rtCurrent = null
    m.rtOutcome = m.rtSeen ? 'cancelled' : 'completed'
  })

  const stepFailed = new ModelCommand('StepFailed', runtimeStep, async (m, real) => {
    real.runtime!.failCurrent()
    await settle(real.s)
    if (m.cancelRequested) reached.stepFailedAfterRequest += 1
    m.rtCurrent = null
    m.rtOutcome = 'failed'
  })

  const reportCompleted = new ModelCommand(
    'ReportCompleted',
    m => m.rtAlive && m.rtOutcome !== null && !m.rtReported,
    async (m, real) => {
      const runtime = real.runtime!
      runtime.poller.stop()
      const sync = real.processor.syncFromRecipeExecution(runtime.report(runtime.outcome!))
      await settle(real.s)
      await sync
      m.rtReported = true
      const written = reportedPhase(m, m.rtOutcome!)
      if (!written) return
      if (written === 'Canceled' && m.phase !== 'Canceled') reached.canceledBySync += 1
      if (written === 'Canceled' && m.rtOutcome === 'failed') reached.failedRelabeledBySync += 1
      m.phase = written
    }
  )

  const signalPoll = new ModelCommand(
    'SignalPoll',
    m => m.rtAlive && !m.rtReported,
    async (m, real) => {
      vi.advanceTimersByTime(SIGNAL_POLL_MS)
      await settle(real.s)
      if (m.signalQueued) m.rtSeen = true
      m.signalQueued = false
      if (m.rtSeen && m.rtHeld) runtimeCancelled(m)
    }
  )

  const loseSignalResponse = new ModelCommand(
    'LoseSignalResponse',
    m => m.hasChild,
    async (m, real) => {
      const answer = await handlers.getSignals(m.childName, signalClaims(m.childName))
      expect(answer.status).toBe(200)
      await settle(real.s)
      m.signalQueued = false
    }
  )

  /** The poll tick's delivery (all runs) or a notification's (this run). */
  const deliverTick = (byRun: boolean) =>
    new ModelCommand(`DeliverTick(${byRun ? 'run' : 'all'})`, always, async (m, real) => {
      const op = real.processor.deliverCancelRequests(byRun ? m.runId : undefined)
      await settle(real.s)
      await op
      if (
        m.cancelRequested &&
        m.hasChild &&
        (m.phase === 'Running' || m.phase === 'AuthorizationPaused')
      ) {
        m.signalQueued = true
      }
    })

  const stuckSweep = (advance: number) =>
    new ModelCommand(`StuckSweep(+${advance}s)`, always, async (m, real) => {
      await advanceClock(m, advance)
      const op = real.processor.checkStuckRuns()
      await settle(real.s)
      const failed = await op
      const stuck =
        (m.phase === 'Running' || m.phase === 'AuthorizationPaused') &&
        m.owner === m.instance &&
        m.started &&
        m.ageSeconds >= Math.min(m.maxDuration, CAP_SECONDS)
      expect(failed).toBe(stuck ? 1 : 0)
      if (!stuck) return
      m.phase = m.cancelRequested ? 'Canceled' : 'Failed'
      if (m.cancelRequested) reached.canceledBySweep += 1
    })

  /** One production tick through start(): orphan poll, stuck sweep and cancel delivery, interleaved. */
  const reclaimTick = (advance: number, childPresent: boolean) =>
    new ModelCommand(
      `ReclaimTick(+${advance}s, child ${childPresent ? 'present' : 'missing'})`,
      always,
      async (m, real) => {
        await advanceClock(m, advance)
        real.childExists = childPresent
        real.childExistsAnsweredFalse = false
        const before = { ...m }
        await real.processor.start()
        vi.advanceTimersByTime(RUN_POLL_MS)
        await settle(real.s)
        await real.processor.stop()
        await settle(real.s)

        const { rows } = await databasePool.query<{
          phase: Phase
          owner_instance_id: string | null
        }>(`SELECT phase, owner_instance_id FROM workflow_runs WHERE run_id = $1`, [m.runId])
        const row = rows[0]
        // The three reads interleave, so the tick's result is one of a set.
        const allowed = new Set<Phase>([before.phase])
        if (before.phase === 'Pending') {
          allowed.add(
            before.bound && before.authority === 'denied' ? 'AuthorizationPaused' : 'Running'
          )
        }
        if (before.phase === 'Running' || before.phase === 'AuthorizationPaused') {
          allowed.add(before.cancelRequested ? 'Canceled' : 'Failed')
        }
        expect([...allowed]).toContain(row.phase)

        if (before.phase === 'Pending' && row.phase === 'Running') {
          claimed(m)
        } else if (before.phase === 'Pending' && row.phase === 'AuthorizationPaused') {
          m.phase = 'AuthorizationPaused'
          m.owner = null
        } else if (row.phase !== before.phase) {
          m.phase = row.phase
          if (row.phase === 'Canceled') {
            if (real.childExistsAnsweredFalse) reached.canceledByReclaim += 1
            else reached.canceledBySweep += 1
          }
        }
        // A reclaimed orphan gets this instance; any other run keeps its owner.
        expect([before.owner, m.instance]).toContain(row.owner_instance_id)
        m.owner = row.owner_instance_id
        if (real.childExistsAnsweredFalse) {
          // The child is gone: the reclaim ended the run, and the pod with it.
          expect(TERMINAL.has(row.phase)).toBe(true)
          m.rtAlive = false
        }
        // Delivery may run before or after a terminal write of the same tick.
        m.signalQueued = queued.has(m.childName)
      }
    )

  const authorityAnswer = (answer: 'allowed' | 'denied') =>
    new ModelCommand(`AuthorityAnswer(${answer})`, always, async (m, real) => {
      real.authority = answer
      m.authority = answer
    })

  const restartProcessor = new ModelCommand('RestartProcessor', always, async (m, real) => {
    // A new WRC pod: another instance id, an empty in-memory signal store.
    await real.processor.stop()
    instanceCounter += 1
    m.instance = `wrc-model-${instanceCounter}`
    real.processor = buildProcessor(real, m.instance)
    for (const name of [...queued.keys()]) drainSignals(name)
    m.signalQueued = false
  })

  const sweepCommand = fc.constantFrom(0, 30, 90, 4_000).map(stuckSweep)
  const reclaimCommand = fc
    .tuple(fc.constantFrom(0, 90, 4_000), fc.boolean())
    .map(([advance, present]) => reclaimTick(advance, present))
  const cancelCommand = fc
    .constantFrom<CallerName>('launcher', 'admin', 'admin2', 'member')
    .map(cancel)
  const authorityCommand = fc
    .constantFrom<'allowed' | 'denied'>('allowed', 'denied')
    .map(authorityAnswer)
  // Cancel, Resume, BoundaryReport, AuthorityAnswer, StuckSweep and
  // ReclaimTick are listed twice, and three runs in four are bound: a paused
  // run with a request needs a claim, a denied answer, a boundary report and
  // an allowed cancel, in order; a swept or reclaimed cancel needs a claim, a
  // cancel and a clock move.
  const commandArbitraries = [
    fc.constant(processPending),
    cancelCommand,
    cancelCommand,
    fc.constant(resume),
    fc.constant(resume),
    fc.constant(boundaryReport),
    fc.constant(boundaryReport),
    fc.constant(pauseWait),
    fc.constant(stepCompleted),
    fc.constant(stepFailed),
    fc.constant(reportCompleted),
    fc.constant(signalPoll),
    fc.boolean().map(deliverTick),
    sweepCommand,
    sweepCommand,
    reclaimCommand,
    reclaimCommand,
    authorityCommand,
    authorityCommand,
    fc.constant(restartProcessor),
    fc.constant(loseSignalResponse),
  ]

  /**
   * L3, bounded form: once the signal is delivered and polled, the running
   * step completes and the runtime reports, a run with a request and a child
   * is terminal. A Resume first: a paused run must refuse it (SAF-d) and
   * stay drainable.
   */
  async function drainCancel(m: Model, real: Real): Promise<void> {
    if (!(m.cancelRequested && m.hasChild)) return
    const drain = [
      resume,
      deliverTick(false),
      signalPoll,
      stepCompleted,
      stepCompleted,
      reportCompleted,
    ]
    for (const step of drain) {
      if (step.check(m)) await step.run(m, real)
    }
    expect(TERMINAL.has(m.phase)).toBe(true)
  }

  it(
    `holds the cancel invariants on every generated sequence (seed ${SEED}${REPLAY_PATH ? `, path ${REPLAY_PATH}` : ''})`,
    { timeout: 1_800_000 },
    async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      let runs = 0
      let longest = 0
      let longestGenerated = 0
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.scheduler(),
            fc.record({
              actor: fc.constantFrom<Actor>('user', 'scheduled'),
              bound: fc.constantFrom(true, true, true, false),
              maxDuration: fc.constantFrom<number | null>(null, 60, 7_200),
            }),
            fc.commands(commandArbitraries, { maxCommands: MAX_COMMANDS, size: 'max' }),
            async (s, triggerParams, commands) => {
              runs += 1
              await databasePool.query('TRUNCATE workflow_runs CASCADE')
              for (const name of [...queued.keys()]) drainSignals(name)
              const real: Real = {
                s,
                processor: undefined as unknown as DbRunProcessor,
                runtime: null,
                authority: 'allowed',
                childExists: true,
                childExistsAnsweredFalse: false,
                notified: [],
                processorErrors: [],
              }
              current = real
              try {
                const model = await trigger(triggerParams, real)
                instanceCounter += 1
                model.instance = `wrc-model-${instanceCounter}`
                real.processor = buildProcessor(real, model.instance)
                await checkAtRest(model, real)
                let executed = 0
                const generated = [...commands]
                longestGenerated = Math.max(longestGenerated, generated.length)
                const counted = generated.map(command => {
                  const run = command.run.bind(command)
                  return Object.assign(Object.create(command), {
                    run: async (mm: Model, rr: Real) => {
                      executed += 1
                      await run(mm, rr)
                    },
                  }) as typeof command
                })
                await fc.asyncModelRun(() => ({ model, real }), counted)
                longest = Math.max(longest, executed)
                await drainCancel(model, real)
              } finally {
                real.runtime?.kill()
                await real.processor?.stop()
                current = null
              }
            }
          ),
          { numRuns: NUM_RUNS, seed: SEED, path: REPLAY_PATH, endOnFailure: true }
        )
      } finally {
        vi.useRealTimers()
      }
      const summary = { seed: SEED, runs, longestGenerated, longestExecuted: longest, reached }
      process.stdout.write(`S30 ${JSON.stringify(summary)}\n`)
      expect(runs).toBe(REPLAY_PATH ? 1 : NUM_RUNS)
      if (!REPLAY_PATH) {
        // Sequences reach the budget; commands whose precondition fails are skipped.
        expect(longestGenerated).toBe(MAX_COMMANDS)
        expect(longest).toBeGreaterThanOrEqual(MAX_COMMANDS / 2)
        for (const [state, count] of Object.entries(reached)) {
          expect({ state, reached: count > 0 }).toEqual({ state, reached: true })
        }
      }
    }
  )
})
