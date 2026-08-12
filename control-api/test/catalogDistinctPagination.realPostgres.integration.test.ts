import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { config } from '../src/config.js'
import { type DbClient, initDb } from '../src/db.js'
import { buildAccessCatalog } from '../src/services/access/accessCatalogCoordinator.js'
import {
  AccessBudgetExceededError,
  AccessExecutionBudget,
} from '../src/services/access/accessExecutionBudget.js'
import type {
  CatalogOperationalSourceState,
  CatalogRequestContext,
} from '../src/services/access/catalogContracts.js'
import { CATALOG_KEY_SQL } from '../src/services/access/catalogProducerSql.js'
import { requireCatalogProducer } from '../src/services/access/catalogProducers.js'
import {
  OPERATIONAL_SOURCE_FAMILIES,
  canonicalEnvironmentId,
} from '../src/services/access/operationalAccessProjection.js'
import { teamGfsTopKSql } from '../src/services/access/teamGfsTopK.js'
import type { ExternalSessionAuthorityContext } from '../src/services/auth/externalSessionAuthentication.js'

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
    const client = await pool.connect()
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

type ExplainNode = Record<string, unknown> & { Plans?: ExplainNode[] }

function explainNodes(root: ExplainNode): ExplainNode[] {
  const values: ExplainNode[] = []
  const pending = [root]
  while (pending.length > 0) {
    const node = pending.pop()!
    values.push(node)
    pending.push(...(node.Plans ?? []))
  }
  return values
}

function actualWork(node: ExplainNode): number {
  return Number(node['Actual Rows'] ?? 0) * Math.max(1, Number(node['Actual Loops'] ?? 1))
}

describeRealPostgres('distinct catalog key pagination on real PostgreSQL', () => {
  const database = `control_api_catalog_distinct_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const environmentId = canonicalEnvironmentId()
  const userId = randomUUID()
  const teamIds = [randomUUID(), randomUUID(), randomUUID()]
  let adminPool: Pool
  let databasePool: Pool

  async function principal(label: string, teamCount = 0) {
    const principalUserId = randomUUID()
    await databasePool.query(`INSERT INTO users(id, email, name) VALUES ($1, $2, $3)`, [
      principalUserId,
      `${label}-${principalUserId}@example.test`,
      label,
    ])
    const principalTeamIds: string[] = []
    for (let index = 0; index < teamCount; index += 1) {
      const teamId = randomUUID()
      principalTeamIds.push(teamId)
      await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [
        teamId,
        `${label} Team ${index + 1}`,
      ])
      await databasePool.query(
        `INSERT INTO team_members(team_id, user_id, role, status)
         VALUES ($1, $2, 'member', 'active')`,
        [teamId, principalUserId]
      )
    }
    return { userId: principalUserId, teamIds: principalTeamIds }
  }

  async function operationalResource(
    type: string,
    logicalId: string,
    sourceFamily = type
  ): Promise<void> {
    await databasePool.query(
      `INSERT INTO operational_resource_index(
         environment_id, resource_type, logical_id, source_family, source_generation,
         provider_uid, provider_resource_version, display_name, enabled, content_bytes
       ) VALUES ($1, $2, $3, $4, 1, $5, '1', $3, TRUE, 64)
       ON CONFLICT (environment_id, resource_type, logical_id) DO NOTHING`,
      [environmentId, type, logicalId, sourceFamily, `${type}:${logicalId}`]
    )
  }

  async function relationship(input: {
    sourceType: string
    sourceId: string
    relationshipType: string
    targetType: string
    targetId: string
    instanceId: string
    behavior?: Record<string, unknown>
  }): Promise<void> {
    await databasePool.query(
      `INSERT INTO operational_resource_relationships(
         environment_id, source_type, source_id, relationship_type, target_type, target_id,
         relationship_instance_id, behavior_attributes, source_family, source_provider_uid,
         source_resource_version, source_generation, content_bytes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $2, $9, '1', 1, 64)`,
      [
        environmentId,
        input.sourceType,
        input.sourceId,
        input.relationshipType,
        input.targetType,
        input.targetId,
        input.instanceId,
        input.behavior ?? {},
        `${input.sourceType}:${input.sourceId}`,
      ]
    )
  }

  async function consumeFamily(input: {
    family:
      | 'host'
      | 'context'
      | 'mcp_server'
      | 'workflow_recipe'
      | 'gfs_resource'
      | 'shared_filesystem'
      | 'sandbox_app'
    userId: string
    expected: readonly string[]
    minimumPathsForFirst?: number
    minimumRelationshipsForFirst?: number
  }): Promise<void> {
    const session: ExternalSessionAuthorityContext = {
      contract: 'v1',
      userId: input.userId,
      tokenHash: randomBytes(32).toString('hex'),
      issuedAt: Math.floor(Date.now() / 1_000),
    }
    const seen: string[] = []
    let cursor: string | null = null
    let firstItem: Awaited<ReturnType<typeof buildAccessCatalog>>['items'][number] | undefined
    try {
      do {
        const page = await buildAccessCatalog(
          {
            session,
            families: [input.family],
            limit: 2,
            ...(cursor ? { cursor } : {}),
          },
          {
            transaction: transaction(databasePool),
            teamGfsMembershipAdmissionLimit: 8,
          }
        )
        expect(page.complete).toBe(true)
        firstItem ??= page.items[0]
        seen.push(...page.items.map(item => item.resource.logicalId))
        cursor = page.nextCursor
      } while (cursor)
    } catch (error) {
      throw new Error(`Failed to consume ${input.family}`, { cause: error })
    }
    expect(seen).toEqual(input.expected)
    expect(new Set(seen).size).toBe(input.expected.length)
    if (input.minimumPathsForFirst) {
      expect(firstItem?.accessPaths.length).toBeGreaterThanOrEqual(input.minimumPathsForFirst)
    }
    if (input.minimumRelationshipsForFirst) {
      expect(firstItem?.relationships.length).toBeGreaterThanOrEqual(
        input.minimumRelationshipsForFirst
      )
    }
    const explained = await databasePool.query(
      `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${CATALOG_KEY_SQL[input.family]}`,
      [
        input.userId,
        '',
        environmentId,
        3,
        config.hostsNamespace,
        config.contextsNamespace,
        '',
        '{}',
        null,
      ]
    )
    const envelope = (explained.rows[0] as Record<string, unknown>)['QUERY PLAN']
    expect(Array.isArray(envelope)).toBe(true)
    const root = (envelope as Array<Record<string, unknown>>)[0]?.Plan as
      | (Record<string, unknown> & { Plans?: unknown[] })
      | undefined
    const armCount = (CATALOG_KEY_SQL[input.family].match(/AS MATERIALIZED/g) ?? []).length
    // Each requested arm contributes at most take + 1 raw rows plus its marker.
    expect(Number(root?.['Actual Rows'] ?? 0)).toBeLessThanOrEqual(armCount * 4)
    const pending: Array<Record<string, unknown> & { Plans?: unknown[] }> = root ? [root] : []
    let sawLimit = false
    while (pending.length > 0) {
      const node = pending.pop()!
      if (node['Node Type'] === 'Limit') sawLimit = true
      expect(String(node['Sort Method'] ?? '')).not.toContain('external')
      expect(Number(node['Temp Read Blocks'] ?? 0)).toBe(0)
      expect(Number(node['Temp Written Blocks'] ?? 0)).toBe(0)
      pending.push(
        ...((node.Plans ?? []) as Array<Record<string, unknown> & { Plans?: unknown[] }>)
      )
    }
    expect(sawLimit).toBe(true)
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Distinct Catalog User')`,
      [userId, `${userId}@example.test`]
    )
    await databasePool.query(
      `INSERT INTO operational_catalog_source_state(
         environment_id, source_family, generation, resource_version, status, last_success_at
       )
       SELECT $1, source_family, 1, '1', 'current', NOW()
         FROM UNNEST($2::text[]) source_family`,
      [environmentId, OPERATIONAL_SOURCE_FAMILIES]
    )
    for (const [index, teamId] of teamIds.entries()) {
      await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, $2)`, [
        teamId,
        `Distinct Team ${index + 1}`,
      ])
      await databasePool.query(
        `INSERT INTO team_members(team_id, user_id, role, status)
         VALUES ($1, $2, 'member', 'active')`,
        [teamId, userId]
      )
      await databasePool.query(`INSERT INTO team_agents(team_id, agent_name) VALUES ($1, 'a')`, [
        teamId,
      ])
    }
    await databasePool.query(
      `INSERT INTO team_agents(team_id, agent_name) VALUES ($1, 'b'), ($1, 'c')`,
      [teamIds[0]]
    )
    await databasePool.query(
      `INSERT INTO operational_resource_index(
         environment_id, resource_type, logical_id, source_family, source_generation,
         provider_uid, provider_resource_version, display_name, enabled, content_bytes
       ) VALUES
         ($1, 'host', $2 || '/a', 'host', 1, 'host-a', '1', 'Host A', TRUE, 64),
         ($1, 'host', $2 || '/b', 'host', 1, 'host-b', '1', 'Host B', TRUE, 64),
         ($1, 'host', $2 || '/c', 'host', 1, 'host-c', '1', 'Host C', TRUE, 64)`,
      [environmentId, config.hostsNamespace]
    )
  })

  afterAll(async () => {
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

  it('refills bounded duplicate team host paths without hiding later canonical IDs', async () => {
    await databasePool.query(
      `INSERT INTO user_agents(user_id, agent_name) VALUES ($1, 'x'), ($1, 'y'), ($1, 'z')`,
      [userId]
    )
    await databasePool.query(
      `INSERT INTO operational_resource_index(
         environment_id, resource_type, logical_id, source_family, source_generation,
         provider_uid, provider_resource_version, display_name, enabled, content_bytes
       ) VALUES
         ($1, 'host', $2 || '/x', 'host', 1, 'host-x', '1', 'Host X', TRUE, 64),
         ($1, 'host', $2 || '/y', 'host', 1, 'host-y', '1', 'Host Y', TRUE, 64),
         ($1, 'host', $2 || '/z', 'host', 1, 'host-z', '1', 'Host Z', TRUE, 64)`,
      [environmentId, config.hostsNamespace]
    )
    const budget = AccessExecutionBudget.create('catalog')
    let hostKeyStatements = 0
    const sourceStates: CatalogOperationalSourceState[] = OPERATIONAL_SOURCE_FAMILIES.map(
      family => ({ family, generation: '1', resourceVersion: '1', status: 'current' })
    )
    const context: CatalogRequestContext = {
      db: {
        query: (text, values) => {
          if (text === CATALOG_KEY_SQL.host) hostKeyStatements += 1
          return databasePool.query(text, values)
        },
      },
      budget,
      principal: {
        userId,
        sessionContract: 'v2',
        sessionRevision: '1',
        userRevision: '1',
        catalogRevision: '1',
        authorizationRevision: '1',
        memberships: teamIds.map(teamId => ({ teamId, role: 'member' })),
      },
      environmentId,
      sourceStates: new Map(sourceStates.map(state => [state.family, state])),
    }
    try {
      const page = await requireCatalogProducer('host').listCanonicalKeys(
        context,
        { afterKey: null, exhausted: false },
        2
      )
      expect(page.candidates.map(candidate => candidate.key[2])).toEqual([
        `${config.hostsNamespace}/a`,
        `${config.hostsNamespace}/b`,
        `${config.hostsNamespace}/c`,
      ])
      expect(page.hasMore).toBe(true)
      expect(page.continuation.exhausted).toBe(false)
      expect(hostKeyStatements).toBe(2)
    } finally {
      budget.close()
    }
  })

  it('fails before an unbudgeted duplicate-refill statement can execute', async () => {
    const budget = AccessExecutionBudget.create('catalog', {
      limits: { databaseStatements: 1 },
    })
    let hostKeyStatements = 0
    const sourceStates: CatalogOperationalSourceState[] = OPERATIONAL_SOURCE_FAMILIES.map(
      family => ({ family, generation: '1', resourceVersion: '1', status: 'current' })
    )
    const context: CatalogRequestContext = {
      db: {
        query: (text, values) => {
          if (text === CATALOG_KEY_SQL.host) hostKeyStatements += 1
          return databasePool.query(text, values)
        },
      },
      budget,
      principal: {
        userId,
        sessionContract: 'v2',
        sessionRevision: '1',
        userRevision: '1',
        catalogRevision: '1',
        authorizationRevision: '1',
        memberships: teamIds.map(teamId => ({ teamId, role: 'member' })),
      },
      environmentId,
      sourceStates: new Map(sourceStates.map(state => [state.family, state])),
    }
    try {
      await expect(
        requireCatalogProducer('host').listCanonicalKeys(
          context,
          { afterKey: null, exhausted: false },
          2
        )
      ).rejects.toMatchObject({
        limit: 'databaseStatements',
        authorityRequired: true,
      } satisfies Partial<AccessBudgetExceededError>)
      expect(hostKeyStatements).toBe(1)
    } finally {
      budget.close()
    }
  })

  it('preserves distinct keys for every duplicate-capable producer arm class', async () => {
    const teamHost = await principal('team-host', 3)
    const hostNames = ['team-host-a', 'team-host-b', 'team-host-c']
    for (const name of hostNames)
      await operationalResource('host', `${config.hostsNamespace}/${name}`)
    for (const teamId of teamHost.teamIds) {
      await databasePool.query(`INSERT INTO team_agents(team_id, agent_name) VALUES ($1, $2)`, [
        teamId,
        hostNames[0],
      ])
    }
    await databasePool.query(
      `INSERT INTO team_agents(team_id, agent_name) VALUES ($1, $2), ($1, $3)`,
      [teamHost.teamIds[0], hostNames[1], hostNames[2]]
    )
    await consumeFamily({
      family: 'host',
      userId: teamHost.userId,
      expected: hostNames.map(name => `${config.hostsNamespace}/${name}`),
      minimumPathsForFirst: 3,
    })

    const teamContext = await principal('team-context', 3)
    const contextNames = ['team-context-a', 'team-context-b', 'team-context-c']
    for (const name of contextNames) {
      await operationalResource('context', `${config.contextsNamespace}/${name}`)
    }
    for (const teamId of teamContext.teamIds) {
      await databasePool.query(`INSERT INTO team_contexts(team_id, context_id) VALUES ($1, $2)`, [
        teamId,
        contextNames[0],
      ])
    }
    await databasePool.query(
      `INSERT INTO team_contexts(team_id, context_id) VALUES ($1, $2), ($1, $3)`,
      [teamContext.teamIds[0], contextNames[1], contextNames[2]]
    )
    await consumeFamily({
      family: 'context',
      userId: teamContext.userId,
      expected: contextNames.map(name => `${config.contextsNamespace}/${name}`),
      minimumPathsForFirst: 3,
    })

    const teamRecipe = await principal('team-recipe', 3)
    const recipeNames = ['team-recipe-a', 'team-recipe-b', 'team-recipe-c']
    for (const name of recipeNames) {
      await operationalResource(
        'workflow_recipe',
        `${config.sandboxNamespace}/${name}`,
        'workflow_recipe'
      )
    }
    for (const teamId of teamRecipe.teamIds) {
      await databasePool.query(
        `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
         VALUES ($1, $2, $3)`,
        [teamId, config.sandboxNamespace, recipeNames[0]]
      )
    }
    await databasePool.query(
      `INSERT INTO team_workflow_triggers(team_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3), ($1, $2, $4)`,
      [teamRecipe.teamIds[0], config.sandboxNamespace, recipeNames[1], recipeNames[2]]
    )
    await consumeFamily({
      family: 'workflow_recipe',
      userId: teamRecipe.userId,
      expected: recipeNames.map(name => `${config.sandboxNamespace}/${name}`),
      minimumPathsForFirst: 3,
    })

    for (const mode of ['direct-context', 'team-context', 'direct-host', 'team-host'] as const) {
      const usingTeam = mode.startsWith('team')
      const usingHost = mode.endsWith('host')
      const actor = await principal(`mcp-${mode}`, usingTeam ? 3 : 0)
      const mcpIds = ['a', 'b', 'c'].map(
        suffix => `${config.mcpServersNamespace}/mcp-${mode}-${suffix}`
      )
      for (const id of mcpIds) await operationalResource('mcp_server', id)
      const contextId = `${config.contextsNamespace}/mcp-${mode}-context`
      await operationalResource('context', contextId)
      for (const [index, targetId] of mcpIds.entries()) {
        await relationship({
          sourceType: 'context',
          sourceId: contextId,
          relationshipType: 'includes_mcp_server',
          targetType: 'mcp_server',
          targetId,
          instanceId: `mcp-${mode}-${index}`,
        })
      }
      if (usingHost) {
        const hostName = `mcp-${mode}-host`
        const hostId = `${config.hostsNamespace}/${hostName}`
        await operationalResource('host', hostId)
        await relationship({
          sourceType: 'host',
          sourceId: hostId,
          relationshipType: 'uses_context',
          targetType: 'context',
          targetId: contextId,
          instanceId: `mcp-${mode}-host-context`,
        })
        if (usingTeam) {
          for (const teamId of actor.teamIds) {
            await databasePool.query(
              `INSERT INTO team_agents(team_id, agent_name) VALUES ($1, $2)`,
              [teamId, hostName]
            )
          }
        } else {
          await databasePool.query(`INSERT INTO user_agents(user_id, agent_name) VALUES ($1, $2)`, [
            actor.userId,
            hostName,
          ])
          for (let copy = 1; copy < 3; copy += 1) {
            const duplicateHostName = `${hostName}-${copy}`
            const duplicateHostId = `${config.hostsNamespace}/${duplicateHostName}`
            await operationalResource('host', duplicateHostId)
            await databasePool.query(
              `INSERT INTO user_agents(user_id, agent_name) VALUES ($1, $2)`,
              [actor.userId, duplicateHostName]
            )
            await relationship({
              sourceType: 'host',
              sourceId: duplicateHostId,
              relationshipType: 'uses_context',
              targetType: 'context',
              targetId: contextId,
              instanceId: `mcp-${mode}-host-context-${copy}`,
            })
          }
        }
      } else if (usingTeam) {
        const contextName = contextId.slice(config.contextsNamespace.length + 1)
        for (const teamId of actor.teamIds) {
          await databasePool.query(
            `INSERT INTO team_contexts(team_id, context_id) VALUES ($1, $2)`,
            [teamId, contextName]
          )
        }
      } else {
        const sourceIds = [contextId]
        for (let copy = 1; copy < 3; copy += 1) {
          const duplicateId = `${config.contextsNamespace}/mcp-${mode}-context-${copy}`
          sourceIds.push(duplicateId)
          await operationalResource('context', duplicateId)
          await relationship({
            sourceType: 'context',
            sourceId: duplicateId,
            relationshipType: 'includes_mcp_server',
            targetType: 'mcp_server',
            targetId: mcpIds[0],
            instanceId: `mcp-${mode}-duplicate-${copy}`,
          })
        }
        for (const sourceId of sourceIds) {
          await databasePool.query(
            `INSERT INTO user_contexts(user_id, context_id) VALUES ($1, $2)`,
            [actor.userId, sourceId.slice(config.contextsNamespace.length + 1)]
          )
        }
      }
      await consumeFamily({
        family: 'mcp_server',
        userId: actor.userId,
        expected: mcpIds,
        minimumPathsForFirst: 3,
      })
    }

    for (const mode of ['direct', 'team'] as const) {
      const actor = await principal(`sfs-${mode}`, mode === 'team' ? 3 : 0)
      const contextName = `sfs-${mode}-context`
      const contextId = `${config.contextsNamespace}/${contextName}`
      const filesystemIds = ['a', 'b', 'c'].map(
        suffix => `${config.sharedFilesystemsNamespace}/sfs-${mode}-${suffix}`
      )
      await operationalResource('context', contextId)
      for (const id of filesystemIds) await operationalResource('shared_filesystem', id)
      for (let copy = 0; copy < 3; copy += 1) {
        await relationship({
          sourceType: 'context',
          sourceId: contextId,
          relationshipType: 'mounts_shared_filesystem',
          targetType: 'shared_filesystem',
          targetId: filesystemIds[0],
          instanceId: `sfs-${mode}-a-${copy}`,
          behavior: { mountPath: `/workspace/${mode}/a-${copy}`, readOnly: true },
        })
      }
      for (const [index, id] of filesystemIds.slice(1).entries()) {
        await relationship({
          sourceType: 'context',
          sourceId: contextId,
          relationshipType: 'mounts_shared_filesystem',
          targetType: 'shared_filesystem',
          targetId: id,
          instanceId: `sfs-${mode}-${index + 1}`,
          behavior: { mountPath: `/workspace/${mode}/${index + 1}`, readOnly: true },
        })
      }
      if (mode === 'direct') {
        await databasePool.query(`INSERT INTO user_contexts(user_id, context_id) VALUES ($1, $2)`, [
          actor.userId,
          contextName,
        ])
      } else {
        for (const teamId of actor.teamIds) {
          await databasePool.query(
            `INSERT INTO team_contexts(team_id, context_id) VALUES ($1, $2)`,
            [teamId, contextName]
          )
        }
      }
      await consumeFamily({
        family: 'shared_filesystem',
        userId: actor.userId,
        expected: filesystemIds,
        minimumPathsForFirst: 3,
        minimumRelationshipsForFirst: 3,
      })
    }

    for (const mode of ['grant', 'share'] as const) {
      const actor = await principal(`gfs-${mode}`, 3)
      const prefix = mode === 'grant' ? '10000000' : '20000000'
      const resourceIds = ['a', 'b', 'c'].map(
        suffix => `${prefix}-0000-4000-8000-00000000000${suffix}`
      )
      for (const [index, resourceId] of resourceIds.entries()) {
        await databasePool.query(
          `INSERT INTO gfs_resources(resource_id, drive, name, kind)
           VALUES ($1, $2, '/', 'directory')`,
          [resourceId, `gfs-${mode}-${index}`]
        )
      }
      const table = mode === 'grant' ? 'gfs_grants' : 'gfs_shares'
      for (const teamId of actor.teamIds) {
        await databasePool.query(
          `INSERT INTO ${table}(drive, resource_id, subject_type, subject_id, permissions)
           VALUES ($1, $2, 'team', $3, ARRAY['read']::text[])`,
          [`gfs-${mode}-0`, resourceIds[0], teamId]
        )
      }
      for (let index = 1; index < resourceIds.length; index += 1) {
        await databasePool.query(
          `INSERT INTO ${table}(drive, resource_id, subject_type, subject_id, permissions)
           VALUES ($1, $2, 'team', $3, ARRAY['read']::text[])`,
          [`gfs-${mode}-${index}`, resourceIds[index], actor.teamIds[0]]
        )
      }
      await consumeFamily({
        family: 'gfs_resource',
        userId: actor.userId,
        expected: resourceIds,
        minimumPathsForFirst: 3,
      })
    }
  }, 30_000)

  it('keeps sparse GFS access subject-indexed instead of scanning unrelated resources', async () => {
    const actor = await principal('sparse-gfs', 1)
    const authorizedResourceId = 'f0000000-0000-4000-8000-000000000001'
    const authorizedDrive = 'sparse-gfs-authorized'
    await databasePool.query(
      `INSERT INTO gfs_resources(resource_id, drive, name, kind)
       SELECT ('01000000-0000-4000-8000-' || LPAD(value::text, 12, '0'))::uuid,
              'sparse-unrelated-' || value, '/', 'directory'
         FROM generate_series(1, 2000) value`
    )
    await databasePool.query(
      `INSERT INTO gfs_resources(resource_id, drive, name, kind)
       VALUES ($1, $2, '/', 'directory')`,
      [authorizedResourceId, authorizedDrive]
    )
    for (const table of ['gfs_grants', 'gfs_shares'] as const) {
      await databasePool.query(
        `INSERT INTO ${table}(drive, resource_id, subject_type, subject_id, permissions)
         SELECT resource.drive, resource.resource_id, subject.subject_type, subject.subject_id,
                ARRAY['read']::text[]
           FROM gfs_resources resource
     CROSS JOIN (VALUES
                  ('user', 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
                  ('team', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'))
                subject(subject_type, subject_id)
          WHERE resource.drive LIKE 'sparse-unrelated-%'`
      )
    }
    for (const table of ['gfs_grants', 'gfs_shares'] as const) {
      await databasePool.query(
        `INSERT INTO ${table}(drive, resource_id, subject_type, subject_id, permissions)
         VALUES ($1, $2, 'user', $3, ARRAY['read']::text[]),
                ($1, $2, 'team', $4, ARRAY['read']::text[])`,
        [authorizedDrive, authorizedResourceId, actor.userId, actor.teamIds[0]]
      )
    }
    await databasePool.query('ANALYZE gfs_resources')
    await databasePool.query('ANALYZE gfs_grants')
    await databasePool.query('ANALYZE gfs_shares')

    const explained = await databasePool.query(
      `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${CATALOG_KEY_SQL.gfs_resource}`,
      [
        actor.userId,
        '',
        environmentId,
        3,
        config.hostsNamespace,
        config.contextsNamespace,
        '',
        '{}',
        null,
      ]
    )
    const envelope = (explained.rows[0] as Record<string, unknown>)['QUERY PLAN'] as Array<{
      Plan: ExplainNode
    }>
    const nodes = explainNodes(envelope[0].Plan)
    const indexNames = new Set(
      nodes.flatMap(node => (typeof node['Index Name'] === 'string' ? [node['Index Name']] : []))
    )
    expect(indexNames).toContain('gfs_grants_subject_resource_catalog_idx')
    expect(indexNames).toContain('gfs_shares_subject_resource_catalog_idx')
    const resourceWork = nodes
      .filter(node => node['Relation Name'] === 'gfs_resources')
      .reduce((total, node) => total + actualWork(node), 0)
    expect(resourceWork).toBeLessThanOrEqual(16)
    for (const node of nodes) {
      expect(String(node['Sort Method'] ?? '')).not.toContain('external')
      expect(Number(node['Temp Read Blocks'] ?? 0)).toBe(0)
      expect(Number(node['Temp Written Blocks'] ?? 0)).toBe(0)
    }

    const teamExplained = await databasePool.query(
      `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${teamGfsTopKSql.streamHead}`,
      [
        JSON.stringify([
          {
            kind: 'grant',
            subject_id: actor.teamIds[0],
            after_id: '00000000-0000-0000-0000-000000000000',
            take: 3,
          },
          {
            kind: 'share',
            subject_id: actor.teamIds[0],
            after_id: '00000000-0000-0000-0000-000000000000',
            take: 3,
          },
        ]),
      ]
    )
    const teamEnvelope = (teamExplained.rows[0] as Record<string, unknown>)['QUERY PLAN'] as Array<{
      Plan: ExplainNode
    }>
    const teamNodes = explainNodes(teamEnvelope[0].Plan)
    const teamIndexes = new Set(
      teamNodes.flatMap(node =>
        typeof node['Index Name'] === 'string' ? [node['Index Name']] : []
      )
    )
    expect(teamIndexes).toContain('gfs_grants_subject_resource_catalog_idx')
    expect(teamIndexes).toContain('gfs_shares_subject_resource_catalog_idx')
    expect(
      teamNodes
        .filter(node => node['Relation Name'] === 'gfs_resources')
        .reduce((total, node) => total + actualWork(node), 0)
    ).toBeLessThanOrEqual(8)
    expect(teamNodes.every(node => Number(node['Temp Written Blocks'] ?? 0) === 0)).toBe(true)

    await consumeFamily({
      family: 'gfs_resource',
      userId: actor.userId,
      expected: [authorizedResourceId],
      minimumPathsForFirst: 4,
    })
  }, 30_000)

  it('fails closed above the configured local team GFS membership admission bound', async () => {
    const actor = await principal('gfs-admission', 3)
    const resourceId = 'e0000000-0000-4000-8000-000000000001'
    await databasePool.query(
      `INSERT INTO gfs_resources(resource_id, drive, name, kind)
       VALUES ($1, 'gfs-admission', '/', 'directory')`,
      [resourceId]
    )
    for (const teamId of actor.teamIds) {
      await databasePool.query(
        `INSERT INTO gfs_grants(drive, resource_id, subject_type, subject_id, permissions)
         VALUES ('gfs-admission', $1, 'team', $2, ARRAY['read']::text[])`,
        [resourceId, teamId]
      )
    }
    const session: ExternalSessionAuthorityContext = {
      contract: 'v1',
      userId: actor.userId,
      tokenHash: randomBytes(32).toString('hex'),
      issuedAt: Math.floor(Date.now() / 1_000),
    }
    const build = (admission: number) =>
      buildAccessCatalog(
        { session, families: ['gfs_resource'], limit: 2 },
        {
          transaction: transaction(databasePool),
          teamGfsMembershipAdmissionLimit: admission,
        }
      )

    await expect(build(4)).resolves.toMatchObject({ complete: true })
    await expect(build(3)).resolves.toMatchObject({ complete: true })
    await expect(build(2)).rejects.toMatchObject({
      limit: 'teamGfsMembershipAdmission',
      authorityRequired: true,
    } satisfies Partial<AccessBudgetExceededError>)
  })
})
