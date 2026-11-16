import type { AuthClaims } from '../../profileTypes.js'
import { verifyExternalSessionToken } from '../../utils/auth/externalSessionAuthToken.js'
import {
  type UserSessionV2Claims,
  verifyUserSessionV2Token,
} from '../../utils/auth/userSessionV2Token.js'
import {
  type EffectiveUserAccessPolicy,
  compareSemanticVersions,
} from '../access/userAccessPolicy.js'
import { resolveEffectiveUserAccessPolicy } from '../access/userAccessRuntimePolicy.js'
import { legacyExternalSessionAuthGeneration } from './legacyV1Generation.js'
import { externalSessionDatabaseFailure } from './sessionDatabaseFailure.js'
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
  now?: Date
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

/**
 * Return a signed V1 subject solely for pre-authentication rate-limit bucketing.
 * This does not establish current session authority; protected work must still
 * pass through authenticateExternalUserSession and its live lifecycle checks.
 */
/**
 * Signature-only subject for limiters that run before live authentication.
 * Both session contracts key on the user, so V2 sessions never fall back to a
 * shared source-IP bucket. No database work happens here.
 */
export function externalSessionUserIdForRateLimit(token: string): string | null {
  return verifyUserSessionV2Token(token)?.sub ?? verifyExternalSessionToken(token)?.userId ?? null
}

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
 * The identity stage of the sole external-user authentication boundary. It
 * validates the presented session and, for a V2 session, records its use (the
 * idle-lifetime touch) unless the caller's own operation records it, as session
 * renewal does when it rotates the session. It performs no effective-policy,
 * rollout, or readiness lookup; authenticateExternalUserSession adds those.
 */
async function authenticateExternalUserSessionIdentity(
  token: string,
  options: Pick<AuthenticationOptions, 'now'> & { touch?: boolean } = {}
): Promise<ExternalSessionIdentityAuthentication> {
  const v2Claims = verifyUserSessionV2Token(token)
  if (v2Claims) {
    const validation = await validateUserSessionClaims(v2Claims, {
      touch: options.touch !== false,
      onDatabaseFailure: externalSessionDatabaseFailure,
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
    onDatabaseFailure: externalSessionDatabaseFailure,
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
 * Sole external-user authentication boundary. No route or middleware may call
 * a low-level external-user token verifier directly.
 */
export async function authenticateExternalUserSession(
  token: string,
  options: AuthenticationOptions
): Promise<ExternalSessionAuthentication> {
  const policy = options.policy ?? (await resolveEffectiveUserAccessPolicy())
  if (
    purposeRequiresMinimumClient(options.purpose) &&
    !clientMeetsMinimum(options.client, policy)
  ) {
    return { status: 'upgrade_required', reason: 'minimum_client_version' }
  }

  // Renewal records the session's use itself when it rotates the session, so
  // one accepted request is one touch.
  const authenticatedIdentity = await authenticateExternalUserSessionIdentity(token, {
    now: options.now,
    touch: options.purpose !== 'renew',
  })
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
  options: Omit<AuthenticationOptions, 'purpose'> & {
    onDatabaseFailure?: (error: unknown) => unknown
  } = {}
): Promise<ExternalSessionRenewal> {
  const policy = options.policy ?? (await resolveEffectiveUserAccessPolicy())
  if (!clientMeetsMinimum(options.client, policy)) {
    return { status: 'upgrade_required', reason: 'minimum_client_version' }
  }
  if (!policy.acceptV2 || !policy.issueV2 || !policy.renewV2) {
    return { status: 'invalid', reason: 'session_renewal_unavailable' }
  }
  const claims = verifyUserSessionV2Token(token)
  if (!claims) return { status: 'invalid', reason: 'invalid_representation' }
  const result = await renewUserSession(claims, {
    onDatabaseFailure: options.onDatabaseFailure,
  })
  if (!('token' in result)) {
    if (result.status === 'valid') {
      return { status: 'invalid', reason: 'session_renewal_failed' }
    }
    return result
  }
  return { status: 'renewed', session: result }
}
