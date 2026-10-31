import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'
import { config } from '../src/config.js'
import { type DbClient, initDb } from '../src/db.js'
import { K8sGateway } from '../src/k8s.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import { createAdminSharedFilesystemsRouter } from '../src/routes/admin/sharedFilesystems.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import {
  checkpointActionAuthority,
  parseActionAuthorityCheckpointRequest,
} from '../src/services/access/actionAuthorityCheckpoint.js'
import { authorizeActionV2 } from '../src/services/access/actionAuthorizer.js'
import { resolveActionDestination } from '../src/services/access/actionDestination.js'
import {
  getActionOperationDefinition,
  selectedPathSupportsActionOperation,
} from '../src/services/access/actionOperationRegistry.js'
import { resolveLiveActionAuthorization } from '../src/services/access/liveAuthorizationResolver.js'
import { OperationalAccessIndex } from '../src/services/access/operationalAccessIndex.js'
import {
  OperationalAccessIndexer,
  operationalSourceSpecs,
} from '../src/services/access/operationalAccessIndexer.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { loadOperationalResourceGraph } from '../src/services/access/operationalAccessReader.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import { createUserSession } from '../src/services/auth/userSessionService.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { TemporaryKubernetesApi } from './helpers/temporaryKubernetesApi.js'
import './realPostgres.requirement.ts'

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

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const
const namespace = config.mcpServersNamespace
const serverName = `r66-read-${randomBytes(4).toString('hex')}`
const contextId = `r66-context-${randomBytes(4).toString('hex')}`
const environmentId = canonicalEnvironmentId()
const userId = randomUUID()
const database = `control_api_mcp_read_binding_${randomBytes(6).toString('hex')}`
const connectionString = databaseUrl(
  adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
  database
)
const resource = canonicalResourceIdentity({
  environmentId,
  type: 'mcp_server',
  logicalId: `${namespace}/${serverName}`,
})
const providerObject = (input: { uid?: string; resourceVersion?: string } = {}) => ({
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'McpServer',
  metadata: {
    name: serverName,
    namespace,
    uid: input.uid ?? `uid-${serverName}`,
    resourceVersion: input.resourceVersion ?? '1',
    generation: 1,
  },
  spec: {
    enabled: true,
    auth: { type: 'none' },
    transport: { type: 'streamable-http', url: `http://${serverName}.${namespace}:3000/mcp` },
  },
})
const server = providerObject()
const context = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'Context',
  metadata: {
    name: contextId,
    namespace: config.contextsNamespace,
    uid: `uid-${contextId}`,
    resourceVersion: '1',
    generation: 1,
  },
  spec: { mcpServers: [serverName], sharedFileSystems: [] },
}

function databaseUrl(baseUrl: string, databaseName: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${databaseName}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function transaction(pool: Pool) {
  return async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
    const client = (await pool.connect()) as PoolClient
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

describeRealPostgres('MCP tools/read destination binding on real producers', () => {
  const kubernetesApi = new TemporaryKubernetesApi()
  let adminPool: Pool | undefined
  let databasePool: Pool | undefined
  let gateway: K8sGateway
  let actionSession: Readonly<{
    contract: 'v2'
    userId: string
    sid: string
    jti: string
    sessionVersion: number
  }>

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    routeTestState.databasePool = databasePool
    await initDb({ connect: () => databasePool!.connect() })

    await databasePool.query(`INSERT INTO users(id, email, name) VALUES ($1, $2, $3)`, [
      userId,
      `${userId}@example.test`,
      'R66 MCP Read Binding User',
    ])
    await databasePool.query(`INSERT INTO user_contexts(user_id, context_id) VALUES ($1, $2)`, [
      userId,
      contextId,
    ])

    await kubernetesApi.start()
    kubernetesApi.put('contexts', config.contextsNamespace, context)
    kubernetesApi.put('mcpservers', namespace, server)
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
      environmentId,
      behaviorFingerprintKey: config.sessionJwtPrivateKey,
    })
    for (const source of operationalSourceSpecs) await indexer.reconcileSource(source)

    const issued = await createUserSession(
      { userId, email: `${userId}@example.test`, authenticationMethods: ['password'] },
      { db: databasePool as never }
    )
    actionSession = Object.freeze({
      contract: 'v2',
      userId,
      sid: issued.identity.sid,
      jti: issued.identity.jti,
      sessionVersion: issued.identity.sessionVersion,
    })
  })

  afterEach(() => {
    kubernetesApi.put('mcpservers', namespace, server)
  })

  afterAll(async () => {
    try {
      await kubernetesApi.close()
      if (databasePool) {
        await endPoolAndWaitForClients(databasePool)
        routeTestState.databasePool = null
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
  })

  async function authorize(operationId: 'mcp.tools.read' | 'mcp.invoke') {
    if (!databasePool) throw new Error('realpg_database_not_ready')
    return authorizeActionV2(
      {
        session: actionSession,
        requested: { version: 2 },
        operationId,
        resource,
        operationTarget:
          operationId === 'mcp.tools.read'
            ? { serverNamespace: namespace, serverName }
            : { serverNamespace: namespace, serverName, toolName: 'list-contract' },
        allocateChatMessageId: false,
        gateway,
      },
      { authorizationOptions: { transaction: transaction(databasePool) } }
    )
  }

  function checkpointRequest(
    authorized: Extract<Awaited<ReturnType<typeof authorizeActionV2>>, { status: 'allowed' }>,
    operationId: 'mcp.tools.read' | 'mcp.invoke'
  ) {
    return {
      version: 2 as const,
      principal: {
        sub: actionSession.userId,
        sid: actionSession.sid,
        sessionVersion: actionSession.sessionVersion,
      },
      delegationJti: actionSession.jti,
      resource,
      operationId,
      target: authorized.context.target,
      targetHash: authorized.context.targetHash,
      accessPathId: authorized.context.accessPathId,
      authorizationRevision: authorized.context.authorizationRevision,
      behaviorBindingHash: authorized.context.behaviorBindingHash,
      domain: {
        service: 'rpc-proxy' as const,
        resource,
        targetHash: authorized.context.targetHash,
      },
    }
  }

  async function checkpoint(
    authorized: Extract<Awaited<ReturnType<typeof authorizeActionV2>>, { status: 'allowed' }>,
    operationId: 'mcp.tools.read' | 'mcp.invoke',
    destinationGateway: Pick<K8sGateway, 'getResourceExact'> = gateway
  ) {
    const budget = AccessExecutionBudget.create('action')
    try {
      return await checkpointActionAuthority({
        request: checkpointRequest(authorized, operationId),
        gateway: destinationGateway,
        budget,
      })
    } finally {
      budget.close()
    }
  }

  it('passes a stable non-OAuth MCP tools/read through authorization and checkpoint', async () => {
    const authorized = await authorize('mcp.tools.read')
    expect(authorized.status, JSON.stringify(authorized)).toBe('allowed')
    if (authorized.status !== 'allowed') return

    const checked = await checkpoint(authorized, 'mcp.tools.read')
    expect(checked).toMatchObject({
      status: 'allowed',
      destination: { kind: 'mcp_server', ref: resource.logicalId },
    })
    expect(authorized.mcpServerBinding).toEqual({
      providerUid: server.metadata.uid,
      providerResourceVersion: server.metadata.resourceVersion,
    })
    expect(authorized.context.selectedPathCapabilities).toContain('mcp_server.read')
  })

  it('keeps read and invoke capabilities distinct', () => {
    const readOnlyCapabilities = ['mcp_server.read'] as const
    expect(
      selectedPathSupportsActionOperation(
        getActionOperationDefinition('mcp.tools.read'),
        readOnlyCapabilities
      )
    ).toBe(true)
    expect(
      selectedPathSupportsActionOperation(
        getActionOperationDefinition('mcp.invoke'),
        readOnlyCapabilities
      )
    ).toBe(false)
    expect(getActionOperationDefinition('mcp.tools.read').requiredCapabilities).toEqual([
      'mcp_server.read',
    ])
    expect(getActionOperationDefinition('mcp.invoke').requiredCapabilities).toEqual([
      'mcp_server.use',
    ])
  })

  it('retains MCP invocation binding and checkpoint behavior', async () => {
    const authorized = await authorize('mcp.invoke')
    expect(authorized.status, JSON.stringify(authorized)).toBe('allowed')
    if (authorized.status !== 'allowed') return
    expect(authorized.context.selectedPathCapabilities).toContain('mcp_server.use')
    expect(authorized.mcpServerBinding).toEqual({
      providerUid: server.metadata.uid,
      providerResourceVersion: server.metadata.resourceVersion,
    })
    expect((await checkpoint(authorized, 'mcp.invoke')).status).toBe('allowed')
  })

  it('keeps selected Host actions inside the exact dependency closure of a three-MCP Context', async () => {
    if (!databasePool) throw new Error('realpg_database_not_ready')
    const dependencyHost = `r68-host-${randomBytes(4).toString('hex')}`
    const dependencyContext = `r68-context-${randomBytes(4).toString('hex')}`
    const dependencyFilesystem = `r68-files-${randomBytes(4).toString('hex')}`
    const dependencyServers = [
      `r68-target-${randomBytes(4).toString('hex')}`,
      `r68-sibling-a-${randomBytes(4).toString('hex')}`,
      `r68-sibling-b-${randomBytes(4).toString('hex')}`,
    ]
    const [targetName, siblingA, siblingB] = dependencyServers
    if (!targetName || !siblingA || !siblingB) throw new Error('mcp_fixture_names_missing')

    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway))
    app.use(createAdminSharedFilesystemsRouter(gateway))
    for (const name of dependencyServers) {
      await request(app)
        .post('/admin/mcp-servers')
        .send({
          metadata: { name },
          spec: {
            enabled: true,
            auth: { type: 'none' },
            transport: {
              type: 'streamable-http',
              url: `http://${name}.${namespace}:3000/mcp`,
            },
          },
        })
        .expect(201)
    }
    await request(app)
      .post('/admin/contexts')
      .send({
        metadata: { name: dependencyContext },
        spec: {
          contextId: dependencyContext,
          mcpServers: dependencyServers,
          sharedFileSystems: [],
        },
      })
      .expect(201)
    const hostCreated = await request(app)
      .post('/admin/hosts')
      .send({ metadata: { name: dependencyHost }, spec: { contextRef: dependencyContext } })
    expect(hostCreated.status, hostCreated.text).toBe(201)

    const hostObject = (await gateway.getResource(
      'hosts',
      dependencyHost,
      config.hostsNamespace
    )) as { kind?: string; spec?: { contextRef?: string } }
    let contextObject = (await gateway.getResource(
      'contexts',
      dependencyContext,
      config.contextsNamespace
    )) as {
      kind?: string
      metadata?: Record<string, unknown>
      spec?: {
        mcpServers?: string[]
        sharedFileSystems?: Array<{ name: string; mountPath: string }>
      }
    }
    expect(hostObject).toMatchObject({ kind: 'Host', spec: { contextRef: dependencyContext } })
    expect(contextObject).toMatchObject({
      kind: 'Context',
      spec: { mcpServers: dependencyServers },
    })

    const dependencyUser = randomUUID()
    await databasePool.query(`INSERT INTO users(id, email, name) VALUES ($1, $2, $3)`, [
      dependencyUser,
      `${dependencyUser}@example.test`,
      'R68 selected-action dependency user',
    ])
    await databasePool.query(`INSERT INTO user_agents(user_id, agent_name) VALUES ($1, $2)`, [
      dependencyUser,
      dependencyHost,
    ])
    const dependencySessionRecord = await createUserSession(
      {
        userId: dependencyUser,
        email: `${dependencyUser}@example.test`,
        authenticationMethods: ['password'],
      },
      { db: databasePool as never }
    )
    const dependencySession = Object.freeze({
      contract: 'v2' as const,
      userId: dependencyUser,
      sid: dependencySessionRecord.identity.sid,
      jti: dependencySessionRecord.identity.jti,
      sessionVersion: dependencySessionRecord.identity.sessionVersion,
    })

    const dependencyIndex = new OperationalAccessIndex(databasePool, transaction(databasePool))
    const dependencyIndexer = new OperationalAccessIndexer(gateway, dependencyIndex, {
      environmentId,
      behaviorFingerprintKey: config.sessionJwtPrivateKey,
    })
    for (const source of operationalSourceSpecs) await dependencyIndexer.reconcileSource(source)

    const hostResource = canonicalResourceIdentity({
      environmentId,
      type: 'host',
      logicalId: `${config.hostsNamespace}/${dependencyHost}`,
    })
    const graphBudget = AccessExecutionBudget.create('action')
    try {
      const producerGraph = await loadOperationalResourceGraph({
        db: databasePool,
        budget: graphBudget,
        environmentId,
        resourceType: 'host',
        logicalId: hostResource.logicalId,
      })
      expect(producerGraph.status).toBe('current')
      if (producerGraph.status !== 'current') return
      expect(producerGraph.resources.map(resource => resource.resourceType).sort()).toEqual([
        'context',
        'host',
        'mcp_server',
        'mcp_server',
        'mcp_server',
      ])
    } finally {
      graphBudget.close()
    }

    const beforeFiveBindingReads = kubernetesApi.requests.length
    const fiveBindingAction = await authorizeActionV2(
      {
        session: dependencySession,
        requested: { version: 2 },
        operationId: 'host.status.read',
        resource: hostResource,
        operationTarget: { hostRef: hostResource.logicalId },
        allocateChatMessageId: false,
        gateway,
      },
      { authorizationOptions: { transaction: transaction(databasePool) } }
    )
    expect(fiveBindingAction.status, JSON.stringify(fiveBindingAction)).toBe('allowed')
    const fiveBindingReads = kubernetesApi.requests
      .slice(beforeFiveBindingReads)
      .filter(item => item.method === 'GET' && item.name !== null)
    expect(fiveBindingReads).toHaveLength(2)
    expect(new Set(fiveBindingReads.map(item => item.plural))).toEqual(
      new Set(['hosts', 'contexts'])
    )

    await request(app)
      .post('/admin/shared-filesystems')
      .send({
        name: dependencyFilesystem,
        size: '1Gi',
        accessModes: ['ReadWriteMany'],
        directories: [],
        retainOnDelete: true,
      })
      .expect(201)
    const filesystemObject = (await gateway.getResource(
      'sharedfilesystems',
      dependencyFilesystem,
      config.sharedFilesystemsNamespace
    )) as Record<string, unknown>
    contextObject = {
      ...contextObject,
      spec: {
        ...(contextObject.spec ?? {}),
        sharedFileSystems: [{ name: dependencyFilesystem, mountPath: '/workspace/r68' }],
      },
    }
    kubernetesApi.put('contexts', config.contextsNamespace, contextObject)
    for (const source of operationalSourceSpecs) await dependencyIndexer.reconcileSource(source)

    kubernetesApi.delete('mcpservers', namespace, siblingA)
    kubernetesApi.delete('mcpservers', namespace, siblingB)
    for (const source of operationalSourceSpecs) await dependencyIndexer.reconcileSource(source)

    for (const [operationId, operationTarget] of [
      ['host.status.read', { hostRef: hostResource.logicalId }],
      ['host.health.read', { hostRef: hostResource.logicalId }],
      ['host.activity.read', { hostRef: hostResource.logicalId, visibility: 'caller_path' }],
    ] as const) {
      const beforeHostReads = kubernetesApi.requests.length
      const hostActivity = await authorizeActionV2(
        {
          session: dependencySession,
          requested: { version: 2 },
          operationId,
          resource: hostResource,
          operationTarget,
          allocateChatMessageId: false,
          gateway,
        },
        { authorizationOptions: { transaction: transaction(databasePool) } }
      )
      expect(hostActivity.status, `${operationId}: ${JSON.stringify(hostActivity)}`).toBe('allowed')
      if (hostActivity.status !== 'allowed') return
      const exactReads = kubernetesApi.requests
        .slice(beforeHostReads)
        .filter(item => item.method === 'GET' && item.name !== null)
      expect(new Set(exactReads.map(item => item.plural))).toEqual(
        new Set(['hosts', 'contexts', 'sharedfilesystems'])
      )
      expect(exactReads).toHaveLength(3)
    }

    const authorizeHostStatus = () =>
      authorizeActionV2(
        {
          session: dependencySession,
          requested: { version: 2 },
          operationId: 'host.status.read',
          resource: hostResource,
          operationTarget: { hostRef: hostResource.logicalId },
          allocateChatMessageId: false,
          gateway,
        },
        { authorizationOptions: { transaction: transaction(databasePool!) } }
      )
    const contextIndexRemoval = await databasePool.query(
      `DELETE FROM operational_resource_index
        WHERE environment_id = $1
          AND resource_type = 'context'
          AND logical_id = $2`,
      [environmentId, `${config.contextsNamespace}/${dependencyContext}`]
    )
    expect(contextIndexRemoval.rowCount).toBe(1)
    const beforeIncompleteContextReads = kubernetesApi.requests.length
    expect((await authorizeHostStatus()).status).toBe('authority_unavailable')
    expect(
      kubernetesApi.requests
        .slice(beforeIncompleteContextReads)
        .filter(item => item.method === 'GET' && item.name !== null)
    ).toHaveLength(0)
    const contextSource = operationalSourceSpecs.find(source => source.family === 'context')
    if (!contextSource) throw new Error('context_source_spec_missing')
    await dependencyIndexer.reconcileSource(contextSource)

    const replacedContext = {
      ...contextObject,
      metadata: {
        ...contextObject.metadata,
        resourceVersion: 'replacement-version',
      },
    }
    kubernetesApi.put('contexts', config.contextsNamespace, replacedContext)
    expect((await authorizeHostStatus()).status).not.toBe('allowed')
    kubernetesApi.put('contexts', config.contextsNamespace, contextObject)

    kubernetesApi.delete('contexts', config.contextsNamespace, dependencyContext)
    expect((await authorizeHostStatus()).status).not.toBe('allowed')
    kubernetesApi.put('contexts', config.contextsNamespace, contextObject)

    const targetResource = canonicalResourceIdentity({
      environmentId,
      type: 'mcp_server',
      logicalId: `${namespace}/${targetName}`,
    })
    const beforeRequests = kubernetesApi.requests.length
    const authorizeTarget = () =>
      authorizeActionV2(
        {
          session: dependencySession,
          requested: { version: 2 },
          operationId: 'mcp.invoke',
          resource: targetResource,
          operationTarget: {
            serverNamespace: namespace,
            serverName: targetName,
            toolName: 'selected-tool',
          },
          allocateChatMessageId: false,
          gateway,
        },
        { authorizationOptions: { transaction: transaction(databasePool!) } }
      )

    const authorized = await authorizeTarget()
    expect(authorized.status, JSON.stringify(authorized)).toBe('allowed')
    if (authorized.status !== 'allowed') return
    expect(authorized.context.selectedPathCapabilities).toContain('mcp_server.use')
    expect(authorized.context.pathKind).toBe('direct')
    const exactReads = kubernetesApi.requests
      .slice(beforeRequests)
      .filter(item => item.method === 'GET' && item.name !== null)
    expect(exactReads).toHaveLength(3)
    expect(new Set(exactReads.map(item => item.plural))).toEqual(
      new Set(['hosts', 'contexts', 'mcpservers'])
    )
    expect(exactReads.map(item => item.name)).not.toContain(siblingA)
    expect(exactReads.map(item => item.name)).not.toContain(siblingB)

    kubernetesApi.delete(
      'sharedfilesystems',
      config.sharedFilesystemsNamespace,
      dependencyFilesystem
    )
    await expect(
      gateway.getResourceExact(
        'sharedfilesystems',
        dependencyFilesystem,
        config.sharedFilesystemsNamespace,
        { timeoutSeconds: 5, signal: new AbortController().signal }
      )
    ).rejects.toThrow('not found')
    const beforeMissingFilesystemReads = kubernetesApi.requests.length
    const afterMissingFilesystem = await authorizeHostStatus()
    expect(
      afterMissingFilesystem.status,
      JSON.stringify({
        result: afterMissingFilesystem,
        reads: kubernetesApi.requests.slice(beforeMissingFilesystemReads),
      })
    ).not.toBe('allowed')
    kubernetesApi.put('sharedfilesystems', config.sharedFilesystemsNamespace, filesystemObject)

    kubernetesApi.delete('mcpservers', namespace, siblingA)
    const afterSiblingRemoval = await authorizeTarget()
    expect(afterSiblingRemoval.status, JSON.stringify(afterSiblingRemoval)).toBe('allowed')

    const noContextHost = `r68-no-context-${randomBytes(4).toString('hex')}`
    await request(app)
      .post('/admin/hosts')
      .send({ metadata: { name: noContextHost }, spec: {} })
      .expect(201)
    await databasePool.query(`INSERT INTO user_agents(user_id, agent_name) VALUES ($1, $2)`, [
      dependencyUser,
      noContextHost,
    ])
    for (const source of operationalSourceSpecs) await dependencyIndexer.reconcileSource(source)
    const noContextResource = canonicalResourceIdentity({
      environmentId,
      type: 'host',
      logicalId: `${config.hostsNamespace}/${noContextHost}`,
    })
    const beforeNoContextReads = kubernetesApi.requests.length
    const noContext = await authorizeActionV2(
      {
        session: dependencySession,
        requested: { version: 2 },
        operationId: 'host.status.read',
        resource: noContextResource,
        operationTarget: { hostRef: noContextResource.logicalId },
        allocateChatMessageId: false,
        gateway,
      },
      { authorizationOptions: { transaction: transaction(databasePool) } }
    )
    expect(noContext.status, JSON.stringify(noContext)).toBe('allowed')
    expect(
      kubernetesApi.requests
        .slice(beforeNoContextReads)
        .filter(item => item.method === 'GET' && item.name !== null)
        .map(item => item.plural)
    ).toEqual(['hosts'])
  })

  it.each([
    { label: 'UID', uid: `replacement-${serverName}`, resourceVersion: '2' },
    { label: 'resourceVersion', uid: server.metadata.uid, resourceVersion: '2' },
  ])('rejects MCP tools/read after provider $label drift', async replacement => {
    const authorized = await authorize('mcp.tools.read')
    expect(authorized.status, JSON.stringify(authorized)).toBe('allowed')
    if (authorized.status !== 'allowed') return

    kubernetesApi.put('mcpservers', namespace, providerObject(replacement))
    expect((await checkpoint(authorized, 'mcp.tools.read')).status).toBe('access_path_stale')
  })

  it('fails closed when the authoritative producer omits the MCP binding', async () => {
    if (!databasePool) throw new Error('realpg_database_not_ready')
    const result = await authorizeActionV2(
      {
        session: actionSession,
        requested: { version: 2 },
        operationId: 'mcp.tools.read',
        resource,
        operationTarget: { serverNamespace: namespace, serverName },
        allocateChatMessageId: false,
        gateway,
      },
      {
        resolve: async (input, options) => {
          const produced = await resolveLiveActionAuthorization(input, {
            ...options,
            transaction: transaction(databasePool!),
          })
          if (produced.status !== 'allowed') return produced
          return {
            ...produced,
            operationalBindings: produced.operationalBindings.filter(
              binding =>
                binding.resourceType !== 'mcp_server' || binding.logicalId !== resource.logicalId
            ),
          }
        },
      }
    )
    expect(result).toEqual({
      status: 'authority_unavailable',
      code: 'authority_unavailable',
      retryable: true,
    })
  })

  it('does not accept a caller-supplied MCP physical binding', async () => {
    const authorized = await authorize('mcp.tools.read')
    expect(authorized.status, JSON.stringify(authorized)).toBe('allowed')
    if (authorized.status !== 'allowed') return
    const caller = { service: 'rpc-proxy', trustPlane: 'internal_service_token' } as const
    const request = checkpointRequest(authorized, 'mcp.tools.read')
    expect(() =>
      parseActionAuthorityCheckpointRequest(
        { ...request, mcpServerBinding: authorized.mcpServerBinding },
        caller
      )
    ).toThrow('invalid_binding')
  })

  it('preserves unavailable destination-source handling', async () => {
    const authorized = await authorize('mcp.tools.read')
    expect(authorized.status, JSON.stringify(authorized)).toBe('allowed')
    if (authorized.status !== 'allowed') return
    const unavailableGateway = {
      getResourceExact: async () => {
        throw new Error('test_source_unavailable')
      },
    }
    const budget = AccessExecutionBudget.create('action')
    try {
      expect(
        await resolveActionDestination({
          resource,
          target: authorized.context.target,
          mcpServerBinding: authorized.mcpServerBinding,
          gateway: unavailableGateway,
          budget,
        })
      ).toEqual({ status: 'unavailable' })
    } finally {
      budget.close()
    }
  })
})
