import { randomBytes } from 'node:crypto'
import { type DesktopLoginError, buildDesktopLoginErrorLink } from '@clerum/desktop-app-links'
import {
  buildDesktopLoginHandoffDocument,
  buildEvenfireDesktopAppContentSecurityPolicy,
} from '../../../lib/desktopAppLinks'
import { DESKTOP_SIGN_IN_COPY } from '../../constants/oidc'
import { PROFILE_SESSION_COOKIE_PREFIX, cookieValues } from './_flow'

/**
 * The binding cookie's value for a Desktop attempt: `desktop.<binding>.<desktopState>`, each a
 * 43-character base64url value. The marker sits inside the binding cookie, not in a cookie of its
 * own: `readSingleCookie` accepts only a bare 43-character binding, so a callback without Desktop
 * sign-in finds no binding here and fails closed instead of signing this browser in. Only the
 * binding is ever sent upstream.
 */
export const DESKTOP_BINDING_COOKIE_RE = /^desktop\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/

/** Throws unless both values are 43-character base64url values. */
export function desktopBindingCookieValue(binding: string, desktopState: string): string {
  const value = `desktop.${binding}.${desktopState}`
  // `.` is not a base64url character, so the whole value matches only for two such values.
  if (!DESKTOP_BINDING_COOKIE_RE.test(value)) {
    throw new Error('Cannot write a Desktop binding cookie for these values')
  }
  return value
}

/**
 * The Desktop binding named `name`. `readSingleCookie`'s rules apply: a Cookie header of at most
 * 16 384 characters that carries the cookie exactly once. Only the value rule differs: it must
 * match `DESKTOP_BINDING_COOKIE_RE`. Anything else is not a Desktop attempt.
 */
export function readDesktopBindingCookie(
  request: Request,
  name: string
): Readonly<{ binding: string; desktopState: string }> | undefined {
  const values = cookieValues(request, name)
  const match = values.length === 1 ? DESKTOP_BINDING_COOKIE_RE.exec(values[0]) : null
  return match ? { binding: match[1], desktopState: match[2] } : undefined
}

/**
 * The page that hands a Desktop sign-in result to Evenfire Desktop: the handoff document under
 * the handoff title, with a fresh script nonce and its CSP (which includes `frame-ancestors
 * 'none'`), no-store and no-referrer. It sets exactly `cookies`. It throws on a `profile_session`
 * cookie, because a Desktop attempt never signs this browser in.
 */
export function desktopLoginPage(
  input: Readonly<{ link: string; message: string; status: number; cookies?: readonly string[] }>
): Response {
  const cookies = input.cookies ?? []
  if (cookies.some(cookie => cookie.trimStart().startsWith(PROFILE_SESSION_COOKIE_PREFIX))) {
    throw new Error('A Desktop sign-in page never sets profile_session')
  }
  const scriptNonce = randomBytes(18).toString('base64')
  const body = buildDesktopLoginHandoffDocument(input.link, scriptNonce, {
    title: DESKTOP_SIGN_IN_COPY.handoffTitle,
    message: input.message,
  })
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-security-policy': buildEvenfireDesktopAppContentSecurityPolicy(scriptNonce),
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(body, { status: input.status, headers })
}

/** The handoff page that fires the package's error link for the Desktop attempt's state. */
export function desktopLoginErrorPage(
  input: Readonly<{
    desktopState: string
    error: DesktopLoginError
    reason?: string
    message: string
    status: number
    cookies?: readonly string[]
  }>
): Response {
  return desktopLoginPage({
    link: buildDesktopLoginErrorLink({
      state: input.desktopState,
      error: input.error,
      reason: input.reason,
    }),
    message: input.message,
    status: input.status,
    cookies: input.cookies,
  })
}
