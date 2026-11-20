import { type DbTransactionClient, withTransaction } from '../../db.js'
import type { OidcMemberSignInPolicy, OidcProviderConfiguration } from '../../oidc/configuration.js'
import type { VerifiedOidcIdentityProof } from '../../oidc/protocol.js'
import type { OidcVerifiedAttributes } from '../../oidc/protocolEngine.js'
import type { EffectiveUserAccessPolicy } from '../access/userAccessPolicy.js'
import type { InvitationRow } from '../directory/invitationStore.js'
import { currentMemberMembership, findFirstActiveMembership } from '../directory/login.js'
import { acceptPendingMembershipInvitation } from '../directory/membership.js'
import type { TeamRole } from '../directory/types.js'
import {
  type ExternalSessionContract,
  issueExternalUserSession,
} from './externalSessionIssuance.js'
import {
  type OidcRefusalReason,
  type OidcResolvedAccount,
  resolveOidcAccount,
} from './oidcAccountResolution.js'

export type OidcMemberSignInResult =
  | Readonly<{
      status: 'signed_in'
      userId: string
      token: string
      contract: ExternalSessionContract
      created: { account: boolean; link: boolean }
      invitationsApplied: number
    }>
  | Readonly<{ status: 'refused'; reason: OidcRefusalReason }>

type OidcMemberSignInInput = Readonly<{
  proof: VerifiedOidcIdentityProof
  provider: OidcProviderConfiguration
  policy: OidcMemberSignInPolicy
  contract: ExternalSessionContract
  sessionPolicy: EffectiveUserAccessPolicy
}>

type MemberTransaction = <T>(work: (db: DbTransactionClient) => Promise<T>) => Promise<T>

type SessionTeam = { team_id: string | null; role: TeamRole }

const TEAMLESS_MEMBER: SessionTeam = Object.freeze({ team_id: null, role: 'member' })

const UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  )
}

/**
 * Accepts every pending member invitation addressed to the account's stored
 * email, not to the provider's claim. The caller holds the user row lock, so
 * the order is the one every invitation path takes: the user, then the
 * invitations (`FOR UPDATE`, by id), then the team_members rows the
 * acceptance writes. Password-reset, admin-desktop-access, expired, revoked
 * and draft invitations are never selected.
 */
async function applyPendingInvitations(
  db: DbTransactionClient,
  account: OidcResolvedAccount
): Promise<number> {
  const pending = await db.query(
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose,
            i.created_at, i.expires_at, i.accepted_at, i.accepted_user_id,
            t.name AS team_name
       FROM invitations i
  LEFT JOIN teams t ON t.id = i.team_id
      WHERE lower(i.email) = lower($1)
        AND i.status = 'pending'
        AND i.purpose = 'member_invitation'
        AND i.expires_at > now()
      ORDER BY i.id
        FOR UPDATE OF i`,
    [account.email]
  )
  let applied = 0
  for (const invitation of pending.rows as InvitationRow[]) {
    // The row is locked and matched the same predicates, so a false return is
    // not expected; only an acceptance that happened is counted.
    if (await acceptPendingMembershipInvitation(db, invitation, account.userId)) applied += 1
  }
  return applied
}

/** The member's current, active membership in one team. */
async function currentMembershipIn(
  db: DbTransactionClient,
  userId: string,
  teamId: string
): Promise<SessionTeam | undefined> {
  const result = await db.query(
    `SELECT tm.team_id, tm.role, t.name AS team_name
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = $1
        AND tm.team_id = $2
        AND tm.status = 'active'`,
    [userId, teamId]
  )
  return result.rows[0] as SessionTeam | undefined
}

async function signInResolvedMember(
  db: DbTransactionClient,
  input: OidcMemberSignInInput
): Promise<OidcMemberSignInResult> {
  const resolution = await resolveOidcAccount(db, {
    proof: input.proof,
    provider: input.provider,
    policy: input.policy,
  })
  if (resolution.status === 'refused') return resolution
  const { account } = resolution

  // The team is chosen before the invitations are applied: a member who
  // already has a team keeps it, and only a teamless member lands in an
  // invited team. The kept team's role is read again afterwards, because an
  // invitation to that team may have changed it. A kept membership that a
  // concurrent removal ended meanwhile counts as no team.
  const before = (await findFirstActiveMembership(db, account.userId)).rows[0] as
    | SessionTeam
    | undefined
  const invitationsApplied = await applyPendingInvitations(db, account)
  const kept = before?.team_id
    ? await currentMembershipIn(db, account.userId, before.team_id)
    : undefined
  const team =
    kept ??
    ((await findFirstActiveMembership(db, account.userId)).rows[0] as SessionTeam | undefined) ??
    TEAMLESS_MEMBER

  const issued = await issueExternalUserSession(
    {
      contract: input.contract,
      userId: account.userId,
      email: account.email,
      teamId: team.team_id,
      role: team.role,
      authenticationMethods: ['oidc'],
    },
    {
      db,
      policy: input.sessionPolicy,
      // resolveOidcAccount read these under the user row lock this transaction holds.
      lockedUser: {
        lifecycleState: account.lifecycleState,
        lifecycleVersion: account.lifecycleVersion,
      },
    }
  )
  return Object.freeze({
    status: 'signed_in',
    userId: account.userId,
    token: issued.token,
    contract: issued.contract,
    created: Object.freeze({ ...account.created }),
    invitationsApplied,
  })
}

/**
 * Signs a verified OIDC identity in as a member, in one transaction: account
 * resolution (v5 §4), pending invitations for the account's stored email, then
 * the session. A refusal issues no session and writes nothing except the
 * connection record.
 *
 * A unique-key conflict means a parallel sign-in committed the same link or
 * account first. PostgreSQL has aborted that transaction, so the whole sign-in
 * runs once more in a new transaction with the same proof (no second provider
 * call). The transaction runner must surface the PostgreSQL error unchanged.
 */
export async function signInOidcMember(
  input: OidcMemberSignInInput,
  deps: Readonly<{ transaction?: MemberTransaction }> = {}
): Promise<OidcMemberSignInResult> {
  const transaction: MemberTransaction =
    deps.transaction ??
    (<T>(work: (db: DbTransactionClient) => Promise<T>) => withTransaction(work))
  const attempt = () => transaction(db => signInResolvedMember(db, input))
  try {
    return await attempt()
  } catch (error) {
    // Only the first unique-key conflict is retried; it is replaced by the
    // rerun's outcome. Every other error propagates unchanged.
    if (!isUniqueViolation(error)) throw error
  }
  // A second conflict propagates from here.
  return attempt()
}

export type OidcVerifiedMemberSignInRefusal =
  | 'email_missing'
  | 'email_unverified'
  | 'no_matching_member'
  | 'ambiguous_member'
  | 'member_inactive'

export type OidcVerifiedMemberSignInResult =
  | Readonly<{
      status: 'signed_in'
      userId: string
      token: string
      contract: ExternalSessionContract
    }>
  | Readonly<{ status: 'refused'; reason: OidcVerifiedMemberSignInRefusal }>

type MemberRow = {
  id: string
  email: string
  lifecycle_state: unknown
  lifecycle_version: unknown
}

/**
 * Dev-only spike: signs a validated OIDC identity in as the one active member whose
 * email matches the provider's verified email claim, without reading or writing
 * an issuer+subject link. `signInOidcMember` replaces it once the route calls that.
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
): Promise<OidcVerifiedMemberSignInResult> {
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
