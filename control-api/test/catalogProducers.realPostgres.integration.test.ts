import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import { initDb } from '../src/db.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import {
  CATALOG_FAMILIES,
  type CatalogFamily,
  type CatalogOperationalSourceState,
  type CatalogRequestContext,
  catalogKey,
} from '../src/services/access/catalogContracts.js'
import { requireCatalogProducer } from '../src/services/access/catalogProducers.js'
import { loadDatabaseCandidates } from '../src/services/access/databaseAuthorityCandidates.js'
import { OperationalAccessIndex } from '../src/services/access/operationalAccessIndex.js'
import {
  OPERATIONAL_SOURCE_FAMILIES,
  canonicalEnvironmentId,
  projectOperationalObject,
} from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import { parseWorkflowTriggerIntent } from '../src/services/userApprovalRequestService.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

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

describeRealPostgres('catalog producer SQL on real PostgreSQL', () => {
  const database = `control_api_catalog_producer_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const environmentId = canonicalEnvironmentId()
  const userId = randomUUID()
  let adminPool: Pool
  let databasePool: Pool

  async function insertUser(): Promise<string> {
    const id = randomUUID()
    await databasePool.query(`INSERT INTO users(id, email, name) VALUES ($1, $2, 'Catalog User')`, [
      id,
      `${id}@example.test`,
    ])
    return id
  }

  async function observe(user: string, family: CatalogFamily, ids: readonly string[]) {
    const budget = AccessExecutionBudget.create('catalog')
    const principal = {
      userId: user,
      sessionContract: 'v1' as const,
      sessionRevision: '1',
      userRevision: '1',
      authorizationRevision: '1',
      memberships: [],
    }
    const context: CatalogRequestContext = {
      db: databasePool,
      budget,
      principal,
      environmentId,
      sourceStates: new Map(),
    }
    try {
      const producer = requireCatalogProducer(family)
      const page = await producer.listCanonicalKeys(
        context,
        { afterKey: null, exhausted: false },
        100
      )
      const hydrated = await producer.hydrateCanonicalKeys(
        context,
        [...ids].sort().map(id => catalogKey(environmentId, family, id))
      )
      const resources = Array.isArray(hydrated) ? hydrated : hydrated.resources
      const authority: string[] = []
      for (const id of ids) {
        const result = await loadDatabaseCandidates({
          db: databasePool,
          budget,
          snapshot: { ...principal, sessionLive: true, resourceRevision: '1' },
          resource: canonicalResourceIdentity({ environmentId, type: family, logicalId: id }),
        })
        if (result.exists) authority.push(id)
      }
      return {
        keys: page.candidates.map(candidate => candidate.key[2]).filter(id => ids.includes(id)),
        hydrated: resources.map(resource => resource.key[2]),
        authority,
      }
    } finally {
      budget.close()
    }
  }

  function expectVisible(result: Awaited<ReturnType<typeof observe>>, expected: readonly string[]) {
    expect(result.keys.sort()).toEqual([...expected].sort())
    expect(result.hydrated.sort()).toEqual([...expected].sort())
    expect(result.authority.sort()).toEqual([...expected].sort())
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(databasePool)
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

  it('S3 C7 restricts team run paths to the actor or team-scoped runs', async () => {
    const alice = await insertUser()
    const bob = await insertUser()
    const team = randomUUID()
    const ids = Array.from({ length: 7 }, () => randomUUID())
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Run Team')`, [team])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active'), ($1, $3, 'member', 'active')`,
      [team, alice, bob]
    )
    await databasePool.query(
      `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
       VALUES ($1, 's3', 'team-run')`,
      [team]
    )
    await databasePool.query(
      `INSERT INTO workflow_runs(
         run_id, recipe_namespace, recipe_name, phase, actor_type, actor_id,
         team_id, usage_team_id, trigger_source
       ) VALUES
         ($1, 's3', 'team-run', 'Succeeded', 'user', $8, $10, NULL, 'onDemand'),
         ($2, 's3', 'team-run', 'Succeeded', 'user', $8, NULL, $10::text, 'onDemand'),
         ($3, 's3', 'team-run', 'Succeeded', 'user', $9, $10, NULL, 'onDemand'),
         ($4, 's3', 'team-run', 'Succeeded', 'scheduled', NULL, $10, NULL, 'schedule'),
         ($5, 's3', 'team-run', 'Succeeded', 'autonomous', NULL, NULL, $10::text, 'autonomous'),
         ($6, 's3', 'team-run', 'Succeeded', 'user', NULL, $10, NULL, 'onDemand'),
         ($7, 's3', 'team-run', 'Succeeded', 'admin', NULL, $10, NULL, 'onDemand')`,
      [...ids, alice, bob, team]
    )
    expectVisible(await observe(bob, 'workflow_run', ids), [ids[2]!, ids[3]!, ids[4]!, ids[5]!])
    expectVisible(await observe(alice, 'workflow_run', ids), [
      ids[0]!,
      ids[1]!,
      ids[3]!,
      ids[4]!,
      ids[5]!,
    ])
  })

  it('S3 TERRA1 uses the approval allowlist instead of team trigger grants', async () => {
    const member = await insertUser()
    const outsider = await insertUser()
    const team = randomUUID()
    const allowed = randomUUID()
    const denied = randomUUID()
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Approval Team')`, [team])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`,
      [team, member]
    )
    await databasePool.query(
      `INSERT INTO workflow_recipe_allowed_teams(recipe_namespace, recipe_name, team_id)
       VALUES ('s3', 'allowed', $1)`,
      [team]
    )
    await databasePool.query(
      `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
       VALUES ($1, 's3', 'trigger-only')`,
      [team]
    )
    await databasePool.query(
      `INSERT INTO workflow_approval_requests(id, recipe_namespace, recipe_name, expires_at,
         status, target_team_id, payload, idempotency_key, payload_hash)
       VALUES ($1, 's3', 'allowed', NOW() + INTERVAL '1 hour', 'pending', $3, '{}', $1::uuid::text, 'hash'),
              ($2, 's3', 'trigger-only', NOW() + INTERVAL '1 hour', 'pending', $3, '{}', $2::uuid::text, 'hash')`,
      [allowed, denied, team]
    )
    expectVisible(await observe(member, 'workflow_approval', [allowed, denied]), [allowed])
    expectVisible(await observe(outsider, 'workflow_approval', [allowed, denied]), [])
    await databasePool.query(`DELETE FROM workflow_recipe_allowed_teams WHERE team_id = $1`, [team])
    expectVisible(await observe(member, 'workflow_approval', [allowed, denied]), [])
  })

  it('S3 I7 binds the team approval candidate to the trigger requester', async () => {
    const requester = await insertUser()
    const teammate = await insertUser()
    const team = randomUUID()
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Requester Team')`, [team])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active'), ($1, $3, 'member', 'active')`,
      [team, requester, teammate]
    )
    await databasePool.query(
      `INSERT INTO workflow_recipe_allowed_teams(recipe_namespace, recipe_name, team_id)
       VALUES ('s3', 'requester', $1)`,
      [team]
    )
    const trigger = (requesterUserId?: unknown) => ({
      namespace: 's3',
      name: 'requester-trigger',
      caller: `user:${requester}`,
      ...(requesterUserId === undefined ? {} : { requesterUserId }),
    })
    const variants: ReadonlyArray<{
      name: string
      payload: Record<string, unknown>
      requesterVisible: boolean
      teammateVisible: boolean
    }> = [
      {
        name: 'requester B',
        payload: { metadata: { workflowTrigger: trigger(requester) } },
        requesterVisible: true,
        teammateVisible: false,
      },
      {
        name: 'no workflowTrigger',
        payload: { metadata: {} },
        requesterVisible: true,
        teammateVisible: true,
      },
      {
        name: "requester '  B  '",
        payload: { metadata: { workflowTrigger: trigger(`  ${requester}  `) } },
        requesterVisible: true,
        teammateVisible: false,
      },
      {
        name: 'requester U+00A0/U+3000 padded',
        payload: { metadata: { workflowTrigger: trigger(`\u00a0${requester}\u3000`) } },
        requesterVisible: true,
        teammateVisible: false,
      },
      {
        name: 'whitespace-only requester',
        payload: { metadata: { workflowTrigger: trigger(' \u00a0\u3000 ') } },
        requesterVisible: true,
        teammateVisible: true,
      },
      {
        name: "requester ''",
        payload: { metadata: { workflowTrigger: trigger('') } },
        requesterVisible: true,
        teammateVisible: true,
      },
      {
        name: 'requester 123',
        payload: { metadata: { workflowTrigger: trigger(123) } },
        requesterVisible: true,
        teammateVisible: true,
      },
    ]
    const authorityFor = async (user: string, approvalId: string) =>
      (await observe(user, 'workflow_approval', [approvalId])).authority

    try {
      for (const variant of variants) {
        const approvalId = randomUUID()
        await databasePool.query(
          `INSERT INTO workflow_approval_requests(
             id, recipe_namespace, recipe_name, expires_at, status, target_team_id,
             payload, idempotency_key, payload_hash
           ) VALUES ($1, 's3', 'requester', NOW() + INTERVAL '1 hour', 'pending', $2,
             $3::jsonb, $4, 'hash')`,
          [approvalId, team, JSON.stringify(variant.payload), `i7-${approvalId}`]
        )
        // The candidate SQL must agree with the parser the decide guard uses.
        const parsedRequester = parseWorkflowTriggerIntent(variant.payload)?.requesterUserId ?? null
        expect(parsedRequester === null || parsedRequester === requester).toBe(
          variant.requesterVisible
        )
        expect(parsedRequester === null || parsedRequester === teammate).toBe(
          variant.teammateVisible
        )
        expect(await authorityFor(requester, approvalId)).toEqual(
          variant.requesterVisible ? [approvalId] : []
        )
        expect(await authorityFor(teammate, approvalId)).toEqual(
          variant.teammateVisible ? [approvalId] : []
        )
      }
    } finally {
      await databasePool.query(`DELETE FROM workflow_approval_requests WHERE target_team_id = $1`, [
        team,
      ])
      await databasePool.query(`DELETE FROM workflow_recipe_allowed_teams WHERE team_id = $1`, [
        team,
      ])
      await databasePool.query(`DELETE FROM team_members WHERE team_id = $1`, [team])
      await databasePool.query(`DELETE FROM teams WHERE id = $1`, [team])
    }
  })

  it('orders and resumes arbitrary PostgreSQL text by exact UTF-8 bytes', async () => {
    const generated = fc.sample(
      fc
        .array(
          fc.constantFrom(
            'a',
            'z',
            'A',
            'Z',
            '0',
            '9',
            '-',
            '_',
            '.',
            '/',
            'é',
            'e\u0301',
            'Ω',
            '😀'
          ),
          { minLength: 1, maxLength: 12 }
        )
        .map(parts => parts.join('')),
      { seed: 106_026, numRuns: 200 }
    )
    const values = [
      ...new Set(['alpha', 'Zeta', 'a_b', 'a-b', 'é', 'e\u0301', 'Ω', '😀', ...generated]),
    ]
    const expected = [...values].sort((left, right) =>
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
    )
    const ordered = await databasePool.query(
      `SELECT value
         FROM unnest($1::text[]) value
        ORDER BY catalog_utf8_bytes(value)`,
      [values]
    )
    expect(ordered.rows.map(row => row.value)).toEqual(expected)

    for (const after of expected) {
      const resumed = await databasePool.query(
        `SELECT value
           FROM unnest($1::text[]) value
          WHERE catalog_utf8_bytes(value) > catalog_utf8_bytes($2)
          ORDER BY catalog_utf8_bytes(value)`,
        [values, after]
      )
      expect(resumed.rows.map(row => row.value)).toEqual(
        expected.filter(value => Buffer.from(value, 'utf8').compare(Buffer.from(after, 'utf8')) > 0)
      )
    }
  })

  it('proves native UUID order matches UTF-8 byte order for canonical UUID text', async () => {
    const values = [
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
      '00000000-0000-4000-8000-000000000000',
      '7fffffff-ffff-4fff-bfff-ffffffffffff',
      '80000000-0000-4000-8000-000000000000',
      '0fffffff-ffff-4fff-bfff-ffffffffffff',
    ]
    const expected = [...values].sort((left, right) =>
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
    )
    const ordered = await databasePool.query<{ value: string }>(
      `SELECT value::text AS value
         FROM unnest($1::uuid[]) AS candidate(value)
        ORDER BY value`,
      [values]
    )

    expect(ordered.rows.map(row => row.value)).toEqual(expected)
  })

  it('parses and executes every bounded key and selected-ID hydration query', async () => {
    const budget = AccessExecutionBudget.create('catalog')
    const sourceStates: CatalogOperationalSourceState[] = OPERATIONAL_SOURCE_FAMILIES.map(
      family => ({
        family,
        generation: '1',
        resourceVersion: '1',
        status: 'current',
      })
    )
    const context: CatalogRequestContext = {
      db: databasePool,
      budget,
      principal: {
        userId,
        sessionContract: 'v2',
        sessionRevision: '1',
        userRevision: '1',
        authorizationRevision: 'catalog-authorization-1',
        memberships: [],
      },
      environmentId,
      sourceStates: new Map(sourceStates.map(state => [state.family, state])),
    }
    const logicalId: Record<CatalogFamily, string> = {
      user: userId,
      team: randomUUID(),
      host: `${config.hostsNamespace}/host-a`,
      context: `${config.contextsNamespace}/context-a`,
      mcp_server: `${config.mcpServersNamespace}/server-a`,
      workflow_recipe: `${config.sandboxNamespace}/recipe-a`,
      workflow_run: randomUUID(),
      workflow_approval: randomUUID(),
      notification: randomUUID(),
      gfs_resource: randomUUID(),
      shared_filesystem: `${config.sharedFilesystemsNamespace}/filesystem-a`,
      sandbox_app: `${config.sandboxNamespace}/recipe-a`,
    }

    try {
      for (const family of CATALOG_FAMILIES) {
        const producer = requireCatalogProducer(family)
        try {
          const page = await producer.listCanonicalKeys(
            context,
            { afterKey: null, exhausted: false },
            2
          )
          expect(page.candidates).toEqual([])
          await expect(
            producer.hydrateCanonicalKeys(context, [
              catalogKey(environmentId, family, logicalId[family]),
            ])
          ).resolves.toEqual([])
        } catch (error) {
          throw new Error(`Producer ${family} failed`, { cause: error })
        }
      }
    } finally {
      budget.close()
    }
  })

  it('stages a producer-shaped Context with duplicate allowlist entries exactly once', async () => {
    const index = new OperationalAccessIndex(databasePool)
    const budget = AccessExecutionBudget.create('catalog')
    const contextName = `r55-m8-${randomBytes(6).toString('hex')}`
    const sourceId = `${config.contextsNamespace}/${contextName}`
    const projection = projectOperationalObject({
      environmentId,
      plural: 'contexts',
      namespace: config.contextsNamespace,
      object: {
        metadata: {
          name: contextName,
          namespace: config.contextsNamespace,
          uid: randomUUID(),
          resourceVersion: '1',
          generation: 1,
        },
        spec: {
          contextId: contextName,
          mcpServers: ['server-a', 'server-a', 'server-b'],
          sharedFileSystems: [
            { name: 'filesystem-a', mountPath: '/workspace/a' },
            { name: 'filesystem-a', mountPath: '/workspace/b' },
          ],
        },
      },
      behaviorFingerprintKey: 'test-context-fingerprint-key',
      relationshipNamespaces: {
        context: config.contextsNamespace,
        mcpServer: config.mcpServersNamespace,
        sharedFilesystem: config.sharedFilesystemsNamespace,
      },
    })

    try {
      const stagingGeneration = await index.beginRelist({
        environmentId,
        sourceFamily: 'context',
        budget,
      })
      await index.stageRelistPage({
        environmentId,
        sourceFamily: 'context',
        stagingGeneration,
        projections: [projection],
        budget,
      })

      const staged = await databasePool.query<{
        relationship_type: string
        target_id: string
        behavior_attributes: Record<string, unknown>
      }>(
        `SELECT relationship_type, target_id, behavior_attributes
           FROM operational_relationships_staging
          WHERE environment_id = $1
            AND source_family = 'context'
            AND source_id = $2
            AND source_generation = $3
          ORDER BY relationship_type, target_id, behavior_attributes->>'mountPath'`,
        [environmentId, sourceId, stagingGeneration]
      )
      expect(staged.rows).toEqual([
        {
          relationship_type: 'includes_mcp_server',
          target_id: `${config.mcpServersNamespace}/server-a`,
          behavior_attributes: {},
        },
        {
          relationship_type: 'includes_mcp_server',
          target_id: `${config.mcpServersNamespace}/server-b`,
          behavior_attributes: {},
        },
        {
          relationship_type: 'mounts_shared_filesystem',
          target_id: `${config.sharedFilesystemsNamespace}/filesystem-a`,
          behavior_attributes: { mountPath: '/workspace/a', readOnly: true },
        },
        {
          relationship_type: 'mounts_shared_filesystem',
          target_id: `${config.sharedFilesystemsNamespace}/filesystem-a`,
          behavior_attributes: { mountPath: '/workspace/b', readOnly: true },
        },
      ])
      await index.promoteRelist({
        environmentId,
        sourceFamily: 'context',
        stagingGeneration,
        resourceVersion: '1',
        budget,
      })

      const promoted = await databasePool.query<{ relationship_type: string; target_id: string }>(
        `SELECT relationship_type, target_id
           FROM operational_resource_relationships
          WHERE environment_id = $1
            AND source_family = 'context'
            AND source_id = $2
          ORDER BY relationship_type, target_id`,
        [environmentId, sourceId]
      )
      expect(promoted.rows).toEqual([
        {
          relationship_type: 'includes_mcp_server',
          target_id: `${config.mcpServersNamespace}/server-a`,
        },
        {
          relationship_type: 'includes_mcp_server',
          target_id: `${config.mcpServersNamespace}/server-b`,
        },
        {
          relationship_type: 'mounts_shared_filesystem',
          target_id: `${config.sharedFilesystemsNamespace}/filesystem-a`,
        },
        {
          relationship_type: 'mounts_shared_filesystem',
          target_id: `${config.sharedFilesystemsNamespace}/filesystem-a`,
        },
      ])
    } finally {
      budget.close()
    }
  })
})
