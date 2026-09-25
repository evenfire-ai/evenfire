import { type DbClient, withTransaction } from '../../db.js'
import type { AuthClaims, TeamRole } from '../../profileTypes.js'
import { signExternalSessionToken } from '../../utils/auth/externalSessionAuthToken.js'
import {
  type EffectiveUserAccessPolicy,
  compareSemanticVersions,
} from '../access/userAccessPolicy.js'
import type { ExternalSessionClient } from './externalSessionAuthentication.js'
import { createUserSession, validateLegacyUserSession } from './userSessionService.js'

export type ExternalSessionContract = 'v1' | 'v2'

export type ExternalSessionSelection =
  | { status: 'selected'; contract: ExternalSessionContract }
  | { status: 'upgrade_required'; reason: string }

export type LegacyExternalSessionExchange =
  | { status: 'issued'; token: string; role: TeamRole }
  | { status: 'invalid_session' }
  | { status: 'membership_not_found' }

type SessionTransaction = <T>(work: (db: DbClient) => Promise<T>) => Promise<T>

export function selectExternalSessionRepresentation(
  client: ExternalSessionClient,
  policy: EffectiveUserAccessPolicy
): ExternalSessionSelection {
  if (policy.enforceMinimumClient && policy.minimumClientVersion) {
    const comparison = client.version
      ? compareSemanticVersions(client.version, policy.minimumClientVersion)
      : null
    if (comparison === null || comparison < 0) {
      return { status: 'upgrade_required', reason: 'minimum_client_version' }
    }
  }

  if (client.requestedContract === 'v2') {
    return policy.issueV2
      ? { status: 'selected', contract: 'v2' }
      : { status: 'upgrade_required', reason: 'session_v2_issuance_unavailable' }
  }
  if (client.requestedContract === 'v1' || client.requestedContract === undefined) {
    return policy.issueV1
      ? { status: 'selected', contract: 'v1' }
      : { status: 'upgrade_required', reason: 'legacy_session_issuance_unavailable' }
  }
  return { status: 'upgrade_required', reason: 'unsupported_session_contract' }
}

export async function issueExternalUserSession(
  input: {
    contract: ExternalSessionContract
    userId: string
    email: string
    teamId: string | null
    role: TeamRole
    authGeneration?: number
    authenticationMethods: string[]
  },
  options: {
    db?: Pick<DbClient, 'query'>
    policy: EffectiveUserAccessPolicy
  }
): Promise<{ token: string; contract: ExternalSessionContract }> {
  const policy = options.policy
  if (input.contract === 'v2') {
    if (!policy.issueV2 || !policy.acceptV2) {
      throw new Error('user-session v2 issuance is not effective')
    }
    const sessionInput = {
      userId: input.userId,
      email: input.email,
      authenticationMethods: input.authenticationMethods,
    }
    const session = options.db
      ? await createUserSession(sessionInput, { db: options.db })
      : await createUserSession(sessionInput)
    return { token: session.token, contract: 'v2' }
  }

  if (!policy.issueV1 || !policy.acceptV1) {
    throw new Error('legacy user-session issuance is not effective')
  }
  if (!Number.isSafeInteger(input.authGeneration) || Number(input.authGeneration) < 1) {
    throw new Error('legacy user-session issuance requires an active lifecycle generation')
  }
  return {
    token: signExternalSessionToken({
      userId: input.userId,
      email: input.email,
      teamId: input.teamId,
      role: input.role,
      authGeneration: Number(input.authGeneration),
    }),
    contract: 'v1',
  }
}

/**
 * Revalidates and replaces a legacy V1 representation from one locked snapshot.
 * Lock order: user/lifecycle -> epoch/revocation reads -> membership -> signing.
 */
export async function exchangeLegacyExternalUserSession(
  input: {
    token: string
    claims: AuthClaims
    userId: string
    email: string
    teamId: string
  },
  options: {
    policy: EffectiveUserAccessPolicy
    transaction?: SessionTransaction
  }
): Promise<LegacyExternalSessionExchange> {
  if (
    input.claims.userId !== input.userId ||
    input.claims.email.toLowerCase() !== input.email.toLowerCase()
  ) {
    return { status: 'invalid_session' }
  }
  const run = options.transaction ?? withTransaction
  return run(async db => {
    const validation = await validateLegacyUserSession(input.token, input.claims, {
      db,
      lockUser: true,
    })
    if (validation.status !== 'valid') return { status: 'invalid_session' }

    const membership = await db.query(
      `SELECT tm.role, u.lifecycle_version
         FROM users u
         JOIN team_members tm ON tm.user_id = u.id
        WHERE u.id = $1
          AND LOWER(u.email) = LOWER($2)
          AND tm.team_id = $3
          AND tm.status = 'active'
          AND u.lifecycle_state = 'active'
        LIMIT 1
        FOR UPDATE OF tm`,
      [input.userId, input.email, input.teamId]
    )
    const row = membership.rows[0] as
      | { role?: TeamRole; lifecycle_version?: number | string }
      | undefined
    if (!row?.role) return { status: 'membership_not_found' }

    const issued = await issueExternalUserSession(
      {
        contract: 'v1',
        userId: input.userId,
        email: input.email,
        teamId: input.teamId,
        role: row.role,
        authGeneration: Number(row.lifecycle_version),
        authenticationMethods: [],
      },
      { db, policy: options.policy }
    )
    return { status: 'issued', token: issued.token, role: row.role }
  })
}
