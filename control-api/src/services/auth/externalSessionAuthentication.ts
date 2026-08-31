import type { AuthClaims } from '../../profileTypes.js'
import { verifyExternalSessionToken } from '../../utils/auth/externalSessionAuthToken.js'
import {
  type UserSessionV2Claims,
  verifyUserSessionV2Token,
} from '../../utils/auth/userSessionV2Token.js'
import type { AccessExecutionBudget } from '../access/accessExecutionBudget.js'
import {
  type EffectiveUserAccessPolicy,
  compareSemanticVersions,
} from '../access/userAccessPolicy.js'
import { resolveEffectiveUserAccessPolicy } from '../access/userAccessRuntimePolicy.js'
import { legacyExternalSessionAuthGeneration } from './legacyV1Generation.js'
import {
  type IssuedUserSession,
  renewUserSession,
  validateLegacyUserSession,
  validateUserSessionClaims,
} from './userSessionService.js'

export type ExternalSessionPurpose =
  | 'protected'
  | 'verify'
  | 'renew'
  | 'switch'
  | 'rpc_legacy'
  | 'workflow_user'
  | 'revoke_cleanup'

export type ExternalSessionClient = Readonly<{
  version?: string
  requestedContract?: 'v1' | 'v2'
}>

export type ExternalSessionIdentityAuthentication =
  | {
      status: 'authenticated'
      claims: AuthClaims
      contract: 'v1' | 'v2'
      authorityContext: ExternalSessionAuthorityContext
      tokenClaims: AuthClaims | UserSessionV2Claims
    }
  | { status: 'invalid' | 'expired' | 'revoked'; reason: string }
  | { status: 'upgrade_required'; reason: string }

export type ExternalSessionAuthentication =
  | (Extract<ExternalSessionIdentityAuthentication, { status: 'authenticated' }> & {
      policy: EffectiveUserAccessPolicy
    })
  | Exclude<ExternalSessionIdentityAuthentication, { status: 'authenticated' }>

export type ExternalSessionRenewal =
  | { status: 'renewed'; session: IssuedUserSession }
  | Exclude<ExternalSessionAuthentication, { status: 'authenticated' }>

type AuthenticationOptions = Readonly<{
  purpose: ExternalSessionPurpose
  client?: ExternalSessionClient
  policy?: EffectiveUserAccessPolicy
  budget?: AccessExecutionBudget
  now?: Date
  identity?: Extract<ExternalSessionIdentityAuthentication, { status: 'authenticated' }>
}>

export type ExternalSessionAuthorityContext = Readonly<
  | {
      contract: 'v1'
      userId: string
      tokenHash: string
      issuedAt: number
      authGeneration: number
    }
  | {
      contract: 'v2'
      userId: string
      sid: string
      jti: string
      sessionVersion: number
    }
>

function clientMeetsMinimum(
  client: ExternalSessionClient | undefined,
  policy: EffectiveUserAccessPolicy
): boolean {
  if (!policy.enforceMinimumClient || !policy.minimumClientVersion) return true
  if (!client?.version) return false
  const comparison = compareSemanticVersions(client.version, policy.minimumClientVersion)
  return comparison !== null && comparison >= 0
}

function purposeRequiresMinimumClient(purpose: ExternalSessionPurpose): boolean {
  return purpose !== 'revoke_cleanup'
}

function v1Allowed(purpose: ExternalSessionPurpose, policy: EffectiveUserAccessPolicy): boolean {
  if (purpose === 'renew') return false
  if (purpose === 'switch') {
    return policy.acceptV1 && policy.issueV1 && policy.switchCompatibility
  }
  return policy.acceptV1
}

function v2Allowed(purpose: ExternalSessionPurpose, policy: EffectiveUserAccessPolicy): boolean {
  if (purpose === 'renew') return policy.acceptV2 && policy.issueV2 && policy.renewV2
  if (purpose === 'switch') return policy.acceptV2 && policy.switchCompatibility
  if (purpose === 'revoke_cleanup') return true
  return policy.acceptV2
}

function normalizedV2Claims(
  claims: UserSessionV2Claims,
  identity: {
    userId: string
    email: string
    sid: string
    jti: string
    sessionVersion: number
  }
): AuthClaims {
  return {
    userId: identity.userId,
    email: identity.email,
    teamId: null,
    role: 'member',
    exp: claims.exp,
    iat: claims.iat,
    sessionContract: 'v2',
    sid: identity.sid,
    jti: identity.jti,
    sv: identity.sessionVersion,
    ver: 2,
    authTime: claims.auth_time,
    amr: [...claims.amr],
  }
}

/**
 * The identity-only stage of the sole external-user authentication boundary.
 * It is sufficient to derive a trusted authenticated rate-limit subject, but
 * intentionally performs no effective-policy, rollout, or readiness lookup.
 */
export async function authenticateExternalUserSessionIdentity(
  token: string,
  options: Pick<AuthenticationOptions, 'budget' | 'now'> = {}
): Promise<ExternalSessionIdentityAuthentication> {
  const v2Claims = verifyUserSessionV2Token(token)
  if (v2Claims) {
    const validation = await validateUserSessionClaims(v2Claims, {
      now: options.now,
      budget: options.budget,
    })
    if (validation.status !== 'valid') return validation
    return {
      status: 'authenticated',
      contract: 'v2',
      claims: normalizedV2Claims(v2Claims, validation.identity),
      tokenClaims: v2Claims,
      authorityContext: Object.freeze({
        contract: 'v2',
        userId: v2Claims.sub,
        sid: v2Claims.sid,
        jti: v2Claims.jti,
        sessionVersion: v2Claims.sv,
      }),
    }
  }

  const v1Claims = verifyExternalSessionToken(token)
  if (!v1Claims) return { status: 'invalid', reason: 'invalid_representation' }
  const validation = await validateLegacyUserSession(token, v1Claims, {
    budget: options.budget,
  })
  if (validation.status !== 'valid') return validation
  const authGeneration = legacyExternalSessionAuthGeneration(v1Claims)
  if (authGeneration === null) {
    return { status: 'invalid', reason: 'invalid_legacy_representation' }
  }
  return {
    status: 'authenticated',
    contract: 'v1',
    claims: Object.freeze({
      ...v1Claims,
      authGeneration,
    }),
    tokenClaims: v1Claims,
    authorityContext: Object.freeze({
      contract: 'v1',
      userId: v1Claims.userId,
      tokenHash: validation.identity.jti,
      issuedAt: v1Claims.iat!,
      authGeneration,
    }),
  }
}

/**
 * Rechecks mutable session authority after the authenticated limiter permits
 * the request. It reuses the Stage-A verified claims and does not re-verify
 * the bearer representation.
 */
async function revalidateExternalUserSessionIdentity(
  token: string,
  identity: Extract<ExternalSessionIdentityAuthentication, { status: 'authenticated' }>,
  options: Pick<AuthenticationOptions, 'budget' | 'now'>
): Promise<ExternalSessionIdentityAuthentication> {
  if (identity.contract === 'v2') {
    const validation = await validateUserSessionClaims(
      identity.tokenClaims as UserSessionV2Claims,
      {
        now: options.now,
        budget: options.budget,
      }
    )
    if (validation.status !== 'valid') return validation
    const claims = identity.tokenClaims as UserSessionV2Claims
    return {
      ...identity,
      claims: normalizedV2Claims(claims, validation.identity),
    }
  }

  const claims = identity.tokenClaims as AuthClaims
  const validation = await validateLegacyUserSession(token, claims, {
    budget: options.budget,
  })
  if (validation.status !== 'valid') return validation
  return identity
}

/**
 * Sole external-user authentication boundary. No route or middleware may call
 * a low-level external-user token verifier directly.
 */
export async function authenticateExternalUserSession(
  token: string,
  options: AuthenticationOptions
): Promise<ExternalSessionAuthentication> {
  const policy =
    options.policy ?? (await resolveEffectiveUserAccessPolicy({ budget: options.budget }))
  const identity = options.identity
    ? await revalidateExternalUserSessionIdentity(token, options.identity, {
        budget: options.budget,
        now: options.now,
      })
    : null
  if (identity && identity.status !== 'authenticated') return identity

  if (
    purposeRequiresMinimumClient(options.purpose) &&
    !clientMeetsMinimum(options.client, policy)
  ) {
    return { status: 'upgrade_required', reason: 'minimum_client_version' }
  }

  const authenticatedIdentity =
    identity ??
    (await authenticateExternalUserSessionIdentity(token, {
      budget: options.budget,
      now: options.now,
    }))
  if (authenticatedIdentity.status !== 'authenticated') return authenticatedIdentity

  if (
    (authenticatedIdentity.contract === 'v1' && !v1Allowed(options.purpose, policy)) ||
    (authenticatedIdentity.contract === 'v2' && !v2Allowed(options.purpose, policy))
  ) {
    return { status: 'invalid', reason: 'session_contract_not_accepted' }
  }

  return { ...authenticatedIdentity, policy }
}

export async function renewExternalUserSession(
  token: string,
  options: Omit<AuthenticationOptions, 'purpose'> = {}
): Promise<ExternalSessionRenewal> {
  const policy =
    options.policy ?? (await resolveEffectiveUserAccessPolicy({ budget: options.budget }))
  if (!clientMeetsMinimum(options.client, policy)) {
    return { status: 'upgrade_required', reason: 'minimum_client_version' }
  }
  if (!policy.acceptV2 || !policy.issueV2 || !policy.renewV2) {
    return { status: 'invalid', reason: 'session_renewal_unavailable' }
  }
  const claims = verifyUserSessionV2Token(token)
  if (!claims) return { status: 'invalid', reason: 'invalid_representation' }
  const result = await renewUserSession(claims, { now: options.now, budget: options.budget })
  if (!('token' in result)) {
    if (result.status === 'valid') {
      return { status: 'invalid', reason: 'session_renewal_failed' }
    }
    return result
  }
  return { status: 'renewed', session: result }
}
