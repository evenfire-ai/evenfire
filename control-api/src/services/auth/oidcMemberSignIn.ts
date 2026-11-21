import { type DbTransactionClient, withTransaction } from '../../db.js'
import { rootLogger } from '../../observability/logger.js'
import type { OidcMemberSignInPolicy, OidcProviderConfiguration } from '../../oidc/configuration.js'
import type { VerifiedOidcIdentityProof } from '../../oidc/protocol.js'
import type { EffectiveUserAccessPolicy } from '../access/userAccessPolicy.js'
import { type InvitationRow, loadInvitationTeams } from '../directory/invitationStore.js'
import { findFirstActiveMembership } from '../directory/login.js'
import {
  type PendingInvitationAcceptance,
  acceptPendingMembershipInvitation,
} from '../directory/membership.js'
import type { TeamRole } from '../directory/types.js'
import {
  type ExternalSessionContract,
  issueExternalUserSession,
} from './externalSessionIssuance.js'
import {
  type OidcRefusal,
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
  | OidcRefusal

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

/** A pending invitation with its creation time in microseconds, which a JS Date would truncate. */
type PendingInvitation = InvitationRow & { created_at_us: string }

/** Oldest created first; the id breaks a tie. */
function byCreation(a: PendingInvitation, b: PendingInvitation): number {
  const aCreated = BigInt(a.created_at_us)
  const bCreated = BigInt(b.created_at_us)
  if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const INVITATION_SAVEPOINT = 'oidc_member_invitation'

/**
 * Accepts an existing member's invitation only if it adds a membership in
 * every one of its teams. If any team already had a team_members row, in any
 * status, everything the acceptance wrote is rolled back: the invitation stays
 * pending, unaccepted, and no team of it gains a membership. Accepted, it would
 * leave a role that a later Google login applies to the existing membership
 * (healAcceptedInvitationMemberships), so an inviter could demote an admin.
 *
 * The decision uses what the insert did, so a row that a concurrent
 * transaction committed first also leaves the invitation pending. An error
 * propagates with the savepoint still open; the caller's transaction is then
 * rolled back whole, and a unique-key conflict reruns it as before.
 */
async function acceptIntoNewTeamsOnly(
  db: DbTransactionClient,
  invitation: InvitationRow,
  userId: string
): Promise<PendingInvitationAcceptance> {
  await db.query(`SAVEPOINT ${INVITATION_SAVEPOINT}`)
  const outcome = await acceptPendingMembershipInvitation(db, invitation, userId, {
    membershipWrite: 'insert_only',
  })
  if (outcome !== 'accepted') await db.query(`ROLLBACK TO SAVEPOINT ${INVITATION_SAVEPOINT}`)
  await db.query(`RELEASE SAVEPOINT ${INVITATION_SAVEPOINT}`)
  return outcome
}

/**
 * Accepts every pending member invitation addressed to the account's stored
 * email, not to the provider's claim. The caller holds the user row lock, so
 * the order is the one every invitation path takes: the user, then the
 * invitations (`FOR UPDATE`, by id for a deterministic lock order), then the
 * team_members rows the acceptance writes. Password-reset,
 * admin-desktop-access, expired, revoked and draft invitations are never
 * selected.
 *
 * An existing member did not choose these invitations, so for them an
 * invitation is accepted only where it adds a membership in each of its teams
 * (acceptIntoNewTeamsOnly). One naming a team where the account has a
 * team_members row in any status stays pending and adds no membership: it
 * never changes an existing role and never restores a removed membership. An
 * account created by this sign-in has no memberships but the new-member team
 * row this sign-in wrote, so its invitations are applied as an acceptance
 * applies them, and one to the new-member team sets its role.
 *
 * Either way, of two invitations to one team the latest created sets the
 * role: an existing member's are applied newest created first, so the newest
 * adds the membership and an older one finds it and stays pending; a new
 * account's are upserted oldest created first (the last write wins). Returns
 * the applied invitations oldest created first.
 */
async function applyPendingInvitations(
  db: DbTransactionClient,
  account: OidcResolvedAccount
): Promise<InvitationRow[]> {
  const pending = await db.query(
    `SELECT i.id, i.team_id, i.invitee_name, i.email, i.role, i.token, i.status, i.purpose,
            i.created_at, i.expires_at, i.accepted_at, i.accepted_user_id,
            t.name AS team_name,
            (extract(epoch FROM i.created_at) * 1000000)::bigint::text AS created_at_us
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
  const membershipWrite = account.created.account ? 'upsert' : 'insert_only'
  const oldestFirst = [...(pending.rows as PendingInvitation[])].sort(byCreation)
  const order = membershipWrite === 'insert_only' ? [...oldestFirst].reverse() : oldestFirst
  const applied: InvitationRow[] = []
  for (const invitation of order) {
    const outcome =
      membershipWrite === 'insert_only'
        ? await acceptIntoNewTeamsOnly(db, invitation, account.userId)
        : await acceptPendingMembershipInvitation(db, invitation, account.userId)
    if (outcome === 'accepted') {
      applied.push(invitation)
      continue
    }
    // The row is locked and matched the same predicates, so `not_pending` is
    // not expected. `existing_membership` is: an inviter may address an
    // invitation to a team the member already belongs to. Never the email.
    rootLogger.info(
      {
        component: 'oidc_member_sign_in',
        event: 'oidc_member_invitation_left_pending',
        invitationId: invitation.id,
        reason: outcome,
      },
      'OIDC member sign-in left an invitation pending'
    )
  }
  return membershipWrite === 'insert_only' ? applied.reverse() : applied
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

/**
 * The team of the most recently created applied invitation that grants one:
 * its primary team, in the order its acceptance used, with the role the
 * member now has there. That is undefined when the member has no active
 * membership in it (an invitation to a team the member was removed from adds
 * none), and the caller then falls back to the first active team.
 */
async function latestInvitedTeam(
  db: DbTransactionClient,
  userId: string,
  applied: readonly InvitationRow[]
): Promise<SessionTeam | undefined> {
  for (let index = applied.length - 1; index >= 0; index -= 1) {
    const invitation = applied[index]!
    const [primary] = await loadInvitationTeams(db, invitation.id, invitation)
    if (primary) return currentMembershipIn(db, userId, primary.team_id)
  }
  return undefined
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

  // An existing member's team is chosen before the invitations are applied:
  // a member who already has a team keeps it, with its role read again
  // afterwards. Invitations never change an existing membership here, but a
  // concurrent removal may have ended it meanwhile; it then counts as no team.
  // A teamless member, and an account created by this sign-in (whose only team
  // so far is the new-member team), land in the team of the most recently
  // created applied invitation; otherwise in their first active team, which
  // for a new account is the new-member team; otherwise they are teamless.
  // currentMemberMembership's email-keyed healing is deliberately not used:
  // OIDC sign-in never restores teams from accepted invitations by email.
  const before = account.created.account
    ? undefined
    : ((await findFirstActiveMembership(db, account.userId)).rows[0] as SessionTeam | undefined)
  const applied = await applyPendingInvitations(db, account)
  const kept = before?.team_id
    ? await currentMembershipIn(db, account.userId, before.team_id)
    : undefined
  const team =
    kept ??
    (await latestInvitedTeam(db, account.userId, applied)) ??
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
    invitationsApplied: applied.length,
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
