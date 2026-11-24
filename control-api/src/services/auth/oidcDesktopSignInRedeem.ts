import { timingSafeEqual } from 'node:crypto'
import { type DbTransactionClient, withTransaction } from '../../db.js'
import type { OidcProviderConfiguration } from '../../oidc/configuration.js'
import { externalLoginResponseBody } from '../../routes/external/loginResponse.js'
import type { EffectiveUserAccessPolicy } from '../access/userAccessPolicy.js'
import { findFirstActiveMembership } from '../directory/login.js'
import type { TeamRole } from '../directory/types.js'
import {
  type ExternalSessionContract,
  issueExternalUserSession,
} from './externalSessionIssuance.js'
import { type OidcRefusalReason, lockUserById } from './oidcAccountResolution.js'
import { hashDesktopSignInCode, s256Challenge } from './oidcDesktopSignInCode.js'
import { type MemberTransaction, currentMembershipIn } from './oidcMemberSignIn.js'

/**
 * What a redeem ends with. `refused` and `unavailable` spent the code and name
 * its member, so the route can log who it was for.
 */
export type DesktopSignInRedeemResult =
  | Readonly<{ status: 'signed_in'; body: ReturnType<typeof externalLoginResponseBody> }>
  | Readonly<{ status: 'invalid_code' }>
  | Readonly<{ status: 'refused'; reason: OidcRefusalReason; userId: string }>
  | Readonly<{ status: 'unavailable'; userId: string }>

type DesktopSignInRedeemInput = Readonly<{
  code: string
  codeVerifier: string
  provider: OidcProviderConfiguration
  contract: ExternalSessionContract
  sessionPolicy: EffectiveUserAccessPolicy
}>

/** The code row redeem takes: whom it signs in, and what it was minted against. */
type DesktopSignInCodeRow = {
  user_id: string
  team_id: string | null
  code_challenge: string
  registration_id: string
  configuration_generation: string
}

type RedeemTeam = { team_id: string | null; team_name: string | null; role: TeamRole }

const TEAMLESS_MEMBER: RedeemTeam = Object.freeze({
  team_id: null,
  team_name: null,
  role: 'member',
})

const INVALID_CODE: DesktopSignInRedeemResult = Object.freeze({ status: 'invalid_code' })

/**
 * Thrown inside the redeem transaction when the verifier does not match the
 * code's challenge, so the transaction rolls back and the code stays
 * redeemable. Returning a value instead would commit the delete.
 */
class DesktopSignInVerifierMismatch extends Error {
  constructor() {
    super('Desktop sign-in code verifier does not match its challenge')
    this.name = 'DesktopSignInVerifierMismatch'
  }
}

/** RFC 7636 S256: base64url(SHA-256(verifier)) equals the stored challenge. */
function verifierMatches(codeVerifier: string, codeChallenge: string): boolean {
  const expected = Buffer.from(codeChallenge, 'ascii')
  const actual = Buffer.from(s256Challenge(codeVerifier), 'ascii')
  // timingSafeEqual throws on unequal lengths; a stored challenge is always 43.
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/**
 * The redeem transaction. Taking the code is a `DELETE … RETURNING`, so a
 * concurrent redeem of the same code waits on the row lock and then finds no
 * row. A wrong verifier throws and rolls the delete back. A connection change
 * or a refused account returns, which commits: the code is spent. A session
 * issuance error propagates and rolls back.
 */
async function redeemInTransaction(
  db: DbTransactionClient,
  input: DesktopSignInRedeemInput
): Promise<DesktopSignInRedeemResult> {
  // 1. Take the code.
  const taken = await db.query(
    `DELETE FROM oidc_desktop_sign_in_codes
      WHERE code_hash = $1
        AND expires_at > now()
      RETURNING user_id, team_id, code_challenge, registration_id, configuration_generation`,
    [hashDesktopSignInCode(input.code)]
  )
  const row = taken.rows[0] as DesktopSignInCodeRow | undefined
  if (!row) return INVALID_CODE

  // 2. The verifier.
  if (!verifierMatches(input.codeVerifier, row.code_challenge)) {
    throw new DesktopSignInVerifierMismatch()
  }

  // 3. The connection: member sign-in is still on, and the code was minted
  // against the connection and configuration this request runs.
  const { provider } = input
  if (
    !provider.memberAuthenticationActivated ||
    row.registration_id !== provider.registrationId ||
    row.configuration_generation !== provider.configurationGeneration
  ) {
    return Object.freeze({ status: 'unavailable', userId: row.user_id })
  }

  // 4. The account, re-checked under its row lock. The code row's user
  // foreign key cascades on delete, so a missing user is not expected; it is
  // refused as a disabled account would be.
  const user = await lockUserById(db, row.user_id)
  if (!user || user.lifecycle_state !== 'active') {
    return Object.freeze({ status: 'refused', reason: 'account_disabled', userId: row.user_id })
  }

  // 5. The team: the one the sign-in chose, while the membership is still
  // active; otherwise the first active team, as password login picks it;
  // otherwise teamless.
  const team: RedeemTeam =
    (row.team_id === null ? undefined : await currentMembershipIn(db, user.id, row.team_id)) ??
    ((await findFirstActiveMembership(db, user.id)).rows[0] as RedeemTeam | undefined) ??
    TEAMLESS_MEMBER

  // 6. The session, from the lifecycle read under the lock step 4 took.
  const issued = await issueExternalUserSession(
    {
      contract: input.contract,
      userId: user.id,
      email: user.email,
      teamId: team.team_id,
      role: team.role,
      authenticationMethods: ['oidc'],
    },
    {
      db,
      policy: input.sessionPolicy,
      lockedUser: {
        lifecycleState: user.lifecycle_state,
        lifecycleVersion: user.lifecycle_version,
      },
    }
  )

  // 7. The body password login answers, with the locked row's name and picture.
  return Object.freeze({ status: 'signed_in', body: externalLoginResponseBody(issued, user, team) })
}

/**
 * Trades a one-use Desktop sign-in code and its PKCE verifier for a session,
 * in one transaction (design §7.4). The caller has already selected the
 * session format and loaded the provider configuration.
 *
 * - `invalid_code`: the code is unknown, expired or already redeemed, or the
 *   verifier is wrong. A wrong verifier leaves the code redeemable.
 * - `unavailable`: member sign-in was switched off, or the connection or its
 *   configuration changed, since the code was minted. The code is spent.
 * - `refused`: the account is no longer active. The code is spent.
 * - `signed_in`: the session and the `{ token, sessionContract, me }` body.
 *
 * A session issuance error, `ExternalSessionIssuanceUnavailableError`
 * included, propagates after the transaction rolls back, so the code stays
 * redeemable until it expires.
 */
export async function redeemDesktopSignInCode(
  input: DesktopSignInRedeemInput,
  deps: Readonly<{ transaction?: MemberTransaction }> = {}
): Promise<DesktopSignInRedeemResult> {
  const transaction: MemberTransaction =
    deps.transaction ??
    (<T>(work: (db: DbTransactionClient) => Promise<T>) => withTransaction(work))
  try {
    return await transaction(db => redeemInTransaction(db, input))
  } catch (error) {
    // Only the wrong-verifier signal is answered here: it was thrown to roll
    // the delete back, and it answers exactly as an unknown code does, so it
    // carries nothing to log. Every other error propagates unchanged.
    if (error instanceof DesktopSignInVerifierMismatch) return INVALID_CODE
    throw error
  }
}
