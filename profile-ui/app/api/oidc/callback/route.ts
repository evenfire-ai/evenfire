import { PROFILE_ROUTES } from '../../../constants/routes'
import {
  type OidcProfileConfiguration,
  OidcProfileFlowError,
  browserCookieName,
  completeOidcProfileFlow,
  finishedAttemptCookies,
  getOidcProfileConfiguration,
  memberSignedInRedirect,
  noStoreResult,
  noStoreText,
  parseCallbackParameters,
  postOidcProfileFlow,
  readReturnToCookie,
  readSingleCookie,
  refusedRedirect,
  requestPathMatchesCallback,
  responseForFlowError,
} from '../_flow'

/** A finished attempt: the browser drops its binding and return cookies. */
function terminalFailure(
  message: string,
  status: number,
  finishedCookies: readonly string[]
): Response {
  return noStoreResult(message, status, finishedCookies)
}

export async function GET(request: Request): Promise<Response> {
  if (request.url.length > 12_288) {
    return noStoreText('Identity proof could not be verified.', 400)
  }

  let configuration: OidcProfileConfiguration
  try {
    configuration = await getOidcProfileConfiguration(request)
  } catch (error) {
    return responseForFlowError(error)
  }
  if (!requestPathMatchesCallback(request, configuration.redirectUri)) {
    return noStoreText('Request rejected.', 403)
  }

  const callback = parseCallbackParameters(request)
  if (callback.kind === 'invalid') {
    return noStoreText('Identity proof could not be verified.', 400)
  }
  const cookieName = browserCookieName(callback.state)
  const browserBinding = readSingleCookie(request, cookieName)
  if (!browserBinding) {
    return noStoreText('Identity proof could not be verified.', 400)
  }
  const finishedCookies = finishedAttemptCookies(request, callback.state)

  if (callback.kind === 'retryable-error') {
    return noStoreText('The identity provider is temporarily unavailable. Retry this attempt.', 503)
  }

  if (callback.kind === 'denied') {
    try {
      const result = await postOidcProfileFlow<{ outcome: 'attempt_cancelled' }>(
        'cancel',
        {
          state: callback.state,
          browserBinding,
        },
        request
      )
      if (result?.outcome !== 'attempt_cancelled') {
        throw new OidcProfileFlowError(503, 'oidc_unavailable', false)
      }
      return terminalFailure('Sign-in was cancelled.', 400, finishedCookies)
    } catch (error) {
      if (error instanceof OidcProfileFlowError && error.retryable) {
        return noStoreText(
          'The cancellation could not be confirmed. Retry this attempt.',
          error.status === 429 ? 429 : 503,
          error.retryAfterSeconds
        )
      }
      if (
        error instanceof OidcProfileFlowError &&
        !error.retryable &&
        (error.code === 'oidc_provider_unavailable' ||
          error.code === 'oidc_storage_unavailable' ||
          error.code === 'oidc_unavailable')
      ) {
        return terminalFailure(
          'This sign-in attempt cannot be reused. Start a new sign-in attempt.',
          error.status,
          finishedCookies
        )
      }
      return terminalFailure(
        'Identity proof could not be verified.',
        error instanceof OidcProfileFlowError ? error.status : 503,
        finishedCookies
      )
    }
  }

  try {
    const result = await completeOidcProfileFlow(
      {
        state: callback.state,
        code: callback.code,
        browserBinding,
        ...(callback.issuer !== undefined ? { issuer: callback.issuer } : {}),
      },
      request
    )
    if (result.kind === 'member_signed_in') {
      const returnTo = readReturnToCookie(request, callback.state)
      return memberSignedInRedirect(
        returnTo ? PROFILE_ROUTES.oidcSignedInWithReturn(returnTo) : PROFILE_ROUTES.oidcSignedIn,
        result.sessionCookie,
        finishedCookies
      )
    }
    if (result.kind === 'refused') {
      return refusedRedirect(PROFILE_ROUTES.oidcResult(result.reason), finishedCookies)
    }
    return terminalFailure(
      'Identity proof was verified. Member sign-in is not enabled.',
      200,
      finishedCookies
    )
  } catch (error) {
    if (error instanceof OidcProfileFlowError && error.retryable) {
      return noStoreText(
        error.status === 429
          ? 'Too many sign-in attempts. Retry this attempt later.'
          : 'The identity provider is temporarily unavailable. Retry this attempt.',
        error.status === 429 ? 429 : 503,
        error.retryAfterSeconds
      )
    }
    if (
      error instanceof OidcProfileFlowError &&
      !error.retryable &&
      (error.code === 'oidc_provider_unavailable' ||
        error.code === 'oidc_storage_unavailable' ||
        error.code === 'oidc_unavailable')
    ) {
      return terminalFailure(
        'This sign-in attempt cannot be reused. Start a new sign-in attempt.',
        error.status,
        finishedCookies
      )
    }
    return terminalFailure(
      'Identity proof could not be verified.',
      error instanceof OidcProfileFlowError ? error.status : 503,
      finishedCookies
    )
  }
}
