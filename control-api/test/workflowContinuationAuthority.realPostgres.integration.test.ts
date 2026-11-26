import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { canonicalActionTarget } from '@clerum/action-context-contracts'
import { config } from '../src/config.js'
import { type DbClient, initDb, pool, withTransaction } from '../src/db.js'
import { K8sGateway } from '../src/k8s.js'
import type { ExternalAuthedRequest } from '../src/middleware/externalSessionAuth.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import {
  checkpointActionAuthority,
  parseActionAuthorityCheckpointRequest,
} from '../src/services/access/actionAuthorityCheckpoint.js'
import { authorizeActionV2 } from '../src/services/access/actionAuthorizer.js'
import { prepareActionOperationTarget } from '../src/services/access/actionMessageId.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import { resolveEffectiveUserAccessPolicy } from '../src/services/access/userAccessRuntimePolicy.js'
import {
  type ExternalSessionAuthorityContext,
  authenticateExternalUserSession,
} from '../src/services/auth/externalSessionAuthentication.js'
import {
  createUserSession,
  renewUserSession,
  revokeAllUserSessions,
  revokeUserSession,
} from '../src/services/auth/userSessionService.js'
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
import type { UserSessionV2Claims } from '../src/utils/auth/userSessionV2Token.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { TemporaryKubernetesApi } from './helpers/temporaryKubernetesApi.js'

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
vi.mock('../src/services/notificationEmitter.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/notificationEmitter.js')>()),
  emitNotification: vi.fn().mockResolvedValue(undefined),
}))

// Pass-through of the live authorizer that can run a hook between the first
// and the second resolution of one checkpoint (R7: a token renewal lands
// between the path listing and the explicit selection).
const authorizerHook = vi.hoisted(() => ({
  armed: false,
  calls: 0,
  afterFirst: null as null | (() => Promise<void>),
}))
vi.mock('../src/services/access/actionAuthorizer.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/access/actionAuthorizer.js')>()
  return {
    ...actual,
    authorizeActionV2: async (...args: Parameters<typeof actual.authorizeActionV2>) => {
      const result = await actual.authorizeActionV2(...args)
      if (authorizerHook.armed) {
        authorizerHook.calls += 1
        if (authorizerHook.calls === 1 && authorizerHook.afterFirst) {
          await authorizerHook.afterFirst()
        }
      }
      return result
    },
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

type Login = Readonly<{
  userId: string
  sid: string
  claims: Awaited<ReturnType<typeof authenticateExternalUserSession>> extends infer T
    ? T extends { status: 'authenticated'; claims: infer C }
      ? C
      : never
    : never
  session: ExternalSessionAuthorityContext
  tokenClaims: UserSessionV2Claims
}>

/**
 * Continuation authority of V2 workflow runs: a run the user started keeps
 * running while the user, the grant and membership of the stored path, the
 * path's behavior and the destination hold, whatever happens to the login
 * session and the delegation's expiry. Each test creates a real V2 run through
 * the trigger service and calls the checkpoint as workflow-recipes does.
 */
describeRealPostgres('workflow continuation authority on real PostgreSQL', () => {
  const database = `control_api_continuation_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const teamId = randomUUID()
  const otherTeamId = randomUUID()
  const controlAdminId = randomUUID()
  const suffix = randomBytes(4).toString('hex')
  const directRecipe = `continuation-direct-${suffix}`
  const bothRecipe = `continuation-both-${suffix}`
  const approvalRecipe = `continuation-approval-${suffix}`
  const contextName = `continuation-context-${suffix}`
  const contextId = `${config.contextsNamespace}/${contextName}`
  const kubernetesApi = new TemporaryKubernetesApi()
  const workflowRecipes = {
    service: 'workflow-recipes',
    trustPlane: 'internal_control_jwt',
  } as const
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

    // Two teams grant the three-path recipe, so removing one path still leaves
    // the resolver offering a choice (`access_path_required`) without the
    // stored path.
    await databasePool.query(
      `INSERT INTO teams(id, name) VALUES ($1, 'Continuation Team'), ($2, 'Other Continuation Team')`,
      [teamId, otherTeamId]
    )
    await databasePool.query(
      `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $3, $4), ($2, $3, $4)`,
      [teamId, otherTeamId, config.sandboxNamespace, bothRecipe]
    )
    await databasePool.query(
      `INSERT INTO team_contexts(team_id, context_id) VALUES ($1, $3), ($2, $3)`,
      [teamId, otherTeamId, contextId]
    )
    await databasePool.query(
      `INSERT INTO llm_allowed_models(provider, model, vendor, enabled)
       VALUES ('openai', 'continuation-test', 'test', TRUE)`
    )
    await databasePool.query(
      `INSERT INTO control_admin_users (id, username, password_hash, role, status)
       VALUES ($1, $2, 'fixture-password-hash', 'admin', 'active')`,
      [controlAdminId, `continuation-retirement-actor-${controlAdminId}`]
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
      [directRecipe, false],
      [bothRecipe, false],
      [approvalRecipe, true],
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
          model: { provider: 'openai', name: 'continuation-test' },
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

  afterEach(() => {
    authorizerHook.armed = false
    authorizerHook.calls = 0
    authorizerHook.afterFirst = null
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

  /**
   * A user of its own, so a case that changes the user, its membership, its
   * grants or its sessions changes no other case: an admin member of both
   * teams with direct grants on the direct, three-path and approval recipes.
   * The three-path recipe offers the direct path and one path per team.
   */
  async function seedUser(): Promise<string> {
    const userId = randomUUID()
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Continuation User')`,
      [userId, `${userId}@example.test`]
    )
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $3, 'admin', 'active'), ($2, $3, 'admin', 'active')`,
      [teamId, otherTeamId, userId]
    )
    await databasePool.query(
      `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3), ($1, $2, $4), ($1, $2, $5)`,
      [userId, config.sandboxNamespace, directRecipe, bothRecipe, approvalRecipe]
    )
    await databasePool.query(`INSERT INTO user_contexts(user_id, context_id) VALUES ($1, $2)`, [
      userId,
      contextId,
    ])
    return userId
  }

  /** One authenticated V2 login session, as the external session boundary produces it. */
  async function login(userId: string): Promise<Login> {
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
      userId,
      sid: issued.identity.sid,
      claims: identity.claims,
      session: identity.authorityContext as ExternalSessionAuthorityContext,
      tokenClaims: identity.tokenClaims as UserSessionV2Claims,
    }
  }

  /**
   * The live selected-path producer: resolve the action for the session (the
   * explicit selection when several paths are offered), sign a delegation for
   * the resolved path, and run the route's single authority checkpoint on it.
   */
  async function liveAuthority(input: {
    login: Login
    operationId: 'workflow.trigger' | 'workflow.approval.decide'
    resourceType: 'workflow_recipe' | 'workflow_approval'
    logicalId: string
    target: Readonly<Record<string, string>>
    pathKind: 'direct' | 'team'
    teamId?: string
  }): Promise<WorkflowAuthorityBinding> {
    const resource = canonicalResourceIdentity({
      environmentId: canonicalEnvironmentId(),
      type: input.resourceType,
      logicalId: input.logicalId,
    })
    const authorize = (requestedAccessPathId?: string) =>
      authorizeActionV2({
        session: input.login.session,
        requested: { version: 2, ...(requestedAccessPathId ? { requestedAccessPathId } : {}) },
        operationId: input.operationId,
        resource,
        operationTarget: input.target,
        allocateChatMessageId: false,
        gateway,
      })
    let resolved = await authorize()
    if (resolved.status === 'access_path_required') {
      const candidate = resolved.paths.find(
        path =>
          path.kind === input.pathKind &&
          (input.teamId === undefined || path.teamId === input.teamId)
      )
      if (!candidate) throw new Error(`live resolver offered no ${input.pathKind} path`)
      resolved = await authorize(candidate.id)
    }
    if (resolved.status !== 'allowed') {
      throw new Error(`live ${input.operationId} producer returned ${resolved.status}`)
    }
    const selected = resolved.context
    expect(selected.pathKind).toBe(input.pathKind)
    const token = issueUserDelegationV2({
      principal: {
        userId: input.login.userId,
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
      caller: { kind: 'user-session', claims: input.login.claims, session: input.login.session },
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
  async function trigger(input: {
    userId: string
    recipeName: string
    pathKind: 'direct' | 'team'
    teamId?: string
  }) {
    const session = await login(input.userId)
    const authority = await liveAuthority({
      login: session,
      operationId: 'workflow.trigger',
      resourceType: 'workflow_recipe',
      logicalId: `${config.sandboxNamespace}/${input.recipeName}`,
      target: Object.freeze({
        recipeNamespace: config.sandboxNamespace,
        recipeName: input.recipeName,
      }),
      pathKind: input.pathKind,
      ...(input.teamId ? { teamId: input.teamId } : {}),
    })
    const result = await triggerWorkflow({
      gateway,
      caller: { kind: 'user-session', claims: session.claims, session: session.session },
      recipeNamespace: config.sandboxNamespace,
      recipeName: input.recipeName,
      body: {},
      idempotencyKey: `continuation-${randomUUID()}`,
      authority,
      validateCurrentInTransaction: (db, current) =>
        requireCurrentWorkflowTriggerAuthority({ db, authority: current }),
    })
    return { result, login: session, authority }
  }

  async function runFor(input: {
    userId: string
    recipeName: string
    pathKind: 'direct' | 'team'
    teamId?: string
  }) {
    const triggered = await trigger(input)
    if (triggered.result.kind !== 'run') throw new Error('trigger did not create a run')
    return { runId: triggered.result.row.run_id, login: triggered.login }
  }

  /**
   * The run's binding as workflow-recipes reads it (`SELECT_RUN`,
   * dbRunProcessor.ts: the latest continuation binding, else the initiating
   * binding), as the request body `checkpointRequest` builds from it
   * (workflowActionCheckpointClient.ts), parsed as the internal route parses it.
   */
  async function checkpointRequest(runId: string) {
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
                'pathKind', binding.path_kind,
                'effectiveTeamId', binding.effective_team_id,
                'behaviorBindingHash', binding.behavior_binding_hash
              ) END AS authority_binding
         FROM workflow_runs run
         LEFT JOIN workflow_authority_bindings initiating_binding
           ON initiating_binding.id = run.initiating_authority_binding_id
         LEFT JOIN LATERAL (
           SELECT candidate.id
             FROM workflow_authority_bindings candidate
            WHERE candidate.binding_kind = 'run_management'
              AND candidate.entity_type = 'workflow_run'
              AND candidate.entity_id = run.run_id::text
              AND candidate.operation_id = 'workflow.run.manage'
              AND candidate.target = jsonb_build_object('runId', run.run_id::text, 'action', 'resume')
            ORDER BY candidate.created_at DESC, candidate.id DESC
            LIMIT 1
         ) continuation_binding ON TRUE
         LEFT JOIN workflow_authority_bindings binding
           ON binding.id = COALESCE(continuation_binding.id, initiating_binding.id)
        WHERE run.run_id = $1`,
      [runId]
    )
    const binding = loaded.rows[0]?.authority_binding
    if (!binding) throw new Error('run has no authority binding')
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
      workflowRecipes
    )
    return { request, binding }
  }

  /** The continuation checkpoint workflow-recipes makes at dequeue and at a step boundary. */
  async function checkpoint(runId: string) {
    const { request } = await checkpointRequest(runId)
    const budget = AccessExecutionBudget.create('action')
    try {
      return await revalidateWorkflowTriggerCheckpoint({
        request,
        caller: workflowRecipes,
        gateway,
        budget,
        db: databasePool,
      })
    } finally {
      budget.close()
    }
  }

  async function sessionRow(sid: string) {
    const result = await databasePool.query<{
      revoked: boolean
      expired: boolean
      currentJti: string
    }>(
      `SELECT revoked_at IS NOT NULL AS revoked,
              (idle_expires_at <= clock_timestamp()
                OR absolute_expires_at <= clock_timestamp()) AS expired,
              current_jti::text AS "currentJti"
         FROM external_user_sessions
        WHERE sid = $1`,
      [sid]
    )
    return result.rows[0]
  }

  /** The claim of a Pending run, with the columns `CLAIM_PENDING` (dbRunProcessor.ts) sets. */
  async function claimRun(runId: string) {
    const claimed = await databasePool.query(
      `UPDATE workflow_runs
          SET phase = 'Running',
              owner_instance_id = $2,
              child_recipe_name = $3,
              child_recipe_namespace = $4,
              started_at = now(),
              last_reconciled_at = now(),
              updated_at = now()
        WHERE run_id = $1 AND phase = 'Pending'`,
      [
        runId,
        `continuation-${randomUUID()}`,
        `continuation-child-${runId.slice(0, 8)}`,
        config.sandboxNamespace,
      ]
    )
    expect(claimed.rowCount).toBe(1)
  }

  async function retireUser(userId: string) {
    const operation = await databasePool.query<{ id: string }>(
      `INSERT INTO desktop_user_retirement_operations(
         actor_type, actor_control_admin_id, target_user_id,
         idempotency_key_hash, request_fingerprint, reason, request_id
       )
       VALUES ('control_admin', $1::uuid, $2::uuid, repeat('a', 64), repeat('b', 64),
               'continuation retirement fixture', $3)
       RETURNING id::text AS id`,
      [controlAdminId, userId, `continuation-retirement-${userId}`]
    )
    const operationId = operation.rows[0]!.id
    await databasePool.query(
      `UPDATE users
          SET lifecycle_state = 'retired',
              retired_at = NOW(),
              retirement_reason = 'continuation retirement fixture',
              retired_by_type = 'control_admin',
              retired_by_control_admin_id = $3::uuid,
              retirement_request_id = $4,
              retirement_operation_id = $2::uuid,
              lifecycle_version = lifecycle_version + 1,
              updated_at = NOW()
        WHERE id = $1::uuid`,
      [userId, operationId, controlAdminId, `continuation-retirement-${userId}`]
    )
    await databasePool.query(
      `UPDATE desktop_user_retirement_operations
          SET status = 'completed', outcome = 'retired', lifecycle_version = 2,
              lifecycle_operation_id = id, completed_at = NOW()
        WHERE id = $1::uuid`,
      [operationId]
    )
  }

  it('allows dequeue and a step checkpoint after the delegation expiry', async () => {
    const userId = await seedUser()
    const { runId } = await runFor({ userId, recipeName: directRecipe, pathKind: 'direct' })
    await databasePool.query(
      `UPDATE workflow_authority_bindings
          SET source_issued_at = clock_timestamp() - interval '20 minutes',
              source_expires_at = clock_timestamp() - interval '10 minutes'
        WHERE id = (SELECT initiating_authority_binding_id FROM workflow_runs WHERE run_id = $1)`,
      [runId]
    )
    // Witness: the stored delegation expiry is in the past.
    const expired = await databasePool.query<{ expired: boolean }>(
      `SELECT binding.source_expires_at < clock_timestamp() AS expired
         FROM workflow_runs run
         JOIN workflow_authority_bindings binding
           ON binding.id = run.initiating_authority_binding_id
        WHERE run.run_id = $1`,
      [runId]
    )
    expect(expired.rows).toEqual([{ expired: true }])
    const { binding } = await checkpointRequest(runId)

    // Dequeue: the run is Pending.
    await expect(checkpoint(runId)).resolves.toMatchObject({
      status: 'allowed',
      authorizationRevision: binding.authorizationRevision,
      behaviorBindingHash: binding.behaviorBindingHash,
    })
    // Step boundary: the run was claimed and is Running.
    await claimRun(runId)
    await expect(checkpoint(runId)).resolves.toMatchObject({
      status: 'allowed',
      authorizationRevision: binding.authorizationRevision,
      behaviorBindingHash: binding.behaviorBindingHash,
    })
  })

  it.each([
    {
      label: 'logout',
      recipeName: directRecipe,
      mutate: async (session: Login) => {
        await revokeUserSession(session.userId, session.sid, 'logout')
      },
      dead: { revoked: true },
    },
    {
      label: 'session expiry',
      recipeName: directRecipe,
      mutate: async (session: Login) => {
        await databasePool.query(
          `UPDATE external_user_sessions
              SET idle_expires_at = clock_timestamp() - interval '1 minute',
                  absolute_expires_at = clock_timestamp() - interval '1 minute'
            WHERE sid = $1`,
          [session.sid]
        )
      },
      dead: { expired: true },
    },
    {
      label: 'revocation of every session',
      recipeName: directRecipe,
      mutate: async (session: Login) => {
        expect(await revokeAllUserSessions(session.userId, 'password_change')).toBeGreaterThan(0)
      },
      dead: { revoked: true },
    },
  ])(
    'allows a checkpoint after logout, session expiry, revocation and a renewed token ($label)',
    async ({ recipeName, mutate, dead }) => {
      const userId = await seedUser()
      const { runId, login: session } = await runFor({ userId, recipeName, pathKind: 'direct' })
      await mutate(session)
      // Witness: the login session the delegation was issued from is dead.
      expect(await sessionRow(session.sid)).toMatchObject(dead)

      await expect(checkpoint(runId)).resolves.toMatchObject({ status: 'allowed' })
    }
  )

  it('allows a checkpoint after logout, session expiry, revocation and a renewed token (renewed token between the two path resolutions)', async () => {
    const userId = await seedUser()
    const { runId, login: session } = await runFor({
      userId,
      recipeName: bothRecipe,
      pathKind: 'direct',
    })
    const before = await sessionRow(session.sid)
    // Witness: the recipe offers several paths, so the checkpoint lists the
    // paths and then selects the stored one explicitly.
    const listed = await listBothRecipePaths(session)
    expect(listed.status).toBe('access_path_required')

    authorizerHook.afterFirst = async () => {
      const renewed = await renewUserSession(session.tokenClaims)
      if (!('token' in renewed)) throw new Error(`session renewal returned ${renewed.status}`)
    }
    authorizerHook.armed = true
    const answer = await checkpoint(runId)
    authorizerHook.armed = false

    // Witness: the renewal landed between the first and the second resolution.
    expect(authorizerHook.calls).toBe(2)
    const after = await sessionRow(session.sid)
    expect(after?.currentJti).not.toBe(before?.currentJti)
    expect(answer).toMatchObject({ status: 'allowed' })
  })

  /** The live listing of the three-path recipe for a session that is still live. */
  async function listBothRecipePaths(session: Login) {
    return authorizeActionV2({
      session: session.session,
      requested: { version: 2 },
      operationId: 'workflow.trigger',
      resource: canonicalResourceIdentity({
        environmentId: canonicalEnvironmentId(),
        type: 'workflow_recipe',
        logicalId: `${config.sandboxNamespace}/${bothRecipe}`,
      }),
      operationTarget: { recipeNamespace: config.sandboxNamespace, recipeName: bothRecipe },
      allocateChatMessageId: false,
      gateway,
    })
  }

  it.each([
    {
      label: 'deactivation',
      recipeName: directRecipe,
      pathKind: 'direct' as const,
      storedTeam: undefined,
      change: async (userId: string) => retireUser(userId),
      expected: { status: 'denied' },
    },
    {
      label: 'membership removal',
      recipeName: bothRecipe,
      pathKind: 'team' as const,
      storedTeam: 'team' as const,
      change: async (userId: string) => {
        await databasePool.query(
          `UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`,
          [teamId, userId]
        )
      },
      expected: { status: 'denied' },
    },
    {
      label: 'grant removal',
      recipeName: bothRecipe,
      pathKind: 'direct' as const,
      storedTeam: undefined,
      change: async (userId: string) => {
        await databasePool.query(
          `DELETE FROM user_workflow_triggers
            WHERE user_id = $1 AND recipe_namespace = $2 AND recipe_name = $3`,
          [userId, config.sandboxNamespace, bothRecipe]
        )
      },
      expected: { status: 'denied' },
    },
    {
      label: 'behaviour change',
      recipeName: directRecipe,
      pathKind: 'direct' as const,
      storedTeam: undefined,
      // A newly allowed model changes the path's provider model policy.
      change: async () => {
        await databasePool.query(
          `INSERT INTO llm_allowed_models(provider, model, vendor, enabled)
           VALUES ('openai', 'continuation-behaviour-change', 'test', TRUE)`
        )
      },
      expected: { status: 'access_path_stale' },
    },
  ])(
    'stops at the next checkpoint after deactivation, membership removal, grant removal and a behaviour change ($label)',
    async ({ recipeName, pathKind, storedTeam, change, expected }) => {
      const userId = await seedUser()
      const { runId, login: session } = await runFor({
        userId,
        recipeName,
        pathKind,
        ...(storedTeam ? { teamId } : {}),
      })
      // Witness: the untouched run is allowed.
      await expect(checkpoint(runId)).resolves.toMatchObject({ status: 'allowed' })
      try {
        await change(userId)
        if (recipeName === bothRecipe) {
          // Witness: the stored path is gone and the two other paths remain,
          // so the checkpoint reaches the explicit selection with no match.
          const listed = await listBothRecipePaths(session)
          if (listed.status !== 'access_path_required') {
            throw new Error(`three-path recipe listed ${listed.status}`)
          }
          const remaining = listed.paths.map(path => `${path.kind}:${path.teamId ?? ''}`).sort()
          expect(remaining).toEqual(
            (pathKind === 'direct'
              ? [`team:${teamId}`, `team:${otherTeamId}`]
              : ['direct:', `team:${otherTeamId}`]
            ).sort()
          )
        }
        await expect(checkpoint(runId)).resolves.toMatchObject(expected)
      } finally {
        await databasePool.query(
          `DELETE FROM llm_allowed_models WHERE model = 'continuation-behaviour-change'`
        )
      }
    }
  )

  it('the generic checkpoint and the approval decision still need a live session', async () => {
    const userId = await seedUser()

    // Generic checkpoint on the live trigger authority of a run.
    const { runId, login: runSession } = await runFor({
      userId,
      recipeName: directRecipe,
      pathKind: 'direct',
    })
    const { request } = await checkpointRequest(runId)
    const generic = async () => {
      const budget = AccessExecutionBudget.create('action')
      try {
        return await checkpointActionAuthority({ request, gateway, budget })
      } finally {
        budget.close()
      }
    }
    await expect(generic()).resolves.toMatchObject({ status: 'allowed' })

    // Approval decision on a live decision authority.
    const requested = await trigger({ userId, recipeName: approvalRecipe, pathKind: 'direct' })
    if (requested.result.kind !== 'approval')
      throw new Error('approval-gated trigger made no approval')
    const approvalRequestId = requested.result.approvalRequestId
    const decider = await login(userId)
    const decision = await liveAuthority({
      login: decider,
      operationId: 'workflow.approval.decide',
      resourceType: 'workflow_approval',
      logicalId: approvalRequestId,
      target: Object.freeze({ approvalId: approvalRequestId, decision: 'approve' }),
      pathKind: 'direct',
    })
    const decide = async () => {
      const budget = AccessExecutionBudget.create('action')
      try {
        return await withTransaction((db: DbClient) =>
          requireCurrentWorkflowApprovalAuthority({ db, authority: decision, budget })
        )
      } finally {
        budget.close()
      }
    }
    await expect(decide()).resolves.toBeDefined()

    // Every session of the user is revoked.
    expect(await revokeAllUserSessions(userId, 'password_change')).toBeGreaterThan(0)
    expect(await sessionRow(runSession.sid)).toMatchObject({ revoked: true })
    expect(await sessionRow(decider.sid)).toMatchObject({ revoked: true })

    await expect(generic()).resolves.toMatchObject({ status: 'denied' })
    await expect(decide()).rejects.toMatchObject({ status: 403 })
    // The continuation checkpoint of the same run is anchored on the user and
    // is not affected by the revocation.
    await expect(checkpoint(runId)).resolves.toMatchObject({ status: 'allowed' })
  })
})
