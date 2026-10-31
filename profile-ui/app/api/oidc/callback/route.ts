import {
  type OidcProfileConfiguration,
  OidcProfileFlowError,
  browserCookieName,
  clearBrowserCookie,
  getOidcProfileConfiguration,
  noStoreResult,
  noStoreText,
  parseCallbackParameters,
  postOidcProfileFlow,
  readSingleCookie,
  requestMatchesCallback,
  responseForFlowError,
} from '../_flow'

function terminalFailure(message: string, status: number, state: string): Response {
  return noStoreResult(message, status, clearBrowserCookie(browserCookieName(state)))
}

export async function GET(request: Request): Promise<Response> {
  if (request.url.length > 12_288) {
    return noStoreText('Identity proof could not be verified.', 400)
  }

  let configuration: OidcProfileConfiguration
  try {
    configuration = await getOidcProfileConfiguration()
  } catch (error) {
    return responseForFlowError(error)
  }
  if (!requestMatchesCallback(request, configuration.redirectUri)) {
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

  if (callback.kind === 'retryable-error') {
    return noStoreText('The identity provider is temporarily unavailable. Retry this attempt.', 503)
  }

  if (callback.kind === 'denied') {
    try {
      const result = await postOidcProfileFlow<{ outcome: 'attempt_cancelled' }>('cancel', {
        state: callback.state,
        browserBinding,
      })
      if (result?.outcome !== 'attempt_cancelled') {
        throw new OidcProfileFlowError(503, 'oidc_unavailable', false)
      }
      return terminalFailure('Sign-in was cancelled.', 400, callback.state)
    } catch (error) {
      if (error instanceof OidcProfileFlowError && error.retryable) {
        return noStoreText('The cancellation could not be confirmed. Retry this attempt.', 503)
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
          callback.state
        )
      }
      return terminalFailure(
        'Identity proof could not be verified.',
        error instanceof OidcProfileFlowError ? error.status : 503,
        callback.state
      )
    }
  }

  try {
    const result = await postOidcProfileFlow<{ outcome: 'identity_proof_verified' }>('complete', {
      state: callback.state,
      code: callback.code,
      browserBinding,
      ...(callback.issuer !== undefined ? { issuer: callback.issuer } : {}),
    })
    if (result?.outcome !== 'identity_proof_verified') {
      throw new OidcProfileFlowError(503, 'oidc_unavailable', false)
    }
    return terminalFailure(
      'Identity proof was verified. Member sign-in is not enabled.',
      200,
      callback.state
    )
  } catch (error) {
    if (error instanceof OidcProfileFlowError && error.retryable) {
      return noStoreText(
        'The identity provider is temporarily unavailable. Retry this attempt.',
        503
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
        callback.state
      )
    }
    return terminalFailure(
      'Identity proof could not be verified.',
      error instanceof OidcProfileFlowError ? error.status : 503,
      callback.state
    )
  }
}
