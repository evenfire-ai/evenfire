import { describe, expect, it } from 'vitest'
import {
  type ConfiguredUserAccessIntent,
  type DeploymentReadiness,
  UserAccessPolicyConfigurationError,
  compareSemanticVersions,
  compileUserAccessPolicy,
  configuredUserAccessIntent,
  loadConfiguredUserAccessIntent,
  reconstructionReadiness,
} from '../src/services/access/userAccessPolicy.js'
import { resolveEffectiveUserAccessPolicy } from '../src/services/access/userAccessRuntimePolicy.js'

function intent(overrides: Partial<ConfiguredUserAccessIntent> = {}): ConfiguredUserAccessIntent {
  const configured: ConfiguredUserAccessIntent = {
    legacyLifecycle: 'issue_and_accept',
    sessionV2Acceptance: true,
    sessionV2Issuance: false,
    legacySwitchEndpoint: true,
    minimumClientVersion: null,
    minimumClientEnforcement: false,
    ...overrides,
  }
  return configured
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
      enforceMinimumClient: false,
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
      'minimum_client_version_missing',
      intent({ sessionV2Issuance: true, minimumClientEnforcement: true }),
    ],
    ['readiness_snapshot_unavailable', intent(), readiness({ snapshot: 'unavailable' })],
    ['readiness_revision_missing', intent(), readiness({ revision: '  ' })],
    ['legacy_session_unavailable', intent(), readiness({ legacySession: 'unavailable' })],
    [
      'session_v2_acceptance_unavailable',
      intent(),
      readiness({ sessionV2Acceptance: 'unavailable' }),
    ],
    [
      'session_v2_issuance_unavailable',
      intent({ sessionV2Issuance: true }),
      readiness({ sessionV2Issuance: 'unavailable' }),
    ],
    [
      'legacy_disabled_requires_v2_issue_and_accept',
      intent({ legacyLifecycle: 'disabled', legacySwitchEndpoint: false }),
    ],
    [
      'legacy_switch_authorization_unavailable',
      intent(),
      readiness({ legacySwitchAuthorization: 'unavailable' }),
    ],
    ['minimum_client_version_invalid', intent({ minimumClientVersion: '2.0' })],
    [
      'minimum_client_enforcement_requires_v2_issuance',
      intent({ minimumClientVersion: '2.0.0', minimumClientEnforcement: true }),
    ],
    [
      'minimum_client_enforcement_unavailable',
      intent({
        sessionV2Issuance: true,
        minimumClientVersion: '2.0.0',
        minimumClientEnforcement: true,
      }),
      readiness({ minimumClientEnforcement: 'unavailable' }),
    ],
  ])('rejects impossible state %s', (code, configured, deployed = readiness()) => {
    expect(() => compileUserAccessPolicy(configured, deployed)).toThrowError(
      new UserAccessPolicyConfigurationError(code)
    )
  })

  it('derives renewal and the minimum-client gate only from ready dependencies', () => {
    const policy = compileUserAccessPolicy(
      intent({
        sessionV2Issuance: true,
        minimumClientVersion: '2.3.0',
        minimumClientEnforcement: true,
      }),
      readiness()
    )

    expect(policy).toMatchObject({
      renewV2: true,
      minimumClientVersion: '2.3.0',
      enforceMinimumClient: true,
    })
    expect(policy.policyRevision).toMatch(/^[0-9a-f]{64}$/)
  })

  it('enumerates every configured Boolean/lifecycle combination deterministically', () => {
    const booleanKeys = [
      'sessionV2Acceptance',
      'sessionV2Issuance',
      'legacySwitchEndpoint',
      'minimumClientEnforcement',
    ] as const
    const lifecycles = ['issue_and_accept', 'accept_only', 'disabled'] as const
    let outcomes = 0

    for (const legacyLifecycle of lifecycles) {
      for (let mask = 0; mask < 1 << booleanKeys.length; mask += 1) {
        const configured = intent({
          legacyLifecycle,
          minimumClientVersion:
            mask & (1 << booleanKeys.indexOf('minimumClientEnforcement')) ? '2.0.0' : null,
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
    expect(outcomes).toBe(3 * 2 ** booleanKeys.length)
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

  it('compiles the runtime policy against the PR 1 deployment readiness', async () => {
    await expect(resolveEffectiveUserAccessPolicy({ intent: intent() })).resolves.toMatchObject({
      acceptV1: true,
      acceptV2: true,
      issueV2: false,
    })
    // Minimum-client enforcement is not deployed in PR 1, so configuring it stops startup.
    await expect(
      resolveEffectiveUserAccessPolicy({
        intent: intent({
          sessionV2Issuance: true,
          minimumClientVersion: '2.0.0',
          minimumClientEnforcement: true,
        }),
      })
    ).rejects.toThrowError(
      new UserAccessPolicyConfigurationError('minimum_client_enforcement_unavailable')
    )
  })

  it('compiles the configured runtime policy once and an explicit intent on every call', async () => {
    const first = await resolveEffectiveUserAccessPolicy()
    const second = await resolveEffectiveUserAccessPolicy()
    expect(second).toBe(first)
    expect(first).toEqual(
      compileUserAccessPolicy(configuredUserAccessIntent, reconstructionReadiness)
    )

    // Witness: an explicit intent is compiled for that call and reflects that intent.
    const explicit = await resolveEffectiveUserAccessPolicy({
      intent: intent({ legacySwitchEndpoint: !first.switchCompatibility }),
    })
    expect(explicit).not.toBe(first)
    expect(explicit.switchCompatibility).toBe(!first.switchCompatibility)
    expect(explicit.policyRevision).not.toBe(first.policyRevision)
    await expect(resolveEffectiveUserAccessPolicy()).resolves.toBe(first)
  })
})
