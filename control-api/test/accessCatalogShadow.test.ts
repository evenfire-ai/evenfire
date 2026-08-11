import { afterEach, describe, expect, it, vi } from 'vitest'
import { registry } from '../src/observability/metrics.js'
import {
  type CatalogShadowOutcome,
  compareAccessCatalogShadow,
} from '../src/services/access/accessCatalogShadow.js'

const session = {
  contract: 'v1' as const,
  userId: '10000000-0000-4000-8000-000000000001',
  tokenHash: 'token-hash',
  issuedAt: 1_900_000_000,
}

function catalog(logicalIds: string[], complete = true, nextCursor: string | null = null) {
  return {
    contractVersion: '2' as const,
    authorizationRevision: 'authorization-1',
    sourceStateRevision: 'source-1',
    complete,
    partialErrors: [],
    items: logicalIds.map(logicalId => ({
      resource: {
        environmentId: 'cluster.local/evenfire',
        type: 'team' as const,
        canonicalId: `team:${logicalId}`,
        logicalId,
        displayName: logicalId,
        resourceRevision: '1',
      },
      relationships: [],
      capabilities: ['team.read'],
      accessPaths: [],
    })),
    nextCursor,
  }
}

async function outcome(legacy: string[], aggregate: string[]): Promise<CatalogShadowOutcome> {
  return compareAccessCatalogShadow(
    { session, family: 'team', legacyLogicalIds: legacy, legacyComplete: true },
    { enabled: true, buildCatalog: vi.fn().mockResolvedValue(catalog(aggregate)) }
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('aggregate access shadow comparison', () => {
  it.each([
    [[], [], 'match'],
    [['a'], ['a'], 'match'],
    [['a'], ['a', 'b'], 'catalog_only'],
    [['a', 'b'], ['a'], 'legacy_only'],
    [['a'], ['b'], 'both_differ'],
  ] as const)('classifies bounded canonical sets %#', async (legacy, aggregate, expected) => {
    await expect(outcome([...legacy], [...aggregate])).resolves.toBe(expected)
  })

  it('does not compute parity for incomplete legacy or aggregate results', async () => {
    const buildCatalog = vi.fn()
    await expect(
      compareAccessCatalogShadow(
        { session, family: 'team', legacyLogicalIds: [], legacyComplete: false },
        { enabled: true, buildCatalog }
      )
    ).resolves.toBe('skipped_legacy_incomplete')
    expect(buildCatalog).not.toHaveBeenCalled()

    await expect(
      compareAccessCatalogShadow(
        { session, family: 'team', legacyLogicalIds: [], legacyComplete: true },
        {
          enabled: true,
          buildCatalog: vi.fn().mockResolvedValue(catalog([], false, 'c3.cursor.signature')),
        }
      )
    ).resolves.toBe('partial')
  })

  it('records only low-cardinality family, outcome, and direction labels', async () => {
    await outcome(['legacy-secret-id'], ['catalog-secret-id'])
    const metrics = await registry.metrics()
    expect(metrics).toContain('aggregate_access_shadow_comparisons_total')
    expect(metrics).toContain('family="team"')
    expect(metrics).toContain('outcome="both_differ"')
    expect(metrics).not.toContain('legacy-secret-id')
    expect(metrics).not.toContain('catalog-secret-id')
  })
})
