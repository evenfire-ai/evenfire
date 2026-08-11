import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCESS_CATALOG_CONTRACT_VERSION,
  ACCESS_CATALOG_SORT,
  AccessCatalogCursorError,
  assertAccessCatalogCursorCurrent,
  catalogFilterHash,
  decodeAccessCatalogCursor,
  encodeAccessCatalogCursor,
} from '../src/services/access/accessCatalogCursor.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import {
  CATALOG_FAMILIES,
  type CatalogFamily,
  type ProducerContinuation,
  catalogKey,
} from '../src/services/access/catalogContracts.js'

const budgets: AccessExecutionBudget[] = []

function budget(): AccessExecutionBudget {
  const value = AccessExecutionBudget.create('catalog')
  budgets.push(value)
  return value
}

function producers(environmentId: string): Record<CatalogFamily, ProducerContinuation> {
  return Object.fromEntries(
    CATALOG_FAMILIES.map(family => [
      family,
      {
        afterKey: family === 'team' ? catalogKey(environmentId, family, 'team-0001') : null,
        exhausted: family !== 'team',
      },
    ])
  ) as Record<CatalogFamily, ProducerContinuation>
}

afterEach(() => {
  for (const value of budgets.splice(0)) value.close()
})

describe('access catalog cursor v3', () => {
  it('round-trips the signed complete producer state', () => {
    const environmentId = 'cluster.local/evenfire'
    const filterHash = catalogFilterHash(['team'])
    const encoded = encodeAccessCatalogCursor(
      {
        v: 3,
        contractVersion: ACCESS_CATALOG_CONTRACT_VERSION,
        authorizationRevision: 'authorization-1',
        sourceStateRevision: 'source-1',
        filterHash,
        sort: ACCESS_CATALOG_SORT,
        lastCanonicalKey: catalogKey(environmentId, 'team', 'team-0001'),
        producers: producers(environmentId),
        validUntil: '2030-01-01T00:00:00.000Z',
      },
      budget()
    )
    const decoded = decodeAccessCatalogCursor(encoded, budget())
    expect(decoded.producers.team.afterKey).toEqual([environmentId, 'team', 'team-0001'])
    expect(Object.keys(decoded.producers)).toEqual(CATALOG_FAMILIES)
  })

  it('rejects tampering and every stale cursor binding', () => {
    const environmentId = 'cluster.local/evenfire'
    const filterHash = catalogFilterHash(['team'])
    const encoded = encodeAccessCatalogCursor(
      {
        v: 3,
        contractVersion: ACCESS_CATALOG_CONTRACT_VERSION,
        authorizationRevision: 'authorization-1',
        sourceStateRevision: 'source-1',
        filterHash,
        sort: ACCESS_CATALOG_SORT,
        lastCanonicalKey: catalogKey(environmentId, 'team', 'team-0001'),
        producers: producers(environmentId),
        validUntil: '2030-01-01T00:00:00.000Z',
      },
      budget()
    )
    expect(() => decodeAccessCatalogCursor(`${encoded}x`, budget())).toThrow(
      AccessCatalogCursorError
    )
    const decoded = decodeAccessCatalogCursor(encoded, budget())
    expect(() =>
      assertAccessCatalogCursorCurrent(decoded, {
        authorizationRevision: 'authorization-2',
        sourceStateRevision: 'source-1',
        filterHash,
      })
    ).toThrow(AccessCatalogCursorError)
    expect(() =>
      assertAccessCatalogCursorCurrent(decoded, {
        authorizationRevision: 'authorization-1',
        sourceStateRevision: 'source-2',
        filterHash,
      })
    ).toThrow(AccessCatalogCursorError)
    expect(() =>
      assertAccessCatalogCursorCurrent(decoded, {
        authorizationRevision: 'authorization-1',
        sourceStateRevision: 'source-1',
        filterHash: catalogFilterHash(['user']),
      })
    ).toThrow(AccessCatalogCursorError)
    expect(() =>
      assertAccessCatalogCursorCurrent(decoded, {
        authorizationRevision: 'authorization-1',
        sourceStateRevision: 'source-1',
        filterHash,
        now: new Date('2030-01-01T00:00:00.000Z'),
      })
    ).toThrow(AccessCatalogCursorError)
  })
})
