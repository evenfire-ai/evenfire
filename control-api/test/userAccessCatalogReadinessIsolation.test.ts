import { describe, expect, it, vi } from 'vitest'
import type { ConfiguredUserAccessIntent } from '../src/services/access/userAccessPolicy.js'
import { resolveEffectiveUserAccessPolicy } from '../src/services/access/userAccessRuntimePolicy.js'

const shadowIntent: ConfiguredUserAccessIntent = Object.freeze({
  legacyLifecycle: 'issue_and_accept',
  sessionV2Acceptance: true,
  sessionV2Issuance: false,
  catalogMode: 'shadow',
  teamGfsMembershipAdmissionLimit: 4,
  actionContextV2: false,
  rpcDelegationV2: false,
  desktopAllTeamMode: false,
  profileV2Mode: false,
  legacySwitchEndpoint: true,
  minimumClientVersion: null,
  minimumClientEnforcement: false,
})

describe('catalog readiness isolation', () => {
  it('keeps ordinary policy resolution independent from catalog readiness', async () => {
    const query = vi.fn().mockRejectedValue(new Error('catalog source unavailable'))

    await expect(
      resolveEffectiveUserAccessPolicy({
        intent: shadowIntent,
        db: { query } as never,
        indexerEnabled: true,
        readinessMaxAgeMs: 5_000,
      })
    ).resolves.toMatchObject({
      acceptV1: true,
      acceptV2: true,
      computeCatalogShadow: false,
      serveCatalog: false,
      advertisedCatalogFamilies: [],
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('keeps catalog-specific readiness fail-closed', async () => {
    const query = vi.fn().mockRejectedValue(new Error('catalog source unavailable'))

    await expect(
      resolveEffectiveUserAccessPolicy({
        intent: shadowIntent,
        db: { query } as never,
        indexerEnabled: true,
        readinessMaxAgeMs: 5_000,
        catalogReadiness: true,
      })
    ).rejects.toMatchObject({ code: 'readiness_snapshot_unavailable' })
    expect(query).toHaveBeenCalledOnce()
  })
})
