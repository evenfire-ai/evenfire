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
import { buildDbRunChildName } from '../../workflow-recipes/src/workflow/childRecipeFactory.js'
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
  cancelWorkflowRunAsOperator,
} from '../src/services/workflows/workflowRunCancelService.js'
import { RESUME_PAUSED_RUN } from '../src/services/workflows/workflowRunResumeService.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

// Model-based test of the cancel lifecycle.
//
// System under test: the workflow-recipes run processor, built with the
// production option builder (so cancel delivery and the duration cap come
// from it), on real PostgreSQL with the control-api schema; the real signal
// store and REST signal endpoint; the runtime's real StepCoordinator and
// SignalPoller; control-api's run producer (createRun), the cancel service
// through both of its entries, the user-session cancel and the operator cancel
// (each runs the same statements, approval cancel included), and the resume
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
// A sequence starts with no run. `Trigger` is a command, so one sequence holds
// up to MAX_RUNS runs of the same recipe; every other command picks a run or
// acts on all of them, and the invariants are read over every run. The child
// creator names children like production (`buildDbRunChildName`: the parent
// name and 8 hex of the run id). A trigger may ask for a run-id prefix
// collision with the sequence's first run: the run's child name is then
// the first run's, fixed at the trigger as production derives it from the run
// id. Production's create of a name another run's child still holds fails
// with its identity-mismatch error and leaves the run Pending; the mock does
// the same while another run's pod still runs. Modelling choice: a pod that
// ended (reported, or killed by a reclaim) stands for its child object being
// deleted, which in production is what frees the name.

// A pass-through spy on the signal store, so the queued-signal check reads what is queued
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
// The run budget: on the default seed it reaches every state of `reached`.
// WORKFLOW_CANCEL_MODEL_RUNS raises it for a deeper exploration.
const NUM_RUNS = Number(process.env.WORKFLOW_CANCEL_MODEL_RUNS ?? 200)
const MAX_COMMANDS = 30
/** Runs one command sequence may trigger. */
const MAX_RUNS = 3
// A fixed default seed keeps CI deterministic: the scheduler makes a seed
// replay exactly, and the run asserts that every state of `reached` was
// visited on it. Set WORKFLOW_CANCEL_MODEL_SEED to explore other seeds.
const DEFAULT_SEED = 210
const SEED = process.env.WORKFLOW_CANCEL_MODEL_SEED
  ? Number(process.env.WORKFLOW_CANCEL_MODEL_SEED)
  : DEFAULT_SEED
const REPLAY_PATH = process.env.WORKFLOW_CANCEL_MODEL_PATH

type Phase = WorkflowRunPhase
type Actor = 'user' | 'scheduled'
type UserCallerName = 'launcher' | 'admin' | 'admin2' | 'member'
/** The operator is a Control UI admin, not an application user. */
type CallerName = UserCallerName | 'operator'
type Outcome = 'completed' | 'failed' | 'cancelled'
const TERMINAL: ReadonlySet<Phase> = new Set(['Succeeded', 'Failed', 'Canceled'])

const STEP_RUN = { type: 'snippet' as const, language: 'typescript' as const, code: 'return {}' }

interface TriggerParams {
  actor: Actor
  bound: boolean
  maxDuration: number | null
  /** The run id collides with the first run's on the 8 hex the child name uses. */
  collide: boolean
}

/** Reference model of one run (C0) and of its runtime pod. */
interface RunModel {
  runId: string
  collide: boolean
  /** The run's child name, fixed at the trigger; the row holds it once the run has a child. */
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
  /** This run's cancel signal is queued under its child name. */
  signalQueued: boolean
  everCanceled: boolean
  rtAlive: boolean
  rtCurrent: string | null
  rtHeld: boolean
  rtSeen: boolean
  rtOutcome: Outcome | null
  rtReported: boolean
}

/** Reference model of the sequence: its runs and the state they share. */
interface World {
  runs: RunModel[]
  authority: 'allowed' | 'denied'
  instance: string
}

/**
 * States the runs reach, so the invariants are not vacuous. Each one must be
 * reached on the run's seed.
 */
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
  twoLivePods: 0,
  claimBlockedByLiveName: 0,
  sharedChildName: 0,
  foreignSignalDropped: 0,
  canceledByOperator: 0,
}

/** Production's error for a create of a child name another run's child holds. */
const CHILD_IDENTITY_MISMATCH = 'already exists but does not match the expected workflow run child'

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
  stopped = false

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

  /** The pod still runs and polls its child name. */
  get active(): boolean {
    return !this.dead && !this.stopped
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

  /** The pod reported its outcome and exits. */
  stopPolling(): void {
    this.stopped = true
    this.poller.stop()
  }

  kill(): void {
    this.dead = true
    this.poller.stop()
  }
}

interface Real {
  s: fc.Scheduler
  processor: DbRunProcessor
  runtimes: Map<string, Runtime>
  /** Each run's child name, fixed at its trigger (a colliding run has the first run's). */
  childNames: Map<string, string>
  authority: 'allowed' | 'denied'
  /** The child name the existence check answers missing for, during one ReclaimTick. */
  missingChild: string | null
  childExistsAnsweredFalse: boolean
  notified: Map<string, Phase[]>
  processorErrors: string[]
  /** processPending's error log before it rethrows, by run. */
  claimFailures: { runId: string; err: string }[]
  /** The tick's warn for a failed dispatch (dbRunProcessor pollOrphans), by run. */
  dispatchFailures: { runId: string; err: string }[]
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

describeRealPostgres('workflow run cancel lifecycle model', () => {
  const database = `workflow_cancel_model_${randomBytes(6).toString('hex')}`
  const recipe = `model-${randomBytes(4).toString('hex')}`
  const team = randomUUID()
  const users: Record<UserCallerName, { id: string; email: string }> = {
    launcher: { id: randomUUID(), email: `launcher-${randomUUID()}@example.test` },
    admin: { id: randomUUID(), email: `admin-${randomUUID()}@example.test` },
    admin2: { id: randomUUID(), email: `admin2-${randomUUID()}@example.test` },
    member: { id: randomUUID(), email: `member-${randomUUID()}@example.test` },
  }
  /** The Control UI admin who cancels as the operator; no row is read for it. */
  const operatorId = randomUUID()
  /** The model's own spelling of an operator's canceller, not production's helper. */
  const operatorCanceller = `operator:${operatorId}`
  let adminPool: Pool
  let databasePool: Pool
  let current: Real | null = null
  let instanceCounter = 0

  const childNameFor = (runId: string) => buildDbRunChildName(recipe, runId)

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
    try {
      vi.unstubAllGlobals()
      vi.useRealTimers()
      await endPoolAndWaitForClients(databasePool)
      if (!adminPool) return
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await adminPool?.end()
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
      const failure = { runId: String(fields?.run_id), err: String(fields?.err) }
      if (level === 'error' && msg === 'processPending failed') real.claimFailures.push(failure)
      else if (level === 'error') {
        real.processorErrors.push(`${msg} ${JSON.stringify(fields ?? {})}`)
      }
      if (level === 'warn' && msg === 'orphan dispatch failed') real.dispatchFailures.push(failure)
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
            if (real.runtimes.has(run.run_id)) throw new Error(`second child for run ${run.run_id}`)
            const name = real.childNames.get(run.run_id)
            if (!name) throw new Error(`run ${run.run_id} was not triggered by the model`)
            // dbRunChildRecipeCreator: a 409 on a child of another run throws.
            const held = [...real.runtimes.values()].some(rt => rt.childName === name && rt.active)
            if (held) {
              throw new Error(
                `Child recipe "${SANDBOX}/${name}" ${CHILD_IDENTITY_MISMATCH} identity and inherited intent`
              )
            }
            const runtime = new Runtime(run.run_id, name)
            real.runtimes.set(run.run_id, runtime)
            runtime.start()
            return { name, namespace: SANDBOX }
          },
          checkpointAuthority: async () => {
            await gate(real.s, 'authority checkpoint')
            if (real.authority === 'denied') {
              throw new WorkflowAuthorityCheckpointError('denied', false)
            }
          },
          childRecipeExists: async child => {
            if (real.missingChild === null || child.name !== real.missingChild) return true
            real.childExistsAnsweredFalse = true
            for (const runtime of real.runtimes.values()) {
              if (runtime.childName === child.name && runtime.active) runtime.kill()
            }
            return false
          },
          onRunTerminal: (runId, phase) => {
            const phases = real.notified.get(runId) ?? []
            phases.push(phase)
            real.notified.set(runId, phases)
          },
        }
      ),
      logger,
    })
  }

  // ── control-api side ──────────────────────────────────────────────────

  function callerFor(name: UserCallerName): CancelCaller {
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

  /**
   * canCancel: the launcher of a user run; a live team admin of a scheduled
   * run. The operator may cancel any run of the recipe (owner decision).
   */
  function mayCancel(actor: Actor, caller: CallerName): boolean {
    if (caller === 'operator') return true
    return actor === 'user' ? caller === 'launcher' : caller === 'admin' || caller === 'admin2'
  }

  /** A caller other than the operator who may cancel a run of `actor`. */
  const cancellerOf = (actor: Actor): UserCallerName => (actor === 'user' ? 'launcher' : 'admin')

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

  async function trigger(
    params: TriggerParams,
    real: Real,
    first: RunModel | undefined
  ): Promise<RunModel> {
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
    const collide = params.collide && first !== undefined
    const childName = collide ? first.childName : childNameFor(runId)
    real.childNames.set(runId, childName)
    return {
      runId,
      collide,
      childName,
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
  async function advanceClock(m: RunModel, seconds: number): Promise<void> {
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

  async function childRecipeNameOf(runId: string): Promise<string | null> {
    const { rows } = await databasePool.query<{ child: string | null }>(
      `SELECT child_recipe_name AS child FROM workflow_runs WHERE run_id = $1`,
      [runId]
    )
    expect(rows).toHaveLength(1)
    return rows[0].child
  }

  // ── model transitions shared by commands ──────────────────────────────

  /** The runtime of this run still runs and polls. */
  const polling = (m: RunModel) => m.rtAlive && !m.rtReported

  /**
   * The live pod of another run holding the run's child name, if any (the
   * model of the creator's 409); a pod polling `deadName` counts as gone.
   */
  function nameHeld(w: World, m: RunModel, deadName: string | null): boolean {
    if (m.childName === deadName) return false
    return w.runs.some(r => r !== m && r.hasChild && r.childName === m.childName && polling(r))
  }

  /**
   * The run got its child and pod. The pod's first signal poll drains its
   * child name: a cancel another run left under that name is dropped.
   */
  function claimed(w: World, m: RunModel): void {
    const childName = m.childName
    const others = w.runs.filter(r => r !== m && r.hasChild && r.childName === childName)
    if (others.length > 0) reached.sharedChildName += 1
    for (const other of others) if (other.signalQueued) reached.foreignSignalDropped += 1
    m.phase = 'Running'
    m.hasChild = true
    m.started = true
    m.owner = w.instance
    m.ageSeconds = 0
    m.rtAlive = true
    m.rtCurrent = 's1'
    for (const other of w.runs) {
      if (other.hasChild && other.childName === childName) other.signalQueued = false
    }
  }

  /** The phase UPDATE_RUN_TERMINAL writes for a terminal report, or null when its WHERE refuses. */
  function reportedPhase(m: RunModel, outcome: Outcome): Phase | null {
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

  function runtimeCancelled(m: RunModel): void {
    m.rtHeld = false
    m.rtCurrent = null
    m.rtOutcome = 'cancelled'
  }

  /** A run cancel delivery reaches: a request, a child, and not ended. */
  const deliverable = (m: RunModel) =>
    m.cancelRequested && m.hasChild && (m.phase === 'Running' || m.phase === 'AuthorizationPaused')

  /** Every live poller drains its child name; a poller keeps only its own run's cancel. */
  function pollersDrained(w: World): void {
    const pollers = w.runs.filter(polling)
    for (const m of pollers) if (m.signalQueued) m.rtSeen = true
    for (const m of pollers) {
      for (const other of w.runs) {
        if (!other.hasChild || other.childName !== m.childName) continue
        if (other !== m && other.signalQueued) reached.foreignSignalDropped += 1
        other.signalQueued = false
      }
    }
    for (const m of pollers) if (m.rtSeen && m.rtHeld) runtimeCancelled(m)
  }

  // ── at-rest check after every command ─────────────────────────────────

  async function checkAtRest(w: World, real: Real): Promise<void> {
    const { rows } = await databasePool.query<{
      run_id: string
      phase: Phase
      requested: boolean
      canceled_by: string | null
      child_recipe_name: string | null
      owner_instance_id: string | null
      started: boolean
      max_duration_seconds: number | null
    }>(
      `SELECT run_id::text AS run_id, phase, cancel_requested_at IS NOT NULL AS requested,
              canceled_by::text AS canceled_by, child_recipe_name, owner_instance_id,
              started_at IS NOT NULL AS started, max_duration_seconds
         FROM workflow_runs`
    )
    expect(rows).toHaveLength(w.runs.length)
    const byId = new Map(rows.map(row => [row.run_id, row]))

    for (const m of w.runs) {
      const row = byId.get(m.runId)
      if (!row) throw new Error(`run ${m.runId} has no row`)

      // The row the model predicts.
      expect({
        run: m.runId,
        phase: row.phase,
        requested: row.requested,
        canceledBy: row.canceled_by,
        child: row.child_recipe_name,
        owner: row.owner_instance_id,
        started: row.started,
      }).toEqual({
        run: m.runId,
        phase: m.phase,
        requested: m.cancelRequested,
        canceledBy: m.canceledBy,
        child: m.hasChild ? m.childName : null,
        owner: m.owner,
        started: m.started,
      })
      // The inserted row is bounded.
      expect(row.max_duration_seconds).toBe(m.maxDuration)
      // The request and its canceller are set together (and the model
      // never rewrites canceledBy once set, so the row comparison above pins it).
      expect(row.requested).toBe(row.canceled_by !== null)
      // The canceller is an operator exactly when the operator's cancel was the
      // one that stored the request.
      const operatorCancelled = row.canceled_by?.startsWith('operator:') ?? false
      expect({ run: m.runId, operatorCancelled }).toEqual({
        run: m.runId,
        operatorCancelled: m.canceledBy === operatorCanceller,
      })
      if (operatorCancelled) reached.canceledByOperator += 1
      // A run with a request that ended is Canceled or Succeeded.
      if (row.requested && TERMINAL.has(row.phase)) {
        expect(['Canceled', 'Succeeded']).toContain(row.phase)
      }
      // A row seen Canceled stays Canceled.
      if (m.everCanceled) expect(row.phase).toBe('Canceled')
      if (row.phase === 'Canceled') m.everCanceled = true
      // This run's own cancel signal is queued exactly when the model says so.
      const ownQueued = m.hasChild && (queued.get(m.childName)?.has(`cancel:${m.runId}`) ?? false)
      expect({ run: m.runId, queued: ownQueued }).toEqual({ run: m.runId, queued: m.signalQueued })
      // The terminal notification names the phase written.
      const notified = real.notified.get(m.runId) ?? []
      if (notified.length > 0) expect(notified.at(-1)).toBe(row.phase)

      const runtime = real.runtimes.get(m.runId)
      expect(Boolean(runtime && !runtime.dead)).toBe(m.rtAlive)
      if (runtime) {
        // A pod holds a cancel only when its own run has a request.
        if (runtime.poller.hasSignal('cancel')) expect(row.requested).toBe(true)
      }
      if (runtime && m.rtAlive) {
        // No step starts after the runtime saw the cancel signal.
        expect(runtime.startedAfterSeen).toEqual([])
        expect({
          run: m.runId,
          current: runtime.current?.id ?? null,
          held: runtime.held,
          seen: runtime.poller.hasSignal('cancel'),
          outcome: runtime.outcome,
        }).toEqual({
          run: m.runId,
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

    // Every queued cancel signal belongs to a run with a request,
    // under that run's child name.
    for (const [name, ids] of queued) {
      for (const id of ids) {
        const owner = w.runs.find(r => `cancel:${r.runId}` === id)
        expect({
          name,
          id,
          owner: owner
            ? {
                child: owner.hasChild ? owner.childName : null,
                requested: byId.get(owner.runId)?.requested ?? false,
              }
            : null,
        }).toEqual({ name, id, owner: { child: name, requested: true } })
      }
    }
    // One live pod per child name (production refuses a second child of a live name).
    const live = [...real.runtimes.values()].filter(rt => rt.active).map(rt => rt.childName)
    expect(new Set(live).size).toBe(live.length)
    if (live.length >= 2) reached.twoLivePods += 1
    expect(real.processorErrors).toEqual([])
    // A claim fails only on the creator's 409 for a held child name, and the
    // run it failed for is still Pending.
    for (const failure of [...real.claimFailures, ...real.dispatchFailures]) {
      expect(failure.err).toContain(CHILD_IDENTITY_MISMATCH)
      expect(byId.get(failure.runId)?.phase).toBe('Pending')
    }
    real.claimFailures.length = 0
    real.dispatchFailures.length = 0
  }

  // ── commands ──────────────────────────────────────────────────────────

  class ModelCommand implements fc.AsyncCommand<World, Real> {
    constructor(
      private readonly label: string,
      private readonly allowed: (w: World) => boolean,
      private readonly apply: (w: World, real: Real) => Promise<void>
    ) {}

    check(w: Readonly<World>): boolean {
      return this.allowed(w as World)
    }

    async run(w: World, real: Real): Promise<void> {
      await this.apply(w, real)
      await checkAtRest(w, real)
    }

    toString(): string {
      return this.label
    }
  }

  /** A command on one run: `pick` selects it among the runs triggered so far. */
  function onRun(
    label: string,
    pick: number,
    allowed: (m: RunModel, w: World) => boolean,
    apply: (m: RunModel, w: World, real: Real) => Promise<void>
  ): ModelCommand {
    const runAt = (w: World) => w.runs[pick % w.runs.length]
    return new ModelCommand(
      `${label}@${pick}`,
      w => w.runs.length > 0 && allowed(runAt(w), w),
      (w, real) => apply(runAt(w), w, real)
    )
  }

  const always = () => true
  const runtimeStep = (m: RunModel) =>
    m.rtAlive && m.rtCurrent !== null && !m.rtHeld && m.rtOutcome === null

  const triggerCommand = (params: TriggerParams) =>
    new ModelCommand(
      `Trigger(${params.actor}, ${params.bound ? 'bound' : 'unbound'}, ${params.maxDuration ?? 'null'}${params.collide ? ', collides' : ''})`,
      w => w.runs.length < MAX_RUNS,
      async (w, real) => {
        w.runs.push(await trigger(params, real, w.runs[0]))
        await settle(real.s)
      }
    )

  const processPending = (pick: number) =>
    onRun('ProcessPending', pick, always, async (m, w, real) => {
      const held = nameHeld(w, m, null)
      const op = real.processor.processPending(m.runId).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      await settle(real.s)
      const rejected = await op
      if (m.phase !== 'Pending' || (m.bound && w.authority === 'denied')) {
        expect(rejected).toBeNull()
        if (m.phase === 'Pending') {
          m.phase = 'AuthorizationPaused'
          m.owner = null
        }
        return
      }
      if (held) {
        // The create fails and the claim rolls back: the run stays Pending.
        expect(rejected).toContain(CHILD_IDENTITY_MISMATCH)
        expect(real.claimFailures.map(failure => failure.runId)).toContain(m.runId)
        reached.claimBlockedByLiveName += 1
        return
      }
      expect(rejected).toBeNull()
      const child = await childRecipeNameOf(m.runId)
      expect(child).toBe(m.childName)
      claimed(w, m)
    })

  const cancel = (caller: CallerName, pick: number) =>
    onRun(`Cancel(${caller})`, pick, always, async (m, _w, real) => {
      let status = 200
      const target = { runId: m.runId, recipeNamespace: NS, recipeName: recipe, db: databasePool }
      const request =
        caller === 'operator'
          ? cancelWorkflowRunAsOperator({ ...target, operatorId })
          : cancelWorkflowRun({ ...target, caller: callerFor(caller) })
      // Only the service's refusal becomes a status; any other error fails the run.
      await request.catch((error: unknown) => {
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
      m.canceledBy = caller === 'operator' ? operatorCanceller : users[caller].id
      if (!m.hasChild) {
        // A 200 cancel of a run without a child ends it.
        m.phase = 'Canceled'
        reached.canceledNoChild += 1
      }
    })

  const resume = (pick: number) =>
    onRun('Resume', pick, always, async (m, _w, real) => {
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
      // No resume succeeds after a cancel request.
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

  const boundaryReport = (pick: number) =>
    onRun('BoundaryReport', pick, runtimeStep, async (m, w, real) => {
      const runtime = real.runtimes.get(m.runId)!
      const op = real.processor.checkpointRunningBoundary(m.runId)
      await settle(real.s)
      const answer = await op
      let expected: 'allowed' | 'paused' | 'not_running'
      if (!m.bound) expected = 'allowed'
      else if (m.phase === 'AuthorizationPaused') expected = 'paused'
      else if (m.phase !== 'Running') expected = 'not_running'
      else if (w.authority === 'denied') expected = 'paused'
      else expected = 'allowed'
      expect(answer.outcome).toBe(expected)
      if (expected === 'paused') {
        if (m.phase === 'Running') m.phase = 'AuthorizationPaused'
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
        const sync = real.processor.syncFromRecipeExecution(runtime.report('running'))
        await settle(real.s)
        await sync
      }
    })

  /** The pause wait's status read: a run back to Running releases the held runtime. */
  const pauseWait = (pick: number) =>
    onRun(
      'PauseWait',
      pick,
      m => m.rtAlive && m.rtHeld,
      async (m, _w, real) => {
        if (m.phase === 'Running') {
          real.runtimes.get(m.runId)!.held = false
          m.rtHeld = false
        }
      }
    )

  const stepCompleted = (pick: number) =>
    onRun('StepCompleted', pick, runtimeStep, async (m, _w, real) => {
      real.runtimes.get(m.runId)!.completeCurrent()
      await settle(real.s)
      // The coordinator checks the signal at the next step boundary.
      if (m.rtCurrent === 's1' && !m.rtSeen) {
        m.rtCurrent = 's2'
        return
      }
      m.rtCurrent = null
      m.rtOutcome = m.rtSeen ? 'cancelled' : 'completed'
    })

  const stepFailed = (pick: number) =>
    onRun('StepFailed', pick, runtimeStep, async (m, _w, real) => {
      real.runtimes.get(m.runId)!.failCurrent()
      await settle(real.s)
      if (m.cancelRequested) reached.stepFailedAfterRequest += 1
      m.rtCurrent = null
      m.rtOutcome = 'failed'
    })

  const reportCompleted = (pick: number) =>
    onRun(
      'ReportCompleted',
      pick,
      m => m.rtAlive && m.rtOutcome !== null && !m.rtReported,
      async (m, _w, real) => {
        const runtime = real.runtimes.get(m.runId)!
        runtime.stopPolling()
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

  /**
   * StepCompleted until the workflow ends, then ReportCompleted, on one run:
   * the existing commands in a row, so a pod often ends before a later
   * colliding run is claimed (a child name is reused only once its pod ended).
   */
  const podRunsToEnd = (pick: number) =>
    onRun(
      'PodRunsToEnd',
      pick,
      m => runtimeStep(m) || (m.rtAlive && m.rtOutcome !== null && !m.rtReported),
      async (_m, w, real) => {
        for (const step of [stepCompleted(pick), stepCompleted(pick), reportCompleted(pick)]) {
          if (step.check(w)) await step.run(w, real)
        }
      }
    )

  /** The pods' signal poll interval: every live poller polls once. */
  const signalPoll = new ModelCommand(
    'SignalPoll',
    w => w.runs.some(polling),
    async (w, real) => {
      vi.advanceTimersByTime(SIGNAL_POLL_MS)
      await settle(real.s)
      pollersDrained(w)
    }
  )

  const loseSignalResponse = (pick: number) =>
    onRun(
      'LoseSignalResponse',
      pick,
      m => m.hasChild,
      async (m, w, real) => {
        const answer = await handlers.getSignals(m.childName, signalClaims(m.childName))
        expect(answer.status).toBe(200)
        await settle(real.s)
        for (const other of w.runs) {
          if (other.hasChild && other.childName === m.childName) other.signalQueued = false
        }
      }
    )

  /** A notification's delivery: this run only. */
  const deliverRun = (pick: number) =>
    onRun('DeliverTick(run)', pick, always, async (m, _w, real) => {
      const op = real.processor.deliverCancelRequests(m.runId)
      await settle(real.s)
      await op
      if (deliverable(m)) m.signalQueued = true
    })

  /** The poll tick's delivery: every run. */
  const deliverAll = new ModelCommand(
    'DeliverTick(all)',
    w => w.runs.length > 0,
    async (w, real) => {
      const op = real.processor.deliverCancelRequests(undefined)
      await settle(real.s)
      await op
      for (const m of w.runs) if (deliverable(m)) m.signalQueued = true
    }
  )

  /** Moves the picked run's clock, then sweeps every run. */
  const stuckSweep = (advance: number, pick: number) =>
    onRun(`StuckSweep(+${advance}s)`, pick, always, async (m, w, real) => {
      await advanceClock(m, advance)
      const op = real.processor.checkStuckRuns()
      await settle(real.s)
      const failed = await op
      const stuck = w.runs.filter(
        r =>
          (r.phase === 'Running' || r.phase === 'AuthorizationPaused') &&
          r.owner === w.instance &&
          r.started &&
          r.ageSeconds >= Math.min(r.maxDuration, CAP_SECONDS)
      )
      expect(failed).toBe(stuck.length)
      for (const r of stuck) {
        r.phase = r.cancelRequested ? 'Canceled' : 'Failed'
        if (r.cancelRequested) reached.canceledBySweep += 1
      }
    })

  /**
   * One production tick through start(): orphan poll, stuck sweep and cancel
   * delivery over every run, interleaved. The picked run's clock moves, and
   * its child name is reported missing when `childPresent` is false (the
   * existence check gets only the name, so every reclaimed holder of that
   * name is answered missing).
   */
  const reclaimTick = (advance: number, childPresent: boolean, pick: number) =>
    onRun(
      `ReclaimTick(+${advance}s, child ${childPresent ? 'present' : 'missing'})`,
      pick,
      always,
      async (m, w, real) => {
        await advanceClock(m, advance)
        const missing = childPresent || !m.hasChild ? null : m.childName
        real.missingChild = missing
        real.childExistsAnsweredFalse = false
        const before = new Map(w.runs.map(r => [r.runId, { ...r }]))
        // The existence check's kill may free the missing name before a claim
        // of the same tick; a claim of the same name earlier in the tick holds
        // it again (one live pod per name is checked at rest).
        const claimable = new Map(w.runs.map(r => [r.runId, !nameHeld(w, r, missing)]))
        const stuckByAge = (r: RunModel) =>
          r.started && r.ageSeconds >= Math.min(r.maxDuration, CAP_SECONDS)
        await real.processor.start()
        vi.advanceTimersByTime(RUN_POLL_MS)
        await settle(real.s)
        await real.processor.stop()
        await settle(real.s)
        real.missingChild = null

        const { rows } = await databasePool.query<{
          run_id: string
          phase: Phase
          owner_instance_id: string | null
          child_recipe_name: string | null
        }>(
          `SELECT run_id::text AS run_id, phase, owner_instance_id, child_recipe_name
             FROM workflow_runs`
        )
        const byId = new Map(rows.map(row => [row.run_id, row]))
        for (const r of w.runs) {
          const b = before.get(r.runId)!
          const row = byId.get(r.runId)
          if (!row) throw new Error(`run ${r.runId} has no row`)
          // The three reads interleave, so the tick's result is one of a set.
          const allowed = new Set<Phase>([b.phase])
          if (b.phase === 'Pending' && b.bound && w.authority === 'denied') {
            allowed.add('AuthorizationPaused')
          } else if (b.phase === 'Pending' && claimable.get(r.runId)) {
            allowed.add('Running')
          }
          if (b.phase === 'Running' || b.phase === 'AuthorizationPaused') {
            allowed.add(b.cancelRequested ? 'Canceled' : 'Failed')
          }
          expect({ run: r.runId, phase: row.phase, allowed: allowed.has(row.phase) }).toEqual({
            run: r.runId,
            phase: row.phase,
            allowed: true,
          })

          const holdsMissing =
            real.childExistsAnsweredFalse && b.hasChild && b.childName === missing
          if (b.phase === 'Pending' && row.phase === 'Running') {
            expect(row.child_recipe_name).toBe(r.childName)
            claimed(w, r)
          } else if (
            b.phase === 'Pending' &&
            row.phase === 'Pending' &&
            real.dispatchFailures.some(failure => failure.runId === r.runId)
          ) {
            reached.claimBlockedByLiveName += 1
          } else if (b.phase === 'Pending' && row.phase === 'AuthorizationPaused') {
            r.phase = 'AuthorizationPaused'
            r.owner = null
          } else if (row.phase !== b.phase) {
            r.phase = row.phase
            if (row.phase === 'Canceled') {
              // Only the reclaim ends a run the sweep does not count as stuck;
              // a stuck holder of the missing name could be ended by either.
              if (holdsMissing && !stuckByAge(b)) reached.canceledByReclaim += 1
              else if (!holdsMissing) reached.canceledBySweep += 1
            }
          }
          // A reclaimed orphan gets this instance; any other run keeps its owner.
          expect([b.owner, w.instance]).toContain(row.owner_instance_id)
          r.owner = row.owner_instance_id
        }
        if (real.childExistsAnsweredFalse) {
          // The check ran for a reclaimed Running holder of the missing name:
          // the reclaim ended it.
          const ended = w.runs.filter(r => {
            const b = before.get(r.runId)!
            return b.phase === 'Running' && b.childName === missing && TERMINAL.has(r.phase)
          })
          expect(ended.length).toBeGreaterThan(0)
          // The check killed the pod polling the missing name. A claim of the
          // same name in this tick starts a pod before or after that kill, so
          // the pods of that name are read from the runtimes.
          for (const r of w.runs) {
            if (!r.hasChild || r.childName !== missing) continue
            const runtime = real.runtimes.get(r.runId)
            r.rtAlive = Boolean(runtime && !runtime.dead)
          }
        }
        // Delivery may run before or after a terminal write of the same tick.
        for (const r of w.runs) {
          r.signalQueued =
            r.hasChild && (queued.get(r.childName)?.has(`cancel:${r.runId}`) ?? false)
        }
      }
    )

  const authorityAnswer = (answer: 'allowed' | 'denied') =>
    new ModelCommand(`AuthorityAnswer(${answer})`, always, async (w, real) => {
      real.authority = answer
      w.authority = answer
    })

  const restartProcessor = new ModelCommand('RestartProcessor', always, async (w, real) => {
    // A new WRC pod: another instance id, an empty in-memory signal store.
    await real.processor.stop()
    instanceCounter += 1
    w.instance = `wrc-model-${instanceCounter}`
    real.processor = buildProcessor(real, w.instance)
    for (const name of [...queued.keys()]) drainSignals(name)
    for (const r of w.runs) r.signalQueued = false
  })

  // ── scenario commands: fixed lists of the commands above ──────────────

  /**
   * Runs existing commands in order, each behind its own check and followed by
   * its at-rest check (`ModelCommand.run`), as `drainCancel` composes them.
   */
  async function runSteps(w: World, real: Real, steps: ModelCommand[]): Promise<void> {
    for (const step of steps) {
      if (step.check(w)) await step.run(w, real)
    }
  }

  /**
   * A bound run is claimed, paused by a denied boundary answer, then gets a
   * cancel request; the resume that follows is refused (no resume on a run with a
   * request). The scenario triggers its own run, so what it reaches does not
   * depend on the commands before it.
   */
  const pausedThenCancel = (actor: Actor, byOperator: boolean) => {
    const caller: CallerName = byOperator ? 'operator' : cancellerOf(actor)
    return new ModelCommand(
      `PausedThenCancel(${actor}, ${caller})`,
      w => w.runs.length < MAX_RUNS,
      async (w, real) => {
        await runSteps(w, real, [
          triggerCommand({ actor, bound: true, maxDuration: null, collide: false }),
        ])
        const p = w.runs.length - 1
        await runSteps(w, real, [
          authorityAnswer('allowed'),
          processPending(p),
          authorityAnswer('denied'),
          boundaryReport(p),
          cancel(caller, p),
          resume(p),
        ])
      }
    )
  }

  /**
   * The first run's cancel is queued under its child name and its pod ends
   * without polling; a run that collides with it is then claimed, and the new
   * pod's first poll drains that cancel and drops it. Collisions are
   * always with the first run, so the scenario starts a sequence.
   */
  const foreignCancel = (byOperator: boolean) => {
    const caller: CallerName = byOperator ? 'operator' : cancellerOf('user')
    const unbound = { actor: 'user', bound: false, maxDuration: null } as const
    return new ModelCommand(
      `ForeignCancel(${caller})`,
      w => w.runs.length === 0,
      async (w, real) => {
        await runSteps(w, real, [
          triggerCommand({ ...unbound, collide: false }),
          processPending(0),
          cancel(caller, 0),
          deliverRun(0),
          stepFailed(0),
          reportCompleted(0),
          triggerCommand({ ...unbound, collide: true }),
          processPending(1),
        ])
      }
    )
  }

  /**
   * A claimed run gets a cancel request, its last reconcile ages past the
   * orphan window (but not the duration cap) and its child is reported
   * missing: the reclaim, not the stuck sweep, ends it Canceled. The scenario
   * triggers its own run.
   */
  const reclaimCancel = (actor: Actor, byOperator: boolean) => {
    const caller: CallerName = byOperator ? 'operator' : cancellerOf(actor)
    return new ModelCommand(
      `ReclaimCancel(${actor}, ${caller})`,
      w => w.runs.length < MAX_RUNS,
      async (w, real) => {
        await runSteps(w, real, [
          triggerCommand({ actor, bound: false, maxDuration: null, collide: false }),
        ])
        const p = w.runs.length - 1
        await runSteps(w, real, [processPending(p), cancel(caller, p), reclaimTick(90, false, p)])
      }
    )
  }

  const pick = fc.nat({ max: MAX_RUNS - 1 })
  const triggerArbitrary = fc
    .record({
      actor: fc.constantFrom<Actor>('user', 'scheduled'),
      bound: fc.constantFrom(true, true, true, false),
      maxDuration: fc.constantFrom<number | null>(null, 60, 7_200),
      // Two runs in three after the first share its child name.
      collide: fc.constantFrom(true, true, false),
    })
    .map(triggerCommand)
  const sweepCommand = fc
    .tuple(fc.constantFrom(0, 30, 90, 4_000), pick)
    .map(([advance, p]) => stuckSweep(advance, p))
  const reclaimCommand = fc
    .tuple(fc.constantFrom(0, 90, 4_000), fc.boolean(), pick)
    .map(([advance, present, p]) => reclaimTick(advance, present, p))
  const cancelCommand = fc
    // Callers who may cancel some runs are listed twice, so requests are
    // frequent; the operator, who may cancel every run, once.
    .tuple(
      fc.constantFrom<CallerName>(
        'launcher',
        'launcher',
        'admin',
        'admin',
        'admin2',
        'member',
        'operator'
      ),
      pick
    )
    .map(([caller, p]) => cancel(caller, p))
  const authorityCommand = fc
    .constantFrom<'allowed' | 'denied'>('allowed', 'denied')
    .map(authorityAnswer)
  const scenarioActor = fc.constantFrom<Actor>('user', 'scheduled')
  // Weights: commands listed twice need to fire in order on one run to reach
  // a rare state (a swept or reclaimed cancel needs a claim, a cancel and a
  // clock move), and three runs in four are bound. Trigger is listed twice so
  // most sequences hold several runs. The states uniform choice does not reach
  // on the budget (a paused run with a request, the resume refused after it,
  // a foreign cancel dropped, a cancel ended by the reclaim) come from the
  // scenario commands.
  const commandArbitraries = [
    triggerArbitrary,
    triggerArbitrary,
    pick.map(processPending),
    pick.map(processPending),
    cancelCommand,
    cancelCommand,
    pick.map(resume),
    pick.map(resume),
    pick.map(boundaryReport),
    pick.map(boundaryReport),
    pick.map(pauseWait),
    pick.map(stepCompleted),
    pick.map(stepFailed),
    pick.map(reportCompleted),
    pick.map(podRunsToEnd),
    fc.constant(signalPoll),
    pick.map(deliverRun),
    fc.constant(deliverAll),
    sweepCommand,
    sweepCommand,
    reclaimCommand,
    reclaimCommand,
    authorityCommand,
    authorityCommand,
    fc.constant(restartProcessor),
    pick.map(loseSignalResponse),
    fc
      .tuple(scenarioActor, fc.boolean())
      .map(([actor, byOperator]) => pausedThenCancel(actor, byOperator)),
    fc.boolean().map(foreignCancel),
    fc
      .tuple(scenarioActor, fc.boolean())
      .map(([actor, byOperator]) => reclaimCancel(actor, byOperator)),
  ]

  /**
   * Bounded liveness, for every run with a request and a child: once the
   * signal is delivered and polled, the running step completes and the
   * runtime reports, the run is terminal. The Resume first is refused for a
   * run with a request (the resume's `cancel_requested_at IS NULL` guard, asserted by the
   * command); it does not move the run.
   */
  async function drainCancel(w: World, real: Real): Promise<void> {
    for (let index = 0; index < w.runs.length; index += 1) {
      const m = w.runs[index]
      if (!(m.cancelRequested && m.hasChild)) continue
      const drain = [
        resume(index),
        deliverAll,
        signalPoll,
        stepCompleted(index),
        stepCompleted(index),
        reportCompleted(index),
      ]
      for (const step of drain) {
        if (step.check(w)) await step.run(w, real)
      }
      expect({ run: m.runId, phase: m.phase, terminal: TERMINAL.has(m.phase) }).toEqual({
        run: m.runId,
        phase: m.phase,
        terminal: true,
      })
    }
  }

  it(
    `holds the cancel invariants on every generated sequence (seed ${SEED}${REPLAY_PATH ? `, path ${REPLAY_PATH}` : ''})`,
    { timeout: 1_800_000 },
    async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      let runs = 0
      let longest = 0
      let longestGenerated = 0
      let mostRuns = 0
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.scheduler(),
            fc.commands(commandArbitraries, { maxCommands: MAX_COMMANDS, size: 'max' }),
            async (s, commands) => {
              runs += 1
              await databasePool.query('TRUNCATE workflow_runs CASCADE')
              for (const name of [...queued.keys()]) drainSignals(name)
              const real: Real = {
                s,
                processor: undefined as unknown as DbRunProcessor,
                runtimes: new Map(),
                childNames: new Map(),
                authority: 'allowed',
                missingChild: null,
                childExistsAnsweredFalse: false,
                notified: new Map(),
                processorErrors: [],
                claimFailures: [],
                dispatchFailures: [],
              }
              current = real
              try {
                instanceCounter += 1
                const world: World = {
                  runs: [],
                  authority: 'allowed',
                  instance: `wrc-model-${instanceCounter}`,
                }
                real.processor = buildProcessor(real, world.instance)
                await checkAtRest(world, real)
                let executed = 0
                const generated = [...commands]
                longestGenerated = Math.max(longestGenerated, generated.length)
                const counted = generated.map(command => {
                  const run = command.run.bind(command)
                  return Object.assign(Object.create(command), {
                    run: async (ww: World, rr: Real) => {
                      executed += 1
                      await run(ww, rr)
                    },
                  }) as typeof command
                })
                await fc.asyncModelRun(() => ({ model: world, real }), counted)
                longest = Math.max(longest, executed)
                mostRuns = Math.max(mostRuns, world.runs.length)
                await drainCancel(world, real)
              } finally {
                for (const runtime of real.runtimes.values()) runtime.kill()
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
      const summary = {
        seed: SEED,
        runs,
        longestGenerated,
        longestExecuted: longest,
        mostRunsInSequence: mostRuns,
        reached,
      }
      process.stdout.write(`S30 ${JSON.stringify(summary)}\n`)
      expect(runs).toBe(REPLAY_PATH ? 1 : NUM_RUNS)
      if (!REPLAY_PATH) {
        // Sequences reach the budget; commands whose precondition fails are skipped.
        expect(longestGenerated).toBe(MAX_COMMANDS)
        expect(longest).toBeGreaterThanOrEqual(MAX_COMMANDS / 2)
        expect(mostRuns).toBe(MAX_RUNS)
        const states = Object.entries(reached)
        // The loop below covers every state, the operator's included.
        expect(states.map(([state]) => state)).toContain('canceledByOperator')
        for (const [state, count] of states) {
          expect({ state, reached: count > 0 }).toEqual({ state, reached: true })
        }
      }
    }
  )
})
