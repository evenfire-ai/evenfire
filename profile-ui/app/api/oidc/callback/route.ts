import { buildDesktopLoginCodeLink } from '@clerum/desktop-app-links'
import { DESKTOP_SIGN_IN_COPY, OIDC_REFUSAL_MESSAGES } from '../../../constants/oidc'
import { PROFILE_ROUTES } from '../../../constants/routes'
import { desktopLoginErrorPage, desktopLoginPage, readDesktopBindingCookie } from '../_desktop'
import {
  type OidcCompletionOutcome,
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

const UNVERIFIABLE_TEXT = 'Identity proof could not be verified.'
const PROVIDER_RETRY_TEXT = 'The identity provider is temporarily unavailable. Retry this attempt.'
const RATE_LIMITED_TEXT = 'Too many sign-in attempts. Retry this attempt later.'
const CANCEL_RETRY_TEXT = 'The cancellation could not be confirmed. Retry this attempt.'

/** A finished attempt: the browser drops its binding and return cookies. */
function terminalFailure(
  message: string,
  status: number,
  finishedCookies: readonly string[]
): Response {
  return noStoreResult(message, status, finishedCookies)
}

/**
 * Answers the provider's callback for a Desktop attempt (design section 8). It accepts only
 * `desktop_code_issued`, `refused`, or `attempt_cancelled` from `/cancel`, each as a handoff page
 * that fires the package's link for the Desktop state. A retryable answer keeps the attempt and its
 * cookie and fires nothing, as for a plain attempt. Every other answer ends the attempt and fires
 * `failed`. Every page clears the attempt's cookies and sets nothing else: never `profile_session`
 * and never the signed-in marker. Only the 43-character binding goes upstream; the marker and the
 * Desktop state never leave Profile UI.
 */
async function finishDesktopAttempt(
  request: Request,
  callback: Exclude<ReturnType<typeof parseCallbackParameters>, Readonly<{ kind: 'invalid' }>>,
  desktop: Readonly<{ binding: string; desktopState: string }>
): Promise<Response> {
  const { binding, desktopState } = desktop
  const finishedCookies = finishedAttemptCookies(request, callback.state)
  const failed = (status: number): Response =>
    desktopLoginErrorPage({
      desktopState,
      error: 'failed',
      message: DESKTOP_SIGN_IN_COPY.failed,
      status,
      cookies: finishedCookies,
    })

  if (callback.kind === 'retryable-error') {
    return noStoreText(PROVIDER_RETRY_TEXT, 503)
  }
  // A provider error with no case of its own (`login_required`, for example). Nothing goes
  // upstream and the attempt expires there, but Desktop is told now.
  if (callback.kind === 'provider-error') {
    return failed(400)
  }

  if (callback.kind === 'denied') {
    let outcome: unknown
    try {
      outcome = (
        await postOidcProfileFlow<{ outcome?: unknown }>(
          'cancel',
          { state: callback.state, browserBinding: binding },
          request
        )
      )?.outcome
    } catch (error) {
      // The answer, not the code, says whether this attempt may be retried
      // (`OidcProfileFlowError.retryable`). Any other answer ends it, as for a plain attempt, and
      // Desktop learns that through the link; the error carries nothing else to report.
      if (error instanceof OidcProfileFlowError && error.retryable) {
        return noStoreText(
          CANCEL_RETRY_TEXT,
          error.status === 429 ? 429 : 503,
          error.retryAfterSeconds
        )
      }
      return failed(error instanceof OidcProfileFlowError ? error.status : 503)
    }
    if (outcome !== 'attempt_cancelled') return failed(503)
    return desktopLoginErrorPage({
      desktopState,
      error: 'cancelled',
      message: DESKTOP_SIGN_IN_COPY.cancelled,
      status: 400,
      cookies: finishedCookies,
    })
  }

  let result: OidcCompletionOutcome
  try {
    result = await completeOidcProfileFlow(
      {
        state: callback.state,
        code: callback.code,
        browserBinding: binding,
        ...(callback.issuer !== undefined ? { issuer: callback.issuer } : {}),
      },
      request
    )
  } catch (error) {
    // As for /cancel above: `retryable` (the edge's retrySameAttempt) keeps the attempt, and any
    // other answer ends it with `failed`.
    if (error instanceof OidcProfileFlowError && error.retryable) {
      return noStoreText(
        error.status === 429 ? RATE_LIMITED_TEXT : PROVIDER_RETRY_TEXT,
        error.status === 429 ? 429 : 503,
        error.retryAfterSeconds
      )
    }
    return failed(error instanceof OidcProfileFlowError ? error.status : 503)
  }

  if (result.kind === 'desktop_code_issued') {
    try {
      return desktopLoginPage({
        link: buildDesktopLoginCodeLink({
          state: desktopState,
          code: result.code,
          environment: result.environment,
        }),
        message: DESKTOP_SIGN_IN_COPY.handoffMessage,
        status: 200,
        cookies: finishedCookies,
      })
    } catch {
      // Profile UI checks the edge's environment only as a string. The package refuses one that is
      // not an http or https URL, and the page re-parses the link it is given. Either refusal means
      // this one-time code cannot reach Desktop, so the attempt is over. The refusal says nothing
      // more, and the code must never be logged.
      return failed(503)
    }
  }
  if (result.kind === 'refused') {
    // The package writes `failed` for a reason the Desktop link does not carry.
    return desktopLoginErrorPage({
      desktopState,
      error: 'refused',
      reason: result.reason,
      message: OIDC_REFUSAL_MESSAGES[result.reason],
      status: 403,
      cookies: finishedCookies,
    })
  }
  // `identity_proof_verified` (member sign-in switched off after the attempt started) or
  // `member_signed_in` (a control-api without Desktop sign-in). A Desktop attempt never becomes a
  // Profile session, so its session cookie is dropped here.
  return failed(503)
}

/**
 * The answer to a configuration failure when the binding cookie names a Desktop attempt, or
 * undefined to keep today's JSON answer. Without the configuration the callback cannot finish the
 * attempt, so a failure a reload cannot pass (`retryable` false: no provider configured, or its
 * settings unusable) fires `failed` for the Desktop state and clears the attempt's cookies (design
 * section 8). A retryable failure keeps the attempt and its cookie for a reload. A plain attempt,
 * or a callback whose cookie is missing or unreadable, keeps today's answer and fires nothing.
 */
function desktopConfigurationFailure(request: Request, error: unknown): Response | undefined {
  if (error instanceof OidcProfileFlowError && error.retryable) return undefined
  const callback = parseCallbackParameters(request)
  if (callback.kind === 'invalid') return undefined
  const cookieName = browserCookieName(callback.state)
  if (readSingleCookie(request, cookieName)) return undefined
  const desktop = readDesktopBindingCookie(request, cookieName)
  if (!desktop) return undefined
  return desktopLoginErrorPage({
    desktopState: desktop.desktopState,
    error: 'failed',
    message: DESKTOP_SIGN_IN_COPY.failed,
    // `requestExternal` turns every transport, status and JSON failure into an
    // OidcProfileFlowError, so the 503 is reached only by a programming error. It ends the attempt
    // as the Desktop branch's other failures do; Profile UI has no logger to report it to.
    status: error instanceof OidcProfileFlowError ? error.status : 503,
    cookies: finishedAttemptCookies(request, callback.state),
  })
}

export async function GET(request: Request): Promise<Response> {
  if (request.url.length > 12_288) {
    return noStoreText(UNVERIFIABLE_TEXT, 400)
  }

  let configuration: OidcProfileConfiguration
  try {
    configuration = await getOidcProfileConfiguration(request)
  } catch (error) {
    return desktopConfigurationFailure(request, error) ?? responseForFlowError(error)
  }
  if (!requestPathMatchesCallback(request, configuration.redirectUri)) {
    return noStoreText('Request rejected.', 403)
  }

  const callback = parseCallbackParameters(request)
  if (callback.kind === 'invalid') {
    return noStoreText(UNVERIFIABLE_TEXT, 400)
  }
  // The attempt's kind comes only from its binding cookie: a bare binding is a plain attempt, and
  // `desktop.<binding>.<desktopState>` a Desktop one. Without either, no attempt can be answered,
  // so no link fires.
  const cookieName = browserCookieName(callback.state)
  const browserBinding = readSingleCookie(request, cookieName)
  if (!browserBinding) {
    const desktop = readDesktopBindingCookie(request, cookieName)
    if (!desktop) return noStoreText(UNVERIFIABLE_TEXT, 400)
    return finishDesktopAttempt(request, callback, desktop)
  }
  const finishedCookies = finishedAttemptCookies(request, callback.state)

  if (callback.kind === 'retryable-error') {
    return noStoreText(PROVIDER_RETRY_TEXT, 503)
  }

  // A plain attempt answers a provider error it has no case for as it always has: an
  // unverifiable callback, with nothing sent upstream and the cookies left to expire.
  if (callback.kind === 'provider-error') {
    return noStoreText(UNVERIFIABLE_TEXT, 400)
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
          CANCEL_RETRY_TEXT,
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
        UNVERIFIABLE_TEXT,
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
    // A plain attempt never asks for a Desktop code. The attempt is consumed upstream, so this
    // answer ends it like any other answer this attempt cannot use.
    if (result.kind === 'desktop_code_issued') {
      return terminalFailure(
        'This sign-in attempt cannot be reused. Start a new sign-in attempt.',
        503,
        finishedCookies
      )
    }
    return terminalFailure(
      'Identity proof was verified. Member sign-in is not enabled.',
      200,
      finishedCookies
    )
  } catch (error) {
    if (error instanceof OidcProfileFlowError && error.retryable) {
      return noStoreText(
        error.status === 429 ? RATE_LIMITED_TEXT : PROVIDER_RETRY_TEXT,
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
      UNVERIFIABLE_TEXT,
      error instanceof OidcProfileFlowError ? error.status : 503,
      finishedCookies
    )
  }
}
