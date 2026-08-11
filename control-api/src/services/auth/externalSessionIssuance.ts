import type { DbClient } from '../../db.js'
import type { TeamRole } from '../../profileTypes.js'
import { signExternalSessionToken } from '../../utils/auth/externalSessionAuthToken.js'
import {
  type EffectiveUserAccessPolicy,
  compareSemanticVersions,
  effectiveUserAccessPolicy,
} from '../access/userAccessPolicy.js'
import type { ExternalSessionClient } from './externalSessionAuthentication.js'
import { createUserSession } from './userSessionService.js'

export type ExternalSessionContract = 'v1' | 'v2'

export type ExternalSessionSelection =
  | { status: 'selected'; contract: ExternalSessionContract }
  | { status: 'upgrade_required'; reason: string }

export function selectExternalSessionRepresentation(
  client: ExternalSessionClient,
  policy: EffectiveUserAccessPolicy = effectiveUserAccessPolicy
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
    authenticationMethods: string[]
  },
  options: {
    db?: Pick<DbClient, 'query'>
    policy?: EffectiveUserAccessPolicy
  } = {}
): Promise<{ token: string; contract: ExternalSessionContract }> {
  const policy = options.policy ?? effectiveUserAccessPolicy
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
  return {
    token: signExternalSessionToken({
      userId: input.userId,
      email: input.email,
      teamId: input.teamId,
      role: input.role,
    }),
    contract: 'v1',
  }
}
