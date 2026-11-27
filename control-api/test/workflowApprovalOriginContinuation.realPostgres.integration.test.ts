import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { canonicalActionTarget } from '@clerum/action-context-contracts'
import { config } from '../src/config.js'
import { type DbClient, initDb, pool, withTransaction } from '../src/db.js'
import { K8sGateway } from '../src/k8s.js'
import type { ExternalAuthedRequest } from '../src/middleware/externalSessionAuth.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { parseActionAuthorityCheckpointRequest } from '../src/services/access/actionAuthorityCheckpoint.js'
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
import {
  WORKFLOW_ACTION_DELEGATION_HEADER,
  type WorkflowAuthorityBinding,
  requireCurrentWorkflowApprovalAuthority,
  requireCurrentWorkflowTriggerAuthority,
  requireWorkflowActionAuthority,
} from '../src/services/workflows/workflowAuthorityBindingService.js'
import { revalidateWorkflowTriggerCheckpoint } from '../src/services/workflows/workflowTriggerCheckpointRevalidation.js'
import { triggerWorkflow } from '../src/services/workflows/workflowTriggerService.js'
import {
  issueUserDelegationV2,
  verifyUserDelegationV2,
} from '../src/utils/auth/userDelegationV2Token.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { TemporaryKubernetesApi } from './helpers/temporaryKubernetesApi.js'

vi.mock('../src/services/notificationEmitter.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/notificationEmitter.js')>()),
  emitNotification: vi.fn().mockResolvedValue(undefined),
}))

// The workflow-recipes checkpoint is served only while the action context is
// on; only the actionContextV2 flag is overridden, everything else is the real
// resolved policy.
vi.mock('../src/services/access/userAccessRuntimePolicy.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/services/access/userAccessRuntimePolicy.js')>()
  return {
    ...actual,
    resolveEffectiveUserAccessPolicy: async (
      ...args: Parameters<typeof actual.resolveEffectiveUserAccessPolicy>
    ) => ({ ...(await actual.resolveEffectiveUserAccessPolicy(...args)), actionContextV2: true }),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * A run created by approving an approval-gated V2 trigger carries,
 * as its initiating binding, the trigger binding persisted for the approval
 * request (`entity_type 'workflow_approval'`). workflow-recipes checkpoints
 * that binding at dequeue; this suite reproduces whether the continuation
 * checkpoint finds it.
 */
describeRealPostgres('approval-origin workflow run continuation on real PostgreSQL', () => {
  const database = `control_api_approval_origin_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const userId = randomUUID()
  const approvalRecipe = `approval-origin-${randomBytes(4).toString('hex')}`
  const plainRecipe = `approval-origin-plain-${randomBytes(4).toString('hex')}`
  const contextName = `approval-origin-context-${randomBytes(4).toString('hex')}`
  const kubernetesApi = new TemporaryKubernetesApi()
  let adminPool: Pool
  let databasePool: Pool
  let gateway: K8sGateway
  let corePoolConnectSpy: ReturnType<typeof vi.spyOn>
  let corePoolQuerySpy: ReturnType<typeof vi.spyOn>

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
    corePoolConnectSpy = vi
      .spyOn(pool, 'connect')
      .mockImplementation((() => databasePool.connect()) as typeof pool.connect)
    corePoolQuerySpy = vi
      .spyOn(pool, 'query')
      .mockImplementation(((...args: Parameters<typeof pool.query>) =>
        (databasePool.query as typeof pool.query)(...args)) as typeof pool.query)

    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Approval Origin User')`,
      [userId, `${userId}@example.test`]
    )
    await databasePool.query(
      `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3), ($1, $2, $4)`,
      [userId, config.sandboxNamespace, approvalRecipe, plainRecipe]
    )
    await databasePool.query(`INSERT INTO user_contexts(user_id, context_id) VALUES ($1, $2)`, [
      userId,
      `${config.contextsNamespace}/${contextName}`,
    ])
    await databasePool.query(
      `INSERT INTO llm_allowed_models(provider, model, vendor, enabled)
       VALUES ('openai', 'approval-origin-test', 'test', TRUE)`
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
      [approvalRecipe, true],
      [plainRecipe, false],
    ] as const) {
      kubernetesApi.put('workflowrecipes', config.sandboxNamespace, {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: {
          name,
          namespace: config.sandboxNamespace,
          uid: randomUUID(),
          resourceVersion: '1',
          generation: 1,
        },
        spec: {
          enabled: true,
          contextRef: contextName,
          model: { provider: 'openai', name: 'approval-origin-test' },
          triggers: { onDemand: { allowedActors: ['user'], requiresApproval } },
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
  })

  afterAll(async () => {
    let waitingCount = 0
    let idleCount = 0
    let totalCount = 0
    try {
      corePoolQuerySpy?.mockRestore()
      corePoolConnectSpy?.mockRestore()
      waitingCount = databasePool?.waitingCount ?? 0
      idleCount = databasePool?.idleCount ?? 0
      totalCount = databasePool?.totalCount ?? 0
      try {
        await kubernetesApi.close()
      } finally {
        await endPoolAndWaitForClients(databasePool)
      }
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
        await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      }
    } finally {
      await adminPool?.end()
    }
    expect(waitingCount).toBe(0)
    expect(idleCount).toBe(totalCount)
  })

  /** One authenticated V2 session of the user, as the external session boundary produces it. */
  async function authenticatedSession() {
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
    return {
      claims: identity.claims,
      session: identity.authorityContext as ExternalSessionAuthorityContext,
    }
  }

  /**
   * The live selected-path producer: resolve the action for the session, sign
   * a delegation for the resolved path, and run the route's single authority
   * checkpoint on it.
   */
  async function liveAuthority(input: {
    session: ExternalSessionAuthorityContext
    claims: Awaited<ReturnType<typeof authenticatedSession>>['claims']
    operationId: 'workflow.trigger' | 'workflow.approval.decide'
    resourceType: 'workflow_recipe' | 'workflow_approval'
    logicalId: string
    target: Readonly<Record<string, string>>
  }): Promise<WorkflowAuthorityBinding> {
    const resource = canonicalResourceIdentity({
      environmentId: canonicalEnvironmentId(),
      type: input.resourceType,
      logicalId: input.logicalId,
    })
    const resolved = await authorizeActionV2({
      session: input.session,
      requested: { version: 2 },
      operationId: input.operationId,
      resource,
      operationTarget: input.target,
      allocateChatMessageId: false,
      gateway,
    })
    if (resolved.status !== 'allowed') {
      throw new Error(`live ${input.operationId} producer returned ${resolved.status}`)
    }
    const selected = resolved.context
    expect(selected.pathKind).toBe('direct')
    const token = issueUserDelegationV2({
      principal: {
        userId,
        sid: selected.principal.sid,
        sessionVersion: selected.principal.sessionVersion,
      },
      operationIds: [input.operationId],
      resource,
      preparedTargets: {
        [input.operationId]: prepareActionOperationTarget({
          operationId: input.operationId,
          resource,
          operationTarget: input.target,
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
      caller: { kind: 'user-session', claims: input.claims, session: input.session },
      operationId: input.operationId,
      resourceType: input.resourceType,
      resourceLogicalId: input.logicalId,
      target: input.target as never,
      gateway,
    })
    if (!authority) throw new Error('v2 producer did not require its signed authority')
    return authority
  }

  /** The trigger route: one authority checkpoint, then the insert transaction's row check. */
  async function trigger(recipeName: string) {
    const session = await authenticatedSession()
    const target = Object.freeze({ recipeNamespace: config.sandboxNamespace, recipeName })
    const authority = await liveAuthority({
      ...session,
      operationId: 'workflow.trigger',
      resourceType: 'workflow_recipe',
      logicalId: `${config.sandboxNamespace}/${recipeName}`,
      target,
    })
    return triggerWorkflow({
      gateway,
      caller: { kind: 'user-session', claims: session.claims, session: session.session },
      recipeNamespace: config.sandboxNamespace,
      recipeName,
      body: {},
      idempotencyKey: `approval-origin-${randomUUID()}`,
      authority,
      validateCurrentInTransaction: (db, current) =>
        requireCurrentWorkflowTriggerAuthority({ db, authority: current }),
    })
  }

  /** The approval decision route: live decision authority, re-authorized before and under the lock. */
  async function approve(approvalRequestId: string) {
    const session = await authenticatedSession()
    const authority = await liveAuthority({
      ...session,
      operationId: 'workflow.approval.decide',
      resourceType: 'workflow_approval',
      logicalId: approvalRequestId,
      target: Object.freeze({ approvalId: approvalRequestId, decision: 'approve' }),
    })
    const budget = AccessExecutionBudget.create('action')
    try {
      return await recordDecision(
        approvalRequestId,
        'approve',
        { userId },
        undefined,
        undefined,
        undefined,
        authority,
        {
          authorizeBeforeLock: () =>
            withTransaction(db =>
              requireCurrentWorkflowApprovalAuthority({ db, authority, budget })
            ),
          validateCurrentInTransaction: (db: DbClient) =>
            requireCurrentWorkflowApprovalAuthority({ db, authority, budget }),
        }
      )
    } finally {
      budget.close()
    }
  }

  /**
   * The dequeue checkpoint as workflow-recipes makes it: the run's binding read
   * as `SELECT_RUN` builds it (dbRunProcessor.ts), the request body as
   * `checkpointRequest` builds it (workflowActionCheckpointClient.ts), parsed
   * as the internal route parses it, then revalidated for the
   * workflow-recipes caller.
   */
  async function dequeueCheckpoint(runId: string) {
    const loaded = await databasePool.query<{ authority_binding: Record<string, any> | null }>(
      `SELECT CASE WHEN binding.id IS NULL THEN NULL ELSE jsonb_build_object(
                'userId', binding.user_id,
                'sid', binding.session_id,
                'sessionVersion', binding.session_version,
                'delegationJti', binding.delegation_jti,
                'operationId', binding.operation_id,
                'resource', binding.resource,
                'target', binding.target,
                'targetHash', binding.target_hash,
                'accessPathId', binding.access_path_id,
                'authorizationRevision', binding.authorization_revision,
                'behaviorBindingHash', binding.behavior_binding_hash
              ) END AS authority_binding
         FROM workflow_runs run
         LEFT JOIN workflow_authority_bindings binding
           ON binding.id = run.initiating_authority_binding_id
        WHERE run.run_id = $1`,
      [runId]
    )
    const binding = loaded.rows[0]?.authority_binding
    if (!binding) throw new Error('run has no initiating authority binding')
    const caller = { service: 'workflow-recipes', trustPlane: 'internal_control_jwt' } as const
    const request = parseActionAuthorityCheckpointRequest(
      {
        version: 2,
        principal: {
          sub: binding.userId,
          sid: binding.sid,
          sessionVersion: binding.sessionVersion,
        },
        delegationJti: binding.delegationJti,
        resource: binding.resource,
        operationId: binding.operationId,
        target: canonicalActionTarget(binding.target),
        targetHash: binding.targetHash,
        accessPathId: binding.accessPathId,
        authorizationRevision: binding.authorizationRevision,
        behaviorBindingHash: binding.behaviorBindingHash,
        domain: {
          service: 'workflow-recipes',
          resource: binding.resource,
          targetHash: binding.targetHash,
        },
      },
      caller
    )
    const budget = AccessExecutionBudget.create('action')
    try {
      return await revalidateWorkflowTriggerCheckpoint({
        request,
        caller,
        gateway,
        budget,
        db: databasePool,
      })
    } finally {
      budget.close()
    }
  }

  async function initiatingBinding(runId: string) {
    const result = await databasePool.query<{
      bindingId: string | null
      entityType: string | null
      bindingKind: string | null
      expired: boolean | null
    }>(
      `SELECT run.initiating_authority_binding_id::text AS "bindingId",
              binding.entity_type AS "entityType",
              binding.binding_kind AS "bindingKind",
              binding.source_expires_at <= clock_timestamp() AS expired
         FROM workflow_runs run
         LEFT JOIN workflow_authority_bindings binding
           ON binding.id = run.initiating_authority_binding_id
        WHERE run.run_id = $1`,
      [runId]
    )
    return result.rows[0]
  }

  it.each([
    { label: 'decided within the delegation lifetime', expireBinding: false },
    { label: 'with the binding expiry in the past', expireBinding: true },
  ])(
    'dequeue checkpoint of an approval-origin run finds its initiating binding ($label)',
    async ({ expireBinding }) => {
      // Control: a run triggered without approval through the same producers
      // answers `allowed` at dequeue, so the live path, grant and destination
      // this suite builds are accepted by the checkpoint.
      const plain = await trigger(plainRecipe)
      expect(plain.kind).toBe('run')
      if (plain.kind !== 'run') throw new Error('plain trigger did not create a run')
      await expect(dequeueCheckpoint(plain.row.run_id)).resolves.toMatchObject({
        status: 'allowed',
      })

      const requested = await trigger(approvalRecipe)
      expect(requested.kind).toBe('approval')
      if (requested.kind !== 'approval') throw new Error('approval-gated trigger made no approval')
      await expect(approve(requested.approvalRequestId)).resolves.toMatchObject({ ok: true })
      const run = await databasePool.query<{ run_id: string; phase: string }>(
        `SELECT run_id::text AS run_id, phase FROM workflow_runs WHERE approval_request_id = $1`,
        [requested.approvalRequestId]
      )
      expect(run.rows).toEqual([{ run_id: expect.any(String), phase: 'Pending' }])
      const runId = run.rows[0]!.run_id

      if (expireBinding) {
        await databasePool.query(
          `UPDATE workflow_authority_bindings
              SET source_issued_at = clock_timestamp() - interval '20 minutes',
                  source_expires_at = clock_timestamp() - interval '10 minutes'
            WHERE id = (SELECT initiating_authority_binding_id
                          FROM workflow_runs WHERE run_id = $1)`,
          [runId]
        )
      }
      // Witness: the run's initiating binding is the approval request's
      // trigger binding, and its expiry is as this case states.
      expect(await initiatingBinding(runId)).toEqual({
        bindingId: expect.any(String),
        entityType: 'workflow_approval',
        bindingKind: 'trigger',
        expired: expireBinding,
      })

      const checkpoint = await dequeueCheckpoint(runId)
      expect(checkpoint).toMatchObject({ status: 'allowed' })
    }
  )
})
