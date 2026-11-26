import type { DesktopLoginRefusalReason } from '../../../src/browserSignInModel'

/**
 * What the login screen says about its sign-in methods and about signing in through the browser
 * (design §10.1).
 */
export const BROWSER_SIGN_IN_COPY = Object.freeze({
  loadingMethods: 'Loading sign-in options…',
  continueWith: (label: string) => `Continue with ${label}`,
  passwordHeading: 'Sign in with a password',
  waiting: 'Finish signing in in your browser',
  cancel: 'Cancel',
  redeeming: 'Finishing sign-in…',
  misconfigured: "This environment's sign-in isn't set up correctly.",
  unreachable: "Can't reach this environment.",
  retry: 'Retry',
})

/**
 * The status each end state shows (plan decision 5). `failed` with `environment_changed`, or
 * with no reason, shows `failed`; `replaced` shows nothing. `sessionLoadFailed` shows when the
 * renderer cannot load a session main holds.
 */
export const BROWSER_SIGN_IN_OUTCOME_COPY = Object.freeze({
  signedIn: 'Signed in.',
  cancelled: 'Browser sign-in cancelled.',
  timedOut: 'Browser sign-in timed out. Try again.',
  failed: "Sign-in through the browser didn't finish. Try again.",
  differentEnvironment: 'This sign-in finished for a different Evenfire environment.',
  unavailable: "Sign-in through the browser isn't available here.",
  noLongerAvailable: 'Sign-in through the browser is no longer available here.',
  sessionLoadFailed: 'Could not load your session. Try again.',
})

/**
 * A refusal's status, for PR 2's eight reasons only, in Profile UI's wording
 * (`profile-ui/app/constants/oidc.ts`, `OIDC_REFUSAL_MESSAGES`). `invitation_email_mismatch` is
 * not a Desktop reason (PR 2 decision 5).
 */
export const BROWSER_SIGN_IN_REFUSAL_COPY: Readonly<Record<DesktopLoginRefusalReason, string>> =
  Object.freeze({
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
  })

/**
 * Start refusals after which the renderer re-reads the login model and shows no message (D5):
 * what the screen offered no longer holds for the environment main is bound to.
 */
export const START_REJECTION_REREAD_CODES = Object.freeze([
  'stale_session_generation',
  'stale_runtime_environment',
  'browser_sign_in_not_offered',
  'browser_sign_in_unavailable_here',
  'methods_unavailable',
] as const)
