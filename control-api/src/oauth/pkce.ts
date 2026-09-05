import { createHash, createHmac } from 'node:crypto'

/**
 * PKCE (RFC 7636) helpers for the auth-code OAuth flow, used by the providers
 * that require Proof Key for Code Exchange (currently monday + vercel; see
 * `OAuthProviderAdapter.usesPkce`).
 *
 * Design decision (spec 06 §U2, DEC-1): the `code_verifier` is NOT stored and
 * NOT randomly generated. It is DERIVED deterministically from the already
 * HMAC-signed `state` string, so the callback can re-derive the exact same
 * verifier from the round-tripped state without any server-side session store.
 *
 *   deriveCodeVerifier(secret, state)
 *     = base64url( HMAC-SHA256(secret, "pkce-verifier:" + state) )
 *
 * The message is domain-separated from the state signature itself: the state
 * signature signs `"${STATE_VERSION}." + payload` (state.ts), while the
 * verifier HMACs `"pkce-verifier:" + <full state string>`. The two message
 * spaces are disjoint (a state string always starts with `v1.`, never with
 * `pkce-verifier:`), so the verifier can never collide with a valid state
 * signature.
 *
 * HMAC-SHA256 is 32 bytes → 43 base64url chars, which satisfies RFC 7636's
 * 43-char minimum verifier length and its `[A-Za-z0-9-._~]` charset (base64url
 * emits only `[A-Za-z0-9-_]`, a strict subset).
 */

const PKCE_VERIFIER_MESSAGE_PREFIX = 'pkce-verifier:'

/**
 * Deterministically derive the PKCE `code_verifier` from the signed OAuth state.
 * Pure: same (secret, state) always yields the same verifier; a different state
 * yields a different verifier. The callback re-derives it from the exact
 * round-tripped state string to reconstruct the verifier at token-exchange time.
 */
export function deriveCodeVerifier(secret: string, state: string): string {
  return createHmac('sha256', secret)
    .update(`${PKCE_VERIFIER_MESSAGE_PREFIX}${state}`)
    .digest('base64url')
}

/**
 * Compute the S256 `code_challenge` for a verifier: base64url(SHA256(verifier)).
 * Anchored on RFC 7636 Appendix B.1 in the unit tests.
 */
export function computeCodeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}
