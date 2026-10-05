export type ActionAuthorityLifetime = Readonly<{
  sourceIssuedAt: number
  sourceExpiresAt: number
}>

export type BoundedTokenLifetime = Readonly<{
  issuedAt?: number
  expiresInSeconds: number
}>

/**
 * Attenuate a child JWT to the configured lifetime and its source authority.
 * The explicit iat keeps the signed expiry aligned with the remaining-source
 * calculation even if signing crosses a wall-clock second boundary.
 */
export function boundedActionAuthorityTokenLifetime(
  configuredTtlSeconds: number,
  authority?: ActionAuthorityLifetime,
  nowSeconds = Math.floor(Date.now() / 1_000)
): BoundedTokenLifetime {
  if (!Number.isSafeInteger(configuredTtlSeconds) || configuredTtlSeconds < 1) {
    throw new Error('token_lifetime_invalid')
  }
  if (!authority) return Object.freeze({ expiresInSeconds: configuredTtlSeconds })
  if (
    !Number.isSafeInteger(authority.sourceIssuedAt) ||
    !Number.isSafeInteger(authority.sourceExpiresAt) ||
    authority.sourceExpiresAt <= authority.sourceIssuedAt ||
    authority.sourceIssuedAt > nowSeconds
  ) {
    throw new Error('action_authority_invalid')
  }
  const remainingSourceSeconds = authority.sourceExpiresAt - nowSeconds
  if (remainingSourceSeconds < 1) throw new Error('action_authority_expired')
  return Object.freeze({
    issuedAt: nowSeconds,
    expiresInSeconds: Math.min(configuredTtlSeconds, remainingSourceSeconds),
  })
}
