import { type OidcRefusalReason } from '../api/oidc/types'

/**
 * Set by the OIDC callback next to a fresh session so `/oidc/signed-in` can tell a real
 * sign-in from someone opening the page by hand. Readable by script on purpose.
 */
export const OIDC_SIGNED_IN_MARKER_COOKIE = '__Host-ef_oidc_signed_in'
export const OIDC_SIGNED_IN_MARKER_MAX_AGE_SECONDS = 60

/**
 * The pages an OIDC sign-in may return to. Only these values travel through the round trip;
 * each maps to a route in `OIDC_RETURN_TO_ROUTES`, so no request value becomes a redirect.
 */
export const OIDC_RETURN_TO_VALUES = ['desktop-setup'] as const
export type OidcReturnTo = (typeof OIDC_RETURN_TO_VALUES)[number]

export function isOidcReturnTo(value: unknown): value is OidcReturnTo {
  return typeof value === 'string' && (OIDC_RETURN_TO_VALUES as readonly string[]).includes(value)
}

/**
 * Most bytes `/api/oidc/start` reads from its unauthenticated form body to find `returnTo`.
 * LoginPanel's real body, `returnTo=desktop-setup`, is 22 bytes.
 */
export const OIDC_START_FORM_MAX_BYTES = 1024

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
