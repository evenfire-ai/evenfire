import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'
import { config } from '../src/config.js'
import { type DbClient, initDb } from '../src/db.js'
import { K8sGateway } from '../src/k8s.js'
import { createExternalRpcDelegationsRouter } from '../src/routes/external/rpcDelegations.js'
import { authorizeActionV2 } from '../src/services/access/actionAuthorizer.js'
import {
  type LiveActionAuthorizationInput,
  type LiveAuthorizationResult,
  resolveLiveActionAuthorization,
} from '../src/services/access/liveAuthorizationResolver.js'
import {
  canonicalEnvironmentId,
  projectOperationalObject,
} from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import { createUserSession } from '../src/services/auth/userSessionService.js'
import { __resetBudgetCheckCache, evaluateBudgetCheck } from '../src/services/budgets/check.js'
import { retireDesktopUser } from '../src/services/directory/users.js'
import { verifyUserDelegationV2 } from '../src/utils/auth/userDelegationV2Token.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { TemporaryKubernetesApi } from './helpers/temporaryKubernetesApi.js'

// The resolver, action-authorizer and budget cases of the deleted
// accessCatalogFamilies, finalAuthorityLifecycle and userAccessRuntimeContract
// real-PostgreSQL suites (merge plan v1 §2.4, "Split" and "Partly moved"),
// reseeded for the live loader (merge plan v2 §2, C5): the Kubernetes objects
// live in a temporary Kubernetes API that the resolver reads at decision time,
// and the grants live in a real PostgreSQL database. No index exists.

const routeTestState = vi.hoisted(() => ({ databasePool: null as unknown }))

vi.mock('../src/db.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/db.js')>()
  const testPool = new Proxy(
    {},
    {
      get(_target, property) {
        const target = routeTestState.databasePool
        if (!target || typeof target !== 'object') {
          throw new Error('realpg_test_database_pool_not_bound')
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }
  )
  return {
    ...actual,
    pool: testPool,
    corePool: testPool,
    rateLimitPool: testPool,
    withTransaction: <T>(work: (db: DbClient) => Promise<T>) =>
      actual.withTransaction(work, testPool as unknown as Pool),
  }
})

// T-QA mounts `POST /external/rpc/delegations`, which answers only while the
// action context and RPC delegation V2 are on and V2 sessions are accepted.
// Only those three flags are overridden; the rest is the real resolved policy.
vi.mock('../src/services/access/userAccessRuntimePolicy.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/services/access/userAccessRuntimePolicy.js')>()
  return {
    ...actual,
    resolveEffectiveUserAccessPolicy: async (
      ...args: Parameters<typeof actual.resolveEffectiveUserAccessPolicy>
    ) => ({
      ...(await actual.resolveEffectiveUserAccessPolicy(...args)),
      acceptV2: true,
      actionContextV2: true,
      rpcDelegationV2: true,
    }),
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(value => {
    resolve = value
  })
  return { promise, resolve }
}

type OperationalFixture = Readonly<{
  plural: 'hosts' | 'contexts' | 'mcpservers' | 'workflowrecipes' | 'sharedfilesystems'
  namespace: string
  object: Readonly<Record<string, unknown>>
}>

function fixture(input: {
  plural: OperationalFixture['plural']
  namespace: string
  name: string
  uid: string
  spec?: Readonly<Record<string, unknown>>
  resourceVersion?: string
}): OperationalFixture {
  const kind = {
    hosts: 'Host',
    contexts: 'Context',
    mcpservers: 'McpServer',
    workflowrecipes: 'WorkflowRecipe',
    sharedfilesystems: 'SharedFileSystem',
  }[input.plural]
  return Object.freeze({
    plural: input.plural,
    namespace: input.namespace,
    object: Object.freeze({
      apiVersion: 'clerum.io/v1alpha1',
      kind,
      metadata: Object.freeze({
        name: input.name,
        namespace: input.namespace,
        uid: input.uid,
        resourceVersion: input.resourceVersion ?? '1',
        generation: 1,
      }),
      spec: Object.freeze({ enabled: true, ...(input.spec ?? {}) }),
    }),
  })
}

/** The relationship instance ids one object projects, as the loader computes them. */
function projectedRelationships(value: OperationalFixture) {
  return projectOperationalObject({
    environmentId: canonicalEnvironmentId(),
    plural: value.plural,
    namespace: value.namespace,
    object: value.object,
    behaviorFingerprintKey: config.sessionJwtPrivateKey,
    relationshipNamespaces: {
      context: config.contextsNamespace,
      mcpServer: config.mcpServersNamespace,
      sharedFilesystem: config.sharedFilesystemsNamespace,
    },
  }).relationships
}

type Session = Readonly<{
  contract: 'v2'
  userId: string
  sid: string
  jti: string
  sessionVersion: number
}>

type Allowed = Extract<LiveAuthorizationResult, { status: 'allowed' }>

describeRealPostgres('action access paths on live producers and real PostgreSQL', () => {
  const database = `control_api_action_access_paths_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const environmentId = canonicalEnvironmentId()
  const userId = randomUUID()
  const teamId = randomUUID()
  const directRunId = randomUUID()
  const teamRunId = randomUUID()
  const directApprovalId = randomUUID()
  const teamApprovalId = randomUUID()
  const gfsResourceId = randomUUID()
  const hostRef = `${config.hostsNamespace}/catalog-host`
  const operationalFixtures: readonly OperationalFixture[] = [
    fixture({
      plural: 'hosts',
      namespace: config.hostsNamespace,
      name: 'catalog-host',
      uid: 'catalog-host-uid',
      spec: {
        contextRef: 'catalog-context',
        model: { provider: 'openai', name: 'test-model' },
      },
    }),
    fixture({
      plural: 'contexts',
      namespace: config.contextsNamespace,
      name: 'catalog-context',
      uid: 'catalog-context-uid',
      spec: {
        mcpServers: ['catalog-mcp'],
        sharedFileSystems: [
          { name: 'catalog-files', mountPath: '/workspace/a' },
          { name: 'catalog-files', mountPath: '/workspace/b' },
        ],
      },
    }),
    fixture({
      plural: 'mcpservers',
      namespace: config.mcpServersNamespace,
      name: 'catalog-mcp',
      uid: 'catalog-mcp-uid',
      spec: { auth: { type: 'none' } },
    }),
    fixture({
      plural: 'workflowrecipes',
      namespace: config.sandboxNamespace,
      name: 'catalog-recipe',
      uid: 'catalog-recipe-uid',
      spec: {
        contextRef: 'catalog-context',
        runtimeEgress: ['example.test'],
        ui: {
          workloadRef: 'catalog-app',
          port: 8080,
          title: 'Catalog App',
          defaultPath: '/',
        },
      },
    }),
    fixture({
      plural: 'sharedfilesystems',
      namespace: config.sharedFilesystemsNamespace,
      name: 'catalog-files',
      uid: 'catalog-files-uid',
    }),
  ]
  const originalOf = (plural: OperationalFixture['plural']) =>
    operationalFixtures.find(value => value.plural === plural)!
  const kubernetesApi = new TemporaryKubernetesApi()
  let adminPool: Pool
  let databasePool: Pool
  let gateway: K8sGateway
  let session: Session

  async function v2Session(forUserId: string): Promise<Session> {
    const issued = await createUserSession(
      { userId: forUserId, email: `${forUserId}@example.test`, authenticationMethods: ['pwd'] },
      { db: databasePool as never }
    )
    return Object.freeze({
      contract: 'v2',
      userId: forUserId,
      sid: issued.identity.sid,
      jti: issued.identity.jti,
      sessionVersion: issued.identity.sessionVersion,
    })
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    routeTestState.databasePool = databasePool
    await initDb({ connect: () => databasePool.connect() })
    await databasePool.query(
      `INSERT INTO llm_allowed_models(provider, model, vendor, enabled)
       VALUES ('openai', 'test-model', 'test', TRUE)`
    )
    await kubernetesApi.start()
    for (const value of operationalFixtures) {
      kubernetesApi.put(value.plural, value.namespace, value.object)
    }
    const priorKubeconfig = process.env.KUBECONFIG
    process.env.KUBECONFIG = kubernetesApi.kubeconfig()
    try {
      gateway = new K8sGateway()
    } finally {
      if (priorKubeconfig === undefined) delete process.env.KUBECONFIG
      else process.env.KUBECONFIG = priorKubeconfig
    }

    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Access Paths User')`,
      [userId, `${userId}@example.test`]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Access Paths Team')`, [
      teamId,
    ])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'admin', 'active')`,
      [teamId, userId]
    )
    await databasePool.query(
      `INSERT INTO user_agents(user_id, agent_name) VALUES ($1, 'catalog-host')`,
      [userId]
    )
    await databasePool.query(
      `INSERT INTO team_agents(team_id, agent_name) VALUES ($1, 'catalog-host')`,
      [teamId]
    )
    await databasePool.query(
      `INSERT INTO user_contexts(user_id, context_id) VALUES ($1, 'catalog-context')`,
      [userId]
    )
    await databasePool.query(
      `INSERT INTO team_contexts(team_id, context_id) VALUES ($1, 'catalog-context')`,
      [teamId]
    )
    await databasePool.query(
      `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, 'catalog-recipe')`,
      [userId, config.sandboxNamespace]
    )
    await databasePool.query(
      `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, 'catalog-recipe')`,
      [teamId, config.sandboxNamespace]
    )
    await databasePool.query(
      `INSERT INTO workflow_recipe_allowed_teams(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, 'catalog-recipe')`,
      [teamId, config.sandboxNamespace]
    )
    await databasePool.query(
      `INSERT INTO workflow_runs(
         run_id, recipe_namespace, recipe_name, phase, actor_type, actor_id,
         team_id, trigger_source
       ) VALUES
         ($1, $5, 'catalog-recipe', 'Succeeded', 'user', $3, NULL, 'onDemand'),
         ($2, $5, 'catalog-recipe', 'Succeeded', 'user', $3, $4, 'onDemand')`,
      [directRunId, teamRunId, userId, teamId, config.sandboxNamespace]
    )
    await databasePool.query(
      `INSERT INTO workflow_approval_requests(
         id, recipe_namespace, recipe_name, expires_at, status, target_user_id,
         target_team_id, payload, idempotency_key, payload_hash
       ) VALUES
         ($1, $5, 'catalog-recipe', NOW() + INTERVAL '1 hour', 'pending', $3, NULL,
          '{}'::jsonb, $6, 'hash'),
         ($2, $5, 'catalog-recipe', NOW() + INTERVAL '1 hour', 'pending', NULL, $4,
          '{}'::jsonb, $7, 'hash')`,
      [
        directApprovalId,
        teamApprovalId,
        userId,
        teamId,
        config.sandboxNamespace,
        `direct-${directApprovalId}`,
        `team-${teamApprovalId}`,
      ]
    )
    await databasePool.query(
      `INSERT INTO gfs_resources(resource_id, drive, name, kind)
       VALUES ($1, 'catalog-drive', '/', 'directory')`,
      [gfsResourceId]
    )
    await databasePool.query(
      `INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
       VALUES
         ('catalog-drive', $1, 'user', $2::text, ARRAY['read', 'write']::text[]),
         ('catalog-drive', $1, 'team', $3::text, ARRAY['read']::text[])`,
      [gfsResourceId, userId, teamId]
    )
    session = await v2Session(userId)
  })

  afterAll(async () => {
    try {
      await kubernetesApi.close()
      await endPoolAndWaitForClients(databasePool)
      routeTestState.databasePool = null
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
  })

  type ActionRequest = Omit<LiveActionAuthorizationInput, 'session'>

  /**
   * Every access path the live resolver offers for one action, each resolved
   * explicitly so its own bindings and behavior are returned.
   */
  async function allowedPaths(input: ActionRequest, as: Session = session): Promise<Allowed[]> {
    const first = await resolveLiveActionAuthorization({ session: as, ...input }, { gateway })
    const ids =
      first.status === 'allowed'
        ? first.paths.map(path => path.id)
        : first.status === 'access_path_required'
          ? first.safePathDescriptors.map(path => path.id)
          : []
    expect(ids, `${input.operationId}: ${JSON.stringify(first)}`).not.toHaveLength(0)
    const results: Allowed[] = []
    for (const requestedAccessPathId of ids) {
      const explicit = await resolveLiveActionAuthorization(
        { session: as, ...input, requestedAccessPathId },
        { gateway }
      )
      expect(explicit.status, `${input.operationId}: ${JSON.stringify(explicit)}`).toBe('allowed')
      if (explicit.status !== 'allowed') throw new Error('explicit path did not resolve')
      expect(explicit.selectedPath.id).toBe(requestedAccessPathId)
      results.push(explicit)
    }
    return results
  }

  const hostResource = canonicalResourceIdentity({
    environmentId,
    type: 'host',
    logicalId: hostRef,
  })
  const hostChat: ActionRequest = {
    operationId: 'chat.message.invoke',
    resource: hostResource,
    operationTarget: {
      hostRef,
      channelType: 'rpc',
      channelId: 'catalog-host',
      messageId: '00000000-0000-4000-8000-000000000001',
    },
  }
  const mcpResource = canonicalResourceIdentity({
    environmentId,
    type: 'mcp_server',
    logicalId: `${config.mcpServersNamespace}/catalog-mcp`,
  })
  const mcpRead: ActionRequest = {
    operationId: 'mcp.tools.read',
    resource: mcpResource,
    operationTarget: { serverNamespace: config.mcpServersNamespace, serverName: 'catalog-mcp' },
  }
  const recipeTrigger: ActionRequest = {
    operationId: 'workflow.trigger',
    resource: canonicalResourceIdentity({
      environmentId,
      type: 'workflow_recipe',
      logicalId: `${config.sandboxNamespace}/catalog-recipe`,
    }),
    operationTarget: { recipeNamespace: config.sandboxNamespace, recipeName: 'catalog-recipe' },
  }
  const gfsRead: ActionRequest = {
    operationId: 'gfs.read',
    resource: canonicalResourceIdentity({
      environmentId,
      type: 'gfs_resource',
      logicalId: gfsResourceId,
    }),
    operationTarget: { drive: 'catalog-drive', resourceId: gfsResourceId },
  }
  const pathBehaviors = (paths: readonly Allowed[]) =>
    paths
      .map(path => ({
        id: path.selectedPath.id,
        kind: path.selectedPath.kind,
        behavior: path.selectedPath.behavior,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  const behaviorSet = (paths: readonly Allowed[]) =>
    paths.map(path => JSON.stringify(path.selectedPath.behavior)).sort()

  const mountIds = () => {
    const contextMounts = projectedRelationships(originalOf('contexts')).filter(
      relationship => relationship.relationshipType === 'mounts_shared_filesystem'
    )
    expect(contextMounts).toHaveLength(2)
    return contextMounts.map(relationship => relationship.relationshipInstanceId)
  }

  it.each([
    { family: 'host', request: () => hostChat },
    {
      family: 'context',
      request: (): ActionRequest => ({
        operationId: 'context.use',
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'context',
          logicalId: `${config.contextsNamespace}/catalog-context`,
        }),
        operationTarget: {
          contextNamespace: config.contextsNamespace,
          contextName: 'catalog-context',
          action: 'use',
        },
      }),
    },
    { family: 'mcp_server', request: () => mcpRead },
    { family: 'workflow_recipe', request: () => recipeTrigger },
    {
      family: 'workflow_approval',
      request: (): ActionRequest => ({
        operationId: 'workflow.approval.decide',
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'workflow_approval',
          logicalId: directApprovalId,
        }),
        operationTarget: { approvalId: directApprovalId, decision: 'approve' },
      }),
    },
    { family: 'gfs_resource', request: () => gfsRead },
    {
      family: 'sandbox_app',
      request: (): ActionRequest => ({
        operationId: 'sandbox.open',
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'sandbox_app',
          logicalId: `${config.sandboxNamespace}/catalog-recipe`,
        }),
        operationTarget: {
          recipeNamespace: config.sandboxNamespace,
          recipeName: 'catalog-recipe',
        },
      }),
    },
  ])('$family paths round-trip from live resolution to the action authorizer', async input => {
    const action = input.request()
    const paths = await allowedPaths(action)
    for (const path of paths) {
      const authorized = await authorizeActionV2({
        session,
        requested: { version: 2, requestedAccessPathId: path.selectedPath.id },
        operationId: action.operationId,
        resource: action.resource,
        operationTarget: action.operationTarget,
        allocateChatMessageId: false,
        gateway,
      })
      expect(authorized.status, JSON.stringify(authorized)).toBe('allowed')
      if (authorized.status === 'allowed') {
        expect(authorized.context.accessPathId).toBe(path.selectedPath.id)
        expect(authorized.context.authorizationRevision).toBe(path.authorizationRevision)
      }
    }
    if (input.family === 'context' || input.family === 'mcp_server') {
      for (const path of paths) {
        expect(path.selectedPath.behavior.providerModelPolicy).toEqual({
          state: 'known',
          value: null,
        })
      }
    }
  })

  it('reaches a team-only approval and a team-owned run through their team paths', async () => {
    const approval = await allowedPaths({
      operationId: 'workflow.approval.decide',
      resource: canonicalResourceIdentity({
        environmentId,
        type: 'workflow_approval',
        logicalId: teamApprovalId,
      }),
      operationTarget: { approvalId: teamApprovalId, decision: 'deny' },
    })
    expect(approval.map(path => path.selectedPath.kind)).toEqual(['team'])
    expect(approval[0]!.selectedPath.teamId).toBe(teamId)

    const run = await allowedPaths({
      operationId: 'workflow.read',
      resource: canonicalResourceIdentity({
        environmentId,
        type: 'workflow_run',
        logicalId: teamRunId,
      }),
      operationTarget: {
        recipeNamespace: config.sandboxNamespace,
        recipeName: 'catalog-recipe',
        runId: teamRunId,
      },
    })
    expect(run.map(path => path.selectedPath.kind)).toContain('team')
  })

  it('resolves producer Context aliases to one canonical authority identity', async () => {
    const suffix = randomBytes(5).toString('hex')
    const contextName = `r55-m7-context-${suffix}`
    const contextAlias = `r55-m7-wire-${suffix}`
    const hostName = `r55-m7-host-${suffix}`
    const mcpName = `r55-m7-mcp-${suffix}`
    const sharedFilesystemName = `r55-m7-files-${suffix}`
    const duplicateAliasName = `r55-m7-duplicate-${suffix}`
    const nextContextAlias = `r55-m7-next-wire-${suffix}`
    const contextUid = randomUUID()
    const contextWith = (alias: string, uid: string) =>
      fixture({
        plural: 'contexts',
        namespace: config.contextsNamespace,
        name: contextName,
        uid,
        spec: {
          contextId: alias,
          mcpServers: [mcpName],
          sharedFileSystems: [{ name: sharedFilesystemName, mountPath: '/workspace/m7' }],
        },
      })
    const hostWith = (alias: string, uid: string) =>
      fixture({
        plural: 'hosts',
        namespace: config.hostsNamespace,
        name: hostName,
        uid,
        spec: { contextRef: alias },
      })
    const hostUid = randomUUID()
    const contextObject = contextWith(contextAlias, contextUid)
    const mcpObject = fixture({
      plural: 'mcpservers',
      namespace: config.mcpServersNamespace,
      name: mcpName,
      uid: randomUUID(),
    })
    const sharedFilesystemObject = fixture({
      plural: 'sharedfilesystems',
      namespace: config.sharedFilesystemsNamespace,
      name: sharedFilesystemName,
      uid: randomUUID(),
    })
    for (const value of [
      contextObject,
      hostWith(contextAlias, hostUid),
      mcpObject,
      sharedFilesystemObject,
    ]) {
      kubernetesApi.put(value.plural, value.namespace, value.object)
    }
    await databasePool.query(`INSERT INTO user_contexts(user_id, context_id) VALUES ($1, $2)`, [
      userId,
      contextAlias,
    ])
    await databasePool.query(`INSERT INTO user_agents(user_id, agent_name) VALUES ($1, $2)`, [
      userId,
      hostName,
    ])
    const canonicalContextId = `${config.contextsNamespace}/${contextName}`
    const contextAction = (): ActionRequest => ({
      operationId: 'context.use',
      resource: canonicalResourceIdentity({
        environmentId,
        type: 'context',
        logicalId: canonicalContextId,
      }),
      operationTarget: {
        contextNamespace: config.contextsNamespace,
        contextName,
        action: 'use',
      },
    })
    const mcpAction: ActionRequest = {
      operationId: 'mcp.tools.read',
      resource: canonicalResourceIdentity({
        environmentId,
        type: 'mcp_server',
        logicalId: `${config.mcpServersNamespace}/${mcpName}`,
      }),
      operationTarget: { serverNamespace: config.mcpServersNamespace, serverName: mcpName },
    }

    try {
      // The alias grant reaches the canonical Context through one path.
      const contextPaths = await allowedPaths(contextAction())
      expect(contextPaths).toHaveLength(1)
      expect(
        contextPaths[0]!.operationalBindings.find(binding => binding.resourceType === 'context')
      ).toMatchObject({ logicalId: canonicalContextId, providerUid: contextUid })

      // The MCP server is reached through the aliased Context grant and the Host.
      expect(await allowedPaths(mcpAction)).toHaveLength(2)

      const mount = projectedRelationships(contextObject).find(
        relationship => relationship.relationshipType === 'mounts_shared_filesystem'
      )!
      const filesystemPaths = await allowedPaths({
        operationId: 'shared_filesystem.read',
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'shared_filesystem',
          logicalId: `${config.sharedFilesystemsNamespace}/${sharedFilesystemName}`,
        }),
        operationTarget: {
          sharedFileSystemNamespace: config.sharedFilesystemsNamespace,
          sharedFileSystemName: sharedFilesystemName,
          relationshipInstanceId: mount.relationshipInstanceId,
          canonicalRelativePath: 'reports',
        },
      })
      expect(filesystemPaths).toHaveLength(1)

      // A second Context claiming the same alias makes it ambiguous: the alias
      // grant resolves to no Context, so the Context is no longer reached.
      const duplicateAlias = fixture({
        plural: 'contexts',
        namespace: config.contextsNamespace,
        name: duplicateAliasName,
        uid: randomUUID(),
        spec: { contextId: contextAlias, mcpServers: [], sharedFileSystems: [] },
      })
      kubernetesApi.put(duplicateAlias.plural, duplicateAlias.namespace, duplicateAlias.object)
      const ambiguous = await resolveLiveActionAuthorization(
        { session, ...contextAction() },
        { gateway }
      )
      expect(ambiguous.status, JSON.stringify(ambiguous)).not.toBe('allowed')
      expect(ambiguous.status).not.toBe('access_path_required')
      kubernetesApi.delete(duplicateAlias.plural, duplicateAlias.namespace, duplicateAliasName)

      // A Context whose name equals the alias also makes it ambiguous.
      const nameCollision = fixture({
        plural: 'contexts',
        namespace: config.contextsNamespace,
        name: contextAlias,
        uid: randomUUID(),
        spec: { mcpServers: [], sharedFileSystems: [] },
      })
      kubernetesApi.put(nameCollision.plural, nameCollision.namespace, nameCollision.object)
      const collided = await resolveLiveActionAuthorization(
        { session, ...contextAction() },
        { gateway }
      )
      expect(collided.status, JSON.stringify(collided)).not.toBe('allowed')
      expect(collided.status).not.toBe('access_path_required')
      kubernetesApi.delete(nameCollision.plural, nameCollision.namespace, contextAlias)

      // The Context changes its alias: the old alias grant reaches nothing.
      const renamed = contextWith(nextContextAlias, contextUid)
      kubernetesApi.put(renamed.plural, renamed.namespace, renamed.object)
      const staleAlias = await resolveLiveActionAuthorization(
        { session, ...contextAction() },
        { gateway }
      )
      expect(staleAlias.status, JSON.stringify(staleAlias)).not.toBe('allowed')
      expect(staleAlias.status).not.toBe('access_path_required')

      await databasePool.query(
        `UPDATE user_contexts SET context_id = $3 WHERE user_id = $1 AND context_id = $2`,
        [userId, contextAlias, nextContextAlias]
      )
      const nextHost = hostWith(nextContextAlias, hostUid)
      kubernetesApi.put(nextHost.plural, nextHost.namespace, nextHost.object)
      const refreshed = await allowedPaths(contextAction())
      expect(refreshed).toHaveLength(1)
      const oldContextPathId = refreshed[0]!.selectedPath.id

      // Recreating the Context with a new UID retires the old path.
      const recreatedUid = randomUUID()
      const recreated = contextWith(nextContextAlias, recreatedUid)
      kubernetesApi.put(recreated.plural, recreated.namespace, recreated.object)
      const recreatedPaths = await allowedPaths(contextAction())
      expect(
        recreatedPaths[0]!.operationalBindings.find(binding => binding.resourceType === 'context')
          ?.providerUid
      ).toBe(recreatedUid)
      expect(recreatedPaths.map(path => path.selectedPath.id)).not.toContain(oldContextPathId)
      await expect(
        resolveLiveActionAuthorization(
          { session, ...contextAction(), requestedAccessPathId: oldContextPathId },
          { gateway }
        )
      ).resolves.toEqual(expect.objectContaining({ status: 'access_path_stale' }))
    } finally {
      await databasePool.query(
        `DELETE FROM user_contexts WHERE user_id = $1 AND context_id = ANY($2::text[])`,
        [userId, [contextAlias, nextContextAlias]]
      )
      await databasePool.query(`DELETE FROM user_agents WHERE user_id = $1 AND agent_name = $2`, [
        userId,
        hostName,
      ])
      kubernetesApi.delete('hosts', config.hostsNamespace, hostName)
      kubernetesApi.delete('contexts', config.contextsNamespace, contextName)
      kubernetesApi.delete('contexts', config.contextsNamespace, duplicateAliasName)
      kubernetesApi.delete('contexts', config.contextsNamespace, contextAlias)
      kubernetesApi.delete(mcpObject.plural, mcpObject.namespace, mcpName)
      kubernetesApi.delete(
        sharedFilesystemObject.plural,
        sharedFilesystemObject.namespace,
        sharedFilesystemName
      )
    }
  })

  it('excludes an ineligible sibling Host from selected MCP paths', async () => {
    const baseline = await allowedPaths(mcpRead)
    const beforeSibling = baseline
      .map(path => JSON.stringify(path.selectedPath.behavior.runtime))
      .sort()
    const baselineIds = new Set(baseline.map(path => path.selectedPath.id))
    const disabledHost = fixture({
      plural: 'hosts',
      namespace: config.hostsNamespace,
      name: 'disabled-catalog-host',
      uid: 'disabled-catalog-host-uid',
      spec: { enabled: false, contextRef: 'catalog-context' },
    })
    kubernetesApi.put(disabledHost.plural, disabledHost.namespace, disabledHost.object)
    await databasePool.query(
      `INSERT INTO user_agents(user_id, agent_name) VALUES ($1, 'disabled-catalog-host')`,
      [userId]
    )
    try {
      // Witness: the disabled Host projects a uses_context edge to the Context.
      expect(
        projectedRelationships(disabledHost).filter(
          relationship => relationship.relationshipType === 'uses_context'
        )
      ).toHaveLength(1)
      // The disabled Host's grant may be offered as a path, but it never
      // authorizes: its exact read finds the Host disabled. Every other path
      // keeps its behavior.
      const offered = await resolveLiveActionAuthorization({ session, ...mcpRead }, { gateway })
      expect(offered.status, JSON.stringify(offered)).toBe('access_path_required')
      if (offered.status !== 'access_path_required') return
      const eligible: Allowed[] = []
      let ineligible = 0
      for (const descriptor of offered.safePathDescriptors) {
        const explicit = await resolveLiveActionAuthorization(
          { session, ...mcpRead, requestedAccessPathId: descriptor.id },
          { gateway }
        )
        if (explicit.status === 'allowed') {
          eligible.push(explicit)
        } else {
          expect(explicit).toEqual({ status: 'not_found', code: 'not_found' })
          expect(baselineIds.has(descriptor.id)).toBe(false)
          ineligible += 1
        }
      }
      expect(ineligible).toBe(1)
      expect(
        eligible.map(path => JSON.stringify(path.selectedPath.behavior.runtime)).sort()
      ).toEqual(beforeSibling)
    } finally {
      await databasePool.query(
        `DELETE FROM user_agents WHERE user_id = $1 AND agent_name = 'disabled-catalog-host'`,
        [userId]
      )
      kubernetesApi.delete(disabledHost.plural, disabledHost.namespace, 'disabled-catalog-host')
    }
  })

  it('keeps a selected MCP path available when its Context has a dangling sibling mount', async () => {
    const contextName = `catalog-context-dangling-sibling-${randomBytes(5).toString('hex')}`
    const missingFilesystemName = `catalog-filesystem-missing-${randomBytes(5).toString('hex')}`
    const baselinePathCount = (await allowedPaths(mcpRead)).length
    const siblingContext = fixture({
      plural: 'contexts',
      namespace: config.contextsNamespace,
      name: contextName,
      uid: randomUUID(),
      spec: {
        mcpServers: ['catalog-mcp'],
        sharedFileSystems: [{ name: missingFilesystemName, mountPath: '/workspace/unrelated' }],
      },
    })
    kubernetesApi.put(siblingContext.plural, siblingContext.namespace, siblingContext.object)
    await databasePool.query(`INSERT INTO user_contexts(user_id, context_id) VALUES ($1, $2)`, [
      userId,
      contextName,
    ])
    try {
      // Witness: the sibling mounts a filesystem that does not exist.
      expect(
        projectedRelationships(siblingContext).filter(
          relationship => relationship.relationshipType === 'mounts_shared_filesystem'
        )
      ).toHaveLength(1)
      await expect(
        gateway.getResourceExact(
          'sharedfilesystems',
          missingFilesystemName,
          config.sharedFilesystemsNamespace,
          { timeoutSeconds: 5, signal: new AbortController().signal }
        )
      ).rejects.toThrow('not found')
      expect(await allowedPaths(mcpRead)).toHaveLength(baselinePathCount + 1)
    } finally {
      await databasePool.query(`DELETE FROM user_contexts WHERE user_id = $1 AND context_id = $2`, [
        userId,
        contextName,
      ])
      kubernetesApi.delete(siblingContext.plural, siblingContext.namespace, contextName)
    }
  })

  it('publishes only the relationships the caller reaches through its own paths', async () => {
    const suffix = randomBytes(5).toString('hex')
    const foreignTeamId = randomUUID()
    const foreignContextName = `i7-foreign-context-${suffix}`
    const foreignHostName = `i7-foreign-host-${suffix}`
    const unownedHostName = `i7-unowned-host-${suffix}`
    const foreignContextId = `${config.contextsNamespace}/${foreignContextName}`
    const mcpLogicalId = `${config.mcpServersNamespace}/catalog-mcp`
    const contextLogicalId = `${config.contextsNamespace}/catalog-context`
    const foreignContext = fixture({
      plural: 'contexts',
      namespace: config.contextsNamespace,
      name: foreignContextName,
      uid: randomUUID(),
      spec: {
        mcpServers: ['catalog-mcp'],
        sharedFileSystems: [{ name: 'catalog-files', mountPath: '/workspace/foreign' }],
      },
    })
    const foreignHost = fixture({
      plural: 'hosts',
      namespace: config.hostsNamespace,
      name: foreignHostName,
      uid: randomUUID(),
      spec: { contextRef: foreignContextName },
    })
    const unownedHost = fixture({
      plural: 'hosts',
      namespace: config.hostsNamespace,
      name: unownedHostName,
      uid: randomUUID(),
      spec: { contextRef: 'catalog-context' },
    })
    const edge = (
      value: OperationalFixture,
      relationshipType: string,
      targetId: string,
      mountPath?: string
    ): string => {
      const matches = projectedRelationships(value).filter(
        relationship =>
          relationship.relationshipType === relationshipType &&
          relationship.targetId === targetId &&
          (mountPath === undefined || relationship.behaviorAttributes.mountPath === mountPath)
      )
      expect(matches).toHaveLength(1)
      return matches[0]!.relationshipInstanceId
    }
    const pathInstances = (paths: readonly Allowed[]) =>
      new Set(
        paths.flatMap(path =>
          path.operationalBindings.flatMap(binding =>
            binding.relationships.map(relationship => relationship.instanceId)
          )
        )
      )

    kubernetesApi.put(foreignContext.plural, foreignContext.namespace, foreignContext.object)
    kubernetesApi.put(foreignHost.plural, foreignHost.namespace, foreignHost.object)
    kubernetesApi.put(unownedHost.plural, unownedHost.namespace, unownedHost.object)
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'I7 Foreign Team')`, [
      foreignTeamId,
    ])
    await databasePool.query(`INSERT INTO team_contexts(team_id, context_id) VALUES ($1, $2)`, [
      foreignTeamId,
      foreignContextName,
    ])
    await databasePool.query(`INSERT INTO team_agents(team_id, agent_name) VALUES ($1, $2)`, [
      foreignTeamId,
      foreignHostName,
    ])

    try {
      const sharedFilesystemLogicalId = `${config.sharedFilesystemsNamespace}/catalog-files`
      const ownMcpEdge = edge(originalOf('contexts'), 'includes_mcp_server', mcpLogicalId)
      const ownHostEdge = edge(originalOf('hosts'), 'uses_context', contextLogicalId)
      const ownMountA = edge(
        originalOf('contexts'),
        'mounts_shared_filesystem',
        sharedFilesystemLogicalId,
        '/workspace/a'
      )
      const ownMountB = edge(
        originalOf('contexts'),
        'mounts_shared_filesystem',
        sharedFilesystemLogicalId,
        '/workspace/b'
      )
      const foreignMcpEdge = edge(foreignContext, 'includes_mcp_server', mcpLogicalId)
      const foreignHostEdge = edge(foreignHost, 'uses_context', foreignContextId)
      const foreignMountEdge = edge(
        foreignContext,
        'mounts_shared_filesystem',
        sharedFilesystemLogicalId,
        '/workspace/foreign'
      )
      const unownedHostEdge = edge(unownedHost, 'uses_context', contextLogicalId)
      expect(
        new Set([ownMcpEdge, ownHostEdge, ownMountA, ownMountB, foreignMcpEdge, foreignHostEdge])
          .size
      ).toBe(6)

      const mcpInstances = pathInstances(await allowedPaths(mcpRead))
      expect(mcpInstances).toContain(ownMcpEdge)
      expect(mcpInstances).toContain(ownHostEdge)
      expect(mcpInstances).not.toContain(foreignMcpEdge)
      expect(mcpInstances).not.toContain(foreignHostEdge)
      expect(mcpInstances).not.toContain(unownedHostEdge)

      const filesystemInstances = new Set<string>()
      for (const [mountId, mountPath] of [
        [ownMountA, '/workspace/a'],
        [ownMountB, '/workspace/b'],
      ] as const) {
        const paths = await allowedPaths({
          operationId: 'shared_filesystem.read',
          resource: canonicalResourceIdentity({
            environmentId,
            type: 'shared_filesystem',
            logicalId: sharedFilesystemLogicalId,
          }),
          operationTarget: {
            sharedFileSystemNamespace: config.sharedFilesystemsNamespace,
            sharedFileSystemName: 'catalog-files',
            relationshipInstanceId: mountId,
            canonicalRelativePath: `reports${mountPath}`,
          },
        })
        for (const instance of pathInstances(paths)) filesystemInstances.add(instance)
      }
      expect(filesystemInstances).toContain(ownMountA)
      expect(filesystemInstances).toContain(ownMountB)
      expect(filesystemInstances).not.toContain(foreignMountEdge)

      const contextInstances = pathInstances(
        await allowedPaths({
          operationId: 'context.use',
          resource: canonicalResourceIdentity({
            environmentId,
            type: 'context',
            logicalId: contextLogicalId,
          }),
          operationTarget: {
            contextNamespace: config.contextsNamespace,
            contextName: 'catalog-context',
            action: 'use',
          },
        })
      )
      expect(contextInstances).toContain(ownMcpEdge)
      expect(contextInstances).toContain(ownMountA)
      expect(contextInstances).not.toContain(unownedHostEdge)

      // Joining the foreign team adds its path, and only then its edges.
      await databasePool.query(
        `INSERT INTO team_members(team_id, user_id, role, status)
         VALUES ($1, $2, 'member', 'active')`,
        [foreignTeamId, userId]
      )
      const joinedInstances = pathInstances(await allowedPaths(mcpRead))
      expect(joinedInstances).toContain(foreignMcpEdge)
      expect(joinedInstances).toContain(foreignHostEdge)
    } finally {
      await databasePool.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
        foreignTeamId,
        userId,
      ])
      await databasePool.query(`DELETE FROM team_contexts WHERE team_id = $1`, [foreignTeamId])
      await databasePool.query(`DELETE FROM team_agents WHERE team_id = $1`, [foreignTeamId])
      await databasePool.query(`DELETE FROM teams WHERE id = $1`, [foreignTeamId])
      kubernetesApi.delete(unownedHost.plural, unownedHost.namespace, unownedHostName)
      kubernetesApi.delete(foreignHost.plural, foreignHost.namespace, foreignHostName)
      kubernetesApi.delete(foreignContext.plural, foreignContext.namespace, foreignContextName)
    }
  })

  it('fails a Host closed when its configured Context does not resolve', async () => {
    const suffix = randomBytes(5).toString('hex')
    const unresolvedHostName = `i7-unresolved-host-${suffix}`
    const ambiguousContextName = `i7-amb-context-${suffix}`
    const ambiguousAliasName = `i7-amb-alias-${suffix}`
    const ambiguousHostName = `i7-amb-host-${suffix}`
    const fixtures = [
      fixture({
        plural: 'hosts',
        namespace: config.hostsNamespace,
        name: unresolvedHostName,
        uid: randomUUID(),
        spec: { contextRef: `i7-missing-context-${suffix}` },
      }),
      fixture({
        plural: 'contexts',
        namespace: config.contextsNamespace,
        name: ambiguousContextName,
        uid: randomUUID(),
        spec: { mcpServers: [], sharedFileSystems: [] },
      }),
      fixture({
        plural: 'contexts',
        namespace: config.contextsNamespace,
        name: ambiguousAliasName,
        uid: randomUUID(),
        spec: { contextId: ambiguousContextName, mcpServers: [], sharedFileSystems: [] },
      }),
      fixture({
        plural: 'hosts',
        namespace: config.hostsNamespace,
        name: ambiguousHostName,
        uid: randomUUID(),
        spec: { contextRef: ambiguousContextName },
      }),
    ]
    for (const value of fixtures) kubernetesApi.put(value.plural, value.namespace, value.object)
    await databasePool.query(
      `INSERT INTO user_agents(user_id, agent_name) VALUES ($1, $2), ($1, $3)`,
      [userId, unresolvedHostName, ambiguousHostName]
    )
    try {
      for (const hostName of [unresolvedHostName, ambiguousHostName]) {
        const logicalId = `${config.hostsNamespace}/${hostName}`
        const before = kubernetesApi.requests.length
        await expect(
          resolveLiveActionAuthorization(
            {
              session,
              operationId: 'host.status.read',
              resource: canonicalResourceIdentity({ environmentId, type: 'host', logicalId }),
              operationTarget: { hostRef: logicalId },
            },
            { gateway }
          )
        ).resolves.toEqual({
          status: 'unavailable',
          dependencyClass: 'operational_resource_store',
          retryable: true,
        })
        // Witness: the Host graph was read live and no exact GET followed.
        const reads = kubernetesApi.requests.slice(before)
        expect(reads.some(item => item.plural === 'contexts' && item.name === null)).toBe(true)
        expect(reads.filter(item => item.name !== null).map(item => item.name)).toEqual([hostName])
      }
      // The resolvable Host keeps every path.
      expect((await allowedPaths(hostChat)).length).toBeGreaterThan(0)
    } finally {
      await databasePool.query(
        `DELETE FROM user_agents WHERE user_id = $1 AND agent_name = ANY($2::text[])`,
        [userId, [unresolvedHostName, ambiguousHostName]]
      )
      for (const value of fixtures) {
        kubernetesApi.delete(
          value.plural,
          value.namespace,
          String((value.object.metadata as Record<string, unknown>).name)
        )
      }
    }
  })

  it('binds producer-backed runtime actions to complete source-derived behavior', async () => {
    const operations = [
      {
        request: hostChat,
        actionTarget: {
          hostRef,
          channelType: 'rpc',
          channelId: 'catalog-host',
        },
        allocateChatMessageId: true,
      },
      {
        request: {
          operationId: 'mcp.invoke' as const,
          resource: mcpResource,
          operationTarget: {
            serverNamespace: config.mcpServersNamespace,
            serverName: 'catalog-mcp',
            toolName: 'lookup',
          },
        },
        actionTarget: {
          serverNamespace: config.mcpServersNamespace,
          serverName: 'catalog-mcp',
          toolName: 'lookup',
        },
        allocateChatMessageId: false,
      },
      {
        request: recipeTrigger,
        actionTarget: { recipeNamespace: config.sandboxNamespace, recipeName: 'catalog-recipe' },
        allocateChatMessageId: false,
      },
      {
        request: {
          operationId: 'context.use' as const,
          resource: canonicalResourceIdentity({
            environmentId,
            type: 'context',
            logicalId: `${config.contextsNamespace}/catalog-context`,
          }),
          operationTarget: {
            contextNamespace: config.contextsNamespace,
            contextName: 'catalog-context',
            action: 'use',
          },
        },
        actionTarget: {
          contextNamespace: config.contextsNamespace,
          contextName: 'catalog-context',
          action: 'use',
        },
        allocateChatMessageId: false,
      },
    ]
    const outcomes: Array<{ operationId: string; accessPathId: string; status: string }> = []
    for (const operation of operations) {
      const produced = await resolveLiveActionAuthorization(
        { session, ...operation.request },
        { gateway }
      )
      const accessPathIds =
        produced.status === 'allowed'
          ? [produced.selectedPath.id]
          : produced.status === 'access_path_required'
            ? produced.safePathDescriptors.map(path => path.id)
            : []
      expect(
        accessPathIds,
        `${operation.request.operationId}: ${JSON.stringify(produced)}`
      ).not.toHaveLength(0)
      for (const requestedAccessPathId of accessPathIds) {
        const authorized = await authorizeActionV2(
          {
            session,
            requested: { version: 2, requestedAccessPathId },
            operationId: operation.request.operationId,
            resource: operation.request.resource,
            operationTarget: operation.actionTarget,
            allocateChatMessageId: operation.allocateChatMessageId,
            gateway,
          },
          { messageId: () => '00000000-0000-4000-8000-000000000001' }
        )
        outcomes.push({
          operationId: operation.request.operationId,
          accessPathId: requestedAccessPathId,
          status: authorized.status,
        })
      }
    }
    expect(outcomes.length).toBeGreaterThanOrEqual(operations.length)
    expect(outcomes).toEqual(outcomes.map(outcome => ({ ...outcome, status: 'allowed' })))

    const manageDenied = await authorizeActionV2({
      session,
      requested: { version: 2 },
      operationId: 'context.manage',
      resource: canonicalResourceIdentity({
        environmentId,
        type: 'context',
        logicalId: `${config.contextsNamespace}/catalog-context`,
      }),
      operationTarget: {
        contextNamespace: config.contextsNamespace,
        contextName: 'catalog-context',
        action: 'manage',
      },
      allocateChatMessageId: false,
      gateway,
    })
    expect(manageDenied).toEqual({ status: 'denied', code: 'forbidden' })
  })

  it('authorizes chat and session actions through Host grants without changing signed resource identity', async () => {
    const actionSession = await v2Session(userId)
    const directPath = (await allowedPaths(hostChat, actionSession)).find(
      path => path.selectedPath.kind === 'direct'
    )
    expect(directPath, 'producer-backed direct Host grant').toBeDefined()

    const mismatchedAncestry = await resolveLiveActionAuthorization(
      {
        session: actionSession,
        operationId: 'chat.read',
        resource: canonicalResourceIdentity({ environmentId, type: 'chat', logicalId: 'chat-a' }),
        authorizationResource: canonicalResourceIdentity({
          environmentId,
          type: 'host',
          logicalId: `${config.hostsNamespace}/other-host`,
        }),
        operationTarget: { hostRef, agent: 'main', chatId: 'chat-a' },
      },
      {
        transaction: async () => {
          throw new Error('mismatched ancestry must not reach PostgreSQL')
        },
      }
    )
    expect(mismatchedAncestry).toEqual({ status: 'invalid', code: 'invalid_resource' })

    const actions = [
      {
        operationId: 'chat.read' as const,
        resource: canonicalResourceIdentity({ environmentId, type: 'chat', logicalId: 'chat-a' }),
        target: { hostRef, agent: 'main', chatId: 'chat-a' },
      },
      {
        operationId: 'task.read' as const,
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'runtime_session',
          logicalId: 'task-a',
        }),
        target: { hostRef, taskId: 'task-a' },
      },
      {
        operationId: 'task.manage' as const,
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'runtime_session',
          logicalId: 'task-a',
        }),
        target: { hostRef, taskId: 'task-a', action: 'cancel' },
      },
      {
        operationId: 'model.read' as const,
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'runtime_session',
          logicalId: 'session-a',
        }),
        target: { hostRef, agent: 'main', chatId: 'chat-a' },
      },
      {
        operationId: 'model.select' as const,
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'runtime_session',
          logicalId: 'session-a',
        }),
        target: {
          hostRef,
          agent: 'main',
          chatId: 'chat-a',
          provider: 'openai',
          model: 'test-model',
        },
      },
      {
        operationId: 'session.read' as const,
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'runtime_session',
          logicalId: 'session-a',
        }),
        target: { hostRef },
      },
      {
        operationId: 'session.manage' as const,
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'runtime_session',
          logicalId: 'session-a',
        }),
        target: { hostRef, agent: 'main', chatId: 'chat-a', action: 'delete' },
      },
    ]
    for (const action of actions) {
      const result = await authorizeActionV2({
        session: actionSession,
        requested: { version: 2, requestedAccessPathId: directPath!.selectedPath.id },
        operationId: action.operationId,
        resource: action.resource,
        operationTarget: action.target,
        allocateChatMessageId: false,
        gateway,
      })
      expect(result.status, action.operationId).toBe('allowed')
      if (result.status === 'allowed') {
        expect(result.context.resource).toEqual(action.resource)
        expect(result.context.target).toEqual(action.target)
      }
    }

    await databasePool.query(
      `UPDATE external_user_sessions SET revoked_at = NOW() WHERE sid = $1`,
      [actionSession.sid]
    )
    const revoked = await authorizeActionV2({
      session: actionSession,
      requested: { version: 2, requestedAccessPathId: directPath!.selectedPath.id },
      operationId: 'chat.read',
      resource: canonicalResourceIdentity({ environmentId, type: 'chat', logicalId: 'chat-a' }),
      operationTarget: { hostRef, agent: 'main', chatId: 'chat-a' },
      allocateChatMessageId: false,
      gateway,
    })
    expect(revoked).toEqual({ status: 'denied', code: 'session_not_live' })

    const ungrantedUserId = randomUUID()
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Un-granted Action User')`,
      [ungrantedUserId, `${ungrantedUserId}@example.test`]
    )
    const ungranted = await authorizeActionV2({
      session: await v2Session(ungrantedUserId),
      requested: { version: 2 },
      operationId: 'chat.read',
      resource: canonicalResourceIdentity({ environmentId, type: 'chat', logicalId: 'chat-a' }),
      operationTarget: { hostRef, agent: 'main', chatId: 'chat-a' },
      allocateChatMessageId: false,
      gateway,
    })
    expect(ungranted.status).toBe('not_found')
  })

  it('binds applicable budget policy but not mutable reservation consumption', async () => {
    const readPaths = async () => {
      const paths = pathBehaviors(await allowedPaths(hostChat))
      return {
        direct: paths.filter(path => path.kind === 'direct'),
        team: paths.filter(path => path.kind === 'team'),
      }
    }
    const before = await readPaths()
    expect(before.direct).toHaveLength(1)
    expect(before.team).toHaveLength(1)
    const budget = await databasePool.query<{ id: string }>(
      `INSERT INTO token_budgets
         (name, scope, unit, limit_amount, period, timezone,
          min_start_amount, enforcement)
       VALUES ($1, $2::jsonb, 'tokens', 1000, 'monthly', 'UTC', 0, 'block')
       RETURNING id`,
      [
        `r31-policy-${randomUUID()}`,
        JSON.stringify({ team_id: [teamId], host_ref: ['catalog-host'] }),
      ]
    )
    const budgetId = budget.rows[0]!.id
    try {
      __resetBudgetCheckCache()
      const canonicalCheck = await evaluateBudgetCheck(
        {
          host_ref: 'catalog-host',
          context_ref: 'catalog-context',
          team_id: null,
          user_id: userId,
          provider: 'openai',
          model: 'gpt-4o',
          llm_secret_name: null,
          source_kind: 'channel',
          recipe_name: null,
          cron_job_id: null,
          task_ref: null,
        },
        databasePool
      )
      expect(canonicalCheck.matched?.map(value => value.id)).toContain(budgetId)

      const withPolicy = await readPaths()
      expect(withPolicy.direct.map(path => path.behavior.budget)).not.toEqual(
        before.direct.map(path => path.behavior.budget)
      )
      expect(withPolicy.team.map(path => path.behavior.budget)).not.toEqual(
        before.team.map(path => path.behavior.budget)
      )
      expect(withPolicy.team.map(path => path.id)).not.toEqual(before.team.map(path => path.id))

      await databasePool.query(
        `INSERT INTO budget_pending_reservations(budget_id, est_amount, host_ref, expires_at)
         VALUES ($1, 5, 'catalog-host', NOW() + INTERVAL '1 hour')`,
        [budgetId]
      )
      expect(await readPaths()).toEqual(withPolicy)

      await databasePool.query(
        `DELETE FROM team_contexts WHERE team_id = $1 AND context_id = 'catalog-context'`,
        [teamId]
      )
      const afterContextTeamRemoval = await readPaths()
      expect(afterContextTeamRemoval.direct.map(path => path.behavior.budget)).toEqual(
        before.direct.map(path => path.behavior.budget)
      )
      await databasePool.query(
        `INSERT INTO team_contexts(team_id, context_id) VALUES ($1, 'catalog-context')`,
        [teamId]
      )
      const afterContextTeamRestore = await readPaths()
      expect(afterContextTeamRestore.direct.map(path => path.behavior.budget)).toEqual(
        withPolicy.direct.map(path => path.behavior.budget)
      )

      await databasePool.query(`UPDATE token_budgets SET scope = $2::jsonb WHERE id = $1`, [
        budgetId,
        JSON.stringify({ team_id: [randomUUID()], host_ref: ['catalog-host'] }),
      ])
      const afterPolicyMutation = await readPaths()
      expect(afterPolicyMutation.direct.map(path => path.behavior.budget)).toEqual(
        before.direct.map(path => path.behavior.budget)
      )
      expect(afterPolicyMutation.team.map(path => path.behavior.budget)).toEqual(
        before.team.map(path => path.behavior.budget)
      )
    } finally {
      await databasePool.query(`DELETE FROM token_budgets WHERE id = $1`, [budgetId])
    }
  })

  it('binds legacy malformed provider/model scopes using the canonical budget matcher', async () => {
    const readBudgetDescriptors = async () =>
      pathBehaviors(await allowedPaths(hostChat)).map(path => path.behavior.budget)
    const legacyScopes: ReadonlyArray<Readonly<{ label: string; scope: Record<string, unknown> }>> =
      [
        { label: 'empty-provider', scope: { host_ref: ['catalog-host'], provider: [] } },
        { label: 'empty-model', scope: { host_ref: ['catalog-host'], model: [] } },
        { label: 'non-array-provider', scope: { host_ref: ['catalog-host'], provider: 'openai' } },
        { label: 'non-array-model', scope: { host_ref: ['catalog-host'], model: 'test-model' } },
      ]
    for (const legacyScope of legacyScopes) {
      const before = await readBudgetDescriptors()
      const budget = await databasePool.query<{ id: string }>(
        `INSERT INTO token_budgets
           (name, scope, unit, limit_amount, period, timezone,
            min_start_amount, enforcement)
         VALUES ($1, $2::jsonb, 'tokens', 1000, 'monthly', 'UTC', 0, 'block')
         RETURNING id`,
        [`r31-${legacyScope.label}-${randomUUID()}`, JSON.stringify(legacyScope.scope)]
      )
      const budgetId = budget.rows[0]!.id
      try {
        __resetBudgetCheckCache()
        const canonicalCheck = await evaluateBudgetCheck(
          {
            host_ref: 'catalog-host',
            context_ref: 'catalog-context',
            team_id: null,
            user_id: userId,
            provider: 'openai',
            model: 'test-model',
            llm_secret_name: null,
            source_kind: 'channel',
            recipe_name: null,
            cron_job_id: null,
            task_ref: null,
          },
          databasePool
        )
        expect(canonicalCheck.matched?.map(value => value.id)).toContain(budgetId)
        expect(await readBudgetDescriptors()).not.toEqual(before)
      } finally {
        await databasePool.query(`DELETE FROM token_budgets WHERE id = $1`, [budgetId])
        __resetBudgetCheckCache()
      }
    }
  })

  it('binds workflow budget policy using the exact workflow evaluator dimensions', async () => {
    const readRecipeBudgets = async () =>
      pathBehaviors(await allowedPaths(recipeTrigger)).map(path => ({
        kind: path.kind,
        budget: path.behavior.budget,
      }))
    const evaluateWorkflowBudget = () => {
      __resetBudgetCheckCache()
      return evaluateBudgetCheck(
        {
          host_ref: `${config.sandboxNamespace}/catalog-recipe`,
          context_ref: null,
          team_id: teamId,
          user_id: userId,
          provider: 'openai',
          model: 'test-model',
          llm_secret_name: null,
          source_kind: 'workflow',
          recipe_name: 'catalog-recipe',
          cron_job_id: null,
          task_ref: null,
        },
        databasePool
      )
    }
    const insertBudget = async (name: string, scope: Record<string, string[]>) => {
      const result = await databasePool.query<{ id: string }>(
        `INSERT INTO token_budgets
           (name, scope, unit, limit_amount, period, timezone,
            min_start_amount, enforcement)
         VALUES ($1, $2::jsonb, 'tokens', 1000, 'monthly', 'UTC', 0, 'block')
         RETURNING id`,
        [name, JSON.stringify(scope)]
      )
      return result.rows[0]!.id
    }

    const before = await readRecipeBudgets()
    const contextScoped = await insertBudget(`r31-context-${randomUUID()}`, {
      context_ref: ['catalog-context'],
      recipe_name: ['catalog-recipe'],
      source_kind: ['workflow'],
    })
    const cronScoped = await insertBudget(`r31-cron-${randomUUID()}`, {
      recipe_name: ['catalog-recipe'],
      source_kind: ['cron'],
    })
    const workflowScoped = await insertBudget(`r31-workflow-${randomUUID()}`, {
      host_ref: [`${config.sandboxNamespace}/catalog-recipe`],
      recipe_name: ['catalog-recipe'],
      source_kind: ['workflow'],
    })
    try {
      const workflowCheck = await evaluateWorkflowBudget()
      const beforeMatchedIds = workflowCheck.matched?.map(value => value.id) ?? []
      expect(beforeMatchedIds).not.toContain(contextScoped)
      expect(beforeMatchedIds).not.toContain(cronScoped)
      expect(beforeMatchedIds, JSON.stringify(workflowCheck)).toContain(workflowScoped)
      expect(await readRecipeBudgets()).not.toEqual(before)
    } finally {
      await databasePool.query(`DELETE FROM token_budgets WHERE id = ANY($1::uuid[])`, [
        [contextScoped, cronScoped, workflowScoped],
      ])
    }
  })

  it('invalidates a Host path when its credential, approval, or model policy changes', async () => {
    const originalHost = originalOf('hosts')
    const baseline = pathBehaviors(await allowedPaths(hostChat))
    const originalMetadata = originalHost.object.metadata as Record<string, unknown>
    const originalSpec = originalHost.object.spec as Record<string, unknown>
    const changes = [
      { secretRef: 'changed-host-secret' },
      {
        approval: {
          defaultPolicy: 'designated_approvers',
          channels: { telegram: { enabled: true } },
        },
      },
      { model: { provider: 'openai', name: 'different-model' } },
    ]
    try {
      for (const [index, change] of changes.entries()) {
        kubernetesApi.put(originalHost.plural, originalHost.namespace, {
          ...originalHost.object,
          metadata: { ...originalMetadata, resourceVersion: String(index + 2) },
          spec: { ...originalSpec, ...change },
        })
        const changed = pathBehaviors(await allowedPaths(hostChat))
        expect(changed.map(path => path.id)).not.toEqual(baseline.map(path => path.id))
        expect(changed.map(path => JSON.stringify(path.behavior)).sort()).not.toEqual(
          baseline.map(path => JSON.stringify(path.behavior)).sort()
        )

        kubernetesApi.put(originalHost.plural, originalHost.namespace, originalHost.object)
        expect(behaviorSet(await allowedPaths(hostChat))).toEqual(
          baseline.map(path => JSON.stringify(path.behavior)).sort()
        )
      }
    } finally {
      kubernetesApi.put(originalHost.plural, originalHost.namespace, originalHost.object)
    }
  })

  it('binds a complete empty Host provider allow policy instead of treating it as absent', async () => {
    const originalHost = originalOf('hosts')
    const originalMetadata = originalHost.object.metadata as Record<string, unknown>
    const withoutModel = { ...(originalHost.object.spec as Record<string, unknown>) }
    delete withoutModel.model
    try {
      kubernetesApi.put(originalHost.plural, originalHost.namespace, {
        ...originalHost.object,
        metadata: { ...originalMetadata, resourceVersion: 'empty-model-policy' },
        spec: withoutModel,
      })
      await databasePool.query(
        `UPDATE llm_allowed_models SET enabled = FALSE
          WHERE provider = 'openai' AND model = 'test-model'`
      )
      const paths = await allowedPaths(hostChat)
      expect(paths.length).toBeGreaterThan(0)
      for (const path of paths) {
        expect(path.selectedPath.behavior.providerModelPolicy).toMatchObject({
          state: 'known',
          value: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
        })
      }
    } finally {
      await databasePool.query(
        `UPDATE llm_allowed_models SET enabled = TRUE
          WHERE provider = 'openai' AND model = 'test-model'`
      )
      kubernetesApi.put(originalHost.plural, originalHost.namespace, originalHost.object)
    }
  })

  it('binds derived MCP paths to their selected Context and ignores sibling Contexts', async () => {
    const before = await allowedPaths(mcpRead)
    const unrelated = fixture({
      plural: 'contexts',
      namespace: config.contextsNamespace,
      name: 'unrelated-context',
      uid: 'unrelated-context-uid',
      spec: { mcpServers: ['catalog-mcp'], sharedFileSystems: [] },
    })
    const originalContext = originalOf('contexts')
    const changedContext = {
      ...originalContext.object,
      metadata: {
        ...(originalContext.object.metadata as Record<string, unknown>),
        resourceVersion: '2',
      },
      spec: {
        ...(originalContext.object.spec as Record<string, unknown>),
        sharedFileSystems: [{ name: 'catalog-files', mountPath: '/workspace/changed' }],
      },
    }
    try {
      kubernetesApi.put(unrelated.plural, unrelated.namespace, unrelated.object)
      expect(behaviorSet(await allowedPaths(mcpRead))).toEqual(behaviorSet(before))

      kubernetesApi.put(originalContext.plural, originalContext.namespace, changedContext)
      expect(behaviorSet(await allowedPaths(mcpRead))).not.toEqual(behaviorSet(before))

      kubernetesApi.put(originalContext.plural, originalContext.namespace, originalContext.object)
      expect(behaviorSet(await allowedPaths(mcpRead))).toEqual(behaviorSet(before))
    } finally {
      kubernetesApi.delete(unrelated.plural, unrelated.namespace, 'unrelated-context')
      kubernetesApi.put(originalContext.plural, originalContext.namespace, originalContext.object)
    }
  })

  it('selects a write path when capability selection excludes a read-only sibling', async () => {
    const readPaths = await allowedPaths(gfsRead)
    const directPath = readPaths.find(path => path.selectedPath.kind === 'direct')
    const teamPath = readPaths.find(path => path.selectedPath.kind === 'team')
    expect(directPath?.selectedPath.behavior.capabilities).toContain('gfs.write')
    expect(teamPath?.selectedPath.behavior.capabilities).not.toContain('gfs.write')
    const write = (requestedAccessPathId?: string) =>
      resolveLiveActionAuthorization(
        {
          session,
          operationId: 'gfs.write',
          resource: gfsRead.resource,
          operationTarget: { drive: 'catalog-drive', resourceId: gfsResourceId, action: 'update' },
          ...(requestedAccessPathId ? { requestedAccessPathId } : {}),
        },
        { gateway }
      )

    await expect(write(directPath!.selectedPath.id)).resolves.toEqual(
      expect.objectContaining({
        status: 'allowed',
        selectedPath: expect.objectContaining({ id: directPath!.selectedPath.id }),
      })
    )
    await expect(write(teamPath!.selectedPath.id)).resolves.toEqual(
      expect.objectContaining({ status: 'access_path_stale', code: 'access_path_stale' })
    )
    await expect(
      resolveLiveActionAuthorization(
        {
          session,
          operationId: 'gfs.delete',
          resource: gfsRead.resource,
          operationTarget: { drive: 'catalog-drive', resourceId: gfsResourceId },
        },
        { gateway }
      )
    ).resolves.toEqual({ status: 'denied', code: 'forbidden' })
  })

  it('preserves both direct/team provenance across duplicate filesystem mounts', async () => {
    const scopes = new Set<string>()
    const ids = new Set<string>()
    for (const mountId of mountIds()) {
      const paths = await allowedPaths({
        operationId: 'shared_filesystem.read',
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'shared_filesystem',
          logicalId: `${config.sharedFilesystemsNamespace}/catalog-files`,
        }),
        operationTarget: {
          sharedFileSystemNamespace: config.sharedFilesystemsNamespace,
          sharedFileSystemName: 'catalog-files',
          relationshipInstanceId: mountId,
          canonicalRelativePath: 'reports',
        },
      })
      // Each mount carries its own direct and team path; both mounts' paths
      // are offered for a mount-specific target.
      expect(paths.map(path => path.selectedPath.kind).sort()).toEqual([
        'direct',
        'direct',
        'team',
        'team',
      ])
      for (const path of paths) {
        ids.add(path.selectedPath.id)
        scopes.add(JSON.stringify(path.selectedPath.behavior.filesystemScope))
      }
    }
    expect(ids.size).toBe(4)
    expect(scopes.size).toBe(2)
  })

  it('reaches a team-only Host and revokes it live without replacing the user session', async () => {
    const teamOnlyUserId = randomUUID()
    const teamOnlyTeamId = randomUUID()
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Team-only Action User')`,
      [teamOnlyUserId, `${teamOnlyUserId}@example.test`]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Team-only Action Team')`, [
      teamOnlyTeamId,
    ])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [teamOnlyTeamId, teamOnlyUserId]
    )
    await databasePool.query(
      `INSERT INTO team_agents(team_id, agent_name) VALUES ($1, 'catalog-host')`,
      [teamOnlyTeamId]
    )
    const teamOnlySession = await v2Session(teamOnlyUserId)
    const paths = await allowedPaths(hostChat, teamOnlySession)
    expect(
      paths.map(path => ({ kind: path.selectedPath.kind, teamId: path.selectedPath.teamId }))
    ).toEqual([{ kind: 'team', teamId: teamOnlyTeamId }])
    const teamPathId = paths[0]!.selectedPath.id

    await databasePool.query(
      `UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`,
      [teamOnlyTeamId, teamOnlyUserId]
    )
    await expect(
      resolveLiveActionAuthorization(
        { session: teamOnlySession, ...hostChat, requestedAccessPathId: teamPathId },
        { gateway }
      )
    ).resolves.toEqual(expect.objectContaining({ status: 'not_found', code: 'not_found' }))
  })

  it('uses real Kubernetes list and exact-read wire boundaries', async () => {
    const before = kubernetesApi.requests.length
    const paths = await allowedPaths(recipeTrigger)
    expect(paths.length).toBeGreaterThan(0)
    const reads = kubernetesApi.requests.slice(before)
    const lists = reads.filter(item => item.name === null)
    const exact = reads.filter(item => item.name !== null)
    expect(lists.length).toBeGreaterThan(0)
    expect(exact.length).toBeGreaterThan(0)
    for (const item of reads) {
      expect(item.method).toBe('GET')
      expect(item.watch).toBe(false)
      // Quorum reads only (merge plan v2 §10 L7): no resourceVersion is sent.
      expect(item.resourceVersion).toBeNull()
    }
    for (const item of lists) {
      // Paged and namespaced: every LIST names its family namespace and a limit.
      expect(item.limit).toBe('100')
      expect(item.namespace).toBe(
        {
          contexts: config.contextsNamespace,
          mcpservers: config.mcpServersNamespace,
          sharedfilesystems: config.sharedFilesystemsNamespace,
          hosts: config.hostsNamespace,
          workflowrecipes: config.sandboxNamespace,
        }[item.plural]
      )
    }
    expect(new Set(exact.map(item => item.plural))).toEqual(
      new Set(['workflowrecipes', 'contexts', 'mcpservers', 'sharedfilesystems'])
    )
  })

  // Partly moved from userAccessRuntimeContract.realPostgres: the resolver runs
  // under the runtime role for a Postgres-only resource in a caller transaction.
  describe('as control_api_runtime', () => {
    const runAsControlApiRuntime = async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
      const client = (await databasePool.connect()) as PoolClient
      try {
        await client.query('BEGIN')
        await client.query('SET LOCAL ROLE control_api_runtime')
        const value = await work(client)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }

    it('reads resolver authority as the runtime role', async () => {
      const observedRoles: string[] = []
      const resolved = await resolveLiveActionAuthorization(
        {
          session,
          ...gfsRead,
          requestedAccessPathId: (await allowedPaths(gfsRead))[0]!.selectedPath.id,
        },
        {
          transaction: work =>
            runAsControlApiRuntime(async db => {
              const result = await work(db)
              const role = await db.query('SELECT current_user AS role')
              observedRoles.push(String((role.rows[0] as { role: unknown }).role))
              return result
            }),
        }
      )
      expect(resolved.status, JSON.stringify(resolved)).toBe('allowed')
      expect(observedRoles).toEqual(['control_api_runtime'])
    })

    it('keeps resolver authority stable across normal session activity', async () => {
      const activitySession = await v2Session(userId)
      const pathId = (await allowedPaths(gfsRead, activitySession))[0]!.selectedPath.id
      const resolve = () =>
        resolveLiveActionAuthorization(
          { session: activitySession, ...gfsRead, requestedAccessPathId: pathId },
          { transaction: runAsControlApiRuntime }
        )
      const first = await resolve()
      expect(first.status).toBe('allowed')

      const idleBefore = await databasePool.query<{ idle_expires_at: Date }>(
        `SELECT idle_expires_at FROM external_user_sessions WHERE sid = $1`,
        [activitySession.sid]
      )
      await databasePool.query(
        `UPDATE external_user_sessions
            SET last_used_at = clock_timestamp(),
                idle_expires_at = LEAST(absolute_expires_at, clock_timestamp() + interval '14 days')
          WHERE sid = $1`,
        [activitySession.sid]
      )
      const idleAfter = await databasePool.query<{ idle_expires_at: Date }>(
        `SELECT idle_expires_at FROM external_user_sessions WHERE sid = $1`,
        [activitySession.sid]
      )
      expect(idleAfter.rows[0]!.idle_expires_at.getTime()).toBeGreaterThan(
        idleBefore.rows[0]!.idle_expires_at.getTime()
      )

      const continued = await resolve()
      expect(continued.status).toBe('allowed')
      if (first.status !== 'allowed' || continued.status !== 'allowed') {
        throw new Error('expected both activity-bound resolutions to be allowed')
      }
      expect(continued.authorizationRevision).toBe(first.authorizationRevision)

      await databasePool.query(
        `UPDATE external_user_sessions
            SET idle_expires_at = clock_timestamp() - interval '1 second'
          WHERE sid = $1`,
        [activitySession.sid]
      )
      await expect(resolve()).resolves.toMatchObject({ status: 'denied', code: 'session_not_live' })
    })
  })

  // Partly moved from finalAuthorityLifecycle.realPostgres: a lifecycle change
  // that commits after admission but before the final snapshot denies the action.
  it('denies an action when retirement commits after admission but before final authority', async () => {
    const principalId = randomUUID()
    const retirementActorId = randomUUID()
    await databasePool.query(
      `INSERT INTO users(id, email, name, lifecycle_state, lifecycle_version)
       VALUES ($1, $2, 'retirement-race', 'active', 1)`,
      [principalId, `${principalId}@example.test`]
    )
    await databasePool.query(
      `INSERT INTO control_admin_users(id, username, password_hash, role, status)
       VALUES ($1, $2, 'c5-final-authority-proof', 'admin', 'active')`,
      [retirementActorId, `c5-final-authority-${retirementActorId}`]
    )
    await databasePool.query(
      `INSERT INTO gfs_desktop_operator_links(
         id, lineage_id, generation, user_id, control_admin_id, state, source, created_by, row_version
       ) VALUES (
         gen_random_uuid(), gen_random_uuid(), 1, $1::uuid, $2::uuid,
         'active', 'initial_setup', $2::uuid, 1
       )`,
      [principalId, retirementActorId]
    )
    await databasePool.query(
      `INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
       VALUES ('catalog-drive', $1, 'user', $2::text, ARRAY['read']::text[])`,
      [gfsResourceId, principalId]
    )
    const principalSession = await v2Session(principalId)
    expect((await allowedPaths(gfsRead, principalSession)).length).toBe(1)

    const started = deferred()
    const release = deferred()
    let snapshotRan = false
    const pending = resolveLiveActionAuthorization(
      { session: principalSession, ...gfsRead },
      {
        transaction: async work => {
          const client = await databasePool.connect()
          try {
            await client.query('BEGIN')
            started.resolve()
            await release.promise
            const result = await work(client as unknown as DbClient)
            snapshotRan = true
            await client.query('COMMIT')
            return result
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          } finally {
            client.release()
          }
        },
      }
    )
    await started.promise
    try {
      await retireDesktopUser(
        { kind: 'control_admin', controlAdminId: retirementActorId },
        principalId,
        'final authority lifecycle race proof',
        `c5-final-authority-${randomUUID()}`,
        `c5-final-authority-request-${randomUUID()}`
      )
    } finally {
      release.resolve()
    }
    await expect(pending).resolves.toEqual({ status: 'denied', code: 'session_not_live' })
    expect(snapshotRan).toBe(true)
  })

  // T-QA (merge plan v2 §5.2, §3.1; v1.7 :1207): two non-equivalent paths to
  // one Host make the delegation route ask for a path, and the selected path
  // header is honoured.
  it('requires an explicit access path for non-equivalent direct and team paths and honours the selection', async () => {
    const issued = await createUserSession(
      { userId, email: `${userId}@example.test`, authenticationMethods: ['pwd'] },
      { db: databasePool as never }
    )
    const app = express()
    app.use(express.json())
    app.use(createExternalRpcDelegationsRouter(gateway))
    const body = {
      version: 2,
      operationId: 'chat.message.invoke',
      resource: { type: 'host', logicalId: hostRef },
      target: { hostRef, channelType: 'rpc', channelId: 'catalog-host' },
    }

    const beforeFirst = kubernetesApi.requests.length
    const first = await request(app)
      .post('/external/rpc/delegations')
      .set('x-user-session-token', issued.token)
      .send(body)
    expect(first.status, first.text).toBe(409)
    expect(first.body).toMatchObject({ error: { code: 'access_path_required' } })
    const descriptors = (first.body.error?.details?.paths ?? []) as Array<{
      id: string
      kind: string
    }>
    expect(descriptors.map(path => path.kind).sort()).toEqual(['direct', 'team'])
    for (const descriptor of descriptors) {
      expect(Object.keys(descriptor).sort()).toEqual(
        descriptor.kind === 'team' ? ['id', 'kind', 'teamId'] : ['id', 'kind']
      )
    }
    // Witness: the first call resolved live.
    expect(kubernetesApi.requests.length).toBeGreaterThan(beforeFirst)

    const team = descriptors.find(path => path.kind === 'team')!
    const beforeSecond = kubernetesApi.requests.length
    const second = await request(app)
      .post('/external/rpc/delegations')
      .set('x-user-session-token', issued.token)
      .set('x-evenfire-access-path-id', team.id)
      .send(body)
    expect(second.status, second.text).toBe(200)
    expect(kubernetesApi.requests.length).toBeGreaterThan(beforeSecond)
    const claims = verifyUserDelegationV2(String(second.body.delegationToken))
    expect(claims).not.toBeNull()
    expect(claims!.accessPathId).toBe(team.id)
    expect(claims!.pathKind).toBe('team')
    expect(claims!.effectiveTeamId).toBe(teamId)
  })
})
