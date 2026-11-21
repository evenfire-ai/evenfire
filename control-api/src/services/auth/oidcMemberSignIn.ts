import { type DbTransactionClient, withTransaction } from '../../db.js'
import type { OidcMemberSignInPolicy, OidcProviderConfiguration } from '../../oidc/configuration.js'
import type { VerifiedOidcIdentityProof } from '../../oidc/protocol.js'
import type { EffectiveUserAccessPolicy } from '../access/userAccessPolicy.js'
import { type InvitationRow, loadInvitationTeams } from '../directory/invitationStore.js'
import { findFirstActiveMembership } from '../directory/login.js'
import { acceptPendingMembershipInvitation } from '../directory/membership.js'
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

/**
 * Accepts every pending member invitation addressed to the account's stored
 * email, not to the provider's claim. The caller holds the user row lock, so
 * the order is the one every invitation path takes: the user, then the
 * invitations (`FOR UPDATE`, by id for a deterministic lock order), then the
 * team_members rows the acceptance writes. Password-reset,
 * admin-desktop-access, expired, revoked and draft invitations are never
 * selected.
 *
 * The member did not choose these invitations, so their memberships are
 * insert-only: an invitation adds a team only where the account has no
 * team_members row in any status. It never changes an existing role and never
 * restores a removed membership; the invitation is still accepted. The locked
 * rows are applied newest created first, so of two invitations to one new
 * team the latest created sets the role. Returns the applied invitations
 * oldest created first.
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
  const newestFirst = [...(pending.rows as PendingInvitation[])].sort(byCreation).reverse()
  const applied: InvitationRow[] = []
  for (const invitation of newestFirst) {
    // The row is locked and matched the same predicates, so a false return is
    // not expected; only an acceptance that happened is counted.
    if (
      await acceptPendingMembershipInvitation(db, invitation, account.userId, {
        membershipWrite: 'insert_only',
      })
    ) {
      applied.push(invitation)
    }
  }
  return applied.reverse()
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
