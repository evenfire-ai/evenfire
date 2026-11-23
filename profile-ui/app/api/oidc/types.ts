/**
 * Why External REST refused an OIDC member sign-in. Mirrors the eight reasons the
 * `complete` answer can carry; Profile UI declares its own copy and does not import
 * Control API.
 */
export const OIDC_REFUSAL_REASONS = [
  'account_disabled',
  'identity_conflict',
  'account_needs_attention',
  'email_claim_missing',
  'email_unverified',
  'not_eligible',
  'no_account',
  'provider_configuration',
] as const

export type OidcRefusalReason = (typeof OIDC_REFUSAL_REASONS)[number]

export type OidcCompletionOutcome =
  | Readonly<{ kind: 'identity_proof_verified' }>
  | Readonly<{ kind: 'member_signed_in'; sessionCookie: string }>
  | Readonly<{ kind: 'refused'; reason: OidcRefusalReason }>
