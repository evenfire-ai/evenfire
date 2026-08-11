export type UserAccessRollout = Readonly<{
  sessionV2Acceptance: boolean
  sessionV2Issuance: boolean
  aggregateCatalogShadowing: boolean
  aggregateCatalogServing: boolean
  actionContextV2: boolean
  rpcDelegationV2: boolean
  desktopAllTeamMode: boolean
  profileV2Mode: boolean
  legacyV1Acceptance: boolean
  legacySwitchEndpoint: boolean
  minimumClientVersion: string | null
}>

function enabled(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase()
  if (value === undefined || value === '') return fallback
  return value === 'true' || value === '1'
}

function boundedVersion(value: string | undefined): string | null {
  const version = value?.trim()
  if (!version) return null
  return version.length <= 64 ? version : null
}

/**
 * Deployment controls are intentionally independent so acceptance can remain enabled while
 * issuance or a downstream consumer is rolled back. New user-visible modes default off; the
 * dual-verification compatibility boundary defaults on.
 */
export function loadUserAccessRollout(env: NodeJS.ProcessEnv): UserAccessRollout {
  return Object.freeze({
    sessionV2Acceptance: enabled(env, 'CONTROL_API_USER_SESSION_V2_ACCEPTANCE', true),
    sessionV2Issuance: enabled(env, 'CONTROL_API_USER_SESSION_V2_ISSUANCE', false),
    aggregateCatalogShadowing: enabled(env, 'CONTROL_API_AGGREGATE_CATALOG_SHADOWING', false),
    aggregateCatalogServing: enabled(env, 'CONTROL_API_AGGREGATE_CATALOG_SERVING', false),
    actionContextV2: enabled(env, 'CONTROL_API_ACTION_CONTEXT_V2', false),
    rpcDelegationV2: enabled(env, 'CONTROL_API_RPC_DELEGATION_V2', false),
    desktopAllTeamMode: enabled(env, 'CONTROL_API_DESKTOP_ALL_TEAM_MODE', false),
    profileV2Mode: enabled(env, 'CONTROL_API_PROFILE_V2_MODE', false),
    legacyV1Acceptance: enabled(env, 'CONTROL_API_LEGACY_V1_ACCEPTANCE', true),
    legacySwitchEndpoint: enabled(env, 'CONTROL_API_LEGACY_SWITCH_ENDPOINT', true),
    minimumClientVersion: boundedVersion(env.CONTROL_API_MINIMUM_USER_CLIENT_VERSION),
  })
}

export const userAccessRollout = loadUserAccessRollout(process.env)
