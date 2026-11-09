import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { Pool } from 'pg'
import type { ActionAuthorityCheckpointRequestV2 } from '@clerum/action-context-contracts'
import { StepCoordinator, WorkflowAuthorizationPausedError } from '@clerum/workflow-runtime-core'
import { createDbRunProcessor } from '../../workflow-recipes/src/reconciler/dbRunProcessor.js'
import { createWorkflowRunAuthorityCheckpointer } from '../../workflow-recipes/src/reconciler/workflowActionCheckpointClient.js'
import { createWorkflowEndpointHandlers } from '../../workflow-recipes/src/workflow/restEndpoints.js'
import { runWorkflowRuntime } from '../../workflow-recipes/src/workflow/sdkRuntime.js'
import { config } from '../src/config.js'
import { initDb, pool } from '../src/db.js'
import { K8sGateway } from '../src/k8s.js'
import type { ExternalAuthedRequest } from '../src/middleware/externalSessionAuth.js'
import { createInternalActionAuthorityCheckpointRouter } from '../src/routes/internal/actionAuthorityCheckpoint.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { authorizeActionV2 } from '../src/services/access/actionAuthorizer.js'
import { prepareActionOperationTarget } from '../src/services/access/actionMessageId.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import {
  loadLiveOperationalResourceGraph,
  selectOperationalPathGraph,
} from '../src/services/access/operationalAccessReader.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import { resolveEffectiveUserAccessPolicy } from '../src/services/access/userAccessRuntimePolicy.js'
import {
  type ExternalSessionAuthorityContext,
  authenticateExternalUserSession,
} from '../src/services/auth/externalSessionAuthentication.js'
import { createUserSession, revokeUserSession } from '../src/services/auth/userSessionService.js'
import {
  requireCurrentWorkflowTriggerAuthority,
  requireWorkflowActionAuthority,
} from '../src/services/workflows/workflowAuthorityBindingService.js'
import { type WorkflowAuthorityBinding } from '../src/services/workflows/workflowAuthorityBindingService.js'
import { WORKFLOW_ACTION_DELEGATION_HEADER } from '../src/services/workflows/workflowAuthorityBindingService.js'
import { resumeWorkflowRun } from '../src/services/workflows/workflowRunResumeService.js'
import { triggerWorkflow } from '../src/services/workflows/workflowTriggerService.js'
import {
  issueUserDelegationV2,
  verifyUserDelegationV2,
} from '../src/utils/auth/userDelegationV2Token.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { TemporaryKubernetesApi } from './helpers/temporaryKubernetesApi.js'

// M-39: the internal checkpoint route answers 409 while the action context is
// off. This V2 run lifecycle mounts that route, so it runs with the action
// context on; only the actionContextV2 flag is overridden, everything else is
// the real resolved policy.
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
  let checkpointServer: Server | null = null

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

  afterEach(async () => {
    if (checkpointServer) {
      const current = checkpointServer
      checkpointServer = null
      await new Promise<void>((resolve, reject) => {
        current.close(error => (error ? reject(error) : resolve()))
      })
    }
    vi.unstubAllEnvs()
    if (!databasePool) return
    await databasePool.query(
      `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_id, recipe_namespace, recipe_name) DO NOTHING`,
      [teamId, config.sandboxNamespace, teamOnlyRecipe]
    )
  })

  /** The delegation a client holds after `POST /external/rpc/delegations`. */
  async function issueSelectedDelegation(
    recipeName: string,
    pathKind: 'direct' | 'team',
    signed: { authorizationRevision?: string } = {}
  ) {
    const issued = await createUserSession(
      {
        userId,
        email: `${userId}@example.test`,
        authenticationMethods: ['password'],
      },
      { db: databasePool as never }
    )
    // The sole external-user authentication boundary, with the resolved
    // policy accepting V2 sessions: session acceptance is not this suite's
    // subject, the selected path is.
    const identity = await authenticateExternalUserSession(issued.token, {
      purpose: 'protected',
      policy: { ...(await resolveEffectiveUserAccessPolicy()), acceptV2: true },
    })
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
    const resolved = await authorizeActionV2({
      session: identity.authorityContext as ExternalSessionAuthorityContext,
      requested: { version: 2 },
      operationId: 'workflow.trigger',
      resource,
      operationTarget: target,
      allocateChatMessageId: false,
      gateway,
    })

    let selected = resolved.status === 'allowed' ? resolved.context : null
    if (resolved.status === 'access_path_required') {
      const candidate = resolved.paths.find(path => path.kind === pathKind)
      if (!candidate) throw new Error(`live resolver did not produce ${pathKind} path`)
      const explicitlySelected = await authorizeActionV2({
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
      })
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
      authorizationRevision: signed.authorizationRevision ?? selected.authorizationRevision,
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
    return { authorityInput, caller, req }
  }

  /** The trigger route's single authority checkpoint on a freshly issued delegation. */
  async function produceSelectedAuthority(recipeName: string, pathKind: 'direct' | 'team') {
    const issued = await issueSelectedDelegation(recipeName, pathKind)
    const authority = await requireWorkflowActionAuthority(issued.authorityInput)
    if (!authority) throw new Error('v2 trigger producer did not require its signed authority')
    return { authority, ...issued }
  }

  /**
   * As the trigger route: one authority checkpoint (produceSelectedAuthority),
   * then the insert transaction re-checks only the bound rows (WF-10/15).
   * `beforeRowCheck` runs inside that transaction, after the checkpoint and
   * before the row check; `rowCheckReads` records which bound rows it read.
   */
  async function runSelectedTrigger(
    recipeName: string,
    pathKind: 'direct' | 'team',
    hooks: {
      idempotencyKey?: string
      beforeRowCheck?: (authority: WorkflowAuthorityBinding) => Promise<void>
      rowCheckReads?: string[]
    } = {}
  ) {
    const produced = await produceSelectedAuthority(recipeName, pathKind)
    const result = await triggerWorkflow({
      gateway,
      caller: produced.caller,
      recipeNamespace: config.sandboxNamespace,
      recipeName,
      body: {},
      idempotencyKey: hooks.idempotencyKey ?? `selected-path-${randomUUID()}`,
      authority: produced.authority,
      validateCurrentInTransaction: async (db, authority) => {
        await hooks.beforeRowCheck?.(authority)
        const reads = hooks.rowCheckReads
        return requireCurrentWorkflowTriggerAuthority({
          db: reads
            ? {
                query: (async (text: string, values?: unknown[]) => {
                  if (/JOIN external_user_sessions s/.test(text)) reads.push('session')
                  if (/FROM team_members/.test(text)) reads.push('membership')
                  if (/FROM (user|team)_workflow_triggers/.test(text)) reads.push('grant')
                  return db.query(text, values)
                }) as typeof db.query,
              }
            : db,
          authority,
        })
      },
    })
    return { result, ...produced }
  }

  async function produceRunResumeAuthority(input: {
    caller: Awaited<ReturnType<typeof produceSelectedAuthority>>['caller']
    runId: string
    pathKind: 'direct' | 'team'
  }): Promise<WorkflowAuthorityBinding> {
    const resource = canonicalResourceIdentity({
      environmentId: canonicalEnvironmentId(),
      type: 'workflow_run',
      logicalId: input.runId,
    })
    const target = Object.freeze({ runId: input.runId, action: 'resume' as const })
    const resolved = await authorizeActionV2({
      session: input.caller.session as ExternalSessionAuthorityContext,
      requested: { version: 2 },
      operationId: 'workflow.run.manage',
      resource,
      operationTarget: target,
      allocateChatMessageId: false,
      gateway,
    })
    let selected = resolved.status === 'allowed' ? resolved.context : null
    if (resolved.status === 'access_path_required') {
      const candidate = resolved.paths.find(path => path.kind === input.pathKind)
      if (!candidate) throw new Error(`run action producer did not produce ${input.pathKind} path`)
      const explicit = await authorizeActionV2({
        session: input.caller.session as ExternalSessionAuthorityContext,
        requested: {
          version: 2,
          requestedAccessPathId: candidate.id,
          expectedAuthorizationRevision: candidate.authorizationRevision,
        },
        operationId: 'workflow.run.manage',
        resource,
        operationTarget: target,
        allocateChatMessageId: false,
        gateway,
      })
      if (explicit.status !== 'allowed') {
        throw new Error(`selected run action authority returned ${explicit.status}`)
      }
      selected = explicit.context
    }
    if (!selected || selected.pathKind !== input.pathKind) {
      throw new Error(`run action producer returned ${resolved.status}`)
    }

    const prepared = prepareActionOperationTarget({
      operationId: 'workflow.run.manage',
      resource,
      operationTarget: target,
    })
    const token = issueUserDelegationV2({
      principal: {
        userId,
        sid: selected.principal.sid,
        sessionVersion: selected.principal.sessionVersion,
      },
      operationIds: ['workflow.run.manage'],
      resource,
      preparedTargets: { 'workflow.run.manage': prepared },
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
      caller: input.caller,
      operationId: 'workflow.run.manage',
      resourceType: 'workflow_run',
      resourceLogicalId: input.runId,
      target,
      gateway,
    })
    if (!authority) throw new Error('run action producer did not require its signed authority')
    return authority
  }

  it('blocks the second workflow effect after revocation between real V2 run effects', async () => {
    vi.stubEnv('INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET', config.internalControlJwtWrcHmacSecret)
    const { result, ...produced } = await runSelectedTrigger(bothGrantRecipe, 'team')
    expect(result.kind).toBe('run')
    if (result.kind !== 'run') throw new Error('actual V2 producer did not create a workflow run')

    const childName = `r68-h1-${result.row.run_id.slice(0, 12)}`
    let recipe: Record<string, any> = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: childName,
        namespace: config.sandboxNamespace,
        labels: { 'clerum.io/workflow-run-id': result.row.run_id },
      },
      spec: {
        steps: [
          { id: 'effect-one', run: { type: 'snippet', language: 'typescript', code: 'return 1' } },
          { id: 'effect-two', run: { type: 'snippet', language: 'typescript', code: 'return 2' } },
        ],
      },
      status: { phase: 'active', steps: [], workflowExecution: { phase: 'pending' } },
    }
    let syncStatus = async (): Promise<void> => undefined
    const applyPatch = (patch: unknown): void => {
      if (!Array.isArray(patch)) {
        const statusPatch = (patch as { status?: Record<string, unknown> })?.status ?? {}
        recipe = {
          ...recipe,
          status: { ...(recipe.status ?? {}), ...statusPatch },
        }
        return
      }
      for (const operation of patch as Array<{ op: string; path: string; value?: unknown }>) {
        if (operation.op === 'test') continue
        if (operation.path === '/status/phase') recipe.status.phase = operation.value
        else if (operation.path === '/status/workflowExecution') {
          recipe.status.workflowExecution = operation.value
        } else if (operation.path === '/status/steps') recipe.status.steps = operation.value
        else if (operation.path === '/status/steps/-') recipe.status.steps.push(operation.value)
        else if (/^\/status\/steps\/\d+$/.test(operation.path)) {
          recipe.status.steps[Number(operation.path.split('/').at(-1))] = operation.value
        }
      }
    }
    const customApi = {
      getNamespacedCustomObject: vi.fn(async () => recipe),
      patchNamespacedCustomObjectStatus: vi.fn(async ({ body }: { body: unknown }) => {
        applyPatch(body)
        await syncStatus()
        return { body: recipe }
      }),
    }

    const checkpointApp = express()
    checkpointApp.use(express.json())
    checkpointApp.use('/api/v1', createInternalActionAuthorityCheckpointRouter(gateway))
    checkpointServer = checkpointApp.listen(0, '127.0.0.1')
    await once(checkpointServer, 'listening')
    const checkpointAddress = checkpointServer.address()
    if (!checkpointAddress || typeof checkpointAddress === 'string') {
      throw new Error('workflow checkpoint test server did not bind a TCP port')
    }
    const checkpointResponses: string[] = []
    const checkpoint = createWorkflowRunAuthorityCheckpointer({
      baseUrl: `http://127.0.0.1:${checkpointAddress.port}`,
      fetchImpl: async (url, init) => {
        const request = JSON.parse(
          String(init?.body ?? 'null')
        ) as ActionAuthorityCheckpointRequestV2
        const response = await fetch(url, init)
        checkpointResponses.push(
          `${request.operationId}:${JSON.stringify(await response.clone().json())}`
        )
        return response
      },
    })
    const processor = createDbRunProcessor({
      instanceId: `r68-h1-${randomUUID()}`,
      pool: databasePool,
      runPollMs: 60_000,
      createChildRecipe: async () => ({ name: childName, namespace: config.sandboxNamespace }),
      checkpointAuthority: checkpoint,
    })
    syncStatus = async () => processor.syncFromRecipeExecution(recipe as never)
    const claims = {
      recipeName: childName,
      recipeNamespace: config.sandboxNamespace,
      runId: result.row.run_id,
      scopes: ['status_read', 'status_write'],
    } as never
    const handlers = createWorkflowEndpointHandlers(
      customApi as never,
      config.sandboxNamespace,
      undefined,
      { dbRunProcessor: processor }
    )
    const currentAction = await authorizeActionV2({
      session: {
        contract: 'v2',
        authorityMode: 'logical_session_checkpoint',
        userId,
        sid: produced.authority.binding.sid,
        sessionVersion: produced.authority.binding.sessionVersion,
      },
      requested: { version: 2 },
      operationId: 'workflow.trigger',
      resource: produced.authority.binding.resource as never,
      operationTarget: produced.authority.binding.target,
      allocateChatMessageId: false,
      gateway,
    })
    const currentActionSummary =
      currentAction.status === 'allowed'
        ? {
            status: currentAction.status,
            accessPathId: currentAction.context.accessPathId,
            authorizationRevision: currentAction.context.authorizationRevision,
          }
        : currentAction
    await processor.processPending(result.row.run_id)

    const effects = { first: 0, second: 0 }
    const status = {
      getWorkflowStatus: async () => {
        const current = await handlers.getWorkflowStatus(childName, claims)
        if (current.status >= 400) throw new Error(`WRC status read failed: ${current.status}`)
        return current.body
      },
      reportWorkflowStatus: async (workflowPhase: string, details?: Record<string, unknown>) => {
        const current = await handlers.postStepStatus(childName, claims, {
          workflowPhase,
          ...details,
        } as never)
        if (current.status === 423 && current.body.code === 'workflow_authorization_paused') {
          throw new WorkflowAuthorizationPausedError()
        }
        if (current.status >= 400) throw new Error(`WRC status write failed: ${current.status}`)
      },
      reportStepStatus: async (
        stepId: string,
        phase: string,
        details?: Record<string, unknown>
      ) => {
        const current = await handlers.postStepStatus(childName, claims, {
          stepId,
          phase,
          ...details,
        } as never)
        if (current.status === 423 && current.body.code === 'workflow_authorization_paused') {
          throw new WorkflowAuthorizationPausedError()
        }
        if (current.status >= 400)
          throw new Error(`WRC step status write failed: ${current.status}`)
      },
    }
    let simulateCoordinatorExit = false
    const runtimeStatus = {
      ...status,
      getWorkflowStatus: async () => {
        const current = await status.getWorkflowStatus()
        return simulateCoordinatorExit ? { ...current, workflowPhase: 'failed' } : current
      },
    }
    let cancelRequested = false
    const signals = {
      pollSignals: () => () => undefined,
      hasSignal: (signal: string) => signal === 'cancel' && cancelRequested,
    }
    const snippetRunner = {
      execute: async ({ stepId }: { stepId: string }) => {
        if (stepId === 'effect-one') {
          effects.first += 1
          await databasePool.query(
            `DELETE FROM team_workflow_triggers
              WHERE team_id = $1 AND recipe_namespace = $2 AND recipe_name = $3`,
            [teamId, config.sandboxNamespace, bothGrantRecipe]
          )
          return { stepId, status: 'completed', output: 'first-effect' }
        }
        effects.second += 1
        return { stepId, status: 'completed', output: 'second-effect' }
      },
    }
    const runRuntime = () =>
      runWorkflowRuntime({
        config: {
          workflowName: childName,
          wrcUrl: 'http://wrc.invalid',
          tokenProvider: {},
          signalPollIntervalMs: 250,
        } as never,
        spec: recipe.spec as never,
        coordinator: new StepCoordinator(),
        status: runtimeStatus as never,
        signals: signals as never,
        snippetRunner: snippetRunner as never,
      } as never)

    await processor.processPending(result.row.run_id)
    const runtime = runRuntime()
    const waitForPaused = async () => {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const state = await databasePool.query(
          `SELECT phase, failure_reason FROM workflow_runs WHERE run_id = $1`,
          [result.row.run_id]
        )
        if (
          state.rows[0]?.phase === 'AuthorizationPaused' ||
          state.rows[0]?.phase === 'Failed' ||
          state.rows[0]?.phase === 'Succeeded' ||
          state.rows[0]?.phase === 'Canceled'
        ) {
          if (state.rows[0]?.phase === 'AuthorizationPaused') return state.rows[0]
          break
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      const state = await databasePool.query(
        `SELECT phase, failure_reason FROM workflow_runs WHERE run_id = $1`,
        [result.row.run_id]
      )
      const steps = await databasePool.query(
        `SELECT step_id, phase, output FROM workflow_run_steps
          WHERE run_id = $1 ORDER BY step_id`,
        [result.row.run_id]
      )
      throw new Error(
        `workflow did not durably pause; state=${JSON.stringify(state.rows)} ` +
          `steps=${JSON.stringify(steps.rows)} effects=${JSON.stringify(effects)} ` +
          `checkpoints=${JSON.stringify(checkpointResponses)} ` +
          `boundRevision=${produced.authority.binding.authorizationRevision} ` +
          `currentAction=${JSON.stringify(currentActionSummary)} ` +
          `workflowExecution=${JSON.stringify(recipe.status.workflowExecution)}`
      )
    }
    let resumed = false
    try {
      const paused = await waitForPaused()
      expect(paused).toEqual({
        phase: 'AuthorizationPaused',
        failure_reason: 'workflow_authority_access_path_stale',
      })
      expect(effects).toEqual({ first: 1, second: 0 })
      expect(recipe.status.workflowExecution.phase).toBe('authorization_paused')

      const completedFirstEffect = await databasePool.query(
        `SELECT phase, output FROM workflow_run_steps
          WHERE run_id = $1 AND step_id = 'effect-one'`,
        [result.row.run_id]
      )
      expect(completedFirstEffect.rows).toEqual([{ phase: 'Succeeded', output: 'first-effect' }])

      // The original coordinator process exits while the durable run remains
      // paused. Its replacement must read the persisted step result and avoid
      // replaying the first protected effect.
      simulateCoordinatorExit = true
      const exitedRuntime = await runtime
      expect(exitedRuntime.workflowPhase).toBe('failed')
      expect(effects).toEqual({ first: 1, second: 0 })

      await databasePool.query(
        `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (team_id, recipe_namespace, recipe_name) DO NOTHING`,
        [teamId, config.sandboxNamespace, bothGrantRecipe]
      )

      const otherSession = await produceSelectedAuthority(bothGrantRecipe, 'team')
      const wrongSessionAuthority = await produceRunResumeAuthority({
        caller: otherSession.caller,
        runId: result.row.run_id,
        pathKind: 'team',
      })
      await expect(
        resumeWorkflowRun({
          runId: result.row.run_id,
          recipeNamespace: config.sandboxNamespace,
          recipeName: bothGrantRecipe,
          authority: wrongSessionAuthority,
          db: databasePool,
        })
      ).rejects.toMatchObject({ code: 'workflow_run_path_mismatch' })

      const resumeAuthority = await produceRunResumeAuthority({
        caller: produced.caller,
        runId: result.row.run_id,
        pathKind: 'team',
      })
      expect(resumeAuthority.binding.sid).toBe(produced.authority.binding.sid)
      expect(resumeAuthority.binding.pathKind).toBe(produced.authority.binding.pathKind)
      expect(resumeAuthority.binding.effectiveTeamId).toBe(teamId)
      expect(resumeAuthority.binding.accessPathId).not.toBe(produced.authority.binding.accessPathId)
      await resumeWorkflowRun({
        runId: result.row.run_id,
        recipeNamespace: config.sandboxNamespace,
        recipeName: bothGrantRecipe,
        authority: resumeAuthority,
        db: databasePool,
      })
      resumed = true

      const firstContinuation = await databasePool.query(
        `SELECT continuation.source_expires_at::text AS continuation_exp,
                initiating.source_expires_at::text AS initiating_exp
           FROM workflow_runs run
           JOIN workflow_authority_bindings initiating
             ON initiating.id = run.initiating_authority_binding_id
           JOIN workflow_authority_bindings continuation
             ON continuation.entity_id = run.run_id::text
            AND continuation.entity_type = 'workflow_run'
            AND continuation.binding_kind = 'run_management'
            AND continuation.delegation_jti = $2
          WHERE run.run_id = $1`,
        [result.row.run_id, resumeAuthority.binding.delegationJti]
      )
      expect(firstContinuation.rows).toEqual([
        {
          continuation_exp: expect.any(String),
          initiating_exp: expect.any(String),
        },
      ])
      expect(firstContinuation.rows[0]?.continuation_exp).toBe(
        firstContinuation.rows[0]?.initiating_exp
      )

      const processorStatusImmediatelyAfterResume = await processor.getRunStatus(
        result.row.run_id,
        config.sandboxNamespace,
        childName
      )
      const databaseStatusImmediatelyAfterResume = await databasePool.query(
        `SELECT phase, recipe_namespace, recipe_name, child_recipe_namespace,
                child_recipe_name,
                initiating_authority_binding_id IS NOT NULL AS has_authority
           FROM workflow_runs WHERE run_id = $1`,
        [result.row.run_id]
      )
      const statusImmediatelyAfterResume = await handlers.getWorkflowStatus(childName, claims)
      if (!processorStatusImmediatelyAfterResume) {
        throw new Error(
          `processor status missing; DB=${JSON.stringify(databaseStatusImmediatelyAfterResume.rows)} ` +
            `child=${childName}/${config.sandboxNamespace}`
        )
      }
      expect(processorStatusImmediatelyAfterResume?.phase).toBe('Running')
      expect(databaseStatusImmediatelyAfterResume.rows).toMatchObject([
        { phase: 'Running', has_authority: true },
      ])
      expect(statusImmediatelyAfterResume).toMatchObject({
        status: 200,
        body: { workflowPhase: 'running' },
      })

      const continuation = await databasePool.query(
        `SELECT child.parent_binding_id::text AS "parentBindingId",
                run.initiating_authority_binding_id::text AS "initiatingBindingId",
                child.access_path_id AS "accessPathId",
                child.source_expires_at::text AS "continuationExpiry",
                initiating.source_expires_at::text AS "initiatingExpiry"
           FROM workflow_runs run
           JOIN workflow_authority_bindings child
             ON child.entity_id = run.run_id::text
            AND child.entity_type = 'workflow_run'
            AND child.binding_kind = 'run_management'
            AND child.delegation_jti = $2
           JOIN workflow_authority_bindings initiating
             ON initiating.id = run.initiating_authority_binding_id
          WHERE run.run_id = $1`,
        [result.row.run_id, resumeAuthority.binding.delegationJti]
      )
      expect(continuation.rows).toEqual([
        {
          parentBindingId: null,
          initiatingBindingId: result.row.initiating_authority_binding_id,
          accessPathId: resumeAuthority.binding.accessPathId,
          continuationExpiry: expect.any(String),
          initiatingExpiry: expect.any(String),
        },
      ])
      expect(continuation.rows[0]?.continuationExpiry).toBe(continuation.rows[0]?.initiatingExpiry)

      simulateCoordinatorExit = false
      const restartedRuntime = runRuntime()
      const runtimeResult = await new Promise<Awaited<typeof restartedRuntime>>(
        (resolve, reject) => {
          const timeout = setTimeout(async () => {
            const durable = await databasePool.query(
              `SELECT phase, failure_reason FROM workflow_runs WHERE run_id = $1`,
              [result.row.run_id]
            )
            const observedStatus = await status.getWorkflowStatus()
            const processorStatus = await processor.getRunStatus(
              result.row.run_id,
              config.sandboxNamespace,
              childName
            )
            cancelRequested = true
            reject(
              new Error(
                `workflow did not finish after authorized resume; ` +
                  `durable=${JSON.stringify(durable.rows)} ` +
                  `status=${JSON.stringify(observedStatus)} effects=${JSON.stringify(effects)} ` +
                  `processorStatus=${JSON.stringify(processorStatus)} ` +
                  `checkpoints=${JSON.stringify(checkpointResponses)} ` +
                  `recipeStatus=${JSON.stringify(recipe.status.workflowExecution)}`
              )
            )
          }, 15_000)
          restartedRuntime.then(
            value => {
              clearTimeout(timeout)
              resolve(value)
            },
            error => {
              clearTimeout(timeout)
              reject(error)
            }
          )
        }
      )
      if (runtimeResult.workflowPhase !== 'completed') {
        const durable = await databasePool.query(
          `SELECT phase, failure_reason FROM workflow_runs WHERE run_id = $1`,
          [result.row.run_id]
        )
        const bindings = await databasePool.query(
          `SELECT delegation_jti, operation_id, resource, target, target_hash,
                  access_path_id, authorization_revision, behavior_binding_hash,
                  path_kind, effective_team_id, source_issued_at, source_expires_at,
                  source_expires_at > clock_timestamp() AS current
             FROM workflow_authority_bindings
            WHERE entity_type = 'workflow_run' AND entity_id = $1
            ORDER BY created_at, id`,
          [result.row.run_id]
        )
        throw new Error(
          `restarted runtime failed: result=${JSON.stringify(runtimeResult)} ` +
            `durable=${JSON.stringify(durable.rows)} effects=${JSON.stringify(effects)} ` +
            `checkpoints=${JSON.stringify(checkpointResponses)} ` +
            `workflowExecution=${JSON.stringify(recipe.status.workflowExecution)} ` +
            `bindings=${JSON.stringify(bindings.rows)}`
        )
      }
      expect(runtimeResult.workflowPhase).toBe('completed')
      expect(effects).toEqual({ first: 1, second: 1 })
      const succeeded = await databasePool.query(
        `SELECT phase, failure_reason FROM workflow_runs WHERE run_id = $1`,
        [result.row.run_id]
      )
      expect(succeeded.rows).toEqual([{ phase: 'Succeeded', failure_reason: null }])
    } finally {
      if (!resumed) {
        await databasePool.query(
          `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (team_id, recipe_namespace, recipe_name) DO NOTHING`,
          [teamId, config.sandboxNamespace, bothGrantRecipe]
        )
        try {
          const current = await databasePool.query(
            `SELECT phase FROM workflow_runs WHERE run_id = $1`,
            [result.row.run_id]
          )
          if (current.rows[0]?.phase === 'AuthorizationPaused') {
            const cleanupAuthority = await produceRunResumeAuthority({
              caller: produced.caller,
              runId: result.row.run_id,
              pathKind: 'team',
            })
            await resumeWorkflowRun({
              runId: result.row.run_id,
              recipeNamespace: config.sandboxNamespace,
              recipeName: bothGrantRecipe,
              authority: cleanupAuthority,
              db: databasePool,
            })
          }
        } catch {
          cancelRequested = true
        }
      }
      const settled = await new Promise<boolean>(resolve => {
        const timeout = setTimeout(() => resolve(false), 5_000)
        runtime.then(
          () => {
            clearTimeout(timeout)
            resolve(true)
          },
          () => {
            clearTimeout(timeout)
            resolve(true)
          }
        )
      })
      if (!settled) {
        cancelRequested = true
        await runtime.catch(() => undefined)
      }
    }
  })

  it('does not resume a run after its initiating delegation expires', async () => {
    const { result, caller } = await runSelectedTrigger(teamOnlyRecipe, 'team')
    expect(result.kind).toBe('run')
    if (result.kind !== 'run') throw new Error('actual V2 producer did not create a workflow run')

    const resumeAuthority = await produceRunResumeAuthority({
      caller,
      runId: result.row.run_id,
      pathKind: 'team',
    })
    await databasePool.query(
      `UPDATE workflow_runs
          SET phase = 'AuthorizationPaused',
              failure_reason = 'workflow_authority_unavailable',
              started_at = now(),
              child_recipe_name = 'expired-authority-child',
              child_recipe_namespace = 'sandbox-recipes'
        WHERE run_id = $1`,
      [result.row.run_id]
    )
    await databasePool.query(
      `UPDATE workflow_authority_bindings
          SET source_issued_at = clock_timestamp() - interval '20 seconds',
              source_expires_at = clock_timestamp() - interval '10 seconds'
        WHERE id = $1`,
      [result.row.initiating_authority_binding_id]
    )

    await expect(
      resumeWorkflowRun({
        runId: result.row.run_id,
        recipeNamespace: config.sandboxNamespace,
        recipeName: teamOnlyRecipe,
        authority: resumeAuthority,
        db: databasePool,
      })
    ).rejects.toMatchObject({ code: 'workflow_run_path_mismatch' })

    const state = await databasePool.query(
      `SELECT phase, failure_reason,
              (SELECT COUNT(*)::int FROM workflow_authority_bindings
                WHERE binding_kind = 'run_management'
                  AND entity_type = 'workflow_run'
                  AND entity_id = run_id::text) AS continuation_count
         FROM workflow_runs WHERE run_id = $1`,
      [result.row.run_id]
    )
    expect(state.rows).toEqual([
      {
        phase: 'AuthorizationPaused',
        failure_reason: 'workflow_authority_unavailable',
        continuation_count: 0,
      },
    ])
  })

  it('serializes concurrent grant revocation against the durable resume write', async () => {
    const { result, caller } = await runSelectedTrigger(teamOnlyRecipe, 'team')
    expect(result.kind).toBe('run')
    if (result.kind !== 'run') throw new Error('actual V2 producer did not create a workflow run')
    await databasePool.query(
      `UPDATE workflow_runs
          SET phase = 'AuthorizationPaused',
              failure_reason = 'workflow_authority_unavailable',
              started_at = now(),
              child_recipe_name = 'revoked-resume-child',
              child_recipe_namespace = 'sandbox-recipes'
        WHERE run_id = $1`,
      [result.row.run_id]
    )
    const resumeAuthority = await produceRunResumeAuthority({
      caller,
      runId: result.row.run_id,
      pathKind: 'team',
    })
    const revocationClient = await databasePool.connect()
    let revocationTransactionOpen = false
    let resume: Promise<unknown> | undefined
    try {
      await revocationClient.query('BEGIN')
      revocationTransactionOpen = true
      await revocationClient.query('LOCK TABLE team_workflow_triggers IN EXCLUSIVE MODE')
      resume = resumeWorkflowRun({
        runId: result.row.run_id,
        recipeNamespace: config.sandboxNamespace,
        recipeName: teamOnlyRecipe,
        authority: resumeAuthority,
        db: databasePool,
      })
      void resume.catch(() => undefined)
      let waitingForLineageLock = false
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const activity = await adminPool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = $1
                AND wait_event_type = 'Lock'
                AND position('FROM team_workflow_triggers twt' in query) > 0
           ) AS waiting`,
          [database]
        )
        if (activity.rows[0]?.waiting) {
          waitingForLineageLock = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(waitingForLineageLock).toBe(true)
      await revocationClient.query(
        `DELETE FROM team_workflow_triggers
          WHERE team_id = $1 AND recipe_namespace = $2 AND recipe_name = $3`,
        [teamId, config.sandboxNamespace, teamOnlyRecipe]
      )
      await revocationClient.query('COMMIT')
      revocationTransactionOpen = false
      await expect(resume).rejects.toMatchObject({ code: 'workflow_run_path_mismatch' })
    } finally {
      if (revocationTransactionOpen) await revocationClient.query('ROLLBACK')
      revocationClient.release()
      if (resume) await resume.catch(() => undefined)
    }

    const state = await databasePool.query(
      `SELECT phase, failure_reason,
              (SELECT COUNT(*)::int FROM workflow_authority_bindings
                WHERE binding_kind = 'run_management'
                  AND entity_type = 'workflow_run'
                  AND entity_id = run_id::text) AS continuation_count
         FROM workflow_runs WHERE run_id = $1`,
      [result.row.run_id]
    )
    expect(state.rows).toEqual([
      {
        phase: 'AuthorizationPaused',
        failure_reason: 'workflow_authority_unavailable',
        continuation_count: 0,
      },
    ])
  })

  it('keeps full workflow behavior while exact-validating only the resume dependency closure', async () => {
    if (!databasePool) throw new Error('realpg_database_not_ready')
    const { result, caller } = await runSelectedTrigger(teamOnlyRecipe, 'team')
    expect(result.kind).toBe('run')
    if (result.kind !== 'run') throw new Error('actual V2 producer did not create a workflow run')

    const serverNames = [0, 1, 2].map(
      index => `r68-run-mcp-${index}-${randomBytes(3).toString('hex')}`
    )
    const existingContext = (await gateway.getResource(
      'contexts',
      contextName,
      config.contextsNamespace
    )) as { metadata: Record<string, unknown>; spec: Record<string, unknown> }
    const originalContext = structuredClone(existingContext)
    try {
      for (const name of serverNames) {
        kubernetesApi.put('mcpservers', config.mcpServersNamespace, {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'McpServer',
          metadata: {
            name,
            namespace: config.mcpServersNamespace,
            uid: randomUUID(),
            resourceVersion: '1',
            generation: 1,
          },
          spec: {
            enabled: true,
            auth: { type: 'none' },
            transport: {
              type: 'streamable-http',
              url: `http://${name}.${config.mcpServersNamespace}:3000/mcp`,
            },
          },
        })
      }
      kubernetesApi.put('contexts', config.contextsNamespace, {
        ...existingContext,
        spec: { ...existingContext.spec, mcpServers: serverNames },
      })

      const recipeLogicalId = `${config.sandboxNamespace}/${teamOnlyRecipe}`
      const graphBudget = AccessExecutionBudget.create('action')
      let producerGraph: Awaited<ReturnType<typeof loadLiveOperationalResourceGraph>>
      try {
        producerGraph = await loadLiveOperationalResourceGraph({
          gateway,
          budget: graphBudget,
          resource: canonicalResourceIdentity({
            environmentId: canonicalEnvironmentId(),
            type: 'workflow_recipe',
            logicalId: recipeLogicalId,
          }),
          operationClass: 'full',
        })
      } finally {
        graphBudget.close()
      }
      expect(producerGraph.status).toBe('current')
      if (producerGraph.status !== 'current') return
      const selectedGraph = selectOperationalPathGraph({ graph: producerGraph })
      expect(selectedGraph?.resources.map(resource => resource.resourceType).sort()).toEqual([
        'context',
        'mcp_server',
        'mcp_server',
        'mcp_server',
        'workflow_recipe',
      ])

      const runResource = canonicalResourceIdentity({
        environmentId: canonicalEnvironmentId(),
        type: 'workflow_run',
        logicalId: result.row.run_id,
      })
      const beforeGets = kubernetesApi.requests.length
      const runAuthority = await authorizeActionV2({
        session: caller.session as ExternalSessionAuthorityContext,
        requested: { version: 2 },
        operationId: 'workflow.run.manage',
        resource: runResource,
        operationTarget: { runId: result.row.run_id, action: 'resume' },
        allocateChatMessageId: false,
        gateway,
      })
      expect(runAuthority.status, JSON.stringify(runAuthority)).toBe('allowed')
      if (runAuthority.status !== 'allowed') return
      expect(
        [
          runAuthority.context.behavior.budget,
          runAuthority.context.behavior.credentialPolicy,
          runAuthority.context.behavior.approvalPolicy,
          runAuthority.context.behavior.filesystemScope,
          runAuthority.context.behavior.runtime,
          runAuthority.context.behavior.providerModelPolicy,
          runAuthority.context.behavior.audit,
        ].every(dimension => dimension.state === 'known')
      ).toBe(true)
      // K1 reads the run's recipe graph live (root GET, Contexts LIST, then
      // the MCP servers LIST its Context reaches); K2 then GETs only the
      // resume closure, the recipe and its Context, never the MCP servers.
      const describeRequest = (item: (typeof kubernetesApi.requests)[number]) =>
        item.name === null ? `LIST ${item.plural}` : `GET ${item.plural}/${item.name}`
      const resumeRequests = kubernetesApi.requests.slice(beforeGets).map(describeRequest)
      expect([...resumeRequests].sort()).toEqual(
        [
          `GET workflowrecipes/${teamOnlyRecipe}`,
          'LIST contexts',
          'LIST mcpservers',
          `GET workflowrecipes/${teamOnlyRecipe}`,
          `GET contexts/${contextName}`,
        ].sort()
      )
      expect(new Set(resumeRequests.slice(-2))).toEqual(
        new Set([`GET workflowrecipes/${teamOnlyRecipe}`, `GET contexts/${contextName}`])
      )

      // Kubernetes unavailable while K1 lists Contexts: the resume fails
      // closed before any exact GET of the closure.
      const listResourcePage = vi
        .spyOn(gateway, 'listResourcePage')
        .mockRejectedValueOnce(new Error('kubernetes_unavailable_fixture'))
      const beforeUnavailableResume = kubernetesApi.requests.length
      let unavailableResume: Awaited<ReturnType<typeof authorizeActionV2>>
      let listCalls: unknown[][]
      try {
        unavailableResume = await authorizeActionV2({
          session: caller.session as ExternalSessionAuthorityContext,
          requested: { version: 2 },
          operationId: 'workflow.run.manage',
          resource: runResource,
          operationTarget: { runId: result.row.run_id, action: 'resume' },
          allocateChatMessageId: false,
          gateway,
        })
        listCalls = listResourcePage.mock.calls.map(call => [...call])
      } finally {
        listResourcePage.mockRestore()
      }
      expect(unavailableResume.status).toBe('authority_unavailable')
      // Witness: the resolver reached K1 and the failing LIST was issued.
      expect(listCalls).toEqual([
        [
          'contexts',
          config.contextsNamespace,
          expect.objectContaining({ limit: expect.any(Number) }),
        ],
      ])
      const unavailableGets = kubernetesApi.requests
        .slice(beforeUnavailableResume)
        .filter(item => item.name !== null)
        .map(describeRequest)
      expect(unavailableGets.every(item => item === `GET workflowrecipes/${teamOnlyRecipe}`)).toBe(
        true
      )
      expect(unavailableGets.length).toBeLessThanOrEqual(1)
    } finally {
      kubernetesApi.put('contexts', config.contextsNamespace, originalContext)
      for (const name of serverNames) {
        kubernetesApi.delete('mcpservers', config.mcpServersNamespace, name)
      }
    }
  })

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
          validateCurrentInTransaction: (db, authority) =>
            requireCurrentWorkflowTriggerAuthority({ db, authority }),
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

  // T-Q2 (merge plan v2 §5.2, §10 M3): a Kubernetes fact of the recipe changes
  // between delegation issuance and the trigger route's single checkpoint.
  it('rejects a trigger whose recipe changed after its delegation was issued', async () => {
    const issued = await issueSelectedDelegation(teamOnlyRecipe, 'team')
    const original = (await gateway.getResource(
      'workflowrecipes',
      teamOnlyRecipe,
      config.sandboxNamespace
    )) as { metadata: Record<string, unknown>; spec: Record<string, unknown> }
    const before = structuredClone(original)
    try {
      kubernetesApi.put('workflowrecipes', config.sandboxNamespace, {
        ...original,
        metadata: { ...original.metadata, resourceVersion: '2', generation: 2 },
        spec: { ...original.spec, description: 'changed after the delegation was issued' },
      })
      const beforeCheckpoint = kubernetesApi.requests.length
      await expect(requireWorkflowActionAuthority(issued.authorityInput)).rejects.toMatchObject({
        status: 409,
        code: 'access_path_stale',
      })
      // Witness: the checkpoint read the changed recipe live.
      expect(
        kubernetesApi.requests
          .slice(beforeCheckpoint)
          .some(item => item.plural === 'workflowrecipes' && item.name === teamOnlyRecipe)
      ).toBe(true)
    } finally {
      kubernetesApi.put('workflowrecipes', config.sandboxNamespace, before)
    }
    // The same delegation shape issued against the restored recipe passes.
    const fresh = await issueSelectedDelegation(teamOnlyRecipe, 'team')
    await expect(requireWorkflowActionAuthority(fresh.authorityInput)).resolves.toMatchObject({
      binding: expect.objectContaining({ pathKind: 'team', effectiveTeamId: teamId }),
    })
  })

  // T-Q2 companion: the selected path id embeds its authorization revision
  // (accessPath.ts buildAccessPath), so a changed fact already fails the path
  // lookup. The authorizer's own revision compare is what rejects a delegation
  // whose path is current but whose signed revision is not.
  it('rejects a delegation whose signed revision does not match its current path', async () => {
    const forged = await issueSelectedDelegation(teamOnlyRecipe, 'team', {
      authorizationRevision: `ar1_${'x'.repeat(43)}`,
    })
    const beforeCheckpoint = kubernetesApi.requests.length
    await expect(requireWorkflowActionAuthority(forged.authorityInput)).rejects.toMatchObject({
      status: 409,
      code: 'access_path_stale',
    })
    // Witness: the checkpoint resolved the path live before comparing.
    expect(kubernetesApi.requests.length).toBeGreaterThan(beforeCheckpoint)
  })

  // T-Q3 (merge plan v2 §5.2, §4.3, §10 L3): a Postgres revocation committed
  // between the route's authorization and the insert reaches the row check.
  it.each([
    {
      label: 'the direct grant row is deleted',
      recipe: () => bothGrantRecipe,
      pathKind: 'direct' as const,
      revoke: async (_authority: WorkflowAuthorityBinding) => {
        await databasePool.query(
          `DELETE FROM user_workflow_triggers
            WHERE user_id = $1 AND recipe_namespace = $2 AND recipe_name = $3`,
          [userId, config.sandboxNamespace, bothGrantRecipe]
        )
      },
      restore: async () => {
        await databasePool.query(
          `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [userId, config.sandboxNamespace, bothGrantRecipe]
        )
      },
      expected: { status: 409, code: 'access_path_stale' },
      reads: ['session', 'grant'],
    },
    {
      label: 'the team membership is deleted',
      recipe: () => teamOnlyRecipe,
      pathKind: 'team' as const,
      revoke: async (_authority: WorkflowAuthorityBinding) => {
        await databasePool.query(
          `UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`,
          [teamId, userId]
        )
      },
      restore: async () => {
        await databasePool.query(
          `UPDATE team_members SET status = 'active' WHERE team_id = $1 AND user_id = $2`,
          [teamId, userId]
        )
      },
      expected: { status: 409, code: 'access_path_stale' },
      // The membership is locked in its own statement before the team grant,
      // so the check stops at the membership and never reads the grant.
      reads: ['session', 'membership'],
    },
    {
      label: 'the session is revoked',
      recipe: () => teamOnlyRecipe,
      pathKind: 'team' as const,
      revoke: async (authority: WorkflowAuthorityBinding) => {
        await expect(
          revokeUserSession(userId, authority.binding.sid, 'row-check-window')
        ).resolves.toBe(true)
      },
      restore: async () => undefined,
      expected: { status: 401, code: 'invalid_session' },
      reads: ['session'],
    },
  ])('rejects the insert when $label inside the window', async input => {
    const recipeName = input.recipe()
    const idempotencyKey = `row-check-window-${randomUUID()}`
    const rowCheckReads: string[] = []
    let delegationJti: string | null = null
    let revoked = false
    try {
      await expect(
        runSelectedTrigger(recipeName, input.pathKind, {
          idempotencyKey,
          rowCheckReads,
          beforeRowCheck: async authority => {
            delegationJti = authority.binding.delegationJti
            await input.revoke(authority)
            revoked = true
          },
        })
      ).rejects.toMatchObject(input.expected)
    } finally {
      await input.restore()
    }
    expect(revoked).toBe(true)
    expect(delegationJti).toEqual(expect.any(String))
    // Witness: the row check ran once inside the insert transaction and
    // stopped at the revoked row.
    expect(rowCheckReads).toEqual(input.reads)
    const runs = await databasePool.query(
      `SELECT run_id FROM workflow_runs
        WHERE recipe_namespace = $1 AND recipe_name = $2 AND idempotency_key = $3`,
      [config.sandboxNamespace, recipeName, idempotencyKey]
    )
    expect(runs.rowCount).toBe(0)
    const bindings = await databasePool.query(
      `SELECT id FROM workflow_authority_bindings WHERE delegation_jti = $1`,
      [delegationJti]
    )
    expect(bindings.rowCount).toBe(0)
  })
})
