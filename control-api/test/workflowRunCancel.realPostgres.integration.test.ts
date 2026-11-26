import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Client, Pool, type PoolClient, type QueryResult } from 'pg'
import request from 'supertest'
import { createDbRunProcessor } from '../../workflow-recipes/src/reconciler/dbRunProcessor.js'
import { config } from '../src/config.js'
import { initDb, pool } from '../src/db.js'
import { K8sGateway } from '../src/k8s.js'
import type { ExternalAuthedRequest } from '../src/middleware/externalSessionAuth.js'
import type { TeamRole } from '../src/profileTypes.js'
import { createExternalWorkflowsRouter } from '../src/routes/external/workflows/index.js'
import { authorizeActionV2 } from '../src/services/access/actionAuthorizer.js'
import { prepareActionOperationTarget } from '../src/services/access/actionMessageId.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import { resolveEffectiveUserAccessPolicy } from '../src/services/access/userAccessRuntimePolicy.js'
import {
  type ExternalSessionAuthorityContext,
  authenticateExternalUserSession,
} from '../src/services/auth/externalSessionAuthentication.js'
import { issueExternalUserSession } from '../src/services/auth/externalSessionIssuance.js'
import { createUserSession, revokeUserSession } from '../src/services/auth/userSessionService.js'
import {
  InvalidWorkflowApprovalRunBindingError,
  createApprovalRequest,
  recordDecision,
} from '../src/services/userApprovalRequestService.js'
import type { WorkflowRouteCaller } from '../src/services/workflows/types.js'
import {
  WORKFLOW_ACTION_DELEGATION_HEADER,
  type WorkflowAuthorityBinding,
  requireCurrentWorkflowTriggerAuthority,
  requireWorkflowActionAuthority,
} from '../src/services/workflows/workflowAuthorityBindingService.js'
import { getWorkflowPrincipalId } from '../src/services/workflows/workflowCallerService.js'
import { LOCK_RUN_FOR_CANCEL } from '../src/services/workflows/workflowRunCancelService.js'
import { listCanonicalRuns } from '../src/services/workflows/workflowRunReadService.js'
import { resumeWorkflowRun } from '../src/services/workflows/workflowRunResumeService.js'
import { triggerWorkflow } from '../src/services/workflows/workflowTriggerService.js'
import {
  issueUserDelegationV2,
  verifyUserDelegationV2,
} from '../src/utils/auth/userDelegationV2Token.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { TemporaryKubernetesApi } from './helpers/temporaryKubernetesApi.js'
import './realPostgres.requirement.ts'
import { waitForDatabaseConnectionsToClose } from './realPostgresCleanup.ts'

// Both session contracts are accepted, as in an environment that has switched
// V2 on with V1 still accepted: the cancel route takes them the same way (S14).
// Everything else is the real resolved policy.
vi.mock('../src/services/access/userAccessRuntimePolicy.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/services/access/userAccessRuntimePolicy.js')>()
  return {
    ...actual,
    resolveEffectiveUserAccessPolicy: async (
      ...args: Parameters<typeof actual.resolveEffectiveUserAccessPolicy>
    ) => ({
      ...(await actual.resolveEffectiveUserAccessPolicy(...args)),
      acceptV1: true,
      issueV1: true,
      acceptV2: true,
      issueV2: true,
      renewV2: true,
      actionContextV2: true,
    }),
  }
})

// The trigger limiter allows 10 requests per minute per user; this suite sends
// more than that for one user. The limiter is not this suite's subject.
vi.mock('../src/services/rateLimiterService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/rateLimiterService.js')>()),
  checkAndIncrement: vi.fn(async () => ({
    allowed: true,
    remaining: 9,
    resetMs: 60_000,
    windowStartMs: Date.now(),
    count: 1,
    backendAvailable: true,
  })),
}))

vi.mock('../src/services/notificationEmitter.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/notificationEmitter.js')>()),
  emitNotification: vi.fn().mockResolvedValue(undefined),
}))

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

type Phase = 'Pending' | 'Running' | 'AuthorizationPaused' | 'Succeeded' | 'Failed' | 'Canceled'
type ActorType = 'user' | 'admin' | 'scheduled' | 'autonomous'

interface TestUser {
  id: string
  email: string
}

interface QueryHook {
  before?: (text: string, values: unknown[] | undefined, client: PoolClient) => Promise<void> | void
  after?: (
    text: string,
    values: unknown[] | undefined,
    result: QueryResult,
    client: PoolClient
  ) => void
}

const TRIGGER_SOURCE: Record<ActorType, string> = {
  user: 'onDemand',
  admin: 'onDemand',
  scheduled: 'schedule',
  autonomous: 'autonomous',
}

function queryText(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg && typeof arg === 'object' && typeof (arg as { text?: unknown }).text === 'string') {
    return (arg as { text: string }).text
  }
  return ''
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A promise with its resolver, to hold one side of an interleaving. */
function gate<T = void>() {
  let open!: (value: T) => void
  const opened = new Promise<T>(resolve => {
    open = resolve
  })
  return { open, opened }
}

describeRealPostgres('workflow run cancel on real PostgreSQL', () => {
  const database = `workflow_run_cancel_${randomBytes(6).toString('hex')}`
  const ns = config.sandboxNamespace
  const suffix = randomBytes(4).toString('hex')
  const cancelRecipe = `cancel-${suffix}`
  const approvalRecipe = `cancel-approval-${suffix}`
  const contextName = `cancel-context-${suffix}`
  const kubernetesApi = new TemporaryKubernetesApi()
  const hooks = new Set<QueryHook>()
  const capturedErrors: unknown[] = []
  const notifications: string[] = []
  let adminPool: Pool
  let databasePool: Pool
  let listener: Client
  let gateway: K8sGateway
  let app: express.Express
  let corePoolConnectSpy: ReturnType<typeof vi.spyOn>
  let corePoolQuerySpy: ReturnType<typeof vi.spyOn>

  const teamT = randomUUID()
  const teamT2 = randomUUID()
  const user = (label: string): TestUser => {
    const id = randomUUID()
    return { id, email: `${label}-${id}@example.test` }
  }
  /** Launcher: no team. */
  const L = user('launcher')
  /** Live admins of T. */
  const A = user('admin-a')
  const A2 = user('admin-a2')
  /** Member and inviter of T. */
  const M = user('member')
  const I = user('inviter')
  /** Admin of T whose membership was removed. */
  const X = user('removed-admin')
  /** Admin of T and of T2; session scoped to T2. */
  const D = user('admin-other-scope')
  /** Member of T and approval target. */
  const P = user('approval-target')

  /** One S12 recipe per row, so each list read sees that row's run only. */
  const s12Recipes = [
    'a1',
    'a2',
    'b',
    'c',
    'd',
    'e-member',
    'e-inviter',
    'e-removed',
    'f-launcher',
    'f-other',
    'g',
    'g-sibling',
    'h',
    'l',
  ].map(row => `s12-${row}-${suffix}`)
  const s12 = (row: string) => `s12-${row}-${suffix}`

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    databasePool = new Pool({ connectionString: url.toString() })
    await initDb({ connect: () => databasePool.connect() })

    // Every core-pool client is the test database's, with a hook point around
    // each statement (lock observation, gates, fault witnesses).
    corePoolConnectSpy = vi.spyOn(pool, 'connect').mockImplementation((async () => {
      const client = await databasePool.connect()
      return new Proxy(client, {
        get(target, prop) {
          if (prop === 'query') {
            return async (...args: unknown[]) => {
              const text = queryText(args[0])
              const values = Array.isArray(args[1]) ? (args[1] as unknown[]) : undefined
              for (const hook of [...hooks]) await hook.before?.(text, values, target)
              const result = await (target.query as (...a: unknown[]) => Promise<QueryResult>)(
                ...args
              )
              for (const hook of [...hooks]) hook.after?.(text, values, result, target)
              return result
            }
          }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }) as unknown as typeof pool.connect)
    corePoolQuerySpy = vi
      .spyOn(pool, 'query')
      .mockImplementation(((...args: Parameters<typeof pool.query>) =>
        (databasePool.query as typeof pool.query)(...args)) as typeof pool.query)

    for (const [label, member] of Object.entries({ L, A, A2, M, I, X, D, P })) {
      await databasePool.query(`INSERT INTO users(id, email, name) VALUES ($1, $2, $3)`, [
        member.id,
        member.email,
        `Cancel ${label}`,
      ])
    }
    await databasePool.query(
      `INSERT INTO teams(id, name) VALUES ($1, 'Cancel T'), ($2, 'Cancel T2')`,
      [teamT, teamT2]
    )
    const memberships: Array<[string, string, TeamRole, 'active' | 'deleted']> = [
      [teamT, A.id, 'admin', 'active'],
      [teamT, A2.id, 'admin', 'active'],
      [teamT, M.id, 'member', 'active'],
      [teamT, I.id, 'inviter', 'active'],
      [teamT, X.id, 'admin', 'deleted'],
      [teamT, D.id, 'admin', 'active'],
      [teamT2, D.id, 'admin', 'active'],
      [teamT, P.id, 'member', 'active'],
    ]
    for (const [team, member, role, status] of memberships) {
      await databasePool.query(
        `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, $3, $4)`,
        [team, member, role, status]
      )
    }
    // The run list shows team runs only to members whose team holds the
    // recipe's grant (listRunsByRecipeForUserScope).
    for (const recipe of s12Recipes) {
      await databasePool.query(
        `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
         VALUES ($1, $2, $3)`,
        [teamT, ns, recipe]
      )
    }

    // The trigger producers (S11, S16, S22) read a live recipe and context.
    await databasePool.query(`INSERT INTO user_contexts(user_id, context_id) VALUES ($1, $2)`, [
      L.id,
      `${config.contextsNamespace}/${contextName}`,
    ])
    await databasePool.query(
      `INSERT INTO llm_allowed_models(provider, model, vendor, enabled)
       VALUES ('openai', 'cancel-test', 'test', TRUE)`
    )
    await kubernetesApi.start()
    kubernetesApi.put('contexts', config.contextsNamespace, {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'Context',
      metadata: {
        name: contextName,
        namespace: config.contextsNamespace,
        uid: randomUUID(),
        resourceVersion: '1',
        generation: 1,
      },
      spec: { enabled: true, mcpServers: [], sharedFileSystems: [] },
    })
    for (const [name, requiresApproval] of [
      [cancelRecipe, false],
      [approvalRecipe, true],
    ] as const) {
      await databasePool.query(
        `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
         VALUES ($1, $2, $3)`,
        [L.id, ns, name]
      )
      kubernetesApi.put('workflowrecipes', ns, {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name, namespace: ns, uid: randomUUID(), resourceVersion: '1', generation: 1 },
        spec: {
          enabled: true,
          contextRef: contextName,
          model: { provider: 'openai', name: 'cancel-test' },
          triggers: { onDemand: { requiresApproval } },
        },
      })
    }
    const priorKubeconfig = process.env.KUBECONFIG
    process.env.KUBECONFIG = kubernetesApi.kubeconfig()
    try {
      gateway = new K8sGateway()
    } finally {
      if (priorKubeconfig === undefined) delete process.env.KUBECONFIG
      else process.env.KUBECONFIG = priorKubeconfig
    }

    app = express()
    app.use(express.json())
    app.use(createExternalWorkflowsRouter(gateway))
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      capturedErrors.push(error)
      res.status(500).json({ error: 'test_error_handler' })
    })

    listener = new Client({ connectionString: url.toString() })
    await listener.connect()
    listener.on('notification', message => {
      if (message.channel === 'workflow_run_update' && message.payload) {
        notifications.push(message.payload)
      }
    })
    await listener.query('LISTEN workflow_run_update')
  }, 180_000)

  afterAll(async () => {
    try {
      corePoolQuerySpy?.mockRestore()
      corePoolConnectSpy?.mockRestore()
      try {
        await listener?.end()
        await kubernetesApi.close()
      } finally {
        await endPoolAndWaitForClients(databasePool)
      }
      if (!adminPool) return
      await waitForDatabaseConnectionsToClose(adminPool, database)
      await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await adminPool?.end()
    }
  })

  // ── sessions ────────────────────────────────────────────────────────────

  async function v1Token(member: TestUser, teamId: string | null, role: TeamRole) {
    const issued = await issueExternalUserSession(
      {
        contract: 'v1',
        userId: member.id,
        email: member.email,
        teamId,
        role,
        authenticationMethods: ['password'],
      },
      { db: databasePool, policy: await resolveEffectiveUserAccessPolicy() }
    )
    return issued.token
  }

  async function v2Session(member: TestUser) {
    const issued = await createUserSession(
      { userId: member.id, email: member.email, authenticationMethods: ['password'] },
      { db: databasePool as never }
    )
    return { token: issued.token, sid: issued.identity.sid }
  }

  /** The caller the route binds for a session token. */
  async function callerFor(token: string) {
    const identity = await authenticateExternalUserSession(token, { purpose: 'protected' })
    if (identity.status !== 'authenticated') {
      throw new Error(`session did not authenticate: ${identity.status}`)
    }
    return {
      kind: 'user-session' as const,
      claims: identity.claims,
      session: identity.authorityContext,
    }
  }

  function principalOf(member: TestUser): string {
    return getWorkflowPrincipalId({
      kind: 'user-session',
      claims: { userId: member.id },
    } as unknown as WorkflowRouteCaller)
  }

  // ── runs ────────────────────────────────────────────────────────────────

  async function insertRun(input: {
    recipe: string
    phase: Phase
    actorType: ActorType
    actorId?: string | null
    teamId?: string | null
    child?: string | null
    approvalRequestId?: string | null
  }): Promise<string> {
    const runId = randomUUID()
    const started = input.phase !== 'Pending' && input.phase !== 'AuthorizationPaused'
    await databasePool.query(
      `INSERT INTO workflow_runs (
         run_id, recipe_namespace, recipe_name, phase, actor_type, actor_id, team_id,
         usage_team_id, trigger_source, child_recipe_name, child_recipe_namespace,
         approval_request_id, failure_reason, max_duration_seconds, started_at, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::uuid, $7::text, $8, $9,
         CASE WHEN $9::text IS NULL THEN NULL ELSE $2 END,
         $10,
         CASE WHEN $4 = 'AuthorizationPaused' THEN 'workflow_authority_unavailable' END,
         86400,
         CASE WHEN $11 THEN now() END,
         CASE WHEN $4 IN ('Succeeded', 'Failed', 'Canceled') THEN now() END
       )`,
      [
        runId,
        ns,
        input.recipe,
        input.phase,
        input.actorType,
        input.actorId ?? null,
        input.teamId ?? null,
        TRIGGER_SOURCE[input.actorType],
        input.child ?? null,
        input.approvalRequestId ?? null,
        started,
      ]
    )
    return runId
  }

  /** A launcher run of L in the stored principal form, as the triggers write it. */
  function launcherRun(phase: Phase, recipe: string, child: string | null = null) {
    return insertRun({ recipe, phase, actorType: 'user', actorId: principalOf(L), child })
  }

  async function readRun(runId: string): Promise<Record<string, unknown>> {
    const result = await databasePool.query(`SELECT * FROM workflow_runs WHERE run_id = $1`, [
      runId,
    ])
    expect(result.rows).toHaveLength(1)
    return result.rows[0] as Record<string, unknown>
  }

  function cancel(
    token: string | null,
    runId: string,
    recipe: string,
    headers: Record<string, string> = {}
  ) {
    const req = request(app).post(`/external/workflows/${ns}/${recipe}/runs/${runId}/cancel`)
    if (token) req.set('x-user-session-token', token)
    for (const [name, value] of Object.entries(headers)) req.set(name, value)
    return req
  }

  // ── notifications ───────────────────────────────────────────────────────

  async function barrier(): Promise<void> {
    const token = `barrier-${randomUUID()}`
    await databasePool.query(`SELECT pg_notify('workflow_run_update', $1)`, [token])
    await waitFor(() => notifications.includes(token), `notification barrier ${token}`)
  }

  /**
   * The `workflow_run_update` payloads committed while `work` ran: a barrier
   * before and after bounds them, since notifications arrive in commit order.
   */
  async function notificationsDuring<T>(work: () => Promise<T>) {
    await barrier()
    const start = notifications.length
    const result = await work()
    await barrier()
    const payloads = notifications.slice(start).filter(payload => !payload.startsWith('barrier-'))
    return { result, payloads }
  }

  // ── step approvals ──────────────────────────────────────────────────────

  /** The runtime's run_start trace event, which a bound step approval requires. */
  async function recordRunStart(runId: string): Promise<void> {
    const client = await databasePool.connect()
    try {
      await client.query('BEGIN')
      const eventId = randomUUID()
      const payloadSha256 = randomBytes(32).toString('hex')
      const occurredAt = new Date()
      await client.query(
        `INSERT INTO agent_run_events
           (event_id, source_kind, source_service, source_event_id, idempotency_key,
            run_id, span_id, origin, event_type, outcome, agent_sub, payload_sha256, occurred_at)
         VALUES ($1, 'wrc_internal_control', 'workflow-recipes', $2, $3, $4, 'run-start',
                 'workflow_runtime', 'run_start', 'started', 'workflow-recipes', $5, $6)`,
        [
          eventId,
          `run-start-${runId}`,
          randomBytes(32).toString('hex'),
          runId,
          payloadSha256,
          occurredAt,
        ]
      )
      await client.query(
        `INSERT INTO governed_event_stream
           (event_family, event_id, schema_version, occurred_at, ingested_at, payload_sha256)
         VALUES ('agent_run', $1, 1, $2, $3, $4)`,
        [eventId, occurredAt, new Date(), payloadSha256]
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  /** A running step whose approval binding proof is known; returns the proof. */
  async function runningStep(runId: string, stepId: string): Promise<string> {
    const proof = randomUUID()
    await databasePool.query(
      `INSERT INTO workflow_run_steps(run_id, step_id, phase, started_at, approval_binding_sha256)
       VALUES ($1, $2, 'Running', now(), $3)`,
      [runId, stepId, createHash('sha256').update(proof).digest('hex')]
    )
    return proof
  }

  /** A running run of L with a child, ready for bound step approvals. */
  async function runReadyForApprovals(recipe: string) {
    const child = `child-${randomBytes(4).toString('hex')}`
    const runId = await launcherRun('Running', recipe, child)
    await recordRunStart(runId)
    return { runId, child }
  }

  /** The step approval a running step requests, through the production producer. */
  function requestStepApproval(input: {
    runId: string
    child: string
    stepId: string
    proof: string
    recipe: string
    idempotencyKey?: string
  }) {
    return createApprovalRequest({
      recipeNamespace: ns,
      recipeName: input.recipe,
      targetUserId: P.id,
      payload: { message: `Approve ${input.stepId}` },
      idempotencyKey: input.idempotencyKey ?? `step-${randomUUID()}`,
      correlation: {
        taskId: `${input.runId}:${input.child}:${new Date().toISOString()}`,
        stepId: input.stepId,
      },
      runBindingProof: input.proof,
    })
  }

  async function approvalOf(id: string) {
    const result = await databasePool.query<{
      status: string
      cancelled_by: string | null
      bound_workflow_run_id: string | null
    }>(
      `SELECT status, cancelled_by::text AS cancelled_by, bound_workflow_run_id::text AS bound_workflow_run_id
         FROM workflow_approval_requests WHERE id = $1`,
      [id]
    )
    expect(result.rows).toHaveLength(1)
    return result.rows[0]!
  }

  // ── trigger producers ───────────────────────────────────────────────────

  function v1Caller(member: TestUser) {
    return {
      kind: 'user-session' as const,
      claims: {
        userId: member.id,
        email: member.email,
        teamId: null,
        role: 'member' as const,
        authGeneration: 1,
        exp: Math.floor(Date.now() / 1000) + 3_600,
      },
      session: {
        contract: 'v1' as const,
        userId: member.id,
        tokenHash: 'cancel-v1-session',
        issuedAt: Math.floor(Date.now() / 1000),
        authGeneration: 1,
      },
    }
  }

  /** The V2 trigger: real session, live direct-path authorization, signed delegation. */
  async function triggerV2() {
    const issued = await v2Session(L)
    const caller = await callerFor(issued.token)
    const resource = canonicalResourceIdentity({
      environmentId: canonicalEnvironmentId(),
      type: 'workflow_recipe',
      logicalId: `${ns}/${cancelRecipe}`,
    })
    const target = Object.freeze({ recipeNamespace: ns, recipeName: cancelRecipe })
    const resolved = await authorizeActionV2({
      session: caller.session as ExternalSessionAuthorityContext,
      requested: { version: 2 },
      operationId: 'workflow.trigger',
      resource,
      operationTarget: target,
      allocateChatMessageId: false,
      gateway,
    })
    if (resolved.status !== 'allowed' || resolved.context.pathKind !== 'direct') {
      throw new Error(`live direct-path producer returned ${resolved.status}`)
    }
    const selected = resolved.context
    const token = issueUserDelegationV2({
      principal: {
        userId: L.id,
        sid: selected.principal.sid,
        sessionVersion: selected.principal.sessionVersion,
      },
      operationIds: ['workflow.trigger'],
      resource,
      preparedTargets: {
        'workflow.trigger': prepareActionOperationTarget({
          operationId: 'workflow.trigger',
          resource,
          operationTarget: target,
        }),
      },
      accessPathId: selected.accessPathId,
      authorizationRevision: selected.authorizationRevision,
      behaviorBindingHash: selected.behaviorBindingHash,
      pathKind: selected.pathKind,
      effectiveTeamId: selected.effectiveTeamId,
    })
    if (!verifyUserDelegationV2(token)) throw new Error('delegation issuer did not verify')
    const authority = await requireWorkflowActionAuthority({
      req: {
        rawHeaders: [WORKFLOW_ACTION_DELEGATION_HEADER, token],
        correlationId: randomUUID(),
      } as unknown as ExternalAuthedRequest,
      caller,
      operationId: 'workflow.trigger',
      resourceType: 'workflow_recipe',
      resourceLogicalId: `${ns}/${cancelRecipe}`,
      target,
      gateway,
    })
    if (!authority) throw new Error('v2 trigger producer did not require its signed authority')
    const result = await triggerWorkflow({
      gateway,
      caller,
      recipeNamespace: ns,
      recipeName: cancelRecipe,
      body: {},
      idempotencyKey: `cancel-v2-${randomUUID()}`,
      authority,
      validateCurrentInTransaction: (db, current) =>
        requireCurrentWorkflowTriggerAuthority({ db, authority: current }),
    })
    if (result.kind !== 'run') throw new Error(`expected a run, got ${result.kind}`)
    expect(result.row.initiating_authority_binding_id).toBeTruthy()
    return { runId: result.row.run_id as string, caller, token: issued.token }
  }

  /** The resume route's authority for a run (`workflow.run.manage`, direct path). */
  async function produceRunResumeAuthority(
    caller: Awaited<ReturnType<typeof callerFor>>,
    runId: string
  ): Promise<WorkflowAuthorityBinding> {
    const resource = canonicalResourceIdentity({
      environmentId: canonicalEnvironmentId(),
      type: 'workflow_run',
      logicalId: runId,
    })
    const target = Object.freeze({ runId, action: 'resume' as const })
    const resolved = await authorizeActionV2({
      session: caller.session as ExternalSessionAuthorityContext,
      requested: { version: 2 },
      operationId: 'workflow.run.manage',
      resource,
      operationTarget: target,
      allocateChatMessageId: false,
      gateway,
    })
    if (resolved.status !== 'allowed' || resolved.context.pathKind !== 'direct') {
      throw new Error(`run action producer returned ${resolved.status}`)
    }
    const selected = resolved.context
    const token = issueUserDelegationV2({
      principal: {
        userId: L.id,
        sid: selected.principal.sid,
        sessionVersion: selected.principal.sessionVersion,
      },
      operationIds: ['workflow.run.manage'],
      resource,
      preparedTargets: {
        'workflow.run.manage': prepareActionOperationTarget({
          operationId: 'workflow.run.manage',
          resource,
          operationTarget: target,
        }),
      },
      accessPathId: selected.accessPathId,
      authorizationRevision: selected.authorizationRevision,
      behaviorBindingHash: selected.behaviorBindingHash,
      pathKind: selected.pathKind,
      effectiveTeamId: selected.effectiveTeamId,
    })
    const authority = await requireWorkflowActionAuthority({
      req: {
        rawHeaders: [WORKFLOW_ACTION_DELEGATION_HEADER, token],
        correlationId: randomUUID(),
      } as unknown as ExternalAuthedRequest,
      caller,
      operationId: 'workflow.run.manage',
      resourceType: 'workflow_run',
      resourceLogicalId: runId,
      target,
      gateway,
    })
    if (!authority) throw new Error('run action producer did not require its signed authority')
    return authority
  }

  /** An authority checkpoint failure: from Pending (no child) or from Running (child). */
  async function pause(runId: string, withChild: boolean) {
    const paused = await databasePool.query(
      `UPDATE workflow_runs
          SET phase = 'AuthorizationPaused',
              failure_reason = 'workflow_authority_unavailable',
              started_at = CASE WHEN $2 THEN now() END,
              child_recipe_name = CASE WHEN $2 THEN 'continuation-child' END,
              child_recipe_namespace = CASE WHEN $2 THEN $3 END
        WHERE run_id = $1`,
      [runId, withChild, ns]
    )
    expect(paused.rowCount).toBe(1)
  }

  // ── S11 · who is the launcher ───────────────────────────────────────────

  it('the launcher cancels with either stored id form, and so does an approval requester', async () => {
    const v2 = await v2Session(L)
    const v1 = await v1Token(L, null, 'member')

    // Raw user id form (only a hand-written row has it).
    const rawRun = await insertRun({
      recipe: cancelRecipe,
      phase: 'Pending',
      actorType: 'user',
      actorId: L.id,
    })
    // Principal form, as the V1 trigger stores it.
    const triggered = await triggerWorkflow({
      gateway,
      caller: v1Caller(L),
      recipeNamespace: ns,
      recipeName: cancelRecipe,
      body: {},
      idempotencyKey: `s11-${randomUUID()}`,
    })
    if (triggered.kind !== 'run') throw new Error(`expected a run, got ${triggered.kind}`)
    const principalRun = triggered.row.run_id as string
    // A user id is a uuid (`users.id`), and the principal form of a uuid is the
    // uuid itself (workflowCallerService.ts:9-10), so both producers store the
    // same value; the raw row stands for the hand-written form.
    expect(triggered.row.actor_id).toBe(principalOf(L))
    expect(principalOf(L)).toBe(L.id)

    // Approval origin: the requester's approved trigger creates the run.
    const requested = await triggerWorkflow({
      gateway,
      caller: v1Caller(L),
      recipeNamespace: ns,
      recipeName: approvalRecipe,
      body: {},
      idempotencyKey: `s11-approval-${randomUUID()}`,
    })
    if (requested.kind !== 'approval')
      throw new Error(`expected an approval, got ${requested.kind}`)
    const decided = await recordDecision(requested.approvalRequestId, 'approve', { userId: L.id })
    if (!decided.ok || !decided.workflowRun) {
      throw new Error(`approve decision did not create a run: ${JSON.stringify(decided)}`)
    }
    const approvalRun = decided.workflowRun.row.run_id as string
    expect(decided.workflowRun.row.approval_request_id).toBe(requested.approvalRequestId)

    for (const [runId, recipe, token] of [
      [rawRun, cancelRecipe, v2.token],
      [principalRun, cancelRecipe, v1],
      [approvalRun, approvalRecipe, v2.token],
    ] as const) {
      const response = await cancel(token, runId, recipe)
      expect(response.status).toBe(200)
      expect(response.body.run).toMatchObject({ id: runId, canceledBy: L.id })
      const row = await readRun(runId)
      expect(row).toMatchObject({ phase: 'Canceled', canceled_by: L.id })
      expect(row.cancel_requested_at).toBeInstanceOf(Date)
    }
  }, 60_000)

  it('no session, a revoked session and an expired session get 401 and write nothing', async () => {
    const runId = await launcherRun('Pending', cancelRecipe)
    const before = await readRun(runId)

    const revoked = await v2Session(L)
    expect(await revokeUserSession(L.id, revoked.sid, 'test_revocation')).toBe(true)
    const expired = await v2Session(L)
    const expiredRows = await databasePool.query(
      `UPDATE external_user_sessions
          SET idle_expires_at = clock_timestamp() - interval '1 minute',
              absolute_expires_at = clock_timestamp() - interval '1 minute'
        WHERE sid = $1`,
      [expired.sid]
    )
    expect(expiredRows.rowCount).toBe(1)

    for (const token of [null, revoked.token, expired.token]) {
      const response = await cancel(token, runId, cancelRecipe)
      expect(response.status).toBe(401)
      expect(await readRun(runId)).toEqual(before)
    }

    // Liveness: the same run is cancellable by its launcher with a live session.
    const live = await v2Session(L)
    const response = await cancel(live.token, runId, cancelRecipe)
    expect(response.status).toBe(200)
    expect(await readRun(runId)).toMatchObject({ phase: 'Canceled', canceled_by: L.id })
  }, 60_000)

  // ── S12 · admin permission ──────────────────────────────────────────────

  it('admin permission follows run visibility', async () => {
    const tokens = {
      A: await v1Token(A, teamT, 'admin'),
      M: await v1Token(M, teamT, 'member'),
      I: await v1Token(I, teamT, 'inviter'),
      X: await v1Token(X, teamT, 'admin'),
      D: await v1Token(D, teamT2, 'admin'),
      L: await v1Token(L, null, 'member'),
      P: (await v2Session(P)).token,
    }
    type Caller = keyof typeof tokens

    // R24h: P sees this autonomous team run only as the approval's target.
    const approval = await createApprovalRequest({
      recipeNamespace: ns,
      recipeName: s12('h'),
      targetUserId: P.id,
      payload: { message: 'Approve the autonomous run' },
      idempotencyKey: `s12-h-${randomUUID()}`,
    })
    if (!('status' in approval) || approval.status !== 'pending') {
      throw new Error(`expected a pending approval, got ${JSON.stringify(approval)}`)
    }

    const rows: Array<{
      row: string
      recipe: string
      run: Parameters<typeof insertRun>[0]
      caller: Caller
      status: 200 | 404
      /** For a 404 row, who then cancels the same run (the path was reachable). */
      permitted?: Caller
      /** For a 404 row, whether the caller still sees the run in the list. */
      visible?: boolean
    }> = [
      {
        row: 'R24a scheduled',
        recipe: s12('a1'),
        run: {
          recipe: s12('a1'),
          phase: 'Running',
          actorType: 'scheduled',
          teamId: teamT,
          child: 'c-a1',
        },
        caller: 'A',
        status: 200,
      },
      {
        row: 'R24a autonomous',
        recipe: s12('a2'),
        run: { recipe: s12('a2'), phase: 'Pending', actorType: 'autonomous', teamId: teamT },
        caller: 'A',
        status: 200,
      },
      {
        row: 'R24b user run with a NULL actor id',
        recipe: s12('b'),
        run: {
          recipe: s12('b'),
          phase: 'Pending',
          actorType: 'user',
          actorId: null,
          teamId: teamT,
        },
        caller: 'A',
        status: 200,
      },
      {
        row: "R24c a teammate's manual run",
        recipe: s12('c'),
        run: {
          recipe: s12('c'),
          phase: 'Pending',
          actorType: 'user',
          actorId: principalOf(M),
          teamId: teamT,
        },
        caller: 'A',
        status: 404,
        permitted: 'M',
        visible: false,
      },
      {
        row: 'R24d admin of the run team, session scoped to another team',
        recipe: s12('d'),
        run: { recipe: s12('d'), phase: 'Pending', actorType: 'scheduled', teamId: teamT },
        caller: 'D',
        status: 404,
        permitted: 'A',
        visible: false,
      },
      {
        row: 'R24e member',
        recipe: s12('e-member'),
        run: { recipe: s12('e-member'), phase: 'Pending', actorType: 'scheduled', teamId: teamT },
        caller: 'M',
        status: 404,
        permitted: 'A',
        visible: true,
      },
      {
        row: 'R24e inviter',
        recipe: s12('e-inviter'),
        run: { recipe: s12('e-inviter'), phase: 'Pending', actorType: 'scheduled', teamId: teamT },
        caller: 'I',
        status: 404,
        permitted: 'A',
        visible: true,
      },
      {
        row: 'R24e removed admin',
        recipe: s12('e-removed'),
        run: { recipe: s12('e-removed'), phase: 'Pending', actorType: 'scheduled', teamId: teamT },
        caller: 'X',
        status: 404,
        permitted: 'A',
        visible: false,
      },
      {
        row: 'R24f launcher of a run with no team',
        recipe: s12('f-launcher'),
        run: {
          recipe: s12('f-launcher'),
          phase: 'Pending',
          actorType: 'user',
          actorId: principalOf(L),
        },
        caller: 'L',
        status: 200,
      },
      {
        row: 'R24f anyone else on a run with no team',
        recipe: s12('f-other'),
        run: {
          recipe: s12('f-other'),
          phase: 'Pending',
          actorType: 'user',
          actorId: principalOf(L),
        },
        caller: 'A',
        status: 404,
        permitted: 'L',
        visible: false,
      },
      {
        row: 'R24h approval target who is not an admin',
        recipe: s12('h'),
        run: {
          recipe: s12('h'),
          phase: 'Pending',
          actorType: 'autonomous',
          teamId: teamT,
          approvalRequestId: approval.id,
        },
        caller: 'P',
        status: 404,
        permitted: 'A',
        visible: true,
      },
    ]

    for (const entry of rows) {
      const runId = await insertRun(entry.run)
      const listed = await listCanonicalRuns(
        ns,
        entry.recipe,
        50,
        await callerFor(tokens[entry.caller])
      )
      const listedRun = listed.find(run => run.id === runId) as
        | { viewerCanCancel?: boolean }
        | undefined
      // viewerCanCancel is true exactly for the rows the cancel accepts.
      expect({
        row: entry.row,
        visible: Boolean(listedRun),
        viewerCanCancel: listedRun?.viewerCanCancel,
      }).toEqual({
        row: entry.row,
        visible: entry.status === 200 ? true : entry.visible,
        viewerCanCancel: entry.status === 200 ? true : entry.visible ? false : undefined,
      })

      const before = await readRun(runId)
      const response = await cancel(tokens[entry.caller], runId, entry.recipe)
      expect({ row: entry.row, status: response.status }).toEqual({
        row: entry.row,
        status: entry.status,
      })
      if (entry.status === 200) {
        expect((await readRun(runId)).cancel_requested_at).toBeInstanceOf(Date)
        continue
      }
      expect(response.body).toEqual({ error: 'workflow_run_not_found' })
      expect(await readRun(runId)).toEqual(before)
      // Liveness: the run was cancellable, by a permitted caller.
      const permitted = await cancel(tokens[entry.permitted!], runId, entry.recipe)
      expect({ row: entry.row, status: permitted.status }).toEqual({ row: entry.row, status: 200 })
      expect((await readRun(runId)).cancel_requested_at).toBeInstanceOf(Date)
    }

    // R24g (cron run with no team) and R24l (admin-UI run): 404 for every
    // external caller, so no permitted caller exists. Witness substitution
    // approved by the coordinator (C1-C5-r5.md:380, :384): the row is
    // unchanged, the cancel's locked read returned the run, and the same caller
    // cancels a sibling run it may cancel.
    const lockReads: Array<{ runId: unknown; rowCount: number | null }> = []
    const lockRecorder: QueryHook = {
      after: (text, values, result) => {
        if (text === LOCK_RUN_FOR_CANCEL)
          lockReads.push({ runId: values?.[0], rowCount: result.rowCount })
      },
    }
    hooks.add(lockRecorder)
    try {
      const unreachable = [
        {
          row: 'R24g cron run with no team',
          run: await insertRun({ recipe: s12('g'), phase: 'Pending', actorType: 'scheduled' }),
          recipe: s12('g'),
        },
        {
          row: 'R24l admin-UI run',
          run: await insertRun({
            recipe: s12('l'),
            phase: 'Pending',
            actorType: 'admin',
            teamId: teamT,
          }),
          recipe: s12('l'),
        },
      ]
      for (const { row, run, recipe } of unreachable) {
        for (const caller of ['A', 'L', 'M', 'P'] as const) {
          const listed = await listCanonicalRuns(ns, recipe, 50, await callerFor(tokens[caller]))
          expect({ row, caller, listed: listed.some(entry => entry.id === run) }).toEqual({
            row,
            caller,
            listed: false,
          })
          const before = await readRun(run)
          lockReads.length = 0
          const response = await cancel(tokens[caller], run, recipe)
          expect({ row, caller, status: response.status }).toEqual({ row, caller, status: 404 })
          expect(response.body).toEqual({ error: 'workflow_run_not_found' })
          expect(await readRun(run)).toEqual(before)
          expect(lockReads).toEqual([{ runId: run, rowCount: 1 }])
        }
      }
    } finally {
      hooks.delete(lockRecorder)
    }
    // The same callers cancel a sibling run they may cancel.
    const siblings: Array<[keyof typeof tokens, string]> = [
      [
        'A',
        await insertRun({
          recipe: s12('g-sibling'),
          phase: 'Pending',
          actorType: 'scheduled',
          teamId: teamT,
        }),
      ],
      ['L', await launcherRun('Pending', s12('g-sibling'))],
      [
        'M',
        await insertRun({
          recipe: s12('g-sibling'),
          phase: 'Pending',
          actorType: 'user',
          actorId: principalOf(M),
          teamId: teamT,
        }),
      ],
      [
        'P',
        await insertRun({
          recipe: s12('g-sibling'),
          phase: 'Pending',
          actorType: 'user',
          actorId: P.id,
        }),
      ],
    ]
    for (const [caller, run] of siblings) {
      const response = await cancel(tokens[caller], run, s12('g-sibling'))
      expect({ caller, status: response.status }).toEqual({ caller, status: 200 })
      expect((await readRun(run)).phase).toBe('Canceled')
    }
  }, 120_000)

  it("an admin cancel needs the scope team's live grant on the run's recipe", async () => {
    // M-93: the admin path also needs a team_workflow_triggers row for (scope
    // team, run recipe). The launcher path does not.
    const recipe = `s12-grant-${suffix}`
    const token = await v1Token(A, teamT, 'admin')
    const grantRow = [teamT, ns, recipe]
    const removeGrant = () =>
      databasePool.query(
        `DELETE FROM team_workflow_triggers
          WHERE team_id = $1 AND recipe_namespace = $2 AND recipe_name = $3`,
        grantRow
      )
    const restoreGrant = () =>
      databasePool.query(
        `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
         VALUES ($1, $2, $3)`,
        grantRow
      )
    await restoreGrant()
    // A run the admin sees only as the approval's target, so the list shows it
    // while the team's grant is absent.
    const approval = await createApprovalRequest({
      recipeNamespace: ns,
      recipeName: recipe,
      targetUserId: A.id,
      payload: { message: 'Approve the scheduled run' },
      idempotencyKey: `s12-grant-${randomUUID()}`,
    })
    if (!('status' in approval) || approval.status !== 'pending') {
      throw new Error(`expected a pending approval, got ${JSON.stringify(approval)}`)
    }
    const teamRun = await insertRun({
      recipe,
      phase: 'Running',
      actorType: 'scheduled',
      teamId: teamT,
      child: 'c-grant',
    })
    const targetRun = await insertRun({
      recipe,
      phase: 'Pending',
      actorType: 'scheduled',
      teamId: teamT,
      approvalRequestId: approval.id,
    })
    const listedFlags = async () => {
      const listed = await listCanonicalRuns(ns, recipe, 50, await callerFor(token))
      const flag = (runId: string) => {
        const run = listed.find(entry => entry.id === runId) as
          | { viewerCanCancel?: boolean }
          | undefined
        return run ? run.viewerCanCancel : 'not listed'
      }
      return { teamRun: flag(teamRun), targetRun: flag(targetRun) }
    }

    await removeGrant()
    // (b) Without the grant the team run is not listed (the list needs the
    // grant for team runs); the run listed through its approval target does
    // not offer the cancel.
    expect(await listedFlags()).toEqual({ teamRun: 'not listed', targetRun: false })
    // (a) The run team's live admin gets the not-found answer and nothing changes.
    for (const runId of [teamRun, targetRun]) {
      const before = await readRun(runId)
      const response = await cancel(token, runId, recipe)
      expect({ runId, status: response.status }).toEqual({ runId, status: 404 })
      expect(response.body).toEqual({ error: 'workflow_run_not_found' })
      const after = await readRun(runId)
      expect(after).toEqual(before)
      expect({
        cancel_requested_at: after.cancel_requested_at,
        canceled_by: after.canceled_by,
      }).toEqual({ cancel_requested_at: null, canceled_by: null })
    }
    expect((await readRun(teamRun)).phase).toBe('Running')
    expect((await readRun(targetRun)).phase).toBe('Pending')

    // Liveness: with the grant restored the same admin is offered the cancel and
    // cancels the same runs.
    await restoreGrant()
    expect(await listedFlags()).toEqual({ teamRun: true, targetRun: true })
    for (const runId of [teamRun, targetRun]) {
      const response = await cancel(token, runId, recipe)
      expect({ runId, status: response.status }).toEqual({ runId, status: 200 })
      expect((await readRun(runId)).canceled_by).toBe(A.id)
    }
    expect((await readRun(teamRun)).cancel_requested_at).toBeInstanceOf(Date)
    expect((await readRun(targetRun)).phase).toBe('Canceled')
  })

  // ── S13 · run ids ───────────────────────────────────────────────────────

  it('unknown, foreign-recipe and non-uuid run ids are not found', async () => {
    const token = await v1Token(L, null, 'member')
    const recipe = `s13-${suffix}`
    const foreignRun = await launcherRun('Pending', `s13-other-${suffix}`)
    const foreignBefore = await readRun(foreignRun)

    for (const runId of [randomUUID(), foreignRun, 'not-a-uuid', foreignRun.toUpperCase()]) {
      const response = await cancel(token, runId, recipe)
      expect({ runId, status: response.status, body: response.body }).toEqual({
        runId,
        status: 404,
        body: { error: 'workflow_run_not_found' },
      })
    }
    expect(await readRun(foreignRun)).toEqual(foreignBefore)

    // Liveness: a valid id on the same recipe is cancelled.
    const validRun = await launcherRun('Pending', recipe)
    const response = await cancel(token, validRun, recipe)
    expect(response.status).toBe(200)
    expect((await readRun(validRun)).phase).toBe('Canceled')
  }, 60_000)

  // ── S14 · session contracts ─────────────────────────────────────────────

  it('V1 and V2 sessions cancel the same way and no delegation is read', async () => {
    const recipe = `s14-${suffix}`
    const v1 = await v1Token(L, null, 'member')
    const v2 = await v2Session(L)
    const cases: Array<{ label: string; token: string; headers: Record<string, string> }> = [
      { label: 'V1 session', token: v1, headers: {} },
      { label: 'V2 session without a delegation', token: v2.token, headers: {} },
      {
        label: 'V2 session with an arbitrary delegation header',
        token: v2.token,
        headers: { [WORKFLOW_ACTION_DELEGATION_HEADER]: 'not-a-delegation' },
      },
    ]
    for (const { label, token, headers } of cases) {
      const runId = await launcherRun('Pending', recipe)
      const response = await cancel(token, runId, recipe, headers)
      expect({ label, status: response.status }).toEqual({ label, status: 200 })
      expect(await readRun(runId)).toMatchObject({ phase: 'Canceled', canceled_by: L.id })
    }
  }, 60_000)

  // ── S15, S16 · by phase ─────────────────────────────────────────────────

  it('a run without a child is Canceled in the cancel transaction', async () => {
    const recipe = `s15-${suffix}`
    const token = await v1Token(L, null, 'member')
    for (const phase of ['Pending', 'AuthorizationPaused'] as const) {
      const runId = await launcherRun(phase, recipe)
      const { result: response, payloads } = await notificationsDuring(() =>
        cancel(token, runId, recipe).then(r => r)
      )
      expect({ phase, status: response.status }).toEqual({ phase, status: 200 })
      const row = await readRun(runId)
      expect(row).toMatchObject({ phase: 'Canceled', canceled_by: L.id, child_recipe_name: null })
      expect(row.completed_at).toBeInstanceOf(Date)
      expect(row.cancel_requested_at).toBeInstanceOf(Date)
      expect({ phase, payloads }).toEqual({ phase, payloads: [runId] })
    }
  }, 60_000)

  it('a run with a child keeps its phase and stores the request', async () => {
    const token = await v1Token(L, null, 'member')
    const v1Run = await launcherRun('Running', cancelRecipe, 'child-v1')
    const v2 = await triggerV2()
    const running = await databasePool.query(
      `UPDATE workflow_runs
          SET phase = 'Running', started_at = now(),
              child_recipe_name = 'child-v2', child_recipe_namespace = $2
        WHERE run_id = $1`,
      [v2.runId, ns]
    )
    expect(running.rowCount).toBe(1)

    for (const [label, runId] of [
      ['V1 run', v1Run],
      ['V2 run', v2.runId],
    ] as const) {
      const { result: response, payloads } = await notificationsDuring(() =>
        cancel(token, runId, cancelRecipe).then(r => r)
      )
      expect({ label, status: response.status }).toEqual({ label, status: 200 })
      const row = await readRun(runId)
      expect(row).toMatchObject({ phase: 'Running', canceled_by: L.id, completed_at: null })
      expect(row.cancel_requested_at).toBeInstanceOf(Date)
      // The phase did not change, so the explicit notification is the only one.
      expect({ label, payloads }).toEqual({ label, payloads: [runId] })
    }
  }, 60_000)

  // ── S19 · repeats and finished runs ─────────────────────────────────────

  it('cancel is idempotent and refuses finished runs', async () => {
    const recipe = `s19-${suffix}`
    const tokenA = await v1Token(A, teamT, 'admin')
    const tokenA2 = await v1Token(A2, teamT, 'admin')
    // An admin cancel needs the scope team's live grant on the recipe (M-93).
    await databasePool.query(
      `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3)`,
      [teamT, ns, recipe]
    )

    const runId = await insertRun({
      recipe,
      phase: 'Running',
      actorType: 'scheduled',
      teamId: teamT,
      child: 'child-s19',
    })
    expect((await cancel(tokenA, runId, recipe)).status).toBe(200)
    const first = await readRun(runId)
    expect(first.canceled_by).toBe(A.id)
    expect(first.cancel_requested_at).toBeInstanceOf(Date)

    const { result: again, payloads } = await notificationsDuring(() =>
      cancel(tokenA2, runId, recipe).then(r => r)
    )
    expect(again.status).toBe(200)
    expect(await readRun(runId)).toEqual(first)
    // The request is announced again so a lost delivery is retried.
    expect(payloads).toEqual([runId])

    const canceled = await insertRun({
      recipe,
      phase: 'Canceled',
      actorType: 'scheduled',
      teamId: teamT,
    })
    const canceledBefore = await readRun(canceled)
    const canceledResponse = await cancel(tokenA, canceled, recipe)
    expect(canceledResponse.status).toBe(200)
    expect(canceledResponse.body.run).toMatchObject({ id: canceled, phase: 'Canceled' })
    expect(await readRun(canceled)).toEqual(canceledBefore)

    for (const phase of ['Succeeded', 'Failed'] as const) {
      const finished = await insertRun({ recipe, phase, actorType: 'scheduled', teamId: teamT })
      const before = await readRun(finished)
      const response = await cancel(tokenA, finished, recipe)
      expect({ phase, status: response.status, body: response.body }).toEqual({
        phase,
        status: 409,
        body: { error: 'workflow_run_not_cancellable' },
      })
      expect(await readRun(finished)).toEqual(before)
    }
  }, 60_000)

  // ── S21 · the pending claim ─────────────────────────────────────────────

  /** A pool whose every transaction runs as the workflow-recipes runtime role. */
  function runtimePool(beforeQuery?: (text: string) => Promise<void>): Pool {
    const runtimeClient = async (): Promise<PoolClient> => {
      const client = await databasePool.connect()
      return {
        query: async (...args: Parameters<PoolClient['query']>) => {
          await beforeQuery?.(queryText(args[0]))
          const result = await client.query(...args)
          if (queryText(args[0]).trim().toUpperCase() === 'BEGIN') {
            await client.query('SET LOCAL ROLE workflow_recipes_runtime')
          }
          return result
        },
        on: client.on.bind(client),
        release: client.release.bind(client),
      } as unknown as PoolClient
    }
    return {
      connect: runtimeClient,
      query: async (text: string, values?: unknown[]) => {
        const client = await runtimeClient()
        try {
          await client.query('BEGIN')
          const result = await client.query(text, values)
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

  function recordCancelPids(): { pids: number[]; hook: QueryHook } {
    const pids: number[] = []
    const hook: QueryHook = {
      before: (text, _values, client) => {
        if (text === LOCK_RUN_FOR_CANCEL)
          pids.push((client as unknown as { processID: number }).processID)
      },
    }
    hooks.add(hook)
    return { pids, hook }
  }

  async function waitForCancelLockWait(pids: number[]) {
    await waitFor(async () => {
      if (pids.length !== 1) return false
      const waiting = await databasePool.query(
        `SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted`,
        [pids[0]]
      )
      return (waiting.rowCount ?? 0) > 0
    }, 'the cancel to wait on the run row lock')
  }

  it('cancel serialises with the pending claim', async () => {
    const recipe = `s21-${suffix}`
    const token = await v1Token(L, null, 'member')

    // Claim first: the claim transaction holds the row; the cancel waits, then
    // reads `Running` with the child and stores a request.
    const claimedRun = await launcherRun('Pending', recipe)
    const childCreation = gate()
    const childEntered = gate()
    const claimer = createDbRunProcessor({
      instanceId: `s21-forward-${suffix}`,
      pool: runtimePool(),
      runPollMs: 60_000,
      maxRunDurationCapSeconds: 86_400,
      createChildRecipe: async () => {
        childEntered.open()
        await childCreation.opened
        return { name: 'child-s21', namespace: ns }
      },
      deliverCancelSignal: () => {
        throw new Error('no cancel is delivered by this test')
      },
    })
    const claim = claimer.processPending(claimedRun)
    await childEntered.opened
    const { pids, hook } = recordCancelPids()
    try {
      const pendingCancel = cancel(token, claimedRun, recipe).then(r => r)
      await waitForCancelLockWait(pids)
      childCreation.open()
      await claim
      const response = await pendingCancel
      expect(response.status).toBe(200)
    } finally {
      hooks.delete(hook)
    }
    const claimed = await readRun(claimedRun)
    expect(claimed).toMatchObject({
      phase: 'Running',
      child_recipe_name: 'child-s21',
      canceled_by: L.id,
      completed_at: null,
    })
    expect(claimed.cancel_requested_at).toBeInstanceOf(Date)

    // Cancel first: the processor's locked read sees `Canceled` and creates no child.
    const canceledRun = await launcherRun('Pending', recipe)
    const lockedReadReached = gate()
    const lockedReadRelease = gate()
    const lockedReads: string[] = []
    const createChildRecipe = vi.fn(async () => ({ name: 'child-s21-reverse', namespace: ns }))
    const reverse = createDbRunProcessor({
      instanceId: `s21-reverse-${suffix}`,
      pool: runtimePool(async text => {
        if (!text.includes('FOR UPDATE OF run')) return
        lockedReads.push(text)
        lockedReadReached.open()
        await lockedReadRelease.opened
      }),
      runPollMs: 60_000,
      maxRunDurationCapSeconds: 86_400,
      createChildRecipe,
      deliverCancelSignal: () => {
        throw new Error('no cancel is delivered by this test')
      },
    })
    const reverseClaim = reverse.processPending(canceledRun)
    await lockedReadReached.opened
    const response = await cancel(token, canceledRun, recipe)
    expect(response.status).toBe(200)
    expect((await readRun(canceledRun)).phase).toBe('Canceled')
    lockedReadRelease.open()
    await reverseClaim
    // Witness: the processor's locked read ran after the cancel committed.
    expect(lockedReads).toHaveLength(1)
    expect(createChildRecipe).not.toHaveBeenCalled()
    expect(await readRun(canceledRun)).toMatchObject({ phase: 'Canceled', child_recipe_name: null })
  }, 60_000)

  // ── S22 · resume ────────────────────────────────────────────────────────

  it('cancel then resume, and resume then cancel', async () => {
    for (const withChild of [false, true]) {
      // Cancel first.
      const first = await triggerV2()
      const firstAuthority = await produceRunResumeAuthority(first.caller, first.runId)
      await pause(first.runId, withChild)
      expect((await cancel(first.token, first.runId, cancelRecipe)).status).toBe(200)
      const afterCancel = await readRun(first.runId)
      expect(afterCancel.cancel_requested_at).toBeInstanceOf(Date)
      expect(afterCancel.phase).toBe(withChild ? 'AuthorizationPaused' : 'Canceled')
      await expect(
        resumeWorkflowRun({
          runId: first.runId,
          recipeNamespace: ns,
          recipeName: cancelRecipe,
          authority: firstAuthority,
          db: databasePool,
        })
      ).rejects.toMatchObject({ status: 409, code: 'workflow_run_not_paused' })
      expect(await readRun(first.runId)).toMatchObject({
        phase: withChild ? 'AuthorizationPaused' : 'Canceled',
        canceled_by: L.id,
      })

      // Resume first.
      const second = await triggerV2()
      const secondAuthority = await produceRunResumeAuthority(second.caller, second.runId)
      await pause(second.runId, withChild)
      const resumed = await resumeWorkflowRun({
        runId: second.runId,
        recipeNamespace: ns,
        recipeName: cancelRecipe,
        authority: secondAuthority,
        db: databasePool,
      })
      expect(resumed.phase).toBe(withChild ? 'Running' : 'Pending')
      expect((await cancel(second.token, second.runId, cancelRecipe)).status).toBe(200)
      const afterResume = await readRun(second.runId)
      expect(afterResume.cancel_requested_at).toBeInstanceOf(Date)
      expect(afterResume.phase).toBe(withChild ? 'Running' : 'Canceled')
    }
  }, 120_000)

  // ── S24 · step approvals ────────────────────────────────────────────────

  it("cancel cancels the run's pending step approvals", async () => {
    const recipe = `s24-${suffix}`
    const token = await v1Token(L, null, 'member')

    const target = await runReadyForApprovals(recipe)
    const approvedProof = await runningStep(target.runId, 'step-approved')
    const approved = await requestStepApproval({
      ...target,
      recipe,
      stepId: 'step-approved',
      proof: approvedProof,
    })
    if (!('status' in approved)) throw new Error('expected an approval')
    const decided = await recordDecision(approved.id, 'approve', { userId: P.id })
    expect(decided).toMatchObject({ ok: true })
    const pendingProof = await runningStep(target.runId, 'step-pending')
    const pending = await requestStepApproval({
      ...target,
      recipe,
      stepId: 'step-pending',
      proof: pendingProof,
    })
    if (!('status' in pending)) throw new Error('expected an approval')

    const other = await runReadyForApprovals(recipe)
    const otherProof = await runningStep(other.runId, 'step-other')
    const otherApproval = await requestStepApproval({
      ...other,
      recipe,
      stepId: 'step-other',
      proof: otherProof,
    })
    if (!('status' in otherApproval)) throw new Error('expected an approval')

    expect(await approvalOf(pending.id)).toMatchObject({
      status: 'pending',
      bound_workflow_run_id: target.runId,
    })
    expect((await cancel(token, target.runId, recipe)).status).toBe(200)

    expect(await approvalOf(pending.id)).toEqual({
      status: 'cancelled',
      cancelled_by: L.id,
      bound_workflow_run_id: target.runId,
    })
    // Untouched: the approved approval of the same run, the pending one of another run.
    expect(await approvalOf(approved.id)).toMatchObject({ status: 'approved', cancelled_by: null })
    expect(await approvalOf(otherApproval.id)).toMatchObject({
      status: 'pending',
      cancelled_by: null,
      bound_workflow_run_id: other.runId,
    })
  }, 60_000)

  // ── S29 · one transaction ───────────────────────────────────────────────

  it('a failure after the run update rolls everything back', async () => {
    const recipe = `s29-${suffix}`
    const token = await v1Token(L, null, 'member')
    const run = await runReadyForApprovals(recipe)
    const proof = await runningStep(run.runId, 'step-s29')
    const approval = await requestStepApproval({ ...run, recipe, stepId: 'step-s29', proof })
    if (!('status' in approval)) throw new Error('expected an approval')
    const runBefore = await readRun(run.runId)
    const approvalBefore = await approvalOf(approval.id)

    await databasePool.query(`
      CREATE FUNCTION s29_injected_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 's29 injected approvals fault';
      END
      $$;
      CREATE TRIGGER s29_injected_fault
        BEFORE UPDATE ON workflow_approval_requests
        FOR EACH STATEMENT EXECUTE FUNCTION s29_injected_fault();
    `)
    capturedErrors.length = 0
    try {
      const response = await cancel(token, run.runId, recipe)
      expect(response.status).toBe(500)
      // Witness: the approvals statement was reached, after the run update.
      expect(capturedErrors).toHaveLength(1)
      expect(String((capturedErrors[0] as Error).message)).toContain('s29 injected approvals fault')
    } finally {
      await databasePool.query(`
        DROP TRIGGER IF EXISTS s29_injected_fault ON workflow_approval_requests;
        DROP FUNCTION IF EXISTS s29_injected_fault();
      `)
    }
    expect(await readRun(run.runId)).toEqual(runBefore)
    expect(await approvalOf(approval.id)).toEqual(approvalBefore)
  }, 60_000)

  // ── S41 · approvals and cancel on one run ───────────────────────────────

  it('an approval and a cancel on the same run serialise on the run row', async () => {
    const recipe = `s41-${suffix}`
    const token = await v1Token(L, null, 'member')

    // Approval first: its binding read holds the share lock; the cancel waits,
    // then cancels the approval in its step 4.
    const held = await runReadyForApprovals(recipe)
    const heldProof = await runningStep(held.runId, 'step-held')
    const insertReached = gate()
    const insertRelease = gate()
    const approvalGate: QueryHook = {
      before: async text => {
        if (!text.includes('INSERT INTO workflow_approval_requests')) return
        insertReached.open()
        await insertRelease.opened
      },
    }
    hooks.add(approvalGate)
    const { pids, hook } = recordCancelPids()
    let heldApprovalId: string
    try {
      const approvalPromise = requestStepApproval({
        ...held,
        recipe,
        stepId: 'step-held',
        proof: heldProof,
      })
      await insertReached.opened
      hooks.delete(approvalGate)
      const pendingCancel = cancel(token, held.runId, recipe).then(r => r)
      await waitForCancelLockWait(pids)
      insertRelease.open()
      const created = await approvalPromise
      if (!('status' in created) || created.status !== 'pending') {
        throw new Error(`expected a pending approval, got ${JSON.stringify(created)}`)
      }
      heldApprovalId = created.id
      expect((await pendingCancel).status).toBe(200)
    } finally {
      hooks.delete(approvalGate)
      hooks.delete(hook)
      insertRelease.open()
    }
    expect(await approvalOf(heldApprovalId)).toEqual({
      status: 'cancelled',
      cancelled_by: L.id,
      bound_workflow_run_id: held.runId,
    })

    // Cancel first: the binding read sees the request and binds nothing.
    const refused = await runReadyForApprovals(recipe)
    const refusedProof = await runningStep(refused.runId, 'step-refused')
    expect((await cancel(token, refused.runId, recipe)).status).toBe(200)
    const refusedKey = `s41-refused-${randomUUID()}`
    await expect(
      requestStepApproval({
        ...refused,
        recipe,
        stepId: 'step-refused',
        proof: refusedProof,
        idempotencyKey: refusedKey,
      })
    ).rejects.toBeInstanceOf(InvalidWorkflowApprovalRunBindingError)
    const refusedRows = await databasePool.query(
      `SELECT 1 FROM workflow_approval_requests
        WHERE idempotency_key = $1 OR bound_workflow_run_id = $2`,
      [refusedKey, refused.runId]
    )
    expect(refusedRows.rowCount).toBe(0)

    // Liveness: on a run without a request the same producer binds an approval.
    const open = await runReadyForApprovals(recipe)
    const openProof = await runningStep(open.runId, 'step-open')
    const openApproval = await requestStepApproval({
      ...open,
      recipe,
      stepId: 'step-open',
      proof: openProof,
    })
    if (!('status' in openApproval)) throw new Error('expected an approval')
    expect(await approvalOf(openApproval.id)).toMatchObject({
      status: 'pending',
      bound_workflow_run_id: open.runId,
    })

    // SAF-j at rest: no pending approval is bound to a run with a cancel request.
    const atRest = await databasePool.query<{ bound: number; violating: number }>(
      `SELECT COUNT(*)::int AS bound,
              COUNT(*) FILTER (WHERE war.status = 'pending'
                                 AND wr.cancel_requested_at IS NOT NULL)::int AS violating
         FROM workflow_approval_requests war
         JOIN workflow_runs wr ON wr.run_id = war.bound_workflow_run_id
        WHERE wr.recipe_name = $1`,
      [recipe]
    )
    expect(atRest.rows).toEqual([{ bound: 2, violating: 0 }])
  }, 60_000)

  // ── S44 · legacy running row ────────────────────────────────────────────

  it('a running row without a child is not cancellable', async () => {
    const recipe = `s44-${suffix}`
    const token = await v1Token(L, null, 'member')
    const legacy = await launcherRun('Running', recipe)
    const before = await readRun(legacy)
    const response = await cancel(token, legacy, recipe)
    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'workflow_run_not_cancellable' })
    expect(await readRun(legacy)).toEqual(before)
    expect(before.cancel_requested_at).toBeNull()

    // Liveness: a running row with a child takes the request branch.
    const withChild = await launcherRun('Running', recipe, 'child-s44')
    expect((await cancel(token, withChild, recipe)).status).toBe(200)
    const row = await readRun(withChild)
    expect(row).toMatchObject({ phase: 'Running', canceled_by: L.id })
    expect(row.cancel_requested_at).toBeInstanceOf(Date)
  }, 60_000)

  // ── S40 · a step held on an approval, end to end ────────────────────────

  it('cancel during a step held on an approval ends Canceled', async () => {
    const recipe = `s40-${suffix}`
    const token = await v1Token(L, null, 'member')
    const target = await runReadyForApprovals(recipe)
    const proof = await runningStep(target.runId, 'step-held')
    const held = await requestStepApproval({ ...target, recipe, stepId: 'step-held', proof })
    if (!('status' in held)) throw new Error('expected an approval')
    expect(await approvalOf(held.id)).toMatchObject({
      status: 'pending',
      bound_workflow_run_id: target.runId,
    })
    expect(await readRun(target.runId)).toMatchObject({
      phase: 'Running',
      child_recipe_name: target.child,
    })

    expect((await cancel(token, target.runId, recipe)).status).toBe(200)

    expect(await approvalOf(held.id)).toEqual({
      status: 'cancelled',
      cancelled_by: L.id,
      bound_workflow_run_id: target.runId,
    })
    // mcp-host's gateStep throws on the cancelled approval and returns the step
    // failed with this error (mcp-host/src/workflow/userApprovalRequester.ts,
    // workflowService.ts); the runtime then reports the workflow failed.
    const stepError = `approval-denied: Approval cancelled for step (request ${held.id})`
    const onRunTerminal = vi.fn()
    const processor = createDbRunProcessor({
      instanceId: `s40-${suffix}`,
      pool: runtimePool(),
      runPollMs: 60_000,
      maxRunDurationCapSeconds: 86_400,
      createChildRecipe: async () => {
        throw new Error('no child is created by this test')
      },
      deliverCancelSignal: () => {
        throw new Error('no cancel is delivered by this test')
      },
      onRunTerminal,
    })
    await processor.syncFromRecipeExecution({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: target.child,
        namespace: ns,
        labels: { 'clerum.io/workflow-run-id': target.runId },
      },
      spec: {},
      status: {
        phase: 'active',
        workflowExecution: { phase: 'failed' },
        steps: [{ id: 'step-held', phase: 'failed', error: stepError }],
      },
    } as never)

    expect(await readRun(target.runId)).toMatchObject({ phase: 'Canceled', canceled_by: L.id })
    const step = await databasePool.query(
      `SELECT phase, error FROM workflow_run_steps WHERE run_id = $1 AND step_id = 'step-held'`,
      [target.runId]
    )
    expect(step.rows).toEqual([{ phase: 'Failed', error: stepError }])
    expect(onRunTerminal).toHaveBeenCalledOnce()
    expect(onRunTerminal).toHaveBeenCalledWith(target.runId, 'Canceled')
  }, 60_000)
})
