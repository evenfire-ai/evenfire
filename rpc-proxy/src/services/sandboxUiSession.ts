import jwt from 'jsonwebtoken'
import { config } from '../config.js'

/**
 * Sandbox-UI session cookie service. Cookie shape:
 *
 *   {
 *     iss: "rpc-proxy",
 *     aud: "rpc-proxy-sandbox-ui",
 *     sub: <userId>,
 *     recipeNs, recipeName,
 *     scope: "sandbox:ui:view",
 *     iat, exp
 *   }
 *
 * Signed HS256 with `sandboxUiCookieSecret`. The `view/*` reverse proxy is
 * the only verifier — it MUST also assert that the cookie's (recipeNs,
 * recipeName) match the URL path so a path-scoping bug in a browser /
 * proxy can't replay one recipe's cookie against another.
 *
 * The cookie's Path is scoped to the per-recipe view URL prefix
 * (`/api/v1/sandbox-ui/<ns>/<name>/`) so the browser only sends it on
 * those requests; the JWT claim check above is the second line of defence.
 */

const ISS = 'rpc-proxy'
const AUD = 'rpc-proxy-sandbox-ui'
const SCOPE = 'sandbox:ui:view'

export type SandboxUiSessionClaims = {
  sub: string
  recipeNs: string
  recipeName: string
  iss: string
  aud: string
  scope: string
  iat: number
  exp: number
}

export function createSandboxUiSession(
  userId: string,
  recipeNs: string,
  recipeName: string
): string {
  return jwt.sign(
    {
      sub: userId,
      recipeNs,
      recipeName,
      scope: SCOPE,
    },
    config.sandboxUiCookieSecret,
    {
      algorithm: 'HS256',
      issuer: ISS,
      audience: AUD,
      expiresIn: config.sandboxUiCookieMaxAgeSec,
    }
  )
}

/**
 * Verify a cookie value, asserting that the recipeNs / recipeName claim
 * matches what the caller resolved from the URL path. Returns the parsed
 * claims on success or null on any failure (signature, expiry, mismatched
 * issuer/audience/scope, claim-vs-URL mismatch, missing fields).
 */
export function verifySandboxUiSession(
  cookieValue: string,
  expectedNs: string,
  expectedName: string
): SandboxUiSessionClaims | null {
  let payload: jwt.JwtPayload
  try {
    payload = jwt.verify(cookieValue, config.sandboxUiCookieSecret, {
      algorithms: ['HS256'],
      issuer: ISS,
      audience: AUD,
    }) as jwt.JwtPayload
  } catch {
    return null
  }

  if (
    typeof payload?.sub !== 'string' ||
    payload.sub.length === 0 ||
    typeof payload?.recipeNs !== 'string' ||
    typeof payload?.recipeName !== 'string' ||
    payload?.scope !== SCOPE ||
    typeof payload?.iat !== 'number' ||
    typeof payload?.exp !== 'number'
  ) {
    return null
  }

  // Defence-in-depth: even though the cookie is path-scoped to
  // /api/v1/sandbox-ui/<ns>/<name>/, refuse to honour a cookie minted for
  // recipe A on a request for recipe B. Catches path-scoping bugs in any
  // intermediate browser / proxy.
  if (payload.recipeNs !== expectedNs || payload.recipeName !== expectedName) {
    return null
  }

  return {
    sub: payload.sub,
    recipeNs: payload.recipeNs,
    recipeName: payload.recipeName,
    iss: ISS,
    aud: AUD,
    scope: SCOPE,
    iat: payload.iat,
    exp: payload.exp,
  }
}

/**
 * Build the Set-Cookie header value for `createSandboxUiSession`. Path is
 * scoped to the per-recipe view URL prefix so browsers don't bleed the
 * cookie to other recipes. `Secure` is appended in production so a network
 * man-in-the-middle on a dev HTTPS-stripped session can't read the JWT.
 */
export function buildSandboxUiSetCookie(
  cookieValue: string,
  recipeNs: string,
  recipeName: string
): string {
  const path = `/api/v1/sandbox-ui/${encodeURIComponent(recipeNs)}/${encodeURIComponent(recipeName)}/`
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${config.sandboxUiCookieName}=${cookieValue}; Path=${path}; HttpOnly; SameSite=Strict${secure}; Max-Age=${config.sandboxUiCookieMaxAgeSec}`
}
