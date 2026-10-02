import { createHash } from 'node:crypto'

export const USER_ACCESS_POLICY_VERSION = '1' as const

export const CATALOG_FAMILIES = [
  'user',
  'team',
  'host',
  'context',
  'mcp_server',
  'workflow_recipe',
  'workflow_run',
  'workflow_approval',
  'notification',
  'gfs_resource',
  'shared_filesystem',
  'sandbox_app',
] as const

export type CatalogFamily = (typeof CATALOG_FAMILIES)[number]
export type LegacyLifecycle = 'issue_and_accept' | 'accept_only' | 'disabled'
export type CatalogMode = 'off' | 'shadow' | 'serve_and_shadow' | 'serve'
export type Readiness = 'ready' | 'unavailable'

export type ConfiguredUserAccessIntent = Readonly<{
  legacyLifecycle: LegacyLifecycle
  sessionV2Acceptance: boolean
  sessionV2Issuance: boolean
  catalogMode: CatalogMode
  teamGfsMembershipAdmissionLimit: number | null
  actionContextV2: boolean
  rpcDelegationV2: boolean
  desktopAllTeamMode: boolean
  profileV2Mode: boolean
  legacySwitchEndpoint: boolean
  minimumClientVersion: string | null
  minimumClientEnforcement: boolean
}>

export type DeploymentReadiness = Readonly<{
  revision: string
  snapshot: 'current' | 'unavailable'
  legacySession: Readiness
  legacySwitchAuthorization: Readiness
  legacyDrainAccepted: boolean
  sessionV2Acceptance: Readiness
  sessionV2Issuance: Readiness
  accessBudget: Readiness
  catalogCoordinator: Readiness
  catalogRegisteredFamilies: ReadonlySet<CatalogFamily>
  catalogHarnessFamilies: ReadonlySet<CatalogFamily>
  catalogOperationalFamilies: ReadonlySet<CatalogFamily>
  catalogShadowComparison: Readiness
  catalogParityAccepted: boolean
  actionSafeRevisions: Readiness
  actionContext: Readiness
  rpcDelegationAllHops: Readiness
  desktop: Readiness
  explicitTeamAdapters: Readiness
  profile: Readiness
  minimumClientEnforcement: Readiness
}>

export type EffectiveUserAccessPolicy = Readonly<{
  policyVersion: typeof USER_ACCESS_POLICY_VERSION
  policyRevision: string
  acceptV1: boolean
  issueV1: boolean
  acceptV2: boolean
  issueV2: boolean
  renewV2: boolean
  switchCompatibility: boolean
  computeCatalogShadow: boolean
  serveCatalog: boolean
  actionContextV2: boolean
  rpcDelegationV2: boolean
  desktopAllTeamMode: boolean
  profileV2Mode: boolean
  minimumClientVersion: string | null
  enforceMinimumClient: boolean
  advertisedCatalogFamilies: readonly CatalogFamily[]
}>

export class UserAccessPolicyConfigurationError extends Error {
  constructor(readonly code: string) {
    super(`Invalid user-access rollout configuration: ${code}`)
    this.name = 'UserAccessPolicyConfigurationError'
  }
}

const SEMANTIC_VERSION_PATTERN = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/

function requireCondition(condition: boolean, code: string): void {
  if (!condition) throw new UserAccessPolicyConfigurationError(code)
}

function sortedFamilies(values: ReadonlySet<CatalogFamily>): CatalogFamily[] {
  return CATALOG_FAMILIES.filter(family => values.has(family))
}

function intersection(...sets: ReadonlySet<CatalogFamily>[]): CatalogFamily[] {
  return CATALOG_FAMILIES.filter(family => sets.every(set => set.has(family)))
}

function hasEveryCatalogFamily(families: readonly CatalogFamily[]): boolean {
  return families.length === CATALOG_FAMILIES.length
}

function policyRevision(
  readinessRevision: string,
  effective: Omit<EffectiveUserAccessPolicy, 'policyVersion' | 'policyRevision'>
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: USER_ACCESS_POLICY_VERSION,
        readinessRevision,
        ...effective,
        advertisedCatalogFamilies: [...effective.advertisedCatalogFamilies],
      })
    )
    .digest('hex')
}

export function compileUserAccessPolicy(
  intent: ConfiguredUserAccessIntent,
  readiness: DeploymentReadiness
): EffectiveUserAccessPolicy {
  requireCondition(readiness.snapshot === 'current', 'readiness_snapshot_unavailable')
  requireCondition(readiness.revision.trim().length > 0, 'readiness_revision_missing')

  const acceptV1 = intent.legacyLifecycle !== 'disabled'
  const issueV1 = intent.legacyLifecycle === 'issue_and_accept'
  const acceptV2 = intent.sessionV2Acceptance
  const issueV2 = intent.sessionV2Issuance

  requireCondition(acceptV1 || acceptV2, 'no_accepted_session_contract')
  if (acceptV1) {
    requireCondition(readiness.legacySession === 'ready', 'legacy_session_unavailable')
  }
  if (acceptV2) {
    requireCondition(readiness.sessionV2Acceptance === 'ready', 'session_v2_acceptance_unavailable')
  }
  if (issueV2) {
    requireCondition(acceptV2, 'session_v2_issuance_requires_acceptance')
    requireCondition(readiness.sessionV2Issuance === 'ready', 'session_v2_issuance_unavailable')
  }
  if (intent.legacyLifecycle === 'accept_only') {
    requireCondition(issueV2, 'legacy_accept_only_requires_v2_issuance')
  }
  if (intent.legacyLifecycle === 'disabled') {
    requireCondition(acceptV2 && issueV2, 'legacy_disabled_requires_v2_issue_and_accept')
    requireCondition(readiness.legacyDrainAccepted, 'legacy_disabled_requires_accepted_drain')
  }

  if (intent.legacySwitchEndpoint) {
    requireCondition(
      intent.legacyLifecycle === 'issue_and_accept',
      'legacy_switch_requires_v1_issue_and_accept'
    )
    requireCondition(
      readiness.legacySwitchAuthorization === 'ready',
      'legacy_switch_authorization_unavailable'
    )
  }

  const wantsShadow = intent.catalogMode === 'shadow' || intent.catalogMode === 'serve_and_shadow'
  const wantsServe = intent.catalogMode === 'serve' || intent.catalogMode === 'serve_and_shadow'
  if (wantsShadow || wantsServe) {
    requireCondition(
      intent.teamGfsMembershipAdmissionLimit !== null,
      'catalog_team_gfs_membership_admission_missing'
    )
  }
  const advertisedCatalogFamilies =
    wantsShadow || wantsServe
      ? intersection(
          readiness.catalogRegisteredFamilies,
          readiness.catalogHarnessFamilies,
          readiness.catalogOperationalFamilies
        )
      : []
  const everyCatalogFamilyReady = hasEveryCatalogFamily(advertisedCatalogFamilies)

  if (wantsShadow) {
    requireCondition(acceptV2, 'catalog_shadow_requires_v2_acceptance')
    requireCondition(readiness.accessBudget === 'ready', 'catalog_shadow_budget_unavailable')
    requireCondition(
      readiness.catalogCoordinator === 'ready',
      'catalog_shadow_coordinator_unavailable'
    )
    requireCondition(everyCatalogFamilyReady, 'catalog_shadow_families_incomplete')
    requireCondition(
      readiness.catalogShadowComparison === 'ready',
      'catalog_shadow_comparison_unavailable'
    )
  }
  if (wantsServe) {
    requireCondition(acceptV2, 'catalog_serving_requires_v2_acceptance')
    requireCondition(readiness.accessBudget === 'ready', 'catalog_serving_budget_unavailable')
    requireCondition(
      readiness.catalogCoordinator === 'ready',
      'catalog_serving_coordinator_unavailable'
    )
    requireCondition(everyCatalogFamilyReady, 'catalog_serving_families_incomplete')
    requireCondition(
      readiness.actionSafeRevisions === 'ready',
      'catalog_serving_revisions_unavailable'
    )
    requireCondition(readiness.catalogParityAccepted, 'catalog_serving_parity_not_accepted')
  }

  if (intent.actionContextV2) {
    requireCondition(acceptV2, 'action_context_requires_v2_acceptance')
    requireCondition(readiness.accessBudget === 'ready', 'action_context_budget_unavailable')
    requireCondition(readiness.actionContext === 'ready', 'action_context_unavailable')
  }
  if (intent.rpcDelegationV2) {
    requireCondition(intent.actionContextV2, 'rpc_v2_requires_action_context')
    requireCondition(readiness.rpcDelegationAllHops === 'ready', 'rpc_v2_all_hops_unavailable')
  }
  if (intent.desktopAllTeamMode) {
    requireCondition(issueV2, 'desktop_mode_requires_v2_issuance')
    requireCondition(wantsServe, 'desktop_mode_requires_catalog_serving')
    requireCondition(intent.actionContextV2, 'desktop_mode_requires_action_context')
    requireCondition(intent.rpcDelegationV2, 'desktop_mode_requires_rpc_v2')
    requireCondition(readiness.desktop === 'ready', 'desktop_mode_unavailable')
  }
  if (intent.profileV2Mode) {
    requireCondition(issueV2 && acceptV2, 'profile_mode_requires_v2_issue_and_accept')
    requireCondition(
      readiness.explicitTeamAdapters === 'ready',
      'profile_explicit_team_adapters_unavailable'
    )
    requireCondition(readiness.profile === 'ready', 'profile_mode_unavailable')
  }

  const minimumVersion = intent.minimumClientVersion?.trim() || null
  if (minimumVersion !== null) {
    requireCondition(
      SEMANTIC_VERSION_PATTERN.test(minimumVersion),
      'minimum_client_version_invalid'
    )
  }
  if (intent.minimumClientEnforcement) {
    requireCondition(minimumVersion !== null, 'minimum_client_version_missing')
    requireCondition(issueV2, 'minimum_client_enforcement_requires_v2_issuance')
    requireCondition(
      readiness.minimumClientEnforcement === 'ready',
      'minimum_client_enforcement_unavailable'
    )
  }

  const effective = Object.freeze({
    acceptV1,
    issueV1,
    acceptV2,
    issueV2,
    renewV2: acceptV2 && issueV2,
    switchCompatibility: intent.legacySwitchEndpoint,
    computeCatalogShadow: wantsShadow,
    serveCatalog: wantsServe,
    actionContextV2: intent.actionContextV2,
    rpcDelegationV2: intent.rpcDelegationV2,
    desktopAllTeamMode: intent.desktopAllTeamMode,
    profileV2Mode: intent.profileV2Mode,
    minimumClientVersion: intent.minimumClientEnforcement ? minimumVersion : null,
    enforceMinimumClient: intent.minimumClientEnforcement,
    advertisedCatalogFamilies: Object.freeze(advertisedCatalogFamilies),
  })

  return Object.freeze({
    policyVersion: USER_ACCESS_POLICY_VERSION,
    policyRevision: policyRevision(readiness.revision, effective),
    ...effective,
  })
}

function parseBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new UserAccessPolicyConfigurationError(`${name.toLowerCase()}_invalid`)
}

function parseEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  fallback: T
): T {
  const raw = env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (allowed.includes(raw as T)) return raw as T
  throw new UserAccessPolicyConfigurationError(`${name.toLowerCase()}_invalid`)
}

function parseVersion(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim()
  if (!raw) return null
  if (!SEMANTIC_VERSION_PATTERN.test(raw)) {
    throw new UserAccessPolicyConfigurationError(`${name.toLowerCase()}_invalid`)
  }
  return raw
}

function parseOptionalPositiveSafeInteger(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = env[name]?.trim()
  if (!raw) return null
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new UserAccessPolicyConfigurationError(`${name.toLowerCase()}_invalid`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UserAccessPolicyConfigurationError(`${name.toLowerCase()}_invalid`)
  }
  return value
}

export function loadConfiguredUserAccessIntent(env: NodeJS.ProcessEnv): ConfiguredUserAccessIntent {
  const catalogMode = parseEnum(
    env,
    'CONTROL_API_USER_ACCESS_CATALOG_MODE',
    ['off', 'shadow', 'serve_and_shadow', 'serve'] as const,
    'off'
  )
  const teamGfsMembershipAdmissionLimit = parseOptionalPositiveSafeInteger(
    env,
    'CONTROL_API_USER_ACCESS_TEAM_GFS_MEMBERSHIP_ADMISSION_LIMIT'
  )
  if (catalogMode !== 'off' && teamGfsMembershipAdmissionLimit === null) {
    throw new UserAccessPolicyConfigurationError(
      'control_api_user_access_team_gfs_membership_admission_limit_missing'
    )
  }
  return Object.freeze({
    legacyLifecycle: parseEnum(
      env,
      'CONTROL_API_USER_ACCESS_LEGACY_LIFECYCLE',
      ['issue_and_accept', 'accept_only', 'disabled'] as const,
      'issue_and_accept'
    ),
    sessionV2Acceptance: parseBoolean(env, 'CONTROL_API_USER_ACCESS_SESSION_V2_ACCEPTANCE', true),
    sessionV2Issuance: parseBoolean(env, 'CONTROL_API_USER_ACCESS_SESSION_V2_ISSUANCE', false),
    catalogMode,
    teamGfsMembershipAdmissionLimit,
    actionContextV2: parseBoolean(env, 'CONTROL_API_USER_ACCESS_ACTION_CONTEXT_V2', false),
    rpcDelegationV2: parseBoolean(env, 'CONTROL_API_USER_ACCESS_RPC_DELEGATION_V2', false),
    desktopAllTeamMode: parseBoolean(env, 'CONTROL_API_USER_ACCESS_DESKTOP_ALL_TEAM_MODE', false),
    profileV2Mode: parseBoolean(env, 'CONTROL_API_USER_ACCESS_PROFILE_V2_MODE', false),
    legacySwitchEndpoint: parseBoolean(env, 'CONTROL_API_USER_ACCESS_LEGACY_SWITCH_ENDPOINT', true),
    minimumClientVersion: parseVersion(env, 'CONTROL_API_USER_ACCESS_MINIMUM_CLIENT_VERSION'),
    minimumClientEnforcement: parseBoolean(
      env,
      'CONTROL_API_USER_ACCESS_MINIMUM_CLIENT_ENFORCEMENT',
      false
    ),
  })
}

export const reconstructionReadiness: DeploymentReadiness = Object.freeze({
  revision: 'pr1-foundation-validated-v1',
  snapshot: 'current',
  legacySession: 'ready',
  legacySwitchAuthorization: 'ready',
  legacyDrainAccepted: false,
  sessionV2Acceptance: 'ready',
  sessionV2Issuance: 'ready',
  accessBudget: 'ready',
  catalogCoordinator: 'ready',
  catalogRegisteredFamilies: new Set<CatalogFamily>(CATALOG_FAMILIES),
  catalogHarnessFamilies: new Set<CatalogFamily>(CATALOG_FAMILIES),
  catalogOperationalFamilies: new Set<CatalogFamily>(),
  catalogShadowComparison: 'ready',
  catalogParityAccepted: false,
  actionSafeRevisions: 'ready',
  // The resolver exists for foundation validation, but its public rollout is
  // owned by the later runtime unit and remains unavailable in PR 1.
  actionContext: 'unavailable',
  // PR 2 owns the rpc-proxy and mcp-host hops. This stays unavailable in PR 1.
  rpcDelegationAllHops: 'unavailable',
  desktop: 'unavailable',
  explicitTeamAdapters: 'ready',
  profile: 'unavailable',
  minimumClientEnforcement: 'unavailable',
})

export const configuredUserAccessIntent = loadConfiguredUserAccessIntent(process.env)

export function catalogBudgetOptionsForIntent(
  intent: ConfiguredUserAccessIntent
): Readonly<{ teamGfsMembershipAdmissionLimit?: number }> {
  return intent.teamGfsMembershipAdmissionLimit === null
    ? Object.freeze({})
    : Object.freeze({
        teamGfsMembershipAdmissionLimit: intent.teamGfsMembershipAdmissionLimit,
      })
}

export const configuredCatalogBudgetOptions = catalogBudgetOptionsForIntent(
  configuredUserAccessIntent
)

export function userAccessCapabilityManifest(policy: EffectiveUserAccessPolicy): Readonly<{
  policyVersion: string
  policyRevision: string
  v1Accepted: boolean
  v1Issued: boolean
  v2Accepted: boolean
  v2Issued: boolean
  v2Renewal: boolean
  legacySwitch: boolean
  catalogShadow: boolean
  catalogServed: boolean
  actionContextV2: boolean
  rpcDelegationV2: boolean
  desktopAllTeamMode: boolean
  profileV2Mode: boolean
  minimumClientVersion: string | null
  minimumClientEnforced: boolean
  catalogFamilies: readonly CatalogFamily[]
}> {
  return Object.freeze({
    policyVersion: policy.policyVersion,
    policyRevision: policy.policyRevision,
    v1Accepted: policy.acceptV1,
    v1Issued: policy.issueV1,
    v2Accepted: policy.acceptV2,
    v2Issued: policy.issueV2,
    v2Renewal: policy.renewV2,
    legacySwitch: policy.switchCompatibility,
    catalogShadow: policy.computeCatalogShadow,
    catalogServed: policy.serveCatalog,
    actionContextV2: policy.actionContextV2,
    rpcDelegationV2: policy.rpcDelegationV2,
    desktopAllTeamMode: policy.desktopAllTeamMode,
    profileV2Mode: policy.profileV2Mode,
    minimumClientVersion: policy.minimumClientVersion,
    minimumClientEnforced: policy.enforceMinimumClient,
    catalogFamilies: Object.freeze([...policy.advertisedCatalogFamilies]),
  })
}

export function compareSemanticVersions(left: string, right: string): number | null {
  const leftMatch = SEMANTIC_VERSION_PATTERN.exec(left)
  const rightMatch = SEMANTIC_VERSION_PATTERN.exec(right)
  if (!leftMatch || !rightMatch) return null
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index])
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

export function registeredCatalogFamilies(readiness: DeploymentReadiness): CatalogFamily[] {
  return sortedFamilies(readiness.catalogRegisteredFamilies)
}
