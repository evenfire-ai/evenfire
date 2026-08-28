import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { config } from '../src/config.js'
import { type DbClient, initDb } from '../src/db.js'
import { K8sGateway } from '../src/k8s.js'
import { buildAccessCatalog } from '../src/services/access/accessCatalogCoordinator.js'
import {
  AccessBudgetExceededError,
  AccessExecutionBudget,
} from '../src/services/access/accessExecutionBudget.js'
import type { AccessCapability } from '../src/services/access/capabilityRegistry.js'
import { CATALOG_FAMILIES, type CatalogFamily } from '../src/services/access/catalogContracts.js'
import { resolveLiveAuthorization } from '../src/services/access/liveAuthorizationResolver.js'
import { OperationalAccessIndex } from '../src/services/access/operationalAccessIndex.js'
import {
  OperationalAccessIndexer,
  operationalSourceSpecs,
} from '../src/services/access/operationalAccessIndexer.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import {
  catalogBudgetOptionsForIntent,
  loadConfiguredUserAccessIntent,
} from '../src/services/access/userAccessPolicy.js'
import type { ExternalSessionAuthorityContext } from '../src/services/auth/externalSessionAuthentication.js'
import { TemporaryKubernetesApi } from './helpers/temporaryKubernetesApi.js'

vi.mock('../src/services/access/operationTarget.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/access/operationTarget.js')>()
  return {
    ...actual,
    validateOperationTarget: (input: Parameters<typeof actual.validateOperationTarget>[0]) =>
      input.capability === 'gfs.write' || input.capability === 'gfs.delete'
        ? null
        : actual.validateOperationTarget(input),
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

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('producer_boundary_wait_timeout')
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
        resourceVersion: '1',
        generation: 1,
      }),
      spec: Object.freeze({ enabled: true, ...(input.spec ?? {}) }),
    }),
  })
}

describeRealPostgres('all aggregate catalog families on real producers', () => {
  const database = `control_api_catalog_families_${randomBytes(6).toString('hex')}`
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
  const directNotificationId = randomUUID()
  const teamNotificationId = randomUUID()
  const gfsResourceId = randomUUID()
  const session: ExternalSessionAuthorityContext = {
    contract: 'v1',
    userId,
    tokenHash: randomBytes(32).toString('hex'),
    issuedAt: Math.floor(Date.now() / 1_000),
    authGeneration: 1,
  }
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
  const kubernetesApi = new TemporaryKubernetesApi()
  let adminPool: Pool
  let databasePool: Pool
  let gateway: K8sGateway
  let indexer: OperationalAccessIndexer

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
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
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Catalog Harness User')`,
      [userId, `${userId}@example.test`]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Catalog Harness Team')`, [
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
      `INSERT INTO notification_deliveries(
         id, event_type, dedupe_key, audience, payload, status, expires_at
       ) VALUES
         ($1, 'catalog.direct', $3, jsonb_build_object('userId', $5::text),
          '{}'::jsonb, 'queued', NOW() + INTERVAL '1 hour'),
         ($2, 'catalog.team', $4, jsonb_build_object('teamId', $6::text),
          '{}'::jsonb, 'queued', NOW() + INTERVAL '1 hour')`,
      [
        directNotificationId,
        teamNotificationId,
        `direct-${directNotificationId}`,
        `team-${teamNotificationId}`,
        userId,
        teamId,
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

    const index = new OperationalAccessIndex(databasePool, transaction(databasePool))
    indexer = new OperationalAccessIndexer(gateway, index, {
      environmentId,
      behaviorFingerprintKey: config.sessionJwtPrivateKey,
    })
    for (const source of operationalSourceSpecs) {
      await indexer.reconcileSource(source)
    }
  })

  afterAll(async () => {
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

  const expectedItemCounts: Readonly<Record<CatalogFamily, number>> = Object.freeze({
    user: 1,
    team: 1,
    host: 1,
    context: 1,
    mcp_server: 1,
    workflow_recipe: 1,
    workflow_run: 2,
    workflow_approval: 2,
    notification: 2,
    gfs_resource: 1,
    shared_filesystem: 1,
    sandbox_app: 1,
  })
  const capability: Readonly<Record<CatalogFamily, AccessCapability>> = Object.freeze({
    user: 'user.profile.read',
    team: 'team.read',
    host: 'host.read',
    context: 'context.read',
    mcp_server: 'mcp_server.read',
    workflow_recipe: 'workflow.read',
    workflow_run: 'workflow.read',
    workflow_approval: 'workflow.approval.decide',
    notification: 'notification.read',
    gfs_resource: 'gfs.read',
    shared_filesystem: 'shared_filesystem.read',
    sandbox_app: 'sandbox_app.read',
  })
  const expectedKinds: Readonly<Record<CatalogFamily, readonly ('direct' | 'team')[]>> =
    Object.freeze({
      user: ['direct'],
      team: ['team'],
      host: ['direct', 'team'],
      context: ['direct', 'team'],
      mcp_server: ['direct', 'team'],
      workflow_recipe: ['direct', 'team'],
      workflow_run: ['direct', 'team'],
      workflow_approval: ['direct', 'team'],
      notification: ['direct', 'team'],
      gfs_resource: ['direct', 'team'],
      shared_filesystem: ['direct', 'team'],
      sandbox_app: ['direct', 'team'],
    })

  for (const family of CATALOG_FAMILIES) {
    it(`${family} producer paths round-trip through catalog and live resolution`, async () => {
      const catalog = await buildAccessCatalog(
        { session, families: [family], limit: 100 },
        {
          transaction: transaction(databasePool),
          ...(family === 'gfs_resource' ? { teamGfsMembershipAdmissionLimit: 1 } : {}),
        }
      )
      expect(catalog.complete).toBe(true)
      expect(catalog.partialErrors).toEqual([])
      expect(catalog.nextCursor).toBeNull()
      expect(catalog.items).toHaveLength(expectedItemCounts[family])
      expect(
        [...new Set(catalog.items.flatMap(item => item.accessPaths.map(path => path.kind)))].sort()
      ).toEqual([...expectedKinds[family]].sort())

      for (const item of catalog.items) {
        expect(item.resource.type).toBe(family)
        expect(item.accessPaths.length).toBeGreaterThan(0)
        for (const path of item.accessPaths) {
          const resolved = await resolveLiveAuthorization(
            {
              session,
              requiredCapability: capability[family],
              resource: canonicalResourceIdentity(item.resource),
              requestedAccessPathId: path.accessPathId,
              ...(family === 'workflow_approval'
                ? {
                    operationTarget: {
                      approvalId: item.resource.logicalId,
                      decision: 'approve',
                    },
                  }
                : {}),
            },
            {
              transaction: transaction(databasePool),
              gateway,
            }
          )
          expect(resolved).toEqual(
            expect.objectContaining({
              status: 'allowed',
              selectedPath: expect.objectContaining({ id: path.accessPathId }),
            })
          )
        }
      }
    })
  }

  it('round-trips a catalog write path when capability selection excludes a read-only sibling', async () => {
    const catalog = await buildAccessCatalog(
      { session, families: ['gfs_resource'], limit: 10 },
      {
        transaction: transaction(databasePool),
        teamGfsMembershipAdmissionLimit: 1,
      }
    )
    const item = catalog.items[0]!
    const directWritePath = item.accessPaths.find(
      path => path.kind === 'direct' && path.capabilities.includes('gfs.write')
    )
    const teamReadPath = item.accessPaths.find(
      path => path.kind === 'team' && path.capabilities.includes('gfs.read')
    )
    expect(directWritePath).toBeDefined()
    expect(teamReadPath).toBeDefined()

    const resolved = await resolveLiveAuthorization(
      {
        session,
        requiredCapability: 'gfs.write',
        resource: canonicalResourceIdentity(item.resource),
        requestedAccessPathId: directWritePath!.accessPathId,
      },
      { transaction: transaction(databasePool), gateway }
    )

    expect(resolved).toEqual(
      expect.objectContaining({
        status: 'allowed',
        selectedPath: expect.objectContaining({ id: directWritePath!.accessPathId }),
      })
    )

    await expect(
      resolveLiveAuthorization(
        {
          session,
          requiredCapability: 'gfs.write',
          resource: canonicalResourceIdentity(item.resource),
          requestedAccessPathId: teamReadPath!.accessPathId,
        },
        { transaction: transaction(databasePool), gateway }
      )
    ).resolves.toEqual(
      expect.objectContaining({ status: 'access_path_stale', code: 'access_path_stale' })
    )

    await expect(
      resolveLiveAuthorization(
        {
          session,
          requiredCapability: 'gfs.delete',
          resource: canonicalResourceIdentity(item.resource),
        },
        { transaction: transaction(databasePool), gateway }
      )
    ).resolves.toEqual({ status: 'denied', code: 'forbidden' })
  })

  it('enforces the operator-configured Team-GFS admission through the production budget contract', async () => {
    const intent = loadConfiguredUserAccessIntent({
      CONTROL_API_USER_ACCESS_CATALOG_MODE: 'serve',
      CONTROL_API_USER_ACCESS_TEAM_GFS_MEMBERSHIP_ADMISSION_LIMIT: '1',
    })
    const budget = AccessExecutionBudget.create('catalog', catalogBudgetOptionsForIntent(intent))
    try {
      await expect(
        buildAccessCatalog(
          { session, families: ['gfs_resource'], limit: 100 },
          { transaction: transaction(databasePool), budget }
        )
      ).resolves.toMatchObject({ complete: true, items: [{ resource: { type: 'gfs_resource' } }] })
    } finally {
      budget.close()
    }

    const secondTeamId = randomUUID()
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Admission Overflow Team')`, [
      secondTeamId,
    ])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [secondTeamId, userId]
    )
    const exhausted = AccessExecutionBudget.create('catalog', catalogBudgetOptionsForIntent(intent))
    try {
      await expect(
        buildAccessCatalog(
          { session, families: ['gfs_resource'], limit: 100 },
          { transaction: transaction(databasePool), budget: exhausted }
        )
      ).rejects.toBeInstanceOf(AccessBudgetExceededError)
    } finally {
      exhausted.close()
      await databasePool.query(`DELETE FROM teams WHERE id = $1`, [secondTeamId])
    }
  })

  it('preserves both direct/team provenance across duplicate filesystem mounts', async () => {
    const catalog = await buildAccessCatalog(
      { session, families: ['shared_filesystem'], limit: 100 },
      { transaction: transaction(databasePool) }
    )
    const item = catalog.items[0]
    expect(
      item.relationships.filter(value => value.type === 'mounts_shared_filesystem')
    ).toHaveLength(2)
    expect(item.accessPaths).toHaveLength(4)
    expect(new Set(item.accessPaths.map(path => path.accessPathId)).size).toBe(4)
    expect(
      new Set(
        item.accessPaths.map(path => JSON.stringify(path.behaviorDescriptors.filesystemScope))
      ).size
    ).toBe(2)
  })

  it('uses real Kubernetes list and exact-read wire boundaries', async () => {
    const listRequests = kubernetesApi.requests.filter(request => !request.watch && !request.name)
    expect(listRequests).toHaveLength(operationalSourceSpecs.length)
    expect(listRequests.map(request => `${request.namespace}/${request.plural}`).sort()).toEqual(
      operationalSourceSpecs.map(source => `${source.namespace}/${source.plural}`).sort()
    )
    expect(listRequests.every(request => request.limit !== null)).toBe(true)
    const exactRequests = kubernetesApi.requests.filter(request => request.name)
    expect(exactRequests.length).toBeGreaterThan(0)
    expect(
      new Set(exactRequests.map(request => request.namespace)).has(config.hostsNamespace)
    ).toBe(true)
    const sourceStates = await databasePool.query(
      `SELECT source_family, resource_version, status
         FROM operational_catalog_source_state
        WHERE environment_id = $1
        ORDER BY source_family`,
      [environmentId]
    )
    expect(sourceStates.rows).toHaveLength(operationalSourceSpecs.length)
    expect(sourceStates.rows.every(row => row.resource_version === '1')).toBe(true)
    expect(sourceStates.rows.every(row => row.status === 'current')).toBe(true)
  })

  it('ingests deletion and recreation through the real Kubernetes watch boundary', async () => {
    const source = operationalSourceSpecs.find(value => value.family === 'host')!
    const original = operationalFixtures.find(value => value.plural === 'hosts')!
    const controller = new AbortController()
    const watch = gateway.watchResource(
      source.plural,
      source.namespace,
      '1',
      controller.signal,
      (phase, object) => indexer.applyWatchEvent(source, phase, object, controller.signal)
    )
    await waitFor(() => kubernetesApi.requests.some(request => request.watch))

    const deleted = {
      ...original.object,
      metadata: {
        ...(original.object.metadata as Record<string, unknown>),
        resourceVersion: '2',
      },
    }
    kubernetesApi.delete(source.plural, source.namespace, 'catalog-host')
    kubernetesApi.emitWatch('DELETED', deleted)
    await waitFor(async () => {
      const result = await databasePool.query(
        `SELECT COUNT(*)::int AS count
           FROM operational_resource_index
          WHERE environment_id = $1 AND resource_type = 'host'
            AND logical_id = $2`,
        [environmentId, `${config.hostsNamespace}/catalog-host`]
      )
      return result.rows[0]?.count === 0
    })

    const recreated = fixture({
      plural: 'hosts',
      namespace: config.hostsNamespace,
      name: 'catalog-host',
      uid: 'catalog-host-uid-recreated',
      spec: {
        contextRef: 'catalog-context',
        model: { provider: 'openai', name: 'test-model' },
      },
    }).object
    const recreatedWithVersion = {
      ...recreated,
      metadata: {
        ...(recreated.metadata as Record<string, unknown>),
        resourceVersion: '3',
      },
    }
    kubernetesApi.put(source.plural, source.namespace, recreatedWithVersion)
    kubernetesApi.emitWatch('ADDED', recreatedWithVersion)
    await waitFor(async () => {
      const result = await databasePool.query(
        `SELECT provider_uid, provider_resource_version, deleted_at
           FROM operational_resource_index
          WHERE environment_id = $1 AND resource_type = 'host'
            AND logical_id = $2`,
        [environmentId, `${config.hostsNamespace}/catalog-host`]
      )
      return (
        result.rows[0]?.provider_uid === 'catalog-host-uid-recreated' &&
        result.rows[0]?.provider_resource_version === '3' &&
        result.rows[0]?.deleted_at === null
      )
    })

    const catalog = await buildAccessCatalog(
      { session, families: ['host'], limit: 10 },
      { transaction: transaction(databasePool) }
    )
    expect(catalog.items).toHaveLength(1)
    const item = catalog.items[0]
    const resolved = await resolveLiveAuthorization(
      {
        session,
        requiredCapability: 'host.read',
        resource: canonicalResourceIdentity(item.resource),
        requestedAccessPathId: item.accessPaths[0].accessPathId,
      },
      { transaction: transaction(databasePool), gateway }
    )
    expect(resolved.status).toBe('allowed')

    controller.abort('watch_complete')
    await expect(watch).resolves.toBeUndefined()
    const watchRequest = kubernetesApi.requests.find(request => request.watch)
    expect(watchRequest).toEqual(
      expect.objectContaining({
        namespace: config.hostsNamespace,
        plural: 'hosts',
        resourceVersion: '1',
      })
    )
  })

  it('cancels a real indexer relist without staging or promoting late results', async () => {
    const source = operationalSourceSpecs.find(value => value.family === 'host')!
    const cancellationHost = fixture({
      plural: 'hosts',
      namespace: config.hostsNamespace,
      name: 'catalog-host',
      uid: 'catalog-host-uid-cancellation',
      spec: {
        contextRef: 'catalog-context',
        model: { provider: 'openai', name: 'test-model' },
      },
    }).object
    const cancellationHostWithVersion = {
      ...cancellationHost,
      metadata: {
        ...(cancellationHost.metadata as Record<string, unknown>),
        resourceVersion: '4',
      },
    }
    kubernetesApi.put(source.plural, source.namespace, cancellationHostWithVersion)
    await expect(indexer.reconcileSource(source)).resolves.toBe('4')
    const before = await databasePool.query(
      `SELECT generation, staging_generation, resource_version, status
         FROM operational_catalog_source_state
        WHERE environment_id = $1 AND source_family = $2`,
      [environmentId, source.family]
    )
    expect(before.rows[0]).toEqual(
      expect.objectContaining({
        staging_generation: null,
        resource_version: '4',
        status: 'current',
      })
    )
    const held = kubernetesApi.holdNextList()
    const controller = new AbortController()
    const pending = indexer.reconcileSource(source, controller.signal)
    try {
      await held.requested
      controller.abort(new Error('test_cancelled'))
      await expect(pending).rejects.toThrow()
      await held.closed

      const afterAbort = await databasePool.query(
        `SELECT generation, staging_generation, resource_version, status
           FROM operational_catalog_source_state
          WHERE environment_id = $1 AND source_family = $2`,
        [environmentId, source.family]
      )
      expect(afterAbort.rows[0]).toEqual(
        expect.objectContaining({
          generation: String(Number(before.rows[0].generation) + 1),
          resource_version: '4',
          status: 'relisting',
        })
      )
      expect(afterAbort.rows[0].staging_generation).not.toBeNull()
      const staged = await databasePool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM operational_resource_index_staging
             WHERE environment_id = $1 AND source_family = $2) AS resources,
           (SELECT COUNT(*)::int FROM operational_relationships_staging
             WHERE environment_id = $1 AND source_family = $2) AS relationships`,
        [environmentId, source.family]
      )
      expect(staged.rows[0]).toEqual({ resources: 0, relationships: 0 })
      const live = await databasePool.query(
        `SELECT provider_uid, provider_resource_version
           FROM operational_resource_index
          WHERE environment_id = $1 AND resource_type = 'host'
            AND logical_id = $2`,
        [environmentId, `${config.hostsNamespace}/catalog-host`]
      )
      expect(live.rows).toEqual([
        {
          provider_uid: 'catalog-host-uid-cancellation',
          provider_resource_version: '4',
        },
      ])

      await expect(indexer.reconcileSource(source)).resolves.toBe('4')
      const recovered = await databasePool.query(
        `SELECT staging_generation, resource_version, status
           FROM operational_catalog_source_state
          WHERE environment_id = $1 AND source_family = $2`,
        [environmentId, source.family]
      )
      expect(recovered.rows[0]).toEqual({
        staging_generation: null,
        resource_version: '4',
        status: 'current',
      })
    } finally {
      held.release()
    }
  })
})
