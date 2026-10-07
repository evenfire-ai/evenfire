import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import request from 'supertest'
import { config } from '../src/config.js'
import { type DbClient, initDb } from '../src/db.js'
import { K8sGateway } from '../src/k8s.js'
import { createExternalAccessRouter } from '../src/routes/external/access.js'
import { buildAccessCatalog } from '../src/services/access/accessCatalogCoordinator.js'
import {
  AccessBudgetExceededError,
  AccessExecutionBudget,
} from '../src/services/access/accessExecutionBudget.js'
import { authorizeActionV2 } from '../src/services/access/actionAuthorizer.js'
import type { AccessCapability } from '../src/services/access/capabilityRegistry.js'
import { CATALOG_FAMILIES, type CatalogFamily } from '../src/services/access/catalogContracts.js'
import {
  resolveLiveActionAuthorization,
  resolveLiveAuthorization,
} from '../src/services/access/liveAuthorizationResolver.js'
import { OperationalAccessIndex } from '../src/services/access/operationalAccessIndex.js'
import {
  OperationalAccessIndexer,
  operationalSourceSpecs,
} from '../src/services/access/operationalAccessIndexer.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import {
  loadOperationalResourceGraphs,
  operationalResourceGraphKey,
} from '../src/services/access/operationalAccessReader.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import {
  catalogBudgetOptionsForIntent,
  configuredUserAccessIntent,
  loadConfiguredUserAccessIntent,
} from '../src/services/access/userAccessPolicy.js'
import { catalogConfigurationRevision } from '../src/services/access/userAccessRuntimePolicy.js'
import type { ExternalSessionAuthorityContext } from '../src/services/auth/externalSessionAuthentication.js'
import { createUserSession } from '../src/services/auth/userSessionService.js'
import { __resetBudgetCheckCache, evaluateBudgetCheck } from '../src/services/budgets/check.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import { TemporaryKubernetesApi } from './helpers/temporaryKubernetesApi.js'

const routeTestState = vi.hoisted(() => {
  return {
    teamIds: [globalThis.crypto.randomUUID()],
    databasePool: null as unknown,
  }
})

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
  return { ...actual, pool: testPool, corePool: testPool, rateLimitPool: testPool }
})

vi.mock('../src/services/access/userAccessPolicy.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/access/userAccessPolicy.js')>()
  const configuredUserAccessIntent = actual.loadConfiguredUserAccessIntent({
    ...process.env,
    CONTROL_API_USER_ACCESS_CATALOG_MODE: 'serve',
    CONTROL_API_USER_ACCESS_TEAM_GFS_MEMBERSHIP_ADMISSION_LIMIT: String(
      routeTestState.teamIds.length
    ),
  })
  return {
    ...actual,
    configuredUserAccessIntent,
    configuredCatalogBudgetOptions: actual.catalogBudgetOptionsForIntent(
      configuredUserAccessIntent
    ),
  }
})

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
  const teamId = routeTestState.teamIds[0]!
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
  const kubernetesApi = new TemporaryKubernetesApi()
  let adminPool: Pool
  let databasePool: Pool
  let gateway: K8sGateway
  let indexer: OperationalAccessIndexer
  let initialListRequests: string[]
  let initialWireRequestCount = 0

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
    const activeMembershipCount = await databasePool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM team_members
        WHERE user_id = $1 AND status = 'active'`,
      [userId]
    )
    expect(Number(activeMembershipCount.rows[0]?.count)).toBe(
      configuredUserAccessIntent.teamGfsMembershipAdmissionLimit
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
    initialListRequests = kubernetesApi.requests
      .filter(request => !request.watch && !request.name)
      .map(request => `${request.namespace}/${request.plural}`)
    initialWireRequestCount = kubernetesApi.requests.length
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

  it('composes twelve families within the existing six-call mounted-route reserve', async () => {
    const activeMemberships = await databasePool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM team_members
        WHERE user_id = $1 AND status = 'active'`,
      [userId]
    )
    const teamGfsAdmissionLimit = Number(activeMemberships.rows[0]?.count)
    expect(teamGfsAdmissionLimit).toBeGreaterThan(0)
    const catalogIntent = loadConfiguredUserAccessIntent({
      CONTROL_API_USER_ACCESS_CATALOG_MODE: 'serve',
      CONTROL_API_USER_ACCESS_TEAM_GFS_MEMBERSHIP_ADMISSION_LIMIT: String(teamGfsAdmissionLimit),
    })
    const budget = AccessExecutionBudget.create(
      'catalog',
      catalogBudgetOptionsForIntent(catalogIntent)
    )
    let sqlQueries = 0
    let transactionIsolation: string | undefined
    let transactionReadOnly: string | undefined
    const measuredTransaction = async <T>(work: (db: DbClient) => Promise<T>): Promise<T> => {
      const client = (await databasePool.connect()) as PoolClient
      try {
        await client.query('BEGIN')
        const db = new Proxy(client, {
          get(target, property) {
            if (property === 'query') {
              return (...args: unknown[]) => {
                sqlQueries += 1
                return Reflect.apply(
                  target.query as (...queryArgs: unknown[]) => unknown,
                  target,
                  args
                )
              }
            }
            return Reflect.get(target, property, target)
          },
        }) as DbClient
        const value = await work(db)
        const transactionSettings = await client.query(
          `SELECT current_setting('transaction_isolation') AS isolation,
                  current_setting('transaction_read_only') AS read_only`
        )
        transactionIsolation = String(transactionSettings.rows[0]?.isolation)
        transactionReadOnly = String(transactionSettings.rows[0]?.read_only)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
    try {
      const catalog = await buildAccessCatalog(
        { session, limit: 100 },
        { transaction: measuredTransaction, budget }
      )
      const producerCalls = 42 - budget.remaining('producerCalls')
      expect(catalog.complete).toBe(true)
      expect(catalog.partialErrors).toEqual([])
      expect(catalog.nextCursor).toBeNull()
      expect(catalog.items).toHaveLength(
        Object.values(expectedItemCounts).reduce((total, count) => total + count, 0)
      )
      expect(
        Object.fromEntries(
          CATALOG_FAMILIES.map(family => [
            family,
            catalog.items.filter(item => item.resource.type === family).length,
          ])
        )
      ).toEqual(expectedItemCounts)
      expect([...new Set(catalog.items.map(item => item.resource.type))].sort()).toEqual(
        [...CATALOG_FAMILIES].sort()
      )
      // The mounted route reserves producer work for authenticated identity and
      // readiness checks before the catalog coordinator receives this budget.
      // Keep the coordinator within that existing six-call reserve; the mount
      // contract separately fixes the total request ceiling at 42.
      expect(producerCalls).toBeLessThanOrEqual(36)
      expect(transactionIsolation).toBe('repeatable read')
      expect(transactionReadOnly).toBe('on')
      console.info(
        `[r34-h2] families=${CATALOG_FAMILIES.length} items=${catalog.items.length} ` +
          `producerCalls=${producerCalls} sqlQueries=${sqlQueries}`
      )
    } finally {
      budget.close()
    }
  })

  it('serves the mounted twelve-family catalog within the unchanged 42-call request budget', async () => {
    const issued = await createUserSession(
      {
        userId,
        email: `${userId}@example.test`,
        authenticationMethods: ['password'],
      },
      { db: databasePool as never }
    )
    const priorIndexerEnabled = config.operationalAccessIndexerEnabled
    const priorReadinessMaxAgeMs = config.operationalAccessReadinessMaxAgeMs
    const priorActivationRecord = config.userAccessCatalogActivationRecord
    const intent = configuredUserAccessIntent
    config.operationalAccessIndexerEnabled = true
    config.operationalAccessReadinessMaxAgeMs = 60_000
    config.userAccessCatalogActivationRecord = JSON.stringify({
      version: 1,
      active: true,
      revision: 'realpg-r34-h2-acceptance',
      acceptedBy: 'realpg-test-harness',
      acceptedAt: new Date().toISOString(),
      catalogConfigurationRevision: catalogConfigurationRevision(intent),
      requiredFamilies: CATALOG_FAMILIES,
      comparisonEvidence: CATALOG_FAMILIES.map(family => ({
        family,
        attempted: 1,
        completed: 1,
        reference: 'realpg-test-harness',
      })),
    })
    const app = express()
    app.use(createExternalAccessRouter(gateway))
    const budgetSpy = vi.spyOn(AccessExecutionBudget, 'create')
    const producerBudgetFailures: string[] = []
    const originalCharge = AccessExecutionBudget.prototype.charge
    const chargeSpy = vi.spyOn(AccessExecutionBudget.prototype, 'charge')
    chargeSpy.mockImplementation(function (this: AccessExecutionBudget, event) {
      try {
        originalCharge.call(this, event)
      } catch (error) {
        if (error instanceof AccessBudgetExceededError) producerBudgetFailures.push(error.limit)
        throw error
      }
    })
    try {
      const response = await request(app)
        .get('/external/access/catalog')
        .set('x-user-session-token', issued.token)

      const requestBudgets = budgetSpy.mock.results
        .filter(result => result.type === 'return')
        .map(result => result.value)
        .filter(budget => budget.limits.producerCalls === 42)
      expect(requestBudgets).toHaveLength(1)
      const producerCalls = 42 - requestBudgets[0]!.remaining('producerCalls')
      console.info(
        `[r34-h2-http] status=${response.status} error=${String(response.body?.error ?? '')} ` +
          `families=${CATALOG_FAMILIES.length} producerCalls=${producerCalls} ` +
          `budgetFailures=${JSON.stringify(producerBudgetFailures)}`
      )

      expect(producerBudgetFailures).toEqual([])
      expect(response.status).toBe(200)
      expect(response.body.complete).toBe(true)
      expect(response.body.partialErrors).toEqual([])
      expect(response.body.nextCursor).toBeNull()
      expect(response.body.items).toHaveLength(
        Object.values(expectedItemCounts).reduce((total, count) => total + count, 0)
      )
      expect(
        Object.fromEntries(
          CATALOG_FAMILIES.map(family => [
            family,
            response.body.items.filter(
              (item: { resource?: { type?: string } }) => item.resource?.type === family
            ).length,
          ])
        )
      ).toEqual(expectedItemCounts)
      expect(producerCalls).toBeLessThanOrEqual(42)
      console.info(
        `[r34-h2-http] status=${response.status} families=${CATALOG_FAMILIES.length} ` +
          `items=${response.body.items.length} producerCalls=${producerCalls}`
      )
    } finally {
      chargeSpy.mockRestore()
      budgetSpy.mockRestore()
      config.operationalAccessIndexerEnabled = priorIndexerEnabled
      config.operationalAccessReadinessMaxAgeMs = priorReadinessMaxAgeMs
      config.userAccessCatalogActivationRecord = priorActivationRecord
    }
  })

  it('does not hydrate unrelated operational families for a small-family request', async () => {
    const budget = AccessExecutionBudget.create('catalog')
    const observedStatements: string[] = []
    const measuredTransaction = async <T>(work: (db: DbClient) => Promise<T>): Promise<T> =>
      transaction(databasePool)(db =>
        work(
          new Proxy(db, {
            get(target, property) {
              if (property === 'query') {
                return (text: string, values?: unknown[]) => {
                  observedStatements.push(text)
                  return Reflect.apply(target.query, target, [text, values])
                }
              }
              return Reflect.get(target, property, target)
            },
          }) as DbClient
        )
      )
    try {
      const catalog = await buildAccessCatalog(
        { session, families: ['user'], limit: 10 },
        { transaction: measuredTransaction, budget }
      )
      const producerCalls = 42 - budget.remaining('producerCalls')
      expect(catalog.complete).toBe(true)
      expect(catalog.items).toHaveLength(1)
      expect(catalog.items[0]?.resource.type).toBe('user')
      // User-only producer work is unchanged from e99a04f: the R34 delta only
      // prepares hydration when the selected roots contain operational types.
      expect(producerCalls).toBe(6)
      expect(
        observedStatements.filter(statement =>
          /\boperational_resource_(?:index|relationships)\b/i.test(statement)
        )
      ).toEqual([])
      console.info(
        `[r34-h2-small] selected=user producerCalls=${producerCalls} unrelatedOperationalReads=0`
      )
    } finally {
      budget.close()
    }
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
      if (family === 'workflow_run') {
        expect(
          catalog.items
            .flatMap(item => item.accessPaths)
            .some(path => path.capabilities.includes('workflow.run.manage'))
        ).toBe(false)
      }
      expect(
        [...new Set(catalog.items.flatMap(item => item.accessPaths.map(path => path.kind)))].sort()
      ).toEqual([...expectedKinds[family]].sort())

      for (const item of catalog.items) {
        expect(item.resource.type).toBe(family)
        expect(item.accessPaths.length).toBeGreaterThan(0)
        for (const path of item.accessPaths) {
          if (family === 'context' || family === 'mcp_server') {
            expect(path.behaviorDescriptors.providerModelPolicy).toEqual({
              state: 'known',
              value: null,
            })
          }
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

  it('resolves producer Context aliases to one canonical catalog and authority identity', async () => {
    const suffix = randomBytes(5).toString('hex')
    const contextName = `r55-m7-context-${suffix}`
    const contextAlias = `r55-m7-wire-${suffix}`
    const hostName = `r55-m7-host-${suffix}`
    const mcpName = `r55-m7-mcp-${suffix}`
    const sharedFilesystemName = `r55-m7-files-${suffix}`
    const duplicateAliasName = `r55-m7-duplicate-${suffix}`
    const nextContextAlias = `r55-m7-next-wire-${suffix}`
    const contextUid = randomUUID()
    const contextSource = operationalSourceSpecs.find(value => value.family === 'context')!
    const hostSource = operationalSourceSpecs.find(value => value.family === 'host')!
    const mcpSource = operationalSourceSpecs.find(value => value.family === 'mcp_server')!
    const sharedFilesystemSource = operationalSourceSpecs.find(
      value => value.family === 'shared_filesystem'
    )!
    let contextObject = fixture({
      plural: 'contexts',
      namespace: config.contextsNamespace,
      name: contextName,
      uid: contextUid,
      spec: {
        contextId: contextAlias,
        mcpServers: [mcpName],
        sharedFileSystems: [{ name: sharedFilesystemName, mountPath: '/workspace/m7' }],
      },
    })
    let hostObject = fixture({
      plural: 'hosts',
      namespace: config.hostsNamespace,
      name: hostName,
      uid: randomUUID(),
      spec: { contextRef: contextAlias },
    })
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
    kubernetesApi.put(contextObject.plural, contextObject.namespace, contextObject.object)
    kubernetesApi.put(hostObject.plural, hostObject.namespace, hostObject.object)
    kubernetesApi.put(mcpObject.plural, mcpObject.namespace, mcpObject.object)
    kubernetesApi.put(
      sharedFilesystemObject.plural,
      sharedFilesystemObject.namespace,
      sharedFilesystemObject.object
    )
    await indexer.reconcileSource(contextSource)
    await indexer.reconcileSource(hostSource)
    await indexer.reconcileSource(mcpSource)
    await indexer.reconcileSource(sharedFilesystemSource)
    await databasePool.query(`INSERT INTO user_contexts(user_id, context_id) VALUES ($1, $2)`, [
      userId,
      contextAlias,
    ])
    await databasePool.query(`INSERT INTO user_agents(user_id, agent_name) VALUES ($1, $2)`, [
      userId,
      hostName,
    ])

    try {
      const canonicalContextId = `${config.contextsNamespace}/${contextName}`
      const contextCatalog = await buildAccessCatalog(
        { session, families: ['context'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      const contextItem = contextCatalog.items.find(
        item => item.resource.logicalId === canonicalContextId
      )
      expect(contextCatalog.complete).toBe(true)
      expect(contextItem?.resource.logicalId).toBe(canonicalContextId)
      expect(contextItem?.resource.providerUid).toBe(contextUid)
      expect(contextItem?.accessPaths).toHaveLength(1)
      expect(contextItem?.relationships).not.toContainEqual(
        expect.objectContaining({ type: 'context_identity_alias' })
      )

      const mcpCatalog = await buildAccessCatalog(
        { session, families: ['mcp_server'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      const mcpItem = mcpCatalog.items.find(
        item => item.resource.logicalId === `${config.mcpServersNamespace}/${mcpName}`
      )
      expect(mcpCatalog.complete).toBe(true)
      expect(mcpItem?.accessPaths).toHaveLength(2)
      for (const path of mcpItem!.accessPaths) {
        await expect(
          resolveLiveAuthorization(
            {
              session,
              requiredCapability: 'mcp_server.read',
              resource: canonicalResourceIdentity(mcpItem!.resource),
              requestedAccessPathId: path.accessPathId,
            },
            { transaction: transaction(databasePool), gateway }
          )
        ).resolves.toEqual(
          expect.objectContaining({
            status: 'allowed',
            selectedPath: expect.objectContaining({ id: path.accessPathId }),
          })
        )
      }

      const sharedFilesystemCatalog = await buildAccessCatalog(
        { session, families: ['shared_filesystem'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      const sharedFilesystemItem = sharedFilesystemCatalog.items.find(
        item =>
          item.resource.logicalId === `${config.sharedFilesystemsNamespace}/${sharedFilesystemName}`
      )
      expect(sharedFilesystemCatalog.complete).toBe(true)
      expect(sharedFilesystemItem?.accessPaths).toHaveLength(1)
      await expect(
        resolveLiveAuthorization(
          {
            session,
            requiredCapability: 'shared_filesystem.read',
            resource: canonicalResourceIdentity(sharedFilesystemItem!.resource),
            requestedAccessPathId: sharedFilesystemItem!.accessPaths[0].accessPathId,
          },
          { transaction: transaction(databasePool), gateway }
        )
      ).resolves.toEqual(
        expect.objectContaining({
          status: 'allowed',
          selectedPath: expect.objectContaining({
            id: sharedFilesystemItem!.accessPaths[0].accessPathId,
          }),
        })
      )

      const duplicateAliasObject = fixture({
        plural: 'contexts',
        namespace: config.contextsNamespace,
        name: duplicateAliasName,
        uid: randomUUID(),
        spec: { contextId: contextAlias, mcpServers: [], sharedFileSystems: [] },
      })
      kubernetesApi.put(
        duplicateAliasObject.plural,
        duplicateAliasObject.namespace,
        duplicateAliasObject.object
      )
      await indexer.reconcileSource(contextSource)
      const duplicateAliasCatalog = await buildAccessCatalog(
        { session, families: ['context'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      expect(
        duplicateAliasCatalog.items.some(item => item.resource.logicalId === canonicalContextId)
      ).toBe(false)
      const duplicateAliasMcpCatalog = await buildAccessCatalog(
        { session, families: ['mcp_server'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      expect(
        duplicateAliasMcpCatalog.items.find(
          item => item.resource.logicalId === `${config.mcpServersNamespace}/${mcpName}`
        )?.accessPaths ?? []
      ).toHaveLength(0)
      kubernetesApi.delete(
        duplicateAliasObject.plural,
        duplicateAliasObject.namespace,
        duplicateAliasName
      )
      await indexer.reconcileSource(contextSource)

      const nameCollisionObject = fixture({
        plural: 'contexts',
        namespace: config.contextsNamespace,
        name: contextAlias,
        uid: randomUUID(),
        spec: { mcpServers: [], sharedFileSystems: [] },
      })
      kubernetesApi.put(
        nameCollisionObject.plural,
        nameCollisionObject.namespace,
        nameCollisionObject.object
      )
      await indexer.reconcileSource(contextSource)
      const nameCollisionCatalog = await buildAccessCatalog(
        { session, families: ['context'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      expect(
        nameCollisionCatalog.items.some(item => item.resource.logicalId === canonicalContextId)
      ).toBe(false)
      kubernetesApi.delete(nameCollisionObject.plural, nameCollisionObject.namespace, contextAlias)
      await indexer.reconcileSource(contextSource)

      contextObject = fixture({
        plural: 'contexts',
        namespace: config.contextsNamespace,
        name: contextName,
        uid: contextUid,
        spec: {
          contextId: nextContextAlias,
          mcpServers: [mcpName],
          sharedFileSystems: [{ name: sharedFilesystemName, mountPath: '/workspace/m7' }],
        },
      })
      kubernetesApi.put(contextObject.plural, contextObject.namespace, contextObject.object)
      await indexer.reconcileSource(contextSource)
      const staleAliasCatalog = await buildAccessCatalog(
        { session, families: ['context'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      expect(
        staleAliasCatalog.items.some(item => item.resource.logicalId === canonicalContextId)
      ).toBe(false)

      await databasePool.query(
        `UPDATE user_contexts SET context_id = $3 WHERE user_id = $1 AND context_id = $2`,
        [userId, contextAlias, nextContextAlias]
      )
      hostObject = fixture({
        plural: 'hosts',
        namespace: config.hostsNamespace,
        name: hostName,
        uid: String((hostObject.object.metadata as Record<string, unknown>).uid),
        spec: { contextRef: nextContextAlias },
      })
      kubernetesApi.put(hostObject.plural, hostObject.namespace, hostObject.object)
      await indexer.reconcileSource(hostSource)
      const refreshedCatalog = await buildAccessCatalog(
        { session, families: ['context'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      const refreshedContext = refreshedCatalog.items.find(
        item => item.resource.logicalId === canonicalContextId
      )
      expect(refreshedContext?.accessPaths).toHaveLength(1)

      const oldContextPathId = refreshedContext!.accessPaths[0].accessPathId
      const recreatedUid = randomUUID()
      contextObject = fixture({
        plural: 'contexts',
        namespace: config.contextsNamespace,
        name: contextName,
        uid: recreatedUid,
        spec: {
          contextId: nextContextAlias,
          mcpServers: [mcpName],
          sharedFileSystems: [{ name: sharedFilesystemName, mountPath: '/workspace/m7' }],
        },
      })
      kubernetesApi.put(contextObject.plural, contextObject.namespace, contextObject.object)
      await indexer.reconcileSource(contextSource)
      const recreatedCatalog = await buildAccessCatalog(
        { session, families: ['context'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      const recreatedContext = recreatedCatalog.items.find(
        item => item.resource.logicalId === canonicalContextId
      )
      expect(recreatedContext?.resource.providerUid).toBe(recreatedUid)
      expect(recreatedContext?.accessPaths.map(path => path.accessPathId)).not.toContain(
        oldContextPathId
      )
      await expect(
        resolveLiveAuthorization(
          {
            session,
            requiredCapability: 'context.read',
            resource: canonicalResourceIdentity(refreshedContext!.resource),
            requestedAccessPathId: oldContextPathId,
          },
          { transaction: transaction(databasePool), gateway }
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
      kubernetesApi.delete(hostObject.plural, hostObject.namespace, hostName)
      kubernetesApi.delete(contextObject.plural, contextObject.namespace, contextName)
      kubernetesApi.delete('contexts', config.contextsNamespace, duplicateAliasName)
      kubernetesApi.delete('contexts', config.contextsNamespace, contextAlias)
      kubernetesApi.delete(mcpObject.plural, mcpObject.namespace, mcpName)
      kubernetesApi.delete(
        sharedFilesystemObject.plural,
        sharedFilesystemObject.namespace,
        sharedFilesystemName
      )
      await indexer.reconcileSource(hostSource)
      await indexer.reconcileSource(contextSource)
      await indexer.reconcileSource(mcpSource)
      await indexer.reconcileSource(sharedFilesystemSource)
    }
  })

  it('excludes an ineligible sibling Host from selected MCP hydration', async () => {
    const hostSource = operationalSourceSpecs.find(value => value.family === 'host')!
    const selectedMcpPathDescriptors = async () => {
      const catalog = await buildAccessCatalog(
        { session, families: ['mcp_server'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      const item = catalog.items.find(
        value => value.resource.logicalId === `${config.mcpServersNamespace}/catalog-mcp`
      )
      expect(catalog.complete).toBe(true)
      expect(catalog.partialErrors).toEqual([])
      expect(item).toBeDefined()
      return item!.accessPaths.map(path => JSON.stringify(path.behaviorDescriptors.runtime)).sort()
    }
    const beforeSibling = await selectedMcpPathDescriptors()
    const disabledHost = fixture({
      plural: 'hosts',
      namespace: config.hostsNamespace,
      name: 'disabled-catalog-host',
      uid: 'disabled-catalog-host-uid',
      spec: { enabled: false, contextRef: 'catalog-context' },
    })
    kubernetesApi.put(disabledHost.plural, disabledHost.namespace, disabledHost.object)
    await indexer.reconcileSource(hostSource)
    await databasePool.query(
      `INSERT INTO user_agents(user_id, agent_name) VALUES ($1, 'disabled-catalog-host')`,
      [userId]
    )

    try {
      const disabledEdge = await databasePool.query<{ relationship_instance_id: string }>(
        `SELECT relationship_instance_id
           FROM operational_resource_relationships
          WHERE environment_id = $1 AND source_type = 'host'
            AND source_id = $2 AND relationship_type = 'uses_context'
            AND target_id = $3`,
        [
          environmentId,
          `${config.hostsNamespace}/disabled-catalog-host`,
          `${config.contextsNamespace}/catalog-context`,
        ]
      )
      const enabledEdge = await databasePool.query<{ relationship_instance_id: string }>(
        `SELECT relationship_instance_id
           FROM operational_resource_relationships
          WHERE environment_id = $1 AND source_type = 'host'
            AND source_id = $2 AND relationship_type = 'uses_context'
            AND target_id = $3`,
        [
          environmentId,
          `${config.hostsNamespace}/catalog-host`,
          `${config.contextsNamespace}/catalog-context`,
        ]
      )
      const directContextEdge = await databasePool.query<{ relationship_instance_id: string }>(
        `SELECT relationship_instance_id
           FROM operational_resource_relationships
          WHERE environment_id = $1 AND source_type = 'context'
            AND source_id = $2 AND relationship_type = 'includes_mcp_server'
            AND target_id = $3`,
        [
          environmentId,
          `${config.contextsNamespace}/catalog-context`,
          `${config.mcpServersNamespace}/catalog-mcp`,
        ]
      )
      expect(disabledEdge.rows).toHaveLength(1)
      expect(enabledEdge.rows).toHaveLength(1)
      expect(directContextEdge.rows).toHaveLength(1)

      await expect(selectedMcpPathDescriptors()).resolves.toEqual(beforeSibling)
    } finally {
      await databasePool.query(
        `DELETE FROM user_agents WHERE user_id = $1 AND agent_name = 'disabled-catalog-host'`,
        [userId]
      )
      kubernetesApi.delete(disabledHost.plural, disabledHost.namespace, 'disabled-catalog-host')
      await indexer.reconcileSource(hostSource)
    }
  })

  it('keeps a selected MCP path available when its Context has a dangling sibling mount', async () => {
    const contextSource = operationalSourceSpecs.find(value => value.family === 'context')!
    const contextName = `catalog-context-dangling-sibling-${randomBytes(5).toString('hex')}`
    const missingFilesystemName = `catalog-filesystem-missing-${randomBytes(5).toString('hex')}`
    const baseline = await buildAccessCatalog(
      { session, families: ['mcp_server', 'shared_filesystem'], limit: 100 },
      { transaction: transaction(databasePool) }
    )
    const baselineItem = baseline.items.find(
      value => value.resource.logicalId === `${config.mcpServersNamespace}/catalog-mcp`
    )
    expect(baseline.complete).toBe(true)
    expect(baselineItem).toBeDefined()
    const baselinePathCount = baselineItem!.accessPaths.length
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
    await indexer.reconcileSource(contextSource)
    await databasePool.query(`INSERT INTO user_contexts(user_id, context_id) VALUES ($1, $2)`, [
      userId,
      contextName,
    ])

    try {
      const persistedEdge = await databasePool.query<{ target_id: string }>(
        `SELECT target_id
           FROM operational_resource_relationships
          WHERE environment_id = $1
            AND source_type = 'context'
            AND source_id = $2
            AND relationship_type = 'mounts_shared_filesystem'`,
        [environmentId, `${config.contextsNamespace}/${contextName}`]
      )
      const persistedTarget = await databasePool.query(
        `SELECT 1 FROM operational_resource_index
          WHERE environment_id = $1 AND resource_type = 'shared_filesystem' AND logical_id = $2`,
        [environmentId, persistedEdge.rows[0]?.target_id]
      )
      expect(persistedEdge.rows).toHaveLength(1)
      expect(persistedTarget.rows).toHaveLength(0)

      const catalog = await buildAccessCatalog(
        { session, families: ['mcp_server', 'shared_filesystem'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      const item = catalog.items.find(
        value => value.resource.logicalId === `${config.mcpServersNamespace}/catalog-mcp`
      )
      expect(catalog.complete).toBe(true)
      expect(catalog.partialErrors).toEqual([])
      expect(item?.accessPaths).toHaveLength(baselinePathCount + 1)
      for (const path of item!.accessPaths) {
        await expect(
          resolveLiveAuthorization(
            {
              session,
              requiredCapability: 'mcp_server.read',
              resource: canonicalResourceIdentity(item!.resource),
              requestedAccessPathId: path.accessPathId,
            },
            { transaction: transaction(databasePool), gateway }
          )
        ).resolves.toEqual(
          expect.objectContaining({
            status: 'allowed',
            selectedPath: expect.objectContaining({ id: path.accessPathId }),
          })
        )
      }
    } finally {
      await databasePool.query(`DELETE FROM user_contexts WHERE user_id = $1 AND context_id = $2`, [
        userId,
        contextName,
      ])
      kubernetesApi.delete(siblingContext.plural, siblingContext.namespace, contextName)
      await indexer.reconcileSource(contextSource)
    }
  })

  it('returns a retryable Host partial without masking an unrelated User', async () => {
    const hostSource = operationalSourceSpecs.find(value => value.family === 'host')!
    const contextSource = operationalSourceSpecs.find(value => value.family === 'context')!
    const hostName = `catalog-host-dangling-root-${randomBytes(5).toString('hex')}`
    const contextName = `catalog-context-dangling-root-${randomBytes(5).toString('hex')}`
    const missingFilesystemName = `catalog-filesystem-missing-${randomBytes(5).toString('hex')}`
    const danglingContext = fixture({
      plural: 'contexts',
      namespace: config.contextsNamespace,
      name: contextName,
      uid: randomUUID(),
      spec: {
        sharedFileSystems: [{ name: missingFilesystemName, mountPath: '/workspace/dangling' }],
      },
    })
    const danglingHost = fixture({
      plural: 'hosts',
      namespace: config.hostsNamespace,
      name: hostName,
      uid: randomUUID(),
      spec: {
        contextRef: contextName,
        model: { provider: 'openai', name: 'test-model' },
      },
    })
    kubernetesApi.put(danglingContext.plural, danglingContext.namespace, danglingContext.object)
    kubernetesApi.put(danglingHost.plural, danglingHost.namespace, danglingHost.object)
    await databasePool.query(`INSERT INTO user_agents(user_id, agent_name) VALUES ($1, $2)`, [
      userId,
      hostName,
    ])
    await indexer.reconcileSource(contextSource)
    await indexer.reconcileSource(hostSource)

    try {
      const indexedHost = await databasePool.query(
        `SELECT logical_id
           FROM operational_resource_index
          WHERE environment_id = $1 AND resource_type = 'host' AND logical_id = $2`,
        [environmentId, `${config.hostsNamespace}/${hostName}`]
      )
      const danglingContextEdge = await databasePool.query(
        `SELECT target_id
           FROM operational_resource_relationships
          WHERE environment_id = $1 AND source_type = 'host' AND source_id = $2
            AND relationship_type = 'uses_context'`,
        [environmentId, `${config.hostsNamespace}/${hostName}`]
      )
      expect(indexedHost.rows).toHaveLength(1)
      expect(danglingContextEdge.rows).toEqual([
        expect.objectContaining({
          target_id: `${config.contextsNamespace}/${contextName}`,
        }),
      ])
      const graphBudget = AccessExecutionBudget.create('catalog')
      try {
        const graphs = await loadOperationalResourceGraphs({
          db: databasePool,
          budget: graphBudget,
          environmentId,
          roots: [
            {
              resourceType: 'host',
              logicalId: `${config.hostsNamespace}/${hostName}`,
            },
          ],
        })
        expect(
          graphs.get(operationalResourceGraphKey('host', `${config.hostsNamespace}/${hostName}`))
        ).toEqual(
          expect.objectContaining({
            status: 'unavailable',
            safeCode: 'operational_related_resource_incomplete',
          })
        )
      } finally {
        graphBudget.close()
      }
      await expect(
        resolveLiveAuthorization(
          {
            session,
            requiredCapability: 'host.read',
            resource: canonicalResourceIdentity({
              environmentId,
              type: 'host',
              logicalId: `${config.hostsNamespace}/${hostName}`,
              displayName: hostName,
            }),
          },
          { transaction: transaction(databasePool), gateway }
        )
      ).resolves.toEqual(
        expect.objectContaining({
          status: 'unavailable',
          dependencyClass: 'operational_resource_store',
          retryable: true,
        })
      )
      const aggregate = await buildAccessCatalog(
        { session, families: ['user', 'host'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      expect(aggregate.complete).toBe(false)
      expect(aggregate.partialErrors).toContainEqual({
        producer: 'host',
        code: 'operational_related_resource_incomplete',
        retryable: true,
      })
      expect(
        aggregate.items.some(
          item => item.resource.logicalId === `${config.hostsNamespace}/${hostName}`
        )
      ).toBe(false)
      expect(aggregate.items.some(item => item.resource.type === 'user')).toBe(true)
      expect(
        aggregate.items.some(
          item => item.resource.logicalId === `${config.hostsNamespace}/catalog-host`
        )
      ).toBe(true)

      const issued = await createUserSession(
        {
          userId,
          email: `${userId}@example.test`,
          authenticationMethods: ['password'],
        },
        { db: databasePool as never }
      )
      const priorIndexerEnabled = config.operationalAccessIndexerEnabled
      const priorReadinessMaxAgeMs = config.operationalAccessReadinessMaxAgeMs
      const priorActivationRecord = config.userAccessCatalogActivationRecord
      config.operationalAccessIndexerEnabled = true
      config.operationalAccessReadinessMaxAgeMs = 60_000
      config.userAccessCatalogActivationRecord = JSON.stringify({
        version: 1,
        active: true,
        revision: 'r35-h1-root-local-partial',
        acceptedBy: 'realpg-test-harness',
        acceptedAt: new Date().toISOString(),
        catalogConfigurationRevision: catalogConfigurationRevision(configuredUserAccessIntent),
        requiredFamilies: CATALOG_FAMILIES,
        comparisonEvidence: CATALOG_FAMILIES.map(family => ({
          family,
          attempted: 1,
          completed: 1,
          reference: 'realpg-test-harness',
        })),
      })
      try {
        const app = express()
        app.use(createExternalAccessRouter(gateway))
        const mounted = await request(app)
          .get('/external/access/catalog')
          .set('x-user-session-token', issued.token)
        expect(mounted.status).toBe(200)
        expect(mounted.body.complete).toBe(false)
        expect(mounted.body.partialErrors).toContainEqual({
          producer: 'host',
          code: 'operational_related_resource_incomplete',
          retryable: true,
        })
        expect(
          mounted.body.items.some(
            (item: { resource?: { logicalId?: string } }) =>
              item.resource?.logicalId === `${config.hostsNamespace}/${hostName}`
          )
        ).toBe(false)
        expect(
          mounted.body.items.some(
            (item: { resource?: { type?: string } }) => item.resource?.type === 'user'
          )
        ).toBe(true)
      } finally {
        config.operationalAccessIndexerEnabled = priorIndexerEnabled
        config.operationalAccessReadinessMaxAgeMs = priorReadinessMaxAgeMs
        config.userAccessCatalogActivationRecord = priorActivationRecord
      }

      const firstPage = await buildAccessCatalog(
        { session, families: ['host'], limit: 1 },
        { transaction: transaction(databasePool) }
      )
      expect(firstPage.nextCursor).not.toBeNull()
      const progressed = await buildAccessCatalog(
        { session, families: ['host'], limit: 1, cursor: firstPage.nextCursor },
        { transaction: transaction(databasePool) }
      )
      expect(progressed.complete).toBe(false)
      expect(progressed.partialErrors).toContainEqual({
        producer: 'host',
        code: 'operational_related_resource_incomplete',
        retryable: true,
      })
      expect(progressed.items).toEqual([])
      expect(progressed.nextCursor).toBeNull()
    } finally {
      await databasePool.query(`DELETE FROM user_agents WHERE user_id = $1 AND agent_name = $2`, [
        userId,
        hostName,
      ])
      kubernetesApi.delete(danglingHost.plural, danglingHost.namespace, hostName)
      kubernetesApi.delete(danglingContext.plural, danglingContext.namespace, contextName)
      await indexer.reconcileSource(hostSource)
      await indexer.reconcileSource(contextSource)
    }
  })

  it('binds producer-backed runtime actions to complete source-derived behavior', async () => {
    const issued = await createUserSession(
      {
        userId,
        email: `${userId}@example.test`,
        authenticationMethods: ['password'],
      },
      { db: databasePool as never }
    )
    const actionSession: ExternalSessionAuthorityContext = {
      contract: 'v2',
      userId,
      sid: issued.identity.sid,
      jti: issued.identity.jti,
      sessionVersion: issued.identity.sessionVersion,
    }
    const operations = [
      {
        operationId: 'chat.message.invoke' as const,
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'host',
          logicalId: `${config.hostsNamespace}/catalog-host`,
        }),
        resolutionTarget: {
          hostRef: `${config.hostsNamespace}/catalog-host`,
          channelType: 'rpc',
          channelId: 'catalog-host',
          messageId: randomUUID(),
        },
        actionTarget: {
          hostRef: `${config.hostsNamespace}/catalog-host`,
          channelType: 'rpc',
          channelId: 'catalog-host',
        },
        allocateChatMessageId: true,
      },
      {
        operationId: 'mcp.invoke' as const,
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'mcp_server',
          logicalId: `${config.mcpServersNamespace}/catalog-mcp`,
        }),
        resolutionTarget: {
          serverNamespace: config.mcpServersNamespace,
          serverName: 'catalog-mcp',
          toolName: 'lookup',
        },
        actionTarget: {
          serverNamespace: config.mcpServersNamespace,
          serverName: 'catalog-mcp',
          toolName: 'lookup',
        },
        allocateChatMessageId: false,
      },
      {
        operationId: 'workflow.trigger' as const,
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'workflow_recipe',
          logicalId: `${config.sandboxNamespace}/catalog-recipe`,
        }),
        resolutionTarget: {
          recipeNamespace: config.sandboxNamespace,
          recipeName: 'catalog-recipe',
        },
        actionTarget: {
          recipeNamespace: config.sandboxNamespace,
          recipeName: 'catalog-recipe',
        },
        allocateChatMessageId: false,
      },
      {
        operationId: 'context.use' as const,
        resource: canonicalResourceIdentity({
          environmentId,
          type: 'context',
          logicalId: `${config.contextsNamespace}/catalog-context`,
        }),
        resolutionTarget: {
          contextNamespace: config.contextsNamespace,
          contextName: 'catalog-context',
          action: 'use',
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
        {
          session: actionSession,
          operationId: operation.operationId,
          resource: operation.resource,
          operationTarget: operation.resolutionTarget,
        },
        { transaction: transaction(databasePool), gateway }
      )
      const accessPathIds =
        produced.status === 'allowed'
          ? [produced.selectedPath.id]
          : produced.status === 'access_path_required'
            ? produced.safePathDescriptors.map(path => path.id)
            : []
      expect(
        accessPathIds,
        `${operation.operationId}: ${JSON.stringify(produced)}`
      ).not.toHaveLength(0)

      for (const requestedAccessPathId of accessPathIds) {
        const authorized = await authorizeActionV2(
          {
            session: actionSession,
            requested: { version: 2, requestedAccessPathId },
            operationId: operation.operationId,
            resource: operation.resource,
            operationTarget: operation.actionTarget,
            allocateChatMessageId: operation.allocateChatMessageId,
            gateway,
          },
          {
            messageId: () => '00000000-0000-4000-8000-000000000001',
            authorizationOptions: { transaction: transaction(databasePool) },
          }
        )
        outcomes.push({
          operationId: operation.operationId,
          accessPathId: requestedAccessPathId,
          status: authorized.status,
        })
      }
    }
    expect(outcomes).toEqual(outcomes.map(outcome => ({ ...outcome, status: 'allowed' })))

    const manageDenied = await authorizeActionV2(
      {
        session: actionSession,
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
      },
      { authorizationOptions: { transaction: transaction(databasePool) } }
    )
    expect(manageDenied).toEqual({ status: 'denied', code: 'forbidden' })
  })

  it('authorizes chat and session actions through Host grants without changing signed resource identity', async () => {
    const issued = await createUserSession(
      {
        userId,
        email: `${userId}@example.test`,
        authenticationMethods: ['password'],
      },
      { db: databasePool as never }
    )
    const actionSession: ExternalSessionAuthorityContext = {
      contract: 'v2',
      userId,
      sid: issued.identity.sid,
      jti: issued.identity.jti,
      sessionVersion: issued.identity.sessionVersion,
    }
    const hostRef = `${config.hostsNamespace}/catalog-host`
    const hostCatalog = await buildAccessCatalog(
      { session: actionSession, families: ['host'], limit: 20 },
      { transaction: transaction(databasePool) }
    )
    const hostItem = hostCatalog.items.find(item => item.resource.logicalId === hostRef)
    const directPath = hostItem?.accessPaths.find(path => path.kind === 'direct')
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
        operationTarget: {
          hostRef,
          agent: 'main',
          chatId: 'chat-a',
        },
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
      const result = await authorizeActionV2(
        {
          session: actionSession,
          requested: { version: 2, requestedAccessPathId: directPath!.accessPathId },
          operationId: action.operationId,
          resource: action.resource,
          operationTarget: action.target,
          allocateChatMessageId: false,
          gateway,
        },
        { authorizationOptions: { transaction: transaction(databasePool) } }
      )
      expect(result.status, action.operationId).toBe('allowed')
      if (result.status === 'allowed') {
        expect(result.context.resource).toEqual(action.resource)
        expect(result.context.target).toEqual(action.target)
      }
    }

    await databasePool.query(
      `UPDATE external_user_sessions SET revoked_at = NOW() WHERE sid = $1`,
      [issued.identity.sid]
    )
    const revoked = await authorizeActionV2(
      {
        session: actionSession,
        requested: { version: 2, requestedAccessPathId: directPath!.accessPathId },
        operationId: 'chat.read',
        resource: canonicalResourceIdentity({ environmentId, type: 'chat', logicalId: 'chat-a' }),
        operationTarget: { hostRef, agent: 'main', chatId: 'chat-a' },
        allocateChatMessageId: false,
        gateway,
      },
      { authorizationOptions: { transaction: transaction(databasePool) } }
    )
    expect(revoked).toEqual({ status: 'denied', code: 'session_not_live' })

    const ungrantedUserId = randomUUID()
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Un-granted Action User')`,
      [ungrantedUserId, `${ungrantedUserId}@example.test`]
    )
    const ungrantedIssued = await createUserSession(
      {
        userId: ungrantedUserId,
        email: `${ungrantedUserId}@example.test`,
        authenticationMethods: ['password'],
      },
      { db: databasePool as never }
    )
    const ungranted = await authorizeActionV2(
      {
        session: {
          contract: 'v2',
          userId: ungrantedUserId,
          sid: ungrantedIssued.identity.sid,
          jti: ungrantedIssued.identity.jti,
          sessionVersion: ungrantedIssued.identity.sessionVersion,
        },
        requested: { version: 2 },
        operationId: 'chat.read',
        resource: canonicalResourceIdentity({ environmentId, type: 'chat', logicalId: 'chat-a' }),
        operationTarget: { hostRef, agent: 'main', chatId: 'chat-a' },
        allocateChatMessageId: false,
        gateway,
      },
      { authorizationOptions: { transaction: transaction(databasePool) } }
    )
    expect(ungranted.status).not.toBe('allowed')
  })

  it('binds applicable budget policy but not mutable reservation consumption', async () => {
    const resource = canonicalResourceIdentity({
      environmentId,
      type: 'host',
      logicalId: `${config.hostsNamespace}/catalog-host`,
    })
    const readPathIds = async () => {
      const catalog = await buildAccessCatalog(
        { session, families: ['host'], limit: 20 },
        { transaction: transaction(databasePool) }
      )
      const item = catalog.items.find(value => value.resource.logicalId === resource.logicalId)
      expect(item).toBeDefined()
      return {
        direct: item!.accessPaths
          .filter(path => path.kind === 'direct')
          .map(path => ({ id: path.accessPathId, behavior: path.behaviorDescriptors })),
        team: item!.accessPaths
          .filter(path => path.kind === 'team')
          .map(path => ({ id: path.accessPathId, behavior: path.behaviorDescriptors })),
      }
    }
    const before = await readPathIds()
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

      const withPolicy = await readPathIds()
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
      expect(await readPathIds()).toEqual(withPolicy)

      await databasePool.query(
        `DELETE FROM team_contexts WHERE team_id = $1 AND context_id = 'catalog-context'`,
        [teamId]
      )
      const afterContextTeamRemoval = await readPathIds()
      expect(afterContextTeamRemoval.direct.map(path => path.behavior.budget)).toEqual(
        before.direct.map(path => path.behavior.budget)
      )
      await databasePool.query(
        `INSERT INTO team_contexts(team_id, context_id) VALUES ($1, 'catalog-context')`,
        [teamId]
      )
      const afterContextTeamRestore = await readPathIds()
      expect(afterContextTeamRestore.direct.map(path => path.behavior.budget)).toEqual(
        withPolicy.direct.map(path => path.behavior.budget)
      )

      await databasePool.query(`UPDATE token_budgets SET scope = $2::jsonb WHERE id = $1`, [
        budgetId,
        JSON.stringify({ team_id: [randomUUID()], host_ref: ['catalog-host'] }),
      ])
      const afterPolicyMutation = await readPathIds()
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
    const resource = canonicalResourceIdentity({
      environmentId,
      type: 'host',
      logicalId: `${config.hostsNamespace}/catalog-host`,
    })
    const readBudgetDescriptors = async () => {
      const catalog = await buildAccessCatalog(
        { session, families: ['host'], limit: 20 },
        { transaction: transaction(databasePool) }
      )
      const item = catalog.items.find(value => value.resource.logicalId === resource.logicalId)
      expect(item).toBeDefined()
      return item!.accessPaths.map(path => path.behaviorDescriptors.budget)
    }

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
    const readRecipeBudgets = async () => {
      const catalog = await buildAccessCatalog(
        { session, families: ['workflow_recipe'], limit: 20 },
        { transaction: transaction(databasePool) }
      )
      const item = catalog.items.find(value => value.resource.logicalId.endsWith('/catalog-recipe'))
      expect(item).toBeDefined()
      return item!.accessPaths.map(path => ({
        kind: path.kind,
        budget: path.behaviorDescriptors.budget,
      }))
    }
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
    const originalHost = operationalFixtures.find(value => value.plural === 'hosts')!
    const source = operationalSourceSpecs.find(value => value.family === 'host')!
    const resource = canonicalResourceIdentity({
      environmentId,
      type: 'host',
      logicalId: `${config.hostsNamespace}/catalog-host`,
    })
    const readPaths = async () => {
      const catalog = await buildAccessCatalog(
        { session, families: ['host'], limit: 20 },
        { transaction: transaction(databasePool) }
      )
      return catalog.items
        .find(value => value.resource.logicalId === resource.logicalId)!
        .accessPaths.map(path => ({
          id: path.accessPathId,
          behavior: path.behaviorDescriptors,
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    }
    const baseline = await readPaths()
    const behaviorSet = (paths: Awaited<ReturnType<typeof readPaths>>) =>
      paths.map(path => JSON.stringify(path.behavior)).sort()
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
        const updated = {
          ...originalHost.object,
          metadata: { ...originalMetadata, resourceVersion: String(index + 2) },
          spec: { ...originalSpec, ...change },
        }
        kubernetesApi.put(originalHost.plural, originalHost.namespace, updated)
        await indexer.reconcileSource(source)
        const changed = await readPaths()
        expect(changed.map(path => path.id)).not.toEqual(baseline.map(path => path.id))

        kubernetesApi.put(originalHost.plural, originalHost.namespace, originalHost.object)
        await indexer.reconcileSource(source)
        expect(behaviorSet(await readPaths())).toEqual(behaviorSet(baseline))
      }
    } finally {
      kubernetesApi.put(originalHost.plural, originalHost.namespace, originalHost.object)
      await indexer.reconcileSource(source)
    }
  })

  it('binds a complete empty Host provider allow policy instead of treating it as absent', async () => {
    const originalHost = operationalFixtures.find(value => value.plural === 'hosts')!
    const source = operationalSourceSpecs.find(value => value.family === 'host')!
    const originalMetadata = originalHost.object.metadata as Record<string, unknown>
    const originalSpec = originalHost.object.spec as Record<string, unknown>
    const withoutModel = { ...originalSpec }
    delete withoutModel.model

    try {
      kubernetesApi.put(originalHost.plural, originalHost.namespace, {
        ...originalHost.object,
        metadata: { ...originalMetadata, resourceVersion: 'empty-model-policy' },
        spec: withoutModel,
      })
      await indexer.reconcileSource(source)
      await databasePool.query(
        `UPDATE llm_allowed_models SET enabled = FALSE
          WHERE provider = 'openai' AND model = 'test-model'`
      )

      const catalog = await buildAccessCatalog(
        { session, families: ['host'], limit: 20 },
        { transaction: transaction(databasePool) }
      )
      const host = catalog.items.find(value => value.resource.logicalId.endsWith('/catalog-host'))
      expect(host).toBeDefined()
      expect(host!.accessPaths.length).toBeGreaterThan(0)
      for (const path of host!.accessPaths) {
        expect(path.behaviorDescriptors.providerModelPolicy).toMatchObject({
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
      await indexer.reconcileSource(source)
    }
  })

  it('binds derived MCP paths to their selected Context and ignores sibling Contexts', async () => {
    const catalogMcp = canonicalResourceIdentity({
      environmentId,
      type: 'mcp_server',
      logicalId: `${config.mcpServersNamespace}/catalog-mcp`,
    })
    const readPaths = async () => {
      const catalog = await buildAccessCatalog(
        { session, families: ['mcp_server'], limit: 100 },
        { transaction: transaction(databasePool) }
      )
      const item = catalog.items.find(value => value.resource.logicalId === catalogMcp.logicalId)
      expect(item).toBeDefined()
      return item!.accessPaths
        .map(path => ({ id: path.accessPathId, behavior: path.behaviorDescriptors }))
        .sort((left, right) => left.id.localeCompare(right.id))
    }
    const before = await readPaths()
    const behaviorSet = (paths: Awaited<ReturnType<typeof readPaths>>) =>
      paths.map(path => JSON.stringify(path.behavior)).sort()
    const unrelated = fixture({
      plural: 'contexts',
      namespace: config.contextsNamespace,
      name: 'unrelated-context',
      uid: 'unrelated-context-uid',
      spec: { mcpServers: ['catalog-mcp'], sharedFileSystems: [] },
    })
    const contextSource = operationalSourceSpecs.find(value => value.family === 'context')!
    const originalContext = operationalFixtures.find(
      value =>
        value.plural === 'contexts' &&
        value.object.metadata &&
        (value.object.metadata as Record<string, unknown>).name === 'catalog-context'
    )!
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
      await indexer.reconcileSource(contextSource)
      const withSibling = await readPaths()
      expect(behaviorSet(withSibling)).toEqual(behaviorSet(before))

      kubernetesApi.put(originalContext.plural, originalContext.namespace, changedContext)
      await indexer.reconcileSource(contextSource)
      const selectedMutation = await readPaths()
      expect(behaviorSet(selectedMutation)).not.toEqual(behaviorSet(before))

      kubernetesApi.put(originalContext.plural, originalContext.namespace, originalContext.object)
      await indexer.reconcileSource(contextSource)
      await expect(readPaths().then(behaviorSet)).resolves.toEqual(behaviorSet(before))
    } finally {
      kubernetesApi.delete(unrelated.plural, unrelated.namespace, 'unrelated-context')
      kubernetesApi.put(originalContext.plural, originalContext.namespace, originalContext.object)
      await indexer.reconcileSource(contextSource)
    }
  })

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

  it('discovers a Host through a direct user grant without a team grant', async () => {
    const directOnlyUserId = randomUUID()
    const directOnlySession: ExternalSessionAuthorityContext = {
      contract: 'v1',
      userId: directOnlyUserId,
      tokenHash: randomBytes(32).toString('hex'),
      issuedAt: Math.floor(Date.now() / 1_000),
      authGeneration: 1,
    }
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Direct-only Catalog User')`,
      [directOnlyUserId, `${directOnlyUserId}@example.test`]
    )
    await databasePool.query(
      `INSERT INTO user_agents(user_id, agent_name) VALUES ($1, 'catalog-host')`,
      [directOnlyUserId]
    )

    const catalog = await buildAccessCatalog(
      { session: directOnlySession, families: ['host'], limit: 10 },
      { transaction: transaction(databasePool) }
    )
    expect(catalog.items.map(item => item.resource.logicalId)).toEqual([
      `${config.hostsNamespace}/catalog-host`,
    ])
    expect(catalog.items[0]?.accessPaths).toHaveLength(1)
    expect(catalog.items[0]?.accessPaths[0]).toEqual(expect.objectContaining({ kind: 'direct' }))
    expect(catalog.items[0]?.accessPaths[0]).not.toHaveProperty('teamId')
  })

  it('discovers a team-only Host and revokes it live without replacing the user session', async () => {
    const teamOnlyUserId = randomUUID()
    const teamOnlyTeamId = randomUUID()
    const teamOnlySession: ExternalSessionAuthorityContext = {
      contract: 'v1',
      userId: teamOnlyUserId,
      tokenHash: randomBytes(32).toString('hex'),
      issuedAt: Math.floor(Date.now() / 1_000),
      authGeneration: 1,
    }
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Team-only Catalog User')`,
      [teamOnlyUserId, `${teamOnlyUserId}@example.test`]
    )
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Team-only Catalog Team')`, [
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

    const firstCatalog = await buildAccessCatalog(
      { session: teamOnlySession, families: ['host'], limit: 10 },
      { transaction: transaction(databasePool) }
    )
    expect(firstCatalog.items.map(item => item.resource.logicalId)).toEqual([
      `${config.hostsNamespace}/catalog-host`,
    ])
    expect(firstCatalog.items[0]?.accessPaths).toEqual([
      expect.objectContaining({
        kind: 'team',
        safeTeamDescriptor: expect.objectContaining({ teamId: teamOnlyTeamId }),
      }),
    ])

    const teamPath = firstCatalog.items[0]!.accessPaths[0]!
    await expect(
      resolveLiveAuthorization(
        {
          session: teamOnlySession,
          requiredCapability: 'host.read',
          resource: canonicalResourceIdentity(firstCatalog.items[0]!.resource),
          requestedAccessPathId: teamPath.accessPathId,
        },
        { transaction: transaction(databasePool), gateway }
      )
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'allowed',
        selectedPath: expect.objectContaining({ kind: 'team', teamId: teamOnlyTeamId }),
      })
    )

    await databasePool.query(
      `UPDATE team_members SET status = 'deleted' WHERE team_id = $1 AND user_id = $2`,
      [teamOnlyTeamId, teamOnlyUserId]
    )

    const afterRevocation = await buildAccessCatalog(
      { session: teamOnlySession, families: ['host'], limit: 10 },
      { transaction: transaction(databasePool) }
    )
    expect(afterRevocation.items).toEqual([])
    await expect(
      resolveLiveAuthorization(
        {
          session: teamOnlySession,
          requiredCapability: 'host.read',
          resource: canonicalResourceIdentity(firstCatalog.items[0]!.resource),
          requestedAccessPathId: teamPath.accessPathId,
        },
        { transaction: transaction(databasePool), gateway }
      )
    ).resolves.toEqual(expect.objectContaining({ status: 'not_found', code: 'not_found' }))
  })

  it('uses real Kubernetes list and exact-read wire boundaries', async () => {
    const initialWireRequests = kubernetesApi.requests.slice(0, initialWireRequestCount)
    const listRequests = initialWireRequests.filter(request => !request.watch && !request.name)
    expect(listRequests).toHaveLength(operationalSourceSpecs.length)
    expect(listRequests.map(request => `${request.namespace}/${request.plural}`).sort()).toEqual(
      operationalSourceSpecs.map(source => `${source.namespace}/${source.plural}`).sort()
    )
    expect(initialListRequests).toHaveLength(operationalSourceSpecs.length)
    expect(initialListRequests.sort()).toEqual(
      operationalSourceSpecs.map(source => `${source.namespace}/${source.plural}`).sort()
    )
    expect(
      kubernetesApi.requests
        .filter(request => !request.watch && !request.name)
        .slice(0, initialListRequests.length)
        .every(request => request.limit !== null)
    ).toBe(true)
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

  it('binds the current source-family generation into operational path identity', async () => {
    const readPathIds = async () => {
      const catalog = await buildAccessCatalog(
        { session, families: ['host'], limit: 20 },
        { transaction: transaction(databasePool) }
      )
      const item = catalog.items.find(value => value.resource.logicalId.endsWith('/catalog-host'))
      expect(item).toBeDefined()
      return item!.accessPaths.map(path => path.accessPathId).sort()
    }
    const before = await readPathIds()
    const hostSource = operationalSourceSpecs.find(value => value.family === 'host')!

    await indexer.reconcileSource(hostSource)

    expect(await readPathIds()).not.toEqual(before)
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
