import { type DbTransactionClient, withTransaction } from '../../db.js'
import type { OidcVerifiedAttributes } from '../../oidc/protocolEngine.js'
import type { EffectiveUserAccessPolicy } from '../access/userAccessPolicy.js'
import { currentMemberMembership } from '../directory/login.js'
import {
  type ExternalSessionContract,
  issueExternalUserSession,
} from './externalSessionIssuance.js'

export type OidcMemberSignInRefusal =
  | 'email_missing'
  | 'email_unverified'
  | 'no_matching_member'
  | 'ambiguous_member'
  | 'member_inactive'

export type OidcMemberSignInResult =
  | Readonly<{
      status: 'signed_in'
      userId: string
      token: string
      contract: ExternalSessionContract
    }>
  | Readonly<{ status: 'refused'; reason: OidcMemberSignInRefusal }>

type MemberRow = {
  id: string
  email: string
  lifecycle_state: unknown
  lifecycle_version: unknown
}

/**
 * Dev-only spike: signs a validated OIDC identity in as the one active member whose
 * email matches the provider's verified email claim. There is no persistent
 * issuer+subject link yet; the planned member sign-in feature replaces this.
 *
 * The session is the one password login issues (same issuer, same lifecycle check
 * under the user row lock), with `oidc` as its authentication method.
 */
export async function signInOidcVerifiedMember(
  input: Readonly<{
    attributes: OidcVerifiedAttributes
    contract: ExternalSessionContract
    policy: EffectiveUserAccessPolicy
  }>,
  dependencies: Readonly<{
    transaction?: <T>(work: (db: DbTransactionClient) => Promise<T>) => Promise<T>
  }> = {}
): Promise<OidcMemberSignInResult> {
  const email = input.attributes.email?.trim().toLowerCase()
  if (!email) return { status: 'refused', reason: 'email_missing' }
  // An unverified address proves nothing: anyone can sign up at a provider with it.
  if (input.attributes.emailVerified !== true) {
    return { status: 'refused', reason: 'email_unverified' }
  }

  const transaction =
    dependencies.transaction ??
    (<T>(work: (db: DbTransactionClient) => Promise<T>) => withTransaction(work))
  return transaction(async db => {
    const matches = await db.query(
      `SELECT id, email, lifecycle_state, lifecycle_version
         FROM users
        WHERE lower(email) = $1
        ORDER BY id
        LIMIT 2
        FOR NO KEY UPDATE`,
      [email]
    )
    const rows = matches.rows as MemberRow[]
    if (rows.length === 0) return { status: 'refused', reason: 'no_matching_member' }
    if (rows.length > 1) return { status: 'refused', reason: 'ambiguous_member' }
    const member = rows[0]!
    if (member.lifecycle_state !== 'active') {
      return { status: 'refused', reason: 'member_inactive' }
    }

    const membership = await currentMemberMembership(db, { id: member.id, email: member.email })
    const issued = await issueExternalUserSession(
      {
        contract: input.contract,
        userId: member.id,
        email: member.email,
        teamId: membership.team_id,
        role: membership.role,
        authGeneration: Number(member.lifecycle_version),
        authenticationMethods: ['oidc'],
      },
      {
        db,
        policy: input.policy,
        lockedUser: {
          lifecycleState: member.lifecycle_state,
          lifecycleVersion: member.lifecycle_version,
        },
      }
    )
    return {
      status: 'signed_in',
      userId: member.id,
      token: issued.token,
      contract: issued.contract,
    }
  })
}
