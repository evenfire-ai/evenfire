import {
  OIDC_START_FORM_MAX_BYTES,
  type OidcReturnTo,
  isOidcReturnTo,
} from '../../../constants/oidc'
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
 * The body as text, or undefined once it passes `maxBytes`. Reading stops there, so a body
 * longer than its declared Content-Length is never buffered past the cap either.
 */
async function readCappedText(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<string | undefined> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maxBytes) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * The page LoginPanel's form asks to come back to. Only a urlencoded POST that declares a
 * Content-Length of at most `OIDC_START_FORM_MAX_BYTES`, and carries exactly one closed-set
 * `returnTo`, yields a value. Any other body is not read: this route is unauthenticated.
 */
async function requestedReturnTo(request: Request): Promise<OidcReturnTo | undefined> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType !== FORM_CONTENT_TYPE || !request.body) return undefined
  const declaredLength = request.headers.get('content-length')?.trim() ?? ''
  if (!/^\d{1,5}$/.test(declaredLength) || Number(declaredLength) > OIDC_START_FORM_MAX_BYTES) {
    return undefined
  }
  let text: string | undefined
  try {
    text = await readCappedText(request.body, OIDC_START_FORM_MAX_BYTES)
  } catch {
    // returnTo is a convenience, not part of sign-in: when the form cannot be read, the
    // attempt still starts without it and the member lands on the default page afterwards.
    return undefined
  }
  if (text === undefined) return undefined
  const values = new URLSearchParams(text).getAll('returnTo')
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
