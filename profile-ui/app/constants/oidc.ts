import { type OidcRefusalReason } from '../api/oidc/types'

/**
 * Set by the OIDC callback next to a fresh session so `/oidc/signed-in` can tell a real
 * sign-in from someone opening the page by hand. Readable by script on purpose.
 */
export const OIDC_SIGNED_IN_MARKER_COOKIE = '__Host-ef_oidc_signed_in'
export const OIDC_SIGNED_IN_MARKER_MAX_AGE_SECONDS = 60

export const OIDC_GENERIC_RESULT_MESSAGE = "Sign-in couldn't be completed. Start again."

export const OIDC_REFUSAL_MESSAGES: Readonly<Record<OidcRefusalReason, string>> = {
  account_disabled: 'Your account has been disabled. Contact your administrator.',
  identity_conflict:
    'This Evenfire account is linked to another sign-in identity. Contact your administrator.',
  account_needs_attention: 'Your account needs attention. Contact your administrator.',
  email_claim_missing: 'Ask your administrator to enable the email claim for Evenfire.',
  email_unverified:
    "Your sign-in provider hasn't verified your email address. Verify it there, then sign in again.",
  not_eligible: "Your account isn't allowed to sign in to Evenfire. Contact your administrator.",
  no_account: "There's no Evenfire account for this sign-in. Ask your administrator to add you.",
  provider_configuration: "Sign-in isn't configured correctly. Contact your administrator.",
}
