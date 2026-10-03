import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { config } from '../src/config.js'
import { type DbClient, initDb, pool } from '../src/db.js'
import { K8sGateway } from '../src/k8s.js'
import type { ExternalAuthedRequest } from '../src/middleware/externalSessionAuth.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { authorizeActionV2 } from '../src/services/access/actionAuthorizer.js'
import { prepareActionOperationTarget } from '../src/services/access/actionMessageId.js'
import { OperationalAccessIndex } from '../src/services/access/operationalAccessIndex.js'
import {
  OperationalAccessIndexer,
  operationalSourceSpecs,
} from '../src/services/access/operationalAccessIndexer.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import {
  type ExternalSessionAuthorityContext,
  authenticateExternalUserSessionIdentity,
} from '../src/services/auth/externalSessionAuthentication.js'
import { createUserSession } from '../src/services/auth/userSessionService.js'
import {
  WorkflowAuthorityError,
  captureWorkflowTriggerAuthorityFence,
  requireCurrentWorkflowTriggerAuthority,
  requireWorkflowActionAuthority,
} from '../src/services/workflows/workflowAuthorityBindingService.js'
import { type WorkflowAuthorityBinding } from '../src/services/workflows/workflowAuthorityBindingService.js'
import { WORKFLOW_ACTION_DELEGATION_HEADER } from '../src/services/workflows/workflowAuthorityBindingService.js'
import { triggerWorkflow } from '../src/services/workflows/workflowTriggerService.js'
import {
  issueUserDelegationV2,
  verifyUserDelegationV2,
} from '../src/utils/auth/userDelegationV2Token.js'
import { TemporaryKubernetesApi } from './helpers/temporaryKubernetesApi.js'

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

function transaction(databasePool: Pool) {
  return async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
    const client = (await databasePool.connect()) as PoolClient
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

describeRealPostgres('workflow trigger selected-path attribution on real PostgreSQL', () => {
  const database = `control_api_workflow_selected_path_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const userId = randomUUID()
  const teamId = randomUUID()
  const teamOnlyRecipe = `selected-team-only-${randomBytes(4).toString('hex')}`
  const bothGrantRecipe = `selected-both-${randomBytes(4).toString('hex')}`
  const approvalRecipe = `selected-approval-${randomBytes(4).toString('hex')}`
  const contextName = `selected-context-${randomBytes(4).toString('hex')}`
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
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Selected Path User')`,
      [userId, `${userId}@example.test`]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Selected Path Team')`, [
      teamId,
    ])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'admin', 'active')`,
      [teamId, userId]
    )
    await databasePool.query(
      `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3), ($1, $2, $4), ($1, $2, $5)`,
      [teamId, config.sandboxNamespace, teamOnlyRecipe, bothGrantRecipe, approvalRecipe]
    )
    await databasePool.query(
      `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3), ($1, $2, $4)`,
      [userId, config.sandboxNamespace, bothGrantRecipe, approvalRecipe]
    )
    await databasePool.query(
      `INSERT INTO workflow_recipe_allowed_teams(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3)`,
      [teamId, config.sandboxNamespace, approvalRecipe]
    )
    await databasePool.query(`INSERT INTO user_contexts(user_id, context_id) VALUES ($1, $2)`, [
      userId,
      `${config.contextsNamespace}/${contextName}`,
    ])
    await databasePool.query(`INSERT INTO team_contexts(team_id, context_id) VALUES ($1, $2)`, [
      teamId,
      `${config.contextsNamespace}/${contextName}`,
    ])
    await databasePool.query(
      `INSERT INTO llm_allowed_models(provider, model, vendor, enabled)
       VALUES ('openai', 'selected-path-test', 'test', TRUE)`
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
      [teamOnlyRecipe, false],
      [bothGrantRecipe, false],
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
          model: { provider: 'openai', name: 'selected-path-test' },
          triggers: {
            onDemand: {
              allowedActors: ['user'],
              requiresApproval,
            },
          },
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

    const index = new OperationalAccessIndex(databasePool, transaction(databasePool))
    const indexer = new OperationalAccessIndexer(gateway, index, {
      environmentId: canonicalEnvironmentId(),
      behaviorFingerprintKey: config.sessionJwtPrivateKey,
    })
    for (const source of operationalSourceSpecs) await indexer.reconcileSource(source)
  })

  afterAll(async () => {
    corePoolQuerySpy?.mockRestore()
    corePoolConnectSpy?.mockRestore()
    expect(databasePool?.waitingCount ?? 0).toBe(0)
    expect(databasePool?.idleCount ?? 0).toBe(databasePool?.totalCount ?? 0)
    await kubernetesApi.close()
    await databasePool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      await adminPool.end()
    }
  })

  async function produceSelectedAuthority(recipeName: string, pathKind: 'direct' | 'team') {
    const issued = await createUserSession(
      {
        userId,
        email: `${userId}@example.test`,
        authenticationMethods: ['password'],
      },
      { db: databasePool as never }
    )
    const identity = await authenticateExternalUserSessionIdentity(issued.token)
    expect(identity.status).toBe('authenticated')
    if (identity.status !== 'authenticated' || identity.contract !== 'v2') {
      throw new Error('real v2 session producer did not authenticate')
    }
    expect(identity.claims.teamId).toBeNull()

    const resource = canonicalResourceIdentity({
      environmentId: canonicalEnvironmentId(),
      type: 'workflow_recipe',
      logicalId: `${config.sandboxNamespace}/${recipeName}`,
    })
    const target = Object.freeze({ recipeNamespace: config.sandboxNamespace, recipeName })
    const resolved = await authorizeActionV2(
      {
        session: identity.authorityContext as ExternalSessionAuthorityContext,
        requested: { version: 2 },
        operationId: 'workflow.trigger',
        resource,
        operationTarget: target,
        allocateChatMessageId: false,
        gateway,
      },
      { authorizationOptions: { transaction: transaction(databasePool) } }
    )

    let selected = resolved.status === 'allowed' ? resolved.context : null
    if (resolved.status === 'access_path_required') {
      const candidate = resolved.paths.find(path => path.kind === pathKind)
      if (!candidate) throw new Error(`live resolver did not produce ${pathKind} path`)
      const explicitlySelected = await authorizeActionV2(
        {
          session: identity.authorityContext as ExternalSessionAuthorityContext,
          requested: {
            version: 2,
            requestedAccessPathId: candidate.id,
            expectedAuthorizationRevision: candidate.authorizationRevision,
          },
          operationId: 'workflow.trigger',
          resource,
          operationTarget: target,
          allocateChatMessageId: false,
          gateway,
        },
        { authorizationOptions: { transaction: transaction(databasePool) } }
      )
      if (explicitlySelected.status !== 'allowed') {
        throw new Error(`live selected-path producer returned ${explicitlySelected.status}`)
      }
      selected = explicitlySelected.context
    }
    if (!selected || selected.pathKind !== pathKind) {
      throw new Error(`live selected-path producer returned ${resolved.status}`)
    }
    expect(selected.effectiveTeamId).toBe(pathKind === 'team' ? teamId : null)

    const preparedTarget = prepareActionOperationTarget({
      operationId: 'workflow.trigger',
      resource,
      operationTarget: target,
    })
    const token = issueUserDelegationV2({
      principal: {
        userId,
        sid: selected.principal.sid,
        sessionVersion: selected.principal.sessionVersion,
      },
      operationIds: ['workflow.trigger'],
      resource,
      preparedTargets: { 'workflow.trigger': preparedTarget },
      accessPathId: selected.accessPathId,
      authorizationRevision: selected.authorizationRevision,
      behaviorBindingHash: selected.behaviorBindingHash,
      pathKind: selected.pathKind,
      effectiveTeamId: selected.effectiveTeamId,
    })
    const claims = verifyUserDelegationV2(token)
    if (!claims) throw new Error('production delegation issuer did not verify its token')

    const caller = {
      kind: 'user-session' as const,
      claims: identity.claims,
      session: identity.authorityContext,
    }
    const req = {
      rawHeaders: [WORKFLOW_ACTION_DELEGATION_HEADER, token],
      accessExecutionBudget: AccessExecutionBudget.create('action'),
      correlationId: randomUUID(),
    } as unknown as ExternalAuthedRequest
    const authorityInput = {
      req,
      caller,
      operationId: 'workflow.trigger' as const,
      resourceType: 'workflow_recipe' as const,
      resourceLogicalId: `${config.sandboxNamespace}/${recipeName}`,
      target,
      gateway,
    }
    const authority = await requireWorkflowActionAuthority(authorityInput)
    if (!authority) throw new Error('v2 trigger producer did not require its signed authority')
    return { authority, authorityInput, caller, req }
  }

  async function runSelectedTrigger(recipeName: string, pathKind: 'direct' | 'team') {
    const produced = await produceSelectedAuthority(recipeName, pathKind)
    let phaseOneFence: Awaited<ReturnType<typeof captureWorkflowTriggerAuthorityFence>> | null =
      null
    const reauthorize = async (): Promise<WorkflowAuthorityBinding | null> => {
      if (!produced.authority) return null
      const before = await captureWorkflowTriggerAuthorityFence({ authority: produced.authority })
      const current = await requireWorkflowActionAuthority(produced.authorityInput)
      if (!current || current.bindingHash !== produced.authority.bindingHash) {
        throw new WorkflowAuthorityError(409, 'access_path_stale')
      }
      const after = await captureWorkflowTriggerAuthorityFence({ authority: current })
      if (before.fingerprint !== after.fingerprint) {
        throw new WorkflowAuthorityError(409, 'access_path_stale')
      }
      phaseOneFence = after
      return current
    }
    const result = await triggerWorkflow({
      gateway,
      caller: produced.caller,
      recipeNamespace: config.sandboxNamespace,
      recipeName,
      body: {},
      idempotencyKey: `selected-path-${randomUUID()}`,
      authority: produced.authority,
      reauthorize,
      validateCurrentInTransaction: (db, authority) => {
        if (!phaseOneFence) throw new WorkflowAuthorityError(409, 'access_path_stale')
        return requireCurrentWorkflowTriggerAuthority({
          db,
          authority,
          expectedFence: phaseOneFence,
        })
      },
    })
    return { result, authority: produced.authority }
  }

  it('persists the selected team attribution when both direct and team grants exist', async () => {
    const { result, authority } = await runSelectedTrigger(bothGrantRecipe, 'team')
    expect(result.kind).toBe('run')
    if (result.kind !== 'run') throw new Error('selected team path did not create a run')
    expect(result.row.team_id).toBe(teamId)
    expect(result.row.usage_team_id).toBe(teamId)
    expect(result.row.initiating_authority_binding_id).toBeTruthy()

    const persisted = await databasePool.query(
      `SELECT wr.team_id AS "teamId",
              wr.usage_team_id AS "usageTeamId",
              binding.path_kind AS "pathKind",
              binding.effective_team_id AS "effectiveTeamId"
         FROM workflow_runs wr
         JOIN workflow_authority_bindings binding
           ON binding.id = wr.initiating_authority_binding_id
        WHERE wr.run_id = $1`,
      [result.row.run_id]
    )
    expect(persisted.rows).toEqual([
      {
        teamId,
        usageTeamId: teamId,
        pathKind: 'team',
        effectiveTeamId: teamId,
      },
    ])
    expect(authority.binding.pathKind).toBe('team')
    expect(authority.binding.effectiveTeamId).toBe(teamId)
  })

  it('permits a team-only selected v2 trigger path with no legacy team claim', async () => {
    const { result } = await runSelectedTrigger(teamOnlyRecipe, 'team')
    expect(result.kind).toBe('run')
    if (result.kind !== 'run') throw new Error('team-only selected path did not create a run')
    expect(result.row.team_id).toBe(teamId)
    expect(result.row.usage_team_id).toBe(teamId)
  })

  it('retains direct attribution when the direct path is explicitly selected', async () => {
    const { result, authority } = await runSelectedTrigger(bothGrantRecipe, 'direct')
    expect(result.kind).toBe('run')
    if (result.kind !== 'run') throw new Error('selected direct path did not create a run')
    expect(result.row.team_id).toBeNull()
    expect(result.row.usage_team_id).toBeNull()
    expect(authority.binding.pathKind).toBe('direct')
    expect(authority.binding.effectiveTeamId).toBeNull()
  })

  it('rejects a binding for another recipe before live work or persistence', async () => {
    const produced = await produceSelectedAuthority(teamOnlyRecipe, 'team')
    const invalidAuthority: WorkflowAuthorityBinding = {
      ...produced.authority,
      binding: {
        ...produced.authority.binding,
        resource: {
          ...produced.authority.binding.resource,
          logicalId: `${config.sandboxNamespace}/another-recipe`,
        },
      },
    }
    const getResourceExact = vi.spyOn(gateway, 'getResourceExact')
    const before = await databasePool.query(
      `SELECT COUNT(*)::int AS count FROM workflow_runs
        WHERE recipe_namespace = $1 AND recipe_name = $2`,
      [config.sandboxNamespace, teamOnlyRecipe]
    )

    try {
      await expect(
        triggerWorkflow({
          gateway,
          caller: produced.caller,
          recipeNamespace: config.sandboxNamespace,
          recipeName: teamOnlyRecipe,
          body: {},
          idempotencyKey: `selected-path-invalid-${randomUUID()}`,
          authority: invalidAuthority,
        })
      ).rejects.toMatchObject({
        status: 403,
        message: 'Not authorized to trigger this recipe',
      })
      expect(getResourceExact).not.toHaveBeenCalled()
    } finally {
      getResourceExact.mockRestore()
    }

    const persisted = await databasePool.query(
      `SELECT COUNT(*)::int AS count FROM workflow_runs
        WHERE recipe_namespace = $1 AND recipe_name = $2`,
      [config.sandboxNamespace, teamOnlyRecipe]
    )
    expect(persisted.rows[0]?.count).toBe(before.rows[0]?.count)
  })

  it('keeps approval target and typed run intent aligned with the selected team path', async () => {
    const { result, authority } = await runSelectedTrigger(approvalRecipe, 'team')
    expect(result.kind).toBe('approval')
    if (result.kind !== 'approval') {
      throw new Error('selected team path did not create the expected approval')
    }
    const persisted = await databasePool.query(
      `SELECT request.target_user_id AS "targetUserId",
              request.target_team_id AS "targetTeamId",
              intent.team_id AS "intentTeamId",
              intent.usage_team_id AS "intentUsageTeamId",
              binding.path_kind AS "pathKind",
              binding.effective_team_id AS "effectiveTeamId"
         FROM workflow_approval_requests request
         JOIN workflow_approval_trigger_run_intents intent
           ON intent.approval_request_id = request.id
         JOIN workflow_authority_bindings binding
           ON binding.id = request.trigger_authority_binding_id
        WHERE request.id = $1`,
      [result.approvalRequestId]
    )
    expect(persisted.rows).toEqual([
      {
        targetUserId: null,
        targetTeamId: teamId,
        intentTeamId: teamId,
        intentUsageTeamId: teamId,
        pathKind: 'team',
        effectiveTeamId: teamId,
      },
    ])
    expect(authority.binding.pathKind).toBe('team')
  })
})
