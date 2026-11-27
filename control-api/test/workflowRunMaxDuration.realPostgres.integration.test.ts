import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import { initDb, pool } from '../src/db.js'
import { K8sGateway } from '../src/k8s.js'
import type { ExternalAuthedRequest } from '../src/middleware/externalSessionAuth.js'
import { authorizeActionV2 } from '../src/services/access/actionAuthorizer.js'
import { prepareActionOperationTarget } from '../src/services/access/actionMessageId.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import { resolveEffectiveUserAccessPolicy } from '../src/services/access/userAccessRuntimePolicy.js'
import {
  type ExternalSessionAuthorityContext,
  authenticateExternalUserSession,
} from '../src/services/auth/externalSessionAuthentication.js'
import { createUserSession } from '../src/services/auth/userSessionService.js'
import { recordDecision } from '../src/services/userApprovalRequestService.js'
import { processMaturedSchedules } from '../src/services/workflowScheduleWorkerService.js'
import {
  WORKFLOW_ACTION_DELEGATION_HEADER,
  requireCurrentWorkflowTriggerAuthority,
  requireWorkflowActionAuthority,
} from '../src/services/workflows/workflowAuthorityBindingService.js'
import { WORKFLOW_RUN_MAX_DURATION_CAP_SECONDS } from '../src/services/workflows/workflowRunDuration.js'
import { createWorkflowTriggerApprovalRequest } from '../src/services/workflows/workflowTriggerApprovalService.js'
import { triggerWorkflow } from '../src/services/workflows/workflowTriggerService.js'
import {
  issueUserDelegationV2,
  verifyUserDelegationV2,
} from '../src/utils/auth/userDelegationV2Token.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { TemporaryKubernetesApi } from './helpers/temporaryKubernetesApi.js'
import './realPostgres.requirement.ts'
import { waitForDatabaseConnectionsToClose } from './realPostgresCleanup.ts'

vi.mock('../src/services/notificationEmitter.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/notificationEmitter.js')>()),
  emitNotification: vi.fn().mockResolvedValue(undefined),
}))

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

/** The value a recipe gives in `spec.runRetention.maxRunDurationSeconds`. */
const RECIPE_DURATION_SECONDS = 600

type Producer = 'v1' | 'v2' | 'decision' | 'legacyConsume' | 'cron'

/**
 * Every `INSERT INTO workflow_runs` stores a
 * duration. Each producer enters through its production entry point, so the
 * NULL comes from the recipe read, the stored approval run intent or the
 * schedule row, never from a hand-built insert:
 *   - V1 and V2 trigger and cron reach createRun (workflowRunService);
 *   - an approve decision on an approval whose typed run intent holds NULL
 *     reaches createWorkflowRunForApprovedTriggerIntent (userApprovalRequestService);
 *   - the mcp-host consume of an approval without a typed run intent (one
 *     written before typed intents existed) reaches createApprovedRun.
 */
const cases: Array<{
  name: string
  producer: Producer
  recipeDuration: number | null
  expected: number
  triggerSource: string
}> = [
  {
    name: 'V1 trigger, recipe without a duration',
    producer: 'v1',
    recipeDuration: null,
    expected: 86_400,
    triggerSource: 'onDemand',
  },
  {
    name: 'V1 trigger, recipe with a duration',
    producer: 'v1',
    recipeDuration: RECIPE_DURATION_SECONDS,
    expected: RECIPE_DURATION_SECONDS,
    triggerSource: 'onDemand',
  },
  {
    name: 'V2 trigger, recipe without a duration',
    producer: 'v2',
    recipeDuration: null,
    expected: 86_400,
    triggerSource: 'onDemand',
  },
  {
    name: 'V2 trigger, recipe with a duration',
    producer: 'v2',
    recipeDuration: RECIPE_DURATION_SECONDS,
    expected: RECIPE_DURATION_SECONDS,
    triggerSource: 'onDemand',
  },
  {
    name: 'approve decision, run intent holding NULL',
    producer: 'decision',
    recipeDuration: null,
    expected: 86_400,
    triggerSource: 'onDemand',
  },
  {
    name: 'approve decision, run intent holding a duration',
    producer: 'decision',
    recipeDuration: RECIPE_DURATION_SECONDS,
    expected: RECIPE_DURATION_SECONDS,
    triggerSource: 'onDemand',
  },
  {
    name: 'mcp-host consume of an approval without a typed run intent, recipe without a duration',
    producer: 'legacyConsume',
    recipeDuration: null,
    expected: 86_400,
    triggerSource: 'autonomous',
  },
  {
    name: 'mcp-host consume of an approval without a typed run intent, recipe with a duration',
    producer: 'legacyConsume',
    recipeDuration: RECIPE_DURATION_SECONDS,
    expected: RECIPE_DURATION_SECONDS,
    triggerSource: 'autonomous',
  },
  {
    name: 'cron fire, schedule row without a duration',
    producer: 'cron',
    recipeDuration: null,
    expected: 86_400,
    triggerSource: 'schedule',
  },
  {
    name: 'cron fire, schedule row with a duration',
    producer: 'cron',
    recipeDuration: RECIPE_DURATION_SECONDS,
    expected: RECIPE_DURATION_SECONDS,
    triggerSource: 'schedule',
  },
]

function recipeName(producer: Producer, recipeDuration: number | null): string {
  return `s33-${producer.toLowerCase()}-${recipeDuration ?? 'none'}`
}

describeRealPostgres('workflow run duration on real PostgreSQL', () => {
  const database = `workflow_run_max_duration_${randomBytes(6).toString('hex')}`
  const userId = randomUUID()
  const contextName = `s33-context-${randomBytes(4).toString('hex')}`
  const ns = config.sandboxNamespace
  const kubernetesApi = new TemporaryKubernetesApi()
  let adminPool: Pool
  let databasePool: Pool
  let gateway: K8sGateway
  let corePoolConnectSpy: ReturnType<typeof vi.spyOn>
  let corePoolQuerySpy: ReturnType<typeof vi.spyOn>

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database}"`)
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    databasePool = new Pool({ connectionString: url.toString() })
    await initDb({ connect: () => databasePool.connect() })
    corePoolConnectSpy = vi
      .spyOn(pool, 'connect')
      .mockImplementation((() => databasePool.connect()) as typeof pool.connect)
    corePoolQuerySpy = vi
      .spyOn(pool, 'query')
      .mockImplementation(((...args: Parameters<typeof pool.query>) =>
        (databasePool.query as typeof pool.query)(...args)) as typeof pool.query)

    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Duration Producer User')`,
      [userId, `${userId}@example.test`]
    )
    await databasePool.query(`INSERT INTO user_contexts(user_id, context_id) VALUES ($1, $2)`, [
      userId,
      `${config.contextsNamespace}/${contextName}`,
    ])
    await databasePool.query(
      `INSERT INTO llm_allowed_models(provider, model, vendor, enabled)
       VALUES ('openai', 's33-test', 'test', TRUE)`
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
    for (const { producer, recipeDuration } of cases) {
      const name = recipeName(producer, recipeDuration)
      await databasePool.query(
        `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
         VALUES ($1, $2, $3)`,
        [userId, ns, name]
      )
      kubernetesApi.put('workflowrecipes', ns, {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: {
          name,
          namespace: ns,
          uid: randomUUID(),
          resourceVersion: '1',
          generation: 1,
        },
        spec: {
          enabled: true,
          contextRef: contextName,
          model: { provider: 'openai', name: 's33-test' },
          ...(recipeDuration === null
            ? {}
            : { runRetention: { maxRunDurationSeconds: recipeDuration } }),
          triggers: { onDemand: { requiresApproval: producer === 'decision' } },
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
  }, 180_000)

  afterAll(async () => {
    try {
      corePoolQuerySpy?.mockRestore()
      corePoolConnectSpy?.mockRestore()
      try {
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

  /** A V1 user-session caller; session acceptance is not this suite's subject. */
  function v1Caller() {
    return {
      kind: 'user-session' as const,
      claims: {
        userId,
        email: `${userId}@example.test`,
        teamId: null,
        role: 'member' as const,
        authGeneration: 1,
        exp: Math.floor(Date.now() / 1000) + 3_600,
      },
      session: {
        contract: 'v1' as const,
        userId,
        tokenHash: 's33-v1-session',
        issuedAt: Math.floor(Date.now() / 1000),
        authGeneration: 1,
      },
    }
  }

  /** The V2 trigger route: real session, live direct-path authorization, signed delegation. */
  async function triggerV2(name: string, idempotencyKey: string) {
    const issued = await createUserSession(
      { userId, email: `${userId}@example.test`, authenticationMethods: ['password'] },
      { db: databasePool as never }
    )
    const identity = await authenticateExternalUserSession(issued.token, {
      purpose: 'protected',
      policy: { ...(await resolveEffectiveUserAccessPolicy()), acceptV2: true },
    })
    if (identity.status !== 'authenticated' || identity.contract !== 'v2') {
      throw new Error('real v2 session producer did not authenticate')
    }
    const resource = canonicalResourceIdentity({
      environmentId: canonicalEnvironmentId(),
      type: 'workflow_recipe',
      logicalId: `${ns}/${name}`,
    })
    const target = Object.freeze({ recipeNamespace: ns, recipeName: name })
    const resolved = await authorizeActionV2({
      session: identity.authorityContext as ExternalSessionAuthorityContext,
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
        userId,
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
    const caller = {
      kind: 'user-session' as const,
      claims: identity.claims,
      session: identity.authorityContext,
    }
    const authority = await requireWorkflowActionAuthority({
      req: {
        rawHeaders: [WORKFLOW_ACTION_DELEGATION_HEADER, token],
        correlationId: randomUUID(),
      } as unknown as ExternalAuthedRequest,
      caller,
      operationId: 'workflow.trigger',
      resourceType: 'workflow_recipe',
      resourceLogicalId: `${ns}/${name}`,
      target,
      gateway,
    })
    if (!authority) throw new Error('v2 trigger producer did not require its signed authority')
    return triggerWorkflow({
      gateway,
      caller,
      recipeNamespace: ns,
      recipeName: name,
      body: {},
      idempotencyKey,
      authority,
      validateCurrentInTransaction: (db, current) =>
        requireCurrentWorkflowTriggerAuthority({ db, authority: current }),
    })
  }

  /**
   * An approve decision on the approval a V1 trigger of a `requiresApproval`
   * recipe stored, run intent included. Returns the created run id.
   */
  async function decide(name: string, recipeDuration: number | null, idempotencyKey: string) {
    const requested = await triggerWorkflow({
      gateway,
      caller: v1Caller(),
      recipeNamespace: ns,
      recipeName: name,
      body: {},
      idempotencyKey,
    })
    if (requested.kind !== 'approval')
      throw new Error(`expected an approval, got ${requested.kind}`)
    const intent = await databasePool.query<{ max_duration_seconds: number | null }>(
      `SELECT max_duration_seconds FROM workflow_approval_trigger_run_intents
        WHERE approval_request_id = $1`,
      [requested.approvalRequestId]
    )
    expect(intent.rows).toEqual([{ max_duration_seconds: recipeDuration }])
    const decided = await recordDecision(requested.approvalRequestId, 'approve', { userId })
    if (!decided.ok || !decided.workflowRun) {
      throw new Error(`approve decision did not create a run: ${JSON.stringify(decided)}`)
    }
    return decided.workflowRun.row.run_id
  }

  /**
   * The mcp-host trigger consuming an approval that predates typed run
   * intents: the approve decision creates no run, so the consume inserts it
   * from the trigger's own recipe read.
   */
  async function consumeLegacy(name: string, idempotencyKey: string) {
    const callerKey = `${ns}/${name}`
    const approval = await createWorkflowTriggerApprovalRequest({
      recipeNamespace: ns,
      recipeName: name,
      callerKey,
      targetUserId: userId,
      payload: { message: 'Approve legacy workflow trigger' },
      idempotencyKey,
      runIntent: {
        actorType: 'user',
        actorId: userId,
        teamId: null,
        usageTeamId: null,
        triggerSource: 'onDemand',
        inputs: {},
      },
    })
    if (approval.kind !== 'approval') throw new Error('expected an approval request')
    // This row models a historical approval that predates typed run-intent storage.
    const deleted = await databasePool.query(
      `DELETE FROM workflow_approval_trigger_run_intents WHERE approval_request_id = $1`,
      [approval.approvalRequestId]
    )
    expect(deleted.rowCount).toBe(1)
    const decided = await recordDecision(approval.approvalRequestId, 'approve', { userId })
    expect(decided).toMatchObject({ ok: true })
    expect(decided.ok && decided.workflowRun).toBeFalsy()
    const triggered = await triggerWorkflow({
      gateway,
      caller: {
        kind: 'mcp-host-control',
        claims: {
          sub: callerKey,
          recipeNamespace: ns,
          recipeName: name,
          hostRefs: [callerKey],
          typ: 'service',
          scopes: ['workflow:trigger'],
          iss: 's33',
          aud: 'mcp-host',
          jti: randomUUID(),
          exp: Math.floor(Date.now() / 1000) + 600,
        },
      },
      recipeNamespace: ns,
      recipeName: name,
      body: { approvalRequestId: approval.approvalRequestId },
      idempotencyKey,
    })
    if (triggered.kind !== 'run' || !triggered.created) {
      throw new Error(`expected a created run, got ${JSON.stringify(triggered)}`)
    }
    return triggered.row.run_id
  }

  /** One matured schedule row, as the WRC schedule sync writes it, fired by the worker. */
  async function fireSchedule(name: string, recipeDuration: number | null) {
    await databasePool.query(
      `INSERT INTO workflow_schedules
         (recipe_namespace, recipe_name, cron_expression, timezone, next_fire_at,
          max_duration_seconds)
       VALUES ($1, $2, '*/5 * * * *', 'UTC', date_trunc('minute', now()) - interval '5 minutes', $3)`,
      [ns, name, recipeDuration]
    )
    const swept = await processMaturedSchedules()
    expect(swept).toMatchObject({ fired: 1, errors: 0, skippedLock: false })
    const run = await databasePool.query<{ run_id: string }>(
      `SELECT run_id FROM workflow_runs WHERE recipe_namespace = $1 AND recipe_name = $2`,
      [ns, name]
    )
    expect(run.rows).toHaveLength(1)
    return run.rows[0]!.run_id
  }

  it.each(cases)(
    'every run insert stores a duration: $name',
    async ({ producer, recipeDuration, expected, triggerSource }) => {
      const name = recipeName(producer, recipeDuration)
      const idempotencyKey = `s33-${randomUUID()}`
      let runId: string
      switch (producer) {
        case 'v1': {
          const result = await triggerWorkflow({
            gateway,
            caller: v1Caller(),
            recipeNamespace: ns,
            recipeName: name,
            body: {},
            idempotencyKey,
          })
          if (result.kind !== 'run') throw new Error(`expected a run, got ${result.kind}`)
          runId = result.row.run_id
          break
        }
        case 'v2': {
          const result = await triggerV2(name, idempotencyKey)
          if (result.kind !== 'run') throw new Error(`expected a run, got ${result.kind}`)
          expect(result.row.initiating_authority_binding_id).toBeTruthy()
          runId = result.row.run_id
          break
        }
        case 'decision':
          runId = await decide(name, recipeDuration, idempotencyKey)
          break
        case 'legacyConsume':
          runId = await consumeLegacy(name, idempotencyKey)
          break
        case 'cron':
          runId = await fireSchedule(name, recipeDuration)
          break
      }

      const stored = await databasePool.query<{
        recipe_name: string
        trigger_source: string
        max_duration_seconds: number | null
      }>(
        `SELECT recipe_name, trigger_source, max_duration_seconds
           FROM workflow_runs WHERE run_id = $1`,
        [runId]
      )
      expect(stored.rows).toEqual([
        { recipe_name: name, trigger_source: triggerSource, max_duration_seconds: expected },
      ])
      if (recipeDuration === null) {
        expect(stored.rows[0]!.max_duration_seconds).toBe(WORKFLOW_RUN_MAX_DURATION_CAP_SECONDS)
      }
    },
    60_000
  )
})
