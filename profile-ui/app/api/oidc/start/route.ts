import {
  OIDC_INVITATION_TOKEN_RE,
  type OidcReturnTo,
  isOidcReturnTo,
} from '../../../constants/oidc'
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

type StartFields = Readonly<{ returnTo?: OidcReturnTo; invitationToken?: string }>

/**
 * What the posted form asks for: the page LoginPanel's form comes back to, and the invitation the
 * invitation page's form signs in with. Only a form `readStartForm` accepts is read, and each
 * field counts only when it appears exactly once and passes its own check (the closed `returnTo`
 * set, `OIDC_INVITATION_TOKEN_RE`). Anything else is dropped, and the attempt starts without it:
 * this route is unauthenticated.
 */
async function requestedFields(request: Request): Promise<StartFields> {
  let form: URLSearchParams | undefined
  try {
    form = await readStartForm(request)
  } catch {
    // Neither field is part of sign-in itself: when the form cannot be read, the attempt still
    // starts plain. The member lands on the default page, and pending invitations still apply
    // by email when they sign in.
    return {}
  }
  if (form === undefined) return {}
  const returnTo = form.getAll('returnTo')
  const invitationToken = form.getAll('invitationToken')
  return {
    ...(returnTo.length === 1 && isOidcReturnTo(returnTo[0]) ? { returnTo: returnTo[0] } : {}),
    ...(invitationToken.length === 1 && OIDC_INVITATION_TOKEN_RE.test(invitationToken[0])
      ? { invitationToken: invitationToken[0] }
      : {}),
  }
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

    const { returnTo, invitationToken } = await requestedFields(request)
    const browserBinding = newBrowserBinding()
    const attempt = await beginOidcAttempt(
      browserBinding,
      request,
      invitationToken !== undefined ? { invitationToken } : {}
    )
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
