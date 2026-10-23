import type { AuthClaims } from '../../profileTypes.js'

/**
 * A V1 session carries its lifecycle generation. The signer requires it
 * (signExternalSessionToken, since 7fd634e6a), so a token without it is not
 * a current session and maps to null like any other invalid generation.
 */
export function legacyExternalSessionAuthGeneration(
  claims: Pick<AuthClaims, 'authGeneration'>
): number | null {
  return Number.isSafeInteger(claims.authGeneration) && Number(claims.authGeneration) >= 1
    ? Number(claims.authGeneration)
    : null
}
