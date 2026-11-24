/**
 * Claim-name rules shared by the protocol engine, which keeps named ID token
 * claims as verified policy evidence, and the configuration, which names the
 * claim member eligibility requires.
 */

const MAX_CLAIM_NAME_LENGTH = 128

/** Claims the OIDC protocol defines and the engine validates itself; never policy evidence. */
export const OIDC_PROTOCOL_CLAIMS: ReadonlySet<string> = new Set([
  'iss',
  'sub',
  'aud',
  'exp',
  'iat',
  'nbf',
  'jti',
  'nonce',
  'azp',
  'auth_time',
  'at_hash',
  'c_hash',
  's_hash',
  'sid',
])

/**
 * Claims member eligibility already reads for its tenant, guest and email
 * checks. A required claim may not use one of these names: `tid` would pass
 * every token of the pinned tenant, and the email claims are not authorization.
 * `roles` is not here: it is the default required claim.
 */
export const OIDC_ELIGIBILITY_RESERVED_CLAIMS: ReadonlySet<string> = new Set([
  'tid',
  'idp',
  'acct',
  'email',
  'email_verified',
  'xms_edov',
])

/** A non-empty name of at most 128 characters, with no control characters, that is not a protocol claim. */
export function isAcceptableEvidenceClaimName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_CLAIM_NAME_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(name) &&
    !OIDC_PROTOCOL_CLAIMS.has(name)
  )
}
