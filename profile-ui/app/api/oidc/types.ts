/**
 * Why External REST refused an OIDC member sign-in. Mirrors the nine reasons the
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
  'invitation_email_mismatch',
] as const

export type OidcRefusalReason = (typeof OIDC_REFUSAL_REASONS)[number]

export type OidcCompletionOutcome =
  | Readonly<{ kind: 'identity_proof_verified' }>
  | Readonly<{ kind: 'member_signed_in'; sessionCookie: string }>
  | Readonly<{ kind: 'refused'; reason: OidcRefusalReason }>
  | Readonly<{ kind: 'desktop_code_issued'; code: string; environment: string }>

/** What an attempt carries besides its browser binding: a Desktop sign-in or an invitation. */
export type OidcAttemptExtras = Readonly<{
  desktopSignIn?: Readonly<{ codeChallenge: string }>
  invitationToken?: string
}>
