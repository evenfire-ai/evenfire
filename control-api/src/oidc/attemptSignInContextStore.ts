import type { DbClient } from '../db.js'

/**
 * What an OIDC protocol attempt was started for, read back by the claim.
 *
 * A plain Profile sign-in has no context. A Desktop sign-in carries the
 * Desktop's PKCE code challenge; an invitation carries the invitation id and
 * the lower-cased invited email. The rows live in
 * `oidc_attempt_sign_in_contexts` (migration `0160_oidc_desktop_sign_in`), one
 * per attempt, and the runtime role only inserts and reads them.
 */
export type OidcAttemptSignInContext =
  | Readonly<{ kind: 'desktop_sign_in'; codeChallenge: string }>
  | Readonly<{ kind: 'invitation'; invitationId: string; invitedEmail: string }>

/** The context columns the claim statement selects, under these aliases. */
export type OidcAttemptSignInContextColumns = {
  ctx_kind?: string | null
  ctx_code_challenge?: string | null
  ctx_invitation_id?: string | null
  ctx_invited_email?: string | null
}

export async function insertDesktopSignInContext(
  db: Pick<DbClient, 'query'>,
  attemptId: string,
  codeChallenge: string
): Promise<void> {
  await db.query(
    `INSERT INTO oidc_attempt_sign_in_contexts (attempt_id, context_kind, desktop_code_challenge)
     VALUES ($1, 'desktop_sign_in', $2)`,
    [attemptId, codeChallenge]
  )
}

/**
 * Records that an attempt was started from an invitation link the hub
 * accepted: the local invitation's id and its lower-cased email. The token
 * itself is never stored.
 */
export async function insertInvitationSignInContext(
  db: Pick<DbClient, 'query'>,
  attemptId: string,
  context: Readonly<{ invitationId: string; invitedEmail: string }>
): Promise<void> {
  await db.query(
    `INSERT INTO oidc_attempt_sign_in_contexts (attempt_id, context_kind, invitation_id, invited_email)
     VALUES ($1, 'invitation', $2, $3)`,
    [attemptId, context.invitationId, context.invitedEmail]
  )
}

/**
 * Maps the claim row's context columns. No context row (null columns from the
 * LEFT JOIN, or no columns at all) is a plain attempt. A row the schema's
 * kind/columns CHECK should have refused throws instead of passing as plain,
 * so a Desktop or invitation attempt never passes as a plain attempt, without
 * its context.
 */
export function signInContextFromClaimRow(
  row: OidcAttemptSignInContextColumns
): OidcAttemptSignInContext | null {
  if (row.ctx_kind === undefined || row.ctx_kind === null) return null
  if (row.ctx_kind === 'desktop_sign_in' && typeof row.ctx_code_challenge === 'string') {
    return Object.freeze({ kind: 'desktop_sign_in', codeChallenge: row.ctx_code_challenge })
  }
  if (
    row.ctx_kind === 'invitation' &&
    typeof row.ctx_invitation_id === 'string' &&
    typeof row.ctx_invited_email === 'string'
  ) {
    return Object.freeze({
      kind: 'invitation',
      invitationId: row.ctx_invitation_id,
      invitedEmail: row.ctx_invited_email,
    })
  }
  throw new Error('OIDC attempt sign-in context is malformed')
}
