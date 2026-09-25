import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { OPERATIONAL_SOURCE_FAMILIES } from '../src/services/access/operationalAccessProjection.js'
import {
  CATALOG_FAMILIES,
  type ConfiguredUserAccessIntent,
  type DeploymentReadiness,
  UserAccessPolicyConfigurationError,
  compareSemanticVersions,
  compileUserAccessPolicy,
  loadConfiguredUserAccessIntent,
  reconstructionReadiness,
} from '../src/services/access/userAccessPolicy.js'
import { resolveEffectiveUserAccessPolicy } from '../src/services/access/userAccessRuntimePolicy.js'

const allFamilies = new Set(CATALOG_FAMILIES)

function intent(overrides: Partial<ConfiguredUserAccessIntent> = {}): ConfiguredUserAccessIntent {
  const configured: ConfiguredUserAccessIntent = {
    legacyLifecycle: 'issue_and_accept',
    sessionV2Acceptance: true,
    sessionV2Issuance: false,
    catalogMode: 'off',
    teamGfsMembershipAdmissionLimit: null,
    actionContextV2: false,
    rpcDelegationV2: false,
    desktopAllTeamMode: false,
    profileV2Mode: false,
    legacySwitchEndpoint: true,
    minimumClientVersion: null,
    minimumClientEnforcement: false,
    ...overrides,
  }
  return configured.catalogMode !== 'off' && overrides.teamGfsMembershipAdmissionLimit === undefined
    ? { ...configured, teamGfsMembershipAdmissionLimit: 4 }
    : configured
}

function readiness(overrides: Partial<DeploymentReadiness> = {}): DeploymentReadiness {
  return {
    revision: 'test-ready-v1',
    snapshot: 'current',
    legacySession: 'ready',
    legacySwitchAuthorization: 'ready',
    legacyDrainAccepted: true,
    sessionV2Acceptance: 'ready',
    sessionV2Issuance: 'ready',
    accessBudget: 'ready',
    catalogCoordinator: 'ready',
    catalogRegisteredFamilies: allFamilies,
    catalogHarnessFamilies: allFamilies,
    catalogOperationalFamilies: allFamilies,
    catalogShadowComparison: 'ready',
    catalogParityAccepted: true,
    actionSafeRevisions: 'ready',
    actionContext: 'ready',
    rpcDelegationAllHops: 'ready',
    desktop: 'ready',
    explicitTeamAdapters: 'ready',
    profile: 'ready',
    minimumClientEnforcement: 'ready',
    ...overrides,
  }
}

describe('central user-access rollout compiler', () => {
  it('keeps the reconstruction defaults dual-compatible and user-visible gates off', () => {
    expect(loadConfiguredUserAccessIntent({})).toEqual(intent())
    expect(
      compileUserAccessPolicy(loadConfiguredUserAccessIntent({}), reconstructionReadiness)
    ).toMatchObject({
      acceptV1: true,
      issueV1: true,
      acceptV2: true,
      issueV2: false,
      renewV2: false,
      switchCompatibility: true,
      computeCatalogShadow: false,
      serveCatalog: false,
      actionContextV2: false,
      rpcDelegationV2: false,
      desktopAllTeamMode: false,
      profileV2Mode: false,
      enforceMinimumClient: false,
      advertisedCatalogFamilies: [],
    })
  })

  it.each([
    [
      'no_accepted_session_contract',
      intent({ legacyLifecycle: 'disabled', sessionV2Acceptance: false }),
    ],
    [
      'session_v2_issuance_requires_acceptance',
      intent({ sessionV2Acceptance: false, sessionV2Issuance: true }),
    ],
    [
      'legacy_accept_only_requires_v2_issuance',
      intent({ legacyLifecycle: 'accept_only', legacySwitchEndpoint: false }),
    ],
    [
      'legacy_disabled_requires_accepted_drain',
      intent({
        legacyLifecycle: 'disabled',
        legacySwitchEndpoint: false,
        sessionV2Issuance: true,
      }),
      readiness({ legacyDrainAccepted: false }),
    ],
    [
      'legacy_switch_requires_v1_issue_and_accept',
      intent({ legacyLifecycle: 'accept_only', sessionV2Issuance: true }),
    ],
    [
      'catalog_shadow_families_incomplete',
      intent({ catalogMode: 'shadow' }),
      readiness({ catalogHarnessFamilies: new Set(['user']) }),
    ],
    [
      'catalog_serving_parity_not_accepted',
      intent({ catalogMode: 'serve' }),
      readiness({ catalogParityAccepted: false }),
    ],
    ['rpc_v2_requires_action_context', intent({ rpcDelegationV2: true })],
    ['desktop_mode_requires_v2_issuance', intent({ desktopAllTeamMode: true })],
    [
      'profile_explicit_team_adapters_unavailable',
      intent({ sessionV2Issuance: true, profileV2Mode: true }),
      readiness({ explicitTeamAdapters: 'unavailable' }),
    ],
    [
      'minimum_client_version_missing',
      intent({ sessionV2Issuance: true, minimumClientEnforcement: true }),
    ],
    ['readiness_snapshot_unavailable', intent(), readiness({ snapshot: 'unavailable' })],
  ])('rejects impossible state %s', (code, configured, deployed = readiness()) => {
    expect(() => compileUserAccessPolicy(configured, deployed)).toThrowError(
      new UserAccessPolicyConfigurationError(code)
    )
  })

  it('derives shadow, serving, renewal, and advertisement only from ready dependencies', () => {
    const policy = compileUserAccessPolicy(
      intent({
        sessionV2Issuance: true,
        catalogMode: 'serve_and_shadow',
        actionContextV2: true,
        rpcDelegationV2: true,
        desktopAllTeamMode: true,
        profileV2Mode: true,
        minimumClientVersion: '2.3.0',
        minimumClientEnforcement: true,
      }),
      readiness()
    )

    expect(policy).toMatchObject({
      renewV2: true,
      computeCatalogShadow: true,
      serveCatalog: true,
      actionContextV2: true,
      rpcDelegationV2: true,
      desktopAllTeamMode: true,
      profileV2Mode: true,
      minimumClientVersion: '2.3.0',
      enforceMinimumClient: true,
      advertisedCatalogFamilies: CATALOG_FAMILIES,
    })
    expect(policy.policyRevision).toMatch(/^[0-9a-f]{64}$/)
  })

  it('enumerates every configured Boolean/lifecycle/catalog combination deterministically', () => {
    const booleanKeys = [
      'sessionV2Acceptance',
      'sessionV2Issuance',
      'actionContextV2',
      'rpcDelegationV2',
      'desktopAllTeamMode',
      'profileV2Mode',
      'legacySwitchEndpoint',
      'minimumClientEnforcement',
    ] as const
    const lifecycles = ['issue_and_accept', 'accept_only', 'disabled'] as const
    const catalogModes = ['off', 'shadow', 'serve_and_shadow', 'serve'] as const
    let outcomes = 0

    for (const legacyLifecycle of lifecycles) {
      for (const catalogMode of catalogModes) {
        for (let mask = 0; mask < 1 << booleanKeys.length; mask += 1) {
          const configured = intent({
            legacyLifecycle,
            catalogMode,
            minimumClientVersion: mask & (1 << 7) ? '2.0.0' : null,
          }) as Record<string, unknown>
          booleanKeys.forEach((key, index) => {
            configured[key] = Boolean(mask & (1 << index))
          })
          try {
            const first = compileUserAccessPolicy(
              configured as ConfiguredUserAccessIntent,
              readiness()
            )
            const second = compileUserAccessPolicy(
              configured as ConfiguredUserAccessIntent,
              readiness()
            )
            expect(first).toEqual(second)
            expect(first.issueV2 && !first.acceptV2).toBe(false)
            expect(first.renewV2).toBe(first.issueV2 && first.acceptV2)
          } catch (error) {
            expect(error).toBeInstanceOf(UserAccessPolicyConfigurationError)
          }
          outcomes += 1
        }
      }
    }
    expect(outcomes).toBe(3 * 4 * 2 ** booleanKeys.length)
  })

  it('strictly parses controls and compares bounded semantic versions', () => {
    expect(() =>
      loadConfiguredUserAccessIntent({ CONTROL_API_USER_ACCESS_SESSION_V2_ISSUANCE: 'maybe' })
    ).toThrow(UserAccessPolicyConfigurationError)
    expect(() =>
      loadConfiguredUserAccessIntent({ CONTROL_API_USER_ACCESS_MINIMUM_CLIENT_VERSION: 'latest' })
    ).toThrow(UserAccessPolicyConfigurationError)
    expect(compareSemanticVersions('2.3.0', '2.2.9')).toBe(1)
    expect(compareSemanticVersions('2.3.0', '2.3.0')).toBe(0)
    expect(compareSemanticVersions('2.2.9', '2.3.0')).toBe(-1)
    expect(compareSemanticVersions('unbounded', '2.3.0')).toBeNull()
  })

  it('advertises shadow only from a fresh complete runtime readiness snapshot', async () => {
    const now = new Date('2026-08-11T10:00:00.000Z')
    const query = vi.fn().mockResolvedValue({
      rows: OPERATIONAL_SOURCE_FAMILIES.map((source_family, index) => ({
        source_family,
        generation: index + 1,
        resource_version: String(index + 10),
        status: 'current',
        last_success_at: new Date(now.getTime() - 1_000),
      })),
    })

    const policy = await resolveEffectiveUserAccessPolicy({
      intent: intent({ catalogMode: 'shadow' }),
      db: { query } as never,
      indexerEnabled: true,
      readinessMaxAgeMs: 5_000,
      now,
      catalogReadiness: true,
    })

    expect(policy.computeCatalogShadow).toBe(true)
    expect(policy.advertisedCatalogFamilies).toEqual(CATALOG_FAMILIES)
    expect(query).toHaveBeenCalledOnce()
  })

  it.each([
    ['missing', OPERATIONAL_SOURCE_FAMILIES.slice(1), 'catalog_shadow_families_incomplete'],
    ['mixed', OPERATIONAL_SOURCE_FAMILIES, 'catalog_shadow_families_incomplete'],
    ['expired', OPERATIONAL_SOURCE_FAMILIES, 'catalog_shadow_families_incomplete'],
  ])(
    'fails shadow readiness closed for a %s operational snapshot',
    async (kind, families, code) => {
      const now = new Date('2026-08-11T10:00:00.000Z')
      const query = vi.fn().mockResolvedValue({
        rows: families.map((source_family, index) => ({
          source_family,
          generation: index + 1,
          resource_version: String(index + 10),
          status: kind === 'mixed' && index === 0 ? 'relisting' : 'current',
          last_success_at: new Date(now.getTime() - (kind === 'expired' ? 5_001 : 1_000)),
        })),
      })

      await expect(
        resolveEffectiveUserAccessPolicy({
          intent: intent({ catalogMode: 'shadow' }),
          db: { query } as never,
          indexerEnabled: true,
          readinessMaxAgeMs: 5_000,
          now,
          catalogReadiness: true,
        })
      ).rejects.toThrowError(new UserAccessPolicyConfigurationError(code))
    }
  )

  it('does not query operational readiness or advertise families while catalog rollout is off', async () => {
    const query = vi.fn()
    const policy = await resolveEffectiveUserAccessPolicy({
      intent: intent(),
      db: { query } as never,
      indexerEnabled: true,
      readinessMaxAgeMs: null,
    })

    expect(query).not.toHaveBeenCalled()
    expect(policy.advertisedCatalogFamilies).toEqual([])
    expect(policy.computeCatalogShadow).toBe(false)
  })

  it('fails configured shadow closed when freshness evidence or its authority is unavailable', async () => {
    await expect(
      resolveEffectiveUserAccessPolicy({
        intent: intent({ catalogMode: 'shadow' }),
        indexerEnabled: true,
        readinessMaxAgeMs: null,
        catalogReadiness: true,
      })
    ).rejects.toThrowError(new UserAccessPolicyConfigurationError('readiness_snapshot_unavailable'))

    await expect(
      resolveEffectiveUserAccessPolicy({
        intent: intent({ catalogMode: 'shadow' }),
        db: { query: vi.fn().mockRejectedValue(new Error('authority unavailable')) } as never,
        indexerEnabled: true,
        readinessMaxAgeMs: 5_000,
        catalogReadiness: true,
      })
    ).rejects.toThrowError(new UserAccessPolicyConfigurationError('readiness_snapshot_unavailable'))
  })

  it('rejects an unparseable runtime readiness row', async () => {
    await expect(
      resolveEffectiveUserAccessPolicy({
        intent: intent({ catalogMode: 'shadow' }),
        db: {
          query: vi.fn().mockResolvedValue({
            rows: [{ source_family: 'host', generation: 'invalid' }],
          }),
        } as never,
        indexerEnabled: true,
        readinessMaxAgeMs: 5_000,
        catalogReadiness: true,
      })
    ).rejects.toThrowError(new UserAccessPolicyConfigurationError('runtime_readiness_invalid'))
  })

  it('keeps PR 1 action context unavailable even when configured', async () => {
    await expect(
      resolveEffectiveUserAccessPolicy({ intent: intent({ actionContextV2: true }) })
    ).rejects.toThrowError(new UserAccessPolicyConfigurationError('action_context_unavailable'))
  })
})
