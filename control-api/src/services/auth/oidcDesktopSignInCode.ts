import { createHash, randomBytes } from 'node:crypto'
import type { DbTransactionClient } from '../../db.js'

/** How long a minted Desktop sign-in code can be redeemed. */
export const DESKTOP_SIGN_IN_CODE_TTL_SECONDS = 90

/** A Desktop sign-in code: 32 random bytes in base64url, 43 characters. */
export const DESKTOP_SIGN_IN_CODE_RE = /^[A-Za-z0-9_-]{43}$/

/** At most this many long-expired codes are deleted by one mint. */
const PURGE_BATCH = 100

/** The stored form of a code: its SHA-256, in hex. The code itself is never stored. */
export function hashDesktopSignInCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

/** The RFC 7636 S256 code challenge of a verifier: base64url(SHA-256(verifier)). */
export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/**
 * Mints a one-use Desktop sign-in code in the caller's transaction and returns
 * it once; only its hash is stored. The row records the member, the team the
 * sign-in chose (null for a teamless member), the Desktop's code challenge and
 * the provider connection the identity proof was verified against.
 *
 * The mint first deletes up to 100 codes that expired more than a day ago, so
 * unredeemed codes do not pile up. Both statements are plain: no statement
 * locks or updates a code row (the runtime role may only insert, read and
 * delete them). Times come from the database clock, which redeem compares
 * against.
 */
export async function mintDesktopSignInCode(
  db: DbTransactionClient,
  input: Readonly<{
    userId: string
    teamId: string | null
    codeChallenge: string
    registrationId: string
    configurationGeneration: string
  }>
): Promise<{ code: string; expiresInSeconds: number }> {
  await db.query(
    `DELETE FROM oidc_desktop_sign_in_codes
      WHERE code_hash IN (
        SELECT code_hash FROM oidc_desktop_sign_in_codes
         WHERE expires_at < now() - interval '1 day'
         LIMIT $1
      )`,
    [PURGE_BATCH]
  )
  const code = randomBytes(32).toString('base64url')
  await db.query(
    `INSERT INTO oidc_desktop_sign_in_codes
       (code_hash, user_id, team_id, code_challenge, registration_id,
        configuration_generation, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
    [
      hashDesktopSignInCode(code),
      input.userId,
      input.teamId,
      input.codeChallenge,
      input.registrationId,
      input.configurationGeneration,
      DESKTOP_SIGN_IN_CODE_TTL_SECONDS,
    ]
  )
  return { code, expiresInSeconds: DESKTOP_SIGN_IN_CODE_TTL_SECONDS }
}
