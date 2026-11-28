import type { DbClient, DbTransactionClient } from '../../db.js'
import type { OidcMemberSignInPolicy, OidcProviderConfiguration } from '../../oidc/configuration.js'
import { evaluateOidcEligibility, oidcEmailState } from '../../oidc/memberEligibility.js'
import type { VerifiedOidcIdentityProof } from '../../oidc/protocol.js'

export type OidcRefusalReason =
  | 'account_disabled'
  | 'identity_conflict'
  | 'account_needs_attention'
  | 'email_claim_missing'
  | 'email_unverified'
  | 'not_eligible'
  | 'no_account'
  | 'provider_configuration'
  | 'invitation_email_mismatch'

/**
 * The invitation an attempt was started from: its id and the invited address,
 * lower-cased. Only these two values reach account resolution, never the
 * invitation token.
 */
export type OidcInvitationContext = Readonly<{ invitationId: string; invitedEmail: string }>

/**
 * Why a `provider_configuration` refusal happened. It is for the operator's log
 * only and never leaves control-api: the browser sees the reason alone.
 */
export type OidcRefusalCause =
  | 'connection_mismatch'
  | 'unknown_new_member_team'
  | 'email_domain_claim_missing'

export type OidcRefusal = Readonly<{
  status: 'refused'
  reason: OidcRefusalReason
  cause?: OidcRefusalCause
}>

/**
 * What a sign-in created. `byInvitation` is present, and true, only on an
 * account the invitation created while account creation is off.
 */
export type OidcCreatedRecords = { account: boolean; link: boolean; byInvitation?: true }

export type OidcResolvedAccount = Readonly<{
  userId: string
  /** The stored `users.email`, not the provider's claim. */
  email: string
  lifecycleState: 'active'
  /** The locked row's `lifecycle_version`, as PostgreSQL returned it. */
  lifecycleVersion: unknown
  created: OidcCreatedRecords
}>

/**
 * The invitation that allowed an account to be created was revoked, accepted
 * or expired while the sign-in waited on its lock. Thrown inside the sign-in
 * transaction only, so the transaction rolls back whole: the user row, and the
 * connection record with it. `signInOidcMember` answers `no_account`.
 */
export class OidcInvitationWithdrawnError extends Error {
  constructor() {
    super('The invitation was withdrawn while the OIDC sign-in waited on it')
    this.name = 'OidcInvitationWithdrawnError'
  }
}

export type OidcResolution =
  | Readonly<{ status: 'resolved'; account: OidcResolvedAccount; guest: boolean }>
  | OidcRefusal

type Query = Pick<DbClient, 'query'>

/**
 * A user row read under its lock (`FOR NO KEY UPDATE`). `name` and `picture`
 * are the profile fields a sign-in answer shows, as password login reads them.
 */
export type LockedUser = {
  id: string
  email: string
  name: string | null
  picture: string | null
  lifecycle_state: unknown
  lifecycle_version: unknown
}

type OidcIdentity = Readonly<{ connectionId: string; issuer: string; subject: string }>

function refused(reason: OidcRefusalReason, cause?: OidcRefusalCause): OidcResolution {
  return Object.freeze(
    cause === undefined ? { status: 'refused', reason } : { status: 'refused', reason, cause }
  )
}

function resolved(user: LockedUser, created: OidcCreatedRecords, guest: boolean): OidcResolution {
  return Object.freeze({
    status: 'resolved',
    account: Object.freeze({
      userId: user.id,
      email: user.email,
      lifecycleState: 'active' as const,
      lifecycleVersion: user.lifecycle_version,
      created: Object.freeze({ ...created }),
    }),
    guest,
  })
}

/**
 * Records the connection a link is made under, then checks that the stored
 * record still names this provider's issuer and client. A registration id
 * reused for another issuer or client is a configuration error: its links
 * belong to the old provider.
 */
export async function ensureOidcConnection(
  db: Pick<DbClient, 'query'>,
  provider: OidcProviderConfiguration
): Promise<'ok' | 'mismatch'> {
  await db.query(
    `INSERT INTO oidc_connections (id, issuer, client_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [provider.registrationId, provider.issuer, provider.clientId]
  )
  const stored = await db.query(`SELECT issuer, client_id FROM oidc_connections WHERE id = $1`, [
    provider.registrationId,
  ])
  const row = stored.rows[0] as { issuer: string; client_id: string } | undefined
  if (!row) throw new Error('OIDC connection record is missing after insert')
  return row.issuer === provider.issuer && row.client_id === provider.clientId ? 'ok' : 'mismatch'
}

/** Locks one user row by id and reads it; undefined when no such user exists. */
export async function lockUserById(db: Query, userId: string): Promise<LockedUser | undefined> {
  const result = await db.query(
    `SELECT id, email, name, picture, lifecycle_state, lifecycle_version
       FROM users
      WHERE id = $1
      FOR NO KEY UPDATE`,
    [userId]
  )
  return result.rows[0] as LockedUser | undefined
}

async function insertLink(db: Query, identity: OidcIdentity, userId: string): Promise<void> {
  // A unique-key conflict (a parallel sign-in won) propagates: the caller
  // retries the whole transaction once.
  await db.query(
    `INSERT INTO user_oidc_links (connection_id, issuer, subject, user_id)
     VALUES ($1, $2, $3, $4)`,
    [identity.connectionId, identity.issuer, identity.subject, userId]
  )
}

/**
 * Decides for one existing account found by email, already locked. The link
 * is re-read under the lock: a parallel first sign-in for this subject may
 * have linked it while this transaction waited.
 */
async function resolveExistingAccount(
  db: Query,
  user: LockedUser,
  identity: OidcIdentity,
  guest: boolean
): Promise<OidcResolution> {
  if (user.lifecycle_state !== 'active') return refused('account_needs_attention')
  const existing = await db.query(
    `SELECT issuer, subject FROM user_oidc_links WHERE connection_id = $1 AND user_id = $2`,
    [identity.connectionId, user.id]
  )
  const link = existing.rows[0] as { issuer: string; subject: string } | undefined
  if (link) {
    if (link.issuer === identity.issuer && link.subject === identity.subject) {
      return resolved(user, { account: false, link: false }, guest)
    }
    return refused('identity_conflict')
  }
  // A guest's address is not proof that they own a member account.
  if (guest) return refused('account_needs_attention')
  await insertLink(db, identity, user.id)
  return resolved(user, { account: false, link: true }, guest)
}

function accountCreationAllowed(policy: OidcMemberSignInPolicy): boolean {
  switch (policy.accountCreation) {
    case 'entra':
    case 'enabled':
      return true
    case 'disabled':
      return false
  }
}

/** An invitation applies by address, compared case-insensitively. */
function differsFromInvitation(invitation: OidcInvitationContext | null, email: string): boolean {
  return invitation !== null && email.toLowerCase() !== invitation.invitedEmail.toLowerCase()
}

async function newMemberTeamExists(db: Query, teamId: string): Promise<boolean> {
  // KEY SHARE keeps the team from being deleted before the membership insert.
  const result = await db.query(`SELECT 1 FROM teams WHERE id = $1 FOR KEY SHARE`, [teamId])
  return (result.rowCount ?? 0) > 0
}

const QUALIFYING_INVITATION = `SELECT id FROM invitations
      WHERE id = $1
        AND purpose = 'member_invitation'
        AND status = 'pending'
        AND expires_at > now()
        AND lower(email) = $2`

/**
 * Whether the invitation still lets its account be created: a pending,
 * unexpired member invitation to this address. The first read takes no lock;
 * the second locks the row, after the user row, which is the order
 * `acceptInvitationInTransaction` takes, so the two cannot deadlock.
 */
async function invitationQualifies(
  db: Query,
  invitation: OidcInvitationContext,
  lock: 'unlocked' | 'for_update'
): Promise<boolean> {
  const result = await db.query(
    lock === 'for_update' ? `${QUALIFYING_INVITATION}\n      FOR UPDATE` : QUALIFYING_INVITATION,
    [invitation.invitationId, invitation.invitedEmail]
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Maps a verified OIDC identity to a member account (v5 §4, rows 1–7).
 * Runs inside the caller's transaction; locks the user row before deciding.
 * Refusals write nothing except the `oidc_connections` record.
 *
 * A sign-in started from an invitation link passes the invitation. After the
 * earlier refusals, and before any account, link or membership is written,
 * the invited address is compared with the account's: a linked account's
 * stored email, otherwise the verified email claim. A different address is
 * refused with `invitation_email_mismatch`.
 *
 * With account creation off, a matching invitation that is pending creates
 * the one account it was sent to. The account gets neither the new-member
 * team nor its check: only the teams of the person's pending invitations,
 * which the sign-in applies afterwards. Whether the invitation qualifies is
 * read before the email lookup, so a password acceptance of it that commits
 * during the sign-in leads to the account that acceptance created, never to
 * `no_account`. If the invitation stops qualifying while the sign-in waits on
 * its lock, this throws OidcInvitationWithdrawnError, so the caller's
 * transaction rolls back whole.
 */
export async function resolveOidcAccount(
  db: DbTransactionClient,
  input: Readonly<{
    proof: VerifiedOidcIdentityProof
    provider: OidcProviderConfiguration
    policy: OidcMemberSignInPolicy
    invitation: OidcInvitationContext | null
  }>
): Promise<OidcResolution> {
  const { proof, provider, policy, invitation } = input
  if (
    proof.registrationId !== provider.registrationId ||
    proof.issuer !== provider.issuer ||
    proof.clientId !== provider.clientId
  ) {
    throw new Error('OIDC identity proof was not issued for this provider configuration')
  }

  const eligibility = evaluateOidcEligibility(proof, policy)
  if (!eligibility.eligible) return refused('not_eligible')
  const guest = eligibility.guest

  if ((await ensureOidcConnection(db, provider)) === 'mismatch') {
    return refused('provider_configuration', 'connection_mismatch')
  }

  const identity: OidcIdentity = {
    connectionId: provider.registrationId,
    issuer: proof.issuer,
    subject: proof.subject,
  }

  // The link decides first (rows 1 and 2); no email claim is needed.
  const linked = await db.query(
    `SELECT user_id FROM user_oidc_links
      WHERE connection_id = $1 AND issuer = $2 AND subject = $3`,
    [identity.connectionId, identity.issuer, identity.subject]
  )
  const linkedUserId = (linked.rows[0] as { user_id: string } | undefined)?.user_id
  if (linkedUserId !== undefined) {
    const user = await lockUserById(db, linkedUserId)
    // The link's foreign key is ON DELETE RESTRICT, so its user always exists.
    if (!user) throw new Error('OIDC link references a missing user')
    if (user.lifecycle_state !== 'active') return refused('account_disabled')
    // A linked account resolves without the claim, so its stored email is compared.
    if (differsFromInvitation(invitation, user.email)) return refused('invitation_email_mismatch')
    return resolved(user, { account: false, link: false }, guest)
  }

  const claimEmail = proof.attributes.email
  const emailState = oidcEmailState(proof, policy, guest)
  if (emailState === 'no_email' || claimEmail === undefined) return refused('email_claim_missing')
  if (emailState === 'unverified') return refused('email_unverified')
  // The app registration does not send xms_edov: a configuration problem.
  if (emailState === 'domain_claim_missing') {
    return refused('provider_configuration', 'email_domain_claim_missing')
  }
  // Before the email lookup, so a different address writes no link and no account.
  if (differsFromInvitation(invitation, claimEmail)) return refused('invitation_email_mismatch')

  // With creation off, only the invitation the attempt came from may create
  // the account: decided from this unlocked read, so an invitation that
  // doesn't qualify writes no user, and checked again under its lock below.
  // It runs before the email lookup. A password acceptance of this invitation
  // that commits after it is then found by the lookup, or makes the insert
  // below lose, so the person signs in to the account it created.
  const creatingInvitation =
    invitation !== null &&
    !accountCreationAllowed(policy) &&
    (await invitationQualifies(db, invitation, 'unlocked'))
      ? invitation
      : null

  // Rows 3, 5 and 6: email finds an existing member the first time only.
  const matches = await db.query(
    `SELECT id, email, name, picture, lifecycle_state, lifecycle_version
       FROM users
      WHERE lower(email) = lower($1)
      ORDER BY id
      LIMIT 2
      FOR NO KEY UPDATE`,
    [claimEmail]
  )
  const candidates = matches.rows as LockedUser[]
  if (candidates.length > 1) return refused('account_needs_attention')
  if (candidates.length === 1) return resolveExistingAccount(db, candidates[0]!, identity, guest)

  // Row 4: create the account. With creation off, only the invitation the
  // attempt came from may create it: the one account it was sent to.
  if (accountCreationAllowed(policy)) {
    if (
      policy.newMemberTeamId !== null &&
      !(await newMemberTeamExists(db, policy.newMemberTeamId))
    ) {
      return refused('provider_configuration', 'unknown_new_member_team')
    }
  } else if (creatingInvitation === null) {
    // No invitation, or none that qualified at the read before the lookup.
    return refused('no_account')
  }

  const name = proof.attributes.name || null
  const inserted = await db.query(
    `INSERT INTO users (email, name)
     VALUES (lower($1), $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [claimEmail, name]
  )
  const reselected = await db.query(
    `SELECT id, email, name, picture, lifecycle_state, lifecycle_version
       FROM users
      WHERE email = lower($1)
      FOR NO KEY UPDATE`,
    [claimEmail]
  )
  const user = reselected.rows[0] as LockedUser | undefined
  if (!user) throw new Error('OIDC account row is missing after insert')
  // A parallel transaction created this address first: decide as for an
  // existing account. That includes a password acceptance of this very
  // invitation, so the invitation no longer creates anything.
  if ((inserted.rowCount ?? 0) === 0) return resolveExistingAccount(db, user, identity, guest)
  if (
    creatingInvitation !== null &&
    !(await invitationQualifies(db, creatingInvitation, 'for_update'))
  ) {
    throw new OidcInvitationWithdrawnError()
  }

  await db.query(
    `INSERT INTO profiles (user_id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id, name]
  )
  await insertLink(db, identity, user.id)
  if (creatingInvitation !== null) {
    // Only the teams of the person's pending invitations, which the sign-in
    // applies next, so an inviter grants no other team.
    return resolved(user, { account: true, link: true, byInvitation: true }, guest)
  }
  if (policy.newMemberTeamId !== null) {
    await db.query(
      `INSERT INTO team_members (team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [policy.newMemberTeamId, user.id]
    )
  }
  return resolved(user, { account: true, link: true }, guest)
}
