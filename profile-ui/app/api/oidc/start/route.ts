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
  setBrowserCookie,
  validateAuthorizationUrl,
} from '../_flow'

export async function POST(request: Request): Promise<Response> {
  try {
    const configuration = await getOidcProfileConfiguration(request)
    if (!originMatchesCallback(request, configuration.redirectUri)) {
      return new Response('Request rejected.', {
        status: 403,
        headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      })
    }

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

    return noStoreRedirect(
      authorizationUrl.href,
      setBrowserCookie(browserCookieName(state), browserBinding, maxAge)
    )
  } catch (error) {
    return responseForFlowError(error)
  }
}
