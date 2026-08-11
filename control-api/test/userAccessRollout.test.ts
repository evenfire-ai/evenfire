import { describe, expect, it } from 'vitest'
import { loadUserAccessRollout } from '../src/services/access/userAccessRollout.js'

describe('user access rollout controls', () => {
  it('defaults new consumer modes off while preserving dual verification', () => {
    const userAccessRollout = loadUserAccessRollout({})

    expect(userAccessRollout).toEqual({
      sessionV2Acceptance: true,
      sessionV2Issuance: false,
      aggregateCatalogShadowing: false,
      aggregateCatalogServing: false,
      actionContextV2: false,
      rpcDelegationV2: false,
      desktopAllTeamMode: false,
      profileV2Mode: false,
      legacyV1Acceptance: true,
      legacySwitchEndpoint: true,
      minimumClientVersion: null,
    })
  })

  it('loads all eleven controls independently from explicit deployment input', () => {
    const userAccessRollout = loadUserAccessRollout({
      CONTROL_API_USER_SESSION_V2_ACCEPTANCE: 'false',
      CONTROL_API_USER_SESSION_V2_ISSUANCE: 'true',
      CONTROL_API_AGGREGATE_CATALOG_SHADOWING: '1',
      CONTROL_API_AGGREGATE_CATALOG_SERVING: 'true',
      CONTROL_API_ACTION_CONTEXT_V2: 'true',
      CONTROL_API_RPC_DELEGATION_V2: 'true',
      CONTROL_API_DESKTOP_ALL_TEAM_MODE: 'true',
      CONTROL_API_PROFILE_V2_MODE: 'true',
      CONTROL_API_LEGACY_V1_ACCEPTANCE: 'false',
      CONTROL_API_LEGACY_SWITCH_ENDPOINT: 'false',
      CONTROL_API_MINIMUM_USER_CLIENT_VERSION: ' 2.3.0 ',
    })

    expect(userAccessRollout).toEqual({
      sessionV2Acceptance: false,
      sessionV2Issuance: true,
      aggregateCatalogShadowing: true,
      aggregateCatalogServing: true,
      actionContextV2: true,
      rpcDelegationV2: true,
      desktopAllTeamMode: true,
      profileV2Mode: true,
      legacyV1Acceptance: false,
      legacySwitchEndpoint: false,
      minimumClientVersion: '2.3.0',
    })
  })
})
