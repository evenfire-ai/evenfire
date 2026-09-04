import type { AuthClaims } from '../../profileTypes.js'

/** Missing generation is the original deployed V1 lifecycle incarnation only. */
export function legacyExternalSessionAuthGeneration(
  claims: Pick<AuthClaims, 'authGeneration'>
): number | null {
  if (claims.authGeneration === undefined) return 1
  return Number.isSafeInteger(claims.authGeneration) && Number(claims.authGeneration) >= 1
    ? Number(claims.authGeneration)
    : null
}
