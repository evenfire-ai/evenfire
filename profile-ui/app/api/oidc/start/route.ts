import { type OidcReturnTo, isOidcReturnTo } from '../../../constants/oidc'
import {
  OIDC_BROWSER_CLOCK_SKEW_SECONDS,
  OIDC_BROWSER_COOKIE_MAX_AGE_SECONDS,
  beginOidcAttempt,
  browserCookieName,
  getOidcProfileConfiguration,
  newBrowserBinding,
  noStoreRedirect,
  originMatchesCallback,
  responseForFlowError,
  returnToCookieName,
  setBrowserCookie,
  validateAuthorizationUrl,
} from '../_flow'

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'

/**
 * The page LoginPanel's form asks to come back to. Only a form POST carrying exactly one
 * closed-set `returnTo` yields a value; any other body is not read.
 */
async function requestedReturnTo(request: Request): Promise<OidcReturnTo | undefined> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType !== FORM_CONTENT_TYPE) return undefined
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    // The return value is a convenience, not part of sign-in: an unreadable form still
    // starts the attempt, and the member lands on the default page afterwards.
    return undefined
  }
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
    const authorizationUrl = validateAuthorizationUrl(
      attempt.authorizationUrl,
      configuration.redirectUri
    )
    const expiresAt = new Date(attempt.expiresAt)
    const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000)
    const state = authorizationUrl?.searchParams.get('state')
    if (
      !authorizationUrl ||
      !state ||
      !Number.isFinite(expiresAt.getTime()) ||
      maxAge <= 0 ||
      maxAge > OIDC_BROWSER_COOKIE_MAX_AGE_SECONDS + OIDC_BROWSER_CLOCK_SKEW_SECONDS
    ) {
      return new Response('Sign-in is unavailable.', {
        status: 503,
        headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      })
    }

    return noStoreRedirect(authorizationUrl.href, [
      setBrowserCookie(browserCookieName(state), browserBinding, maxAge),
      ...(returnTo ? [setBrowserCookie(returnToCookieName(state), returnTo, maxAge)] : []),
    ])
  } catch (error) {
    return responseForFlowError(error)
  }
}
