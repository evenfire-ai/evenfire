import { type DesktopLoginFragment, parseDesktopLoginFragment } from '@clerum/desktop-app-links'
import { DESKTOP_SIGN_IN_COPY } from '../../../constants/oidc'
import { desktopBindingCookieValue, desktopLoginErrorPage } from '../_desktop'
import {
  type OidcProfileConfiguration,
  OidcProfileFlowError,
  beginOidcAttempt,
  browserCookieName,
  getOidcProfileConfiguration,
  newBrowserBinding,
  noStoreRedirect,
  noStoreText,
  originMatchesCallback,
  setBrowserCookie,
  validatedAttemptRedirect,
} from '../_flow'
import { readStartForm } from '../_form'

/** The fragment key each Desktop form field stands for. */
const FRAGMENT_KEY_BY_FIELD: ReadonlyMap<string, string> = new Map([
  ['desktopChallenge', 'challenge'],
  ['desktopState', 'state'],
])
/** Any other field. It is not a fragment key, so the parser refuses the form. */
const UNEXPECTED_FRAGMENT_KEY = 'unexpected'

/**
 * The challenge and state the /desktop-login page posts, checked by the package's fragment rule:
 * exactly one of each, each a 43-character base64url value, and no other field. Every field is
 * re-encoded under its fragment key, and any other field under a key the parser refuses, so
 * neither a value nor a field named `state` or `challenge` can stand in for a Desktop field. The
 * state is returned whenever it alone is well formed.
 */
async function postedDesktopValues(request: Request): Promise<DesktopLoginFragment> {
  let form: URLSearchParams | undefined
  try {
    form = await readStartForm(request)
  } catch {
    // A body that fails mid-read carries no state, so it gets the malformed-state answer below.
    form = undefined
  }
  const fragment = new URLSearchParams()
  for (const [field, value] of form?.entries() ?? []) {
    fragment.append(FRAGMENT_KEY_BY_FIELD.get(field) ?? UNEXPECTED_FRAGMENT_KEY, value)
  }
  return parseDesktopLoginFragment(fragment.toString())
}

/** The page a started-but-failed Desktop sign-in gets, from the start's failure. */
function attemptFailure(error: unknown): Readonly<{ message: string; status: number }> {
  // External REST's "Desktop sign-in is off here". Profile UI keeps any upstream 409, so the
  // code, not the status, says which one this is.
  if (error instanceof OidcProfileFlowError && error.code === 'desktop_sign_in_unavailable') {
    return { message: DESKTOP_SIGN_IN_COPY.unavailable, status: 409 }
  }
  if (error instanceof OidcProfileFlowError && error.status === 400) {
    return { message: DESKTOP_SIGN_IN_COPY.invalidLink, status: 400 }
  }
  return { message: DESKTOP_SIGN_IN_COPY.startFailed, status: 503 }
}

/**
 * Starts a Desktop sign-in: a provider round trip whose binding cookie carries the Desktop marker
 * and the state. Only the challenge goes upstream. It never reads or sets `profile_session`, so a
 * browser that is already signed in to Profile still goes through the provider. Once the state is
 * known, every failure fires the `unavailable` link for it and sets no cookie.
 */
export async function POST(request: Request): Promise<Response> {
  const posted = await postedDesktopValues(request)
  // Without a well-formed state there is no Desktop sign-in to answer, so no link fires.
  if (posted.state === null) return noStoreText(DESKTOP_SIGN_IN_COPY.invalidLink, 400)
  const desktopState = posted.state
  const unavailable = (message: string, status: number): Response =>
    desktopLoginErrorPage({ desktopState, error: 'unavailable', message, status })
  if (!posted.valid) return unavailable(DESKTOP_SIGN_IN_COPY.invalidLink, 400)

  let configuration: OidcProfileConfiguration
  try {
    configuration = await getOidcProfileConfiguration(request)
  } catch (error) {
    return unavailable(
      DESKTOP_SIGN_IN_COPY.startFailed,
      error instanceof OidcProfileFlowError ? error.status : 503
    )
  }
  if (!originMatchesCallback(request, configuration.redirectUri)) {
    return unavailable(DESKTOP_SIGN_IN_COPY.startFailed, 403)
  }

  const browserBinding = newBrowserBinding()
  let attempt: Awaited<ReturnType<typeof beginOidcAttempt>>
  try {
    attempt = await beginOidcAttempt(browserBinding, request, {
      desktopSignIn: { codeChallenge: posted.challenge },
    })
  } catch (error) {
    const failure = attemptFailure(error)
    return unavailable(failure.message, failure.status)
  }
  // An edge without Desktop sign-in starts a plain attempt and echoes no context. That attempt
  // would end in a Profile session, so it is never redirected to.
  if (attempt?.signInContext !== 'desktop_sign_in') {
    return unavailable(DESKTOP_SIGN_IN_COPY.unavailable, 409)
  }
  const redirect = validatedAttemptRedirect(attempt, configuration)
  if (!redirect) return unavailable(DESKTOP_SIGN_IN_COPY.startFailed, 503)

  const { authorizationUrl, state, maxAge } = redirect
  return noStoreRedirect(authorizationUrl.href, [
    setBrowserCookie(
      browserCookieName(state),
      desktopBindingCookieValue(browserBinding, desktopState),
      maxAge
    ),
  ])
}
