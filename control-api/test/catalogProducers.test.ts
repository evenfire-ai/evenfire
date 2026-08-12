import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import {
  CATALOG_FAMILIES,
  type CatalogOperationalSourceState,
  type CatalogRequestContext,
  catalogKey,
} from '../src/services/access/catalogContracts.js'
import { CATALOG_KEY_SQL } from '../src/services/access/catalogProducerSql.js'
import {
  catalogProducers,
  requireCatalogProducer,
} from '../src/services/access/catalogProducers.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'

const environmentId = canonicalEnvironmentId()
const userId = '10000000-0000-4000-8000-000000000001'
const budgets: AccessExecutionBudget[] = []

function context(
  query: ReturnType<typeof vi.fn>,
  sourceStates: CatalogOperationalSourceState[] = []
): CatalogRequestContext {
  const budget = AccessExecutionBudget.create('catalog')
  budgets.push(budget)
  return {
    db: { query } as unknown as Pick<DbClient, 'query'>,
    budget,
    principal: {
      userId,
      sessionContract: 'v2',
      sessionRevision: 'session-1',
      userRevision: 'user-1',
      catalogRevision: 'catalog-1',
      authorizationRevision: 'catalog-authorization-1',
      memberships: [],
    },
    environmentId,
    sourceStates: new Map(sourceStates.map(state => [state.family, state])),
  }
}

afterEach(() => {
  for (const budget of budgets.splice(0)) budget.close()
})

describe('catalog producer registry', () => {
  it('registers exactly the twelve frozen PR 1 families', () => {
    expect([...catalogProducers.keys()]).toEqual(CATALOG_FAMILIES)
  })

  it('keyset-bounds every source arm before its final union and never uses offsets', () => {
    const expectedArmCounts: Record<(typeof CATALOG_FAMILIES)[number], number> = {
      user: 1,
      team: 1,
      host: 2,
      context: 2,
      mcp_server: 4,
      workflow_recipe: 2,
      workflow_run: 3,
      workflow_approval: 2,
      notification: 2,
      gfs_resource: 2,
      shared_filesystem: 2,
      sandbox_app: 2,
    }
    for (const family of CATALOG_FAMILIES) {
      const sql = CATALOG_KEY_SQL[family]
      expect(sql).not.toMatch(/\bOFFSET\b/i)
      expect(sql.match(/AS MATERIALIZED/g)).toHaveLength(expectedArmCounts[family])
      expect(sql.match(/LIMIT \$4/g)).toHaveLength(expectedArmCounts[family] + 1)
    }
  })
})

describe('catalog producer protocol', () => {
  it('returns a stable keyset page with one bounded lookahead candidate', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          logical_id: '20000000-0000-4000-8000-000000000002',
          source_saturated: false,
        },
        {
          logical_id: '30000000-0000-4000-8000-000000000003',
          source_saturated: false,
        },
      ],
      rowCount: 2,
    })
    const result = await requireCatalogProducer('team').listCanonicalKeys(
      context(query),
      { afterKey: null, exhausted: false },
      1
    )

    expect(result.candidates.map(candidate => candidate.key[2])).toEqual([
      '20000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000003',
    ])
    expect(result.hasMore).toBe(true)
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      userId,
      '',
      environmentId,
      2,
      expect.any(String),
      expect.any(String),
      '',
    ])
  })

  it('rejects duplicate or non-increasing producer keys', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { logical_id: 'z', source_saturated: false },
        { logical_id: 'z', source_saturated: false },
      ],
      rowCount: 2,
    })
    await expect(
      requireCatalogProducer('notification').listCanonicalKeys(
        context(query),
        { afterKey: null, exhausted: false },
        2
      )
    ).rejects.toMatchObject({ code: 'keys_not_strictly_ordered' })
  })

  it('reports an operational source gap as partial without querying authority', async () => {
    const query = vi.fn()
    const result = await requireCatalogProducer('host').listCanonicalKeys(
      context(query, [
        {
          family: 'host',
          generation: '2',
          resourceVersion: null,
          status: 'relisting',
        },
      ]),
      { afterKey: null, exhausted: false },
      10
    )

    expect(result).toEqual(
      expect.objectContaining({
        sourceCompleteness: 'partial',
        candidates: [],
        partialErrors: [expect.objectContaining({ code: 'operational_source_relisting' })],
      })
    )
    expect(query).not.toHaveBeenCalled()
  })

  it('hydrates a real user path shape only for selected canonical IDs', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          logical_id: userId,
          display_name: 'Ada',
          provider_uid: null,
          resource_revision: '4',
          paths: [{ kind: 'direct', grant_id: `users:${userId}` }],
          relationships: [],
          valid_until: null,
        },
      ],
      rowCount: 1,
    })
    const result = await requireCatalogProducer('user').hydrateCanonicalKeys(context(query), [
      catalogKey(environmentId, 'user', userId),
    ])

    expect(result).toEqual([
      expect.objectContaining({
        key: [environmentId, 'user', userId],
        authorizationResourceRevision: '4',
        authorizationSourceRevision: 'database-resource',
        authorizationRelationshipsRevision: '[]',
        accessPaths: [expect.objectContaining({ kind: 'direct', grantId: `users:${userId}` })],
      }),
    ])
    expect(query).toHaveBeenCalledWith(expect.any(String), [userId, [userId], environmentId])
  })
})
