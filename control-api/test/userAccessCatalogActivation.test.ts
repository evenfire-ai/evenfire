import { describe, expect, it, vi } from 'vitest'
import { OPERATIONAL_SOURCE_FAMILIES } from '../src/services/access/operationalAccessProjection.js'
import {
  CATALOG_FAMILIES,
  type ConfiguredUserAccessIntent,
  UserAccessPolicyConfigurationError,
} from '../src/services/access/userAccessPolicy.js'
import * as runtimePolicy from '../src/services/access/userAccessRuntimePolicy.js'

const configured: ConfiguredUserAccessIntent = Object.freeze({
  legacyLifecycle: 'issue_and_accept',
  sessionV2Acceptance: true,
  sessionV2Issuance: false,
  catalogMode: 'serve',
  teamGfsMembershipAdmissionLimit: 4,
  actionContextV2: false,
  rpcDelegationV2: false,
  desktopAllTeamMode: false,
  profileV2Mode: false,
  legacySwitchEndpoint: true,
  minimumClientVersion: null,
  minimumClientEnforcement: false,
})

const now = new Date('2026-09-01T10:00:00.000Z')

function sourceQuery() {
  return vi.fn().mockResolvedValue({
    rows: OPERATIONAL_SOURCE_FAMILIES.map((source_family, index) => ({
      source_family,
      generation: index + 1,
      resource_version: String(index + 10),
      status: 'current',
      last_success_at: new Date(now.getTime() - 1_000),
    })),
  })
}

function activationRecord(
  overrides: Partial<{
    active: boolean
    catalogConfigurationRevision: string
    comparisonEvidence: Array<{
      family: (typeof CATALOG_FAMILIES)[number]
      attempted: number
      completed: number
      reference: string
    }>
  }> = {}
): string {
  const revisionProducer = Reflect.get(runtimePolicy, 'catalogConfigurationRevision') as
    | ((intent: ConfiguredUserAccessIntent) => string)
    | undefined
  return JSON.stringify({
    version: 1,
    active: true,
    revision: 'catalog-acceptance-2026-09-01',
    acceptedBy: 'release-operator@example.test',
    acceptedAt: '2026-09-01T10:00:00.000Z',
    catalogConfigurationRevision: revisionProducer?.(configured) ?? 'pre-correction-placeholder',
    requiredFamilies: CATALOG_FAMILIES,
    comparisonEvidence: CATALOG_FAMILIES.map(family => ({
      family,
      attempted: 10,
      completed: 10,
      reference: `shadow-run-2026-09-01/${family}`,
    })),
    ...overrides,
  })
}

async function resolve(catalogActivationRecord: string) {
  return runtimePolicy.resolveEffectiveUserAccessPolicy({
    intent: configured,
    db: { query: sourceQuery() } as never,
    indexerEnabled: true,
    readinessMaxAgeMs: 5_000,
    now,
    catalogActivationRecord,
  })
}

describe('operator-owned catalog activation', () => {
  it('serves only from an active acceptance record bound to the current configuration', async () => {
    await expect(resolve(activationRecord())).resolves.toMatchObject({
      serveCatalog: true,
      advertisedCatalogFamilies: CATALOG_FAMILIES,
    })

    await expect(resolve(activationRecord({ active: false }))).rejects.toThrowError(
      new UserAccessPolicyConfigurationError('catalog_serving_parity_not_accepted')
    )
    await expect(
      resolve(activationRecord({ catalogConfigurationRevision: 'another-configuration' }))
    ).rejects.toThrowError(
      new UserAccessPolicyConfigurationError('catalog_serving_parity_not_accepted')
    )
  })

  it('rejects incomplete or skipped-only comparison evidence', async () => {
    const incompleteEvidence = CATALOG_FAMILIES.slice(1).map(family => ({
      family,
      attempted: 10,
      completed: 10,
      reference: `shadow-run-2026-09-01/${family}`,
    }))
    const skippedEvidence = CATALOG_FAMILIES.map(family => ({
      family,
      attempted: 10,
      completed: family === CATALOG_FAMILIES[0] ? 0 : 10,
      reference: `shadow-run-2026-09-01/${family}`,
    }))

    await expect(
      resolve(activationRecord({ comparisonEvidence: incompleteEvidence }))
    ).rejects.toThrowError(
      new UserAccessPolicyConfigurationError('catalog_serving_parity_not_accepted')
    )
    await expect(
      resolve(activationRecord({ comparisonEvidence: skippedEvidence }))
    ).rejects.toThrowError(
      new UserAccessPolicyConfigurationError('catalog_serving_parity_not_accepted')
    )
  })
})
