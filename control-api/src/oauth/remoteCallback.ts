import { RFC1123_RE } from '../http/rfc1123.js'

/**
 * Redirect-URI policy for the remote MCP-OAuth lane (CIMD / DCR / pre-registered).
 *
 * Two callback variants exist, and which one a server uses is decided solely by
 * whether its authorization server advertises RFC 9207 (`iss` on the authorization
 * response):
 *
 *   - `shared`     — every server lands on ONE stable callback. Safe only because the
 *                    callback checks the response `iss` against the pinned issuer; the
 *                    URL itself carries no per-server binding.
 *   - `per-server` — without `iss`, the redirect URI itself is the mix-up defence: each
 *                    server (and, for DCR, each installation) registers a distinct URI,
 *                    so an AS can only ever deliver a code to the server it was issued
 *                    for.
 *
 * This module is the single place that derives the variant and builds the URI, so the
 * value registered at the AS, sent on authorize and replayed on the token exchange
 * cannot drift apart. It deliberately imports nothing from the OAuth modules: both
 * `callback.ts` and `cimd.ts` depend on it, and `cimd.ts` already reaches
 * `callback.ts` through `routes/external/oauthCallback.ts`, so any OAuth import here
 * would risk closing a cycle.
 */

/** Reserved last URL segment of the shared remote callback. */
export const REMOTE_CALLBACK_CLIENT_SEGMENT = 'remote'

/** Public path of the shared remote callback; per-server URIs extend it. */
export const REMOTE_CALLBACK_PATH = `/api/v1/oauth-callback/${REMOTE_CALLBACK_CLIENT_SEGMENT}`

export type RemoteCallbackVariant = 'shared' | 'per-server'

/**
 * Derive the callback variant from a remote `spec.oauth` block. Takes the block (not
 * the CR) so the install can call it on the block it is about to write, before the CR
 * exists, and the runtime paths on the block read back from the CR — one derivation
 * for both. `issForCallback` is third-party-derived CR data, hence `unknown`.
 */
export function remoteCallbackVariant(oauth: { issForCallback?: unknown }): RemoteCallbackVariant {
  return typeof oauth.issForCallback === 'string' && oauth.issForCallback.length > 0
    ? 'shared'
    : 'per-server'
}

/** A server name usable as a callback path segment: an RFC 1123 label (the K8s name rule). */
export function isValidRemoteServerNameSegment(value: unknown): value is string {
  return typeof value === 'string' && RFC1123_RE.test(value)
}

// Lowercase only: the install nonce is minted by `randomUUID()` (always lowercase) and
// is compared byte-for-byte against the stored `install_id`, so an uppercase spelling
// can never be legitimate and accepting it would give one nonce two valid URIs.
const INSTALL_NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** An installation nonce usable as a callback path segment: a canonical lowercase UUID. */
export function isValidInstallNonce(value: unknown): value is string {
  return typeof value === 'string' && INSTALL_NONCE_RE.test(value)
}

// A per-server URI is compared byte-for-byte by the AS and replayed on the token
// exchange, so its origin must already be in canonical form: no path, trailing slash,
// query, fragment or userinfo, and no spelling `new URL` would normalize differently.
export function isBareOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string' || origin.length === 0) return false
  try {
    return new URL(origin).origin === origin
  } catch {
    return false
  }
}

export type RemoteRedirectUriInput =
  | { origin: string; variant: 'shared' }
  | {
      origin: string
      variant: 'per-server'
      mode: 'dcr'
      serverName: string
      installNonce: string
    }
  | { origin: string; variant: 'per-server'; mode: 'pre-registered'; serverName: string }

export class InvalidRemoteRedirectUriInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRemoteRedirectUriInputError'
  }
}

/**
 * Build the remote redirect URI.
 *
 *   shared                    → `${origin}/api/v1/oauth-callback/remote`
 *   per-server, DCR           → `${origin}/api/v1/oauth-callback/remote/<serverName>/<installNonce>`
 *   per-server, pre-registered → `${origin}/api/v1/oauth-callback/remote/<serverName>`
 *
 * DCR carries the installation nonce because a DCR client outlives its uninstall at
 * the AS (RFC 7592 deletion is best-effort): without it, a later server reusing the
 * name would receive codes minted for the old, still-consented client. A pre-registered
 * client is confidential and its secret is deleted with the CR, so an old code is
 * useless and the URI stays stable for the operator to register once.
 *
 * Segments are validated and then interpolated verbatim — no `encodeURIComponent` —
 * because the validators admit only characters that are already URL-safe, and the
 * callback route must see the exact same bytes. Throws on any input that does not fit
 * the table (invalid segment, missing/extra nonce, or a mode without a per-server URI
 * such as CIMD), since a malformed redirect URI must never reach an AS.
 */
export function buildRemoteRedirectUri(input: RemoteRedirectUriInput): string {
  // The shared URI keeps its historical origin handling (callers may fall back to the
  // request Host); the per-server variant is only ever built from a configured origin.
  if (input.variant === 'shared') {
    return `${input.origin}${REMOTE_CALLBACK_PATH}`
  }
  if (input.variant !== 'per-server') {
    throw new InvalidRemoteRedirectUriInputError(
      `unknown callback variant "${String((input as { variant: unknown }).variant)}"`
    )
  }
  if (!isBareOrigin(input.origin)) {
    throw new InvalidRemoteRedirectUriInputError(
      'a per-server redirect URI requires a bare origin (scheme://host[:port])'
    )
  }
  if (!isValidRemoteServerNameSegment(input.serverName)) {
    throw new InvalidRemoteRedirectUriInputError('serverName is not a valid RFC 1123 label')
  }
  const base = `${input.origin}${REMOTE_CALLBACK_PATH}/${input.serverName}`
  if (input.mode === 'dcr') {
    if (!isValidInstallNonce(input.installNonce)) {
      throw new InvalidRemoteRedirectUriInputError(
        'a per-server DCR redirect URI requires a lowercase UUID installNonce'
      )
    }
    return `${base}/${input.installNonce}`
  }
  if (input.mode === 'pre-registered') {
    if ((input as { installNonce?: unknown }).installNonce !== undefined) {
      throw new InvalidRemoteRedirectUriInputError(
        'a per-server pre-registered redirect URI carries no installNonce'
      )
    }
    return base
  }
  throw new InvalidRemoteRedirectUriInputError(
    `registration mode "${String((input as { mode: unknown }).mode)}" has no per-server redirect URI`
  )
}
