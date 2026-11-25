import { type OidcReturnTo, isOidcReturnTo } from '../../../constants/oidc'
import {
  beginOidcAttempt,
  browserCookieName,
  getOidcProfileConfiguration,
  newBrowserBinding,
  noStoreRedirect,
  originMatchesCallback,
  responseForFlowError,
  returnToCookieName,
  setBrowserCookie,
  validatedAttemptRedirect,
} from '../_flow'
import { readStartForm } from '../_form'

/**
 * The page LoginPanel's form asks to come back to. Only a form `readStartForm` accepts, and
 * that carries exactly one closed-set `returnTo`, yields a value. Any other body is not read:
 * this route is unauthenticated.
 */
async function requestedReturnTo(request: Request): Promise<OidcReturnTo | undefined> {
  let form: URLSearchParams | undefined
  try {
    form = await readStartForm(request)
  } catch {
    // returnTo is a convenience, not part of sign-in: when the form cannot be read, the
    // attempt still starts without it and the member lands on the default page afterwards.
    return undefined
  }
  if (form === undefined) return undefined
  const values = form.getAll('returnTo')
  return values.length === 1 && isOidcReturnTo(values[0]) ? values[0] : undefined
}

export async function POST(request: Request): Promise<Response> {
  try {
    const configuration = await getOidcProfileConfiguration(request)
    if (!originMatchesCallback(request, configuration.redirectUri)) {
      return new Response('Request rejected.', {
        status: 403,
        headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      })
    }

    const returnTo = await requestedReturnTo(request)
    const browserBinding = newBrowserBinding()
    const attempt = await beginOidcAttempt(browserBinding, request)
    const redirect = validatedAttemptRedirect(attempt, configuration)
    if (!redirect) {
      return new Response('Sign-in is unavailable.', {
        status: 503,
        headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      })
    }

    const { authorizationUrl, state, maxAge } = redirect
    return noStoreRedirect(authorizationUrl.href, [
      setBrowserCookie(browserCookieName(state), browserBinding, maxAge),
      ...(returnTo ? [setBrowserCookie(returnToCookieName(state), returnTo, maxAge)] : []),
    ])
  } catch (error) {
    return responseForFlowError(error)
  }
}
