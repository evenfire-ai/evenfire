/**
 * Delays before the second and the third resolve of one suggested-reference
 * key. Three failures in a row end the attempts for that key.
 */
export const TAB_REFERENCE_RETRY_DELAYS_MS = [2_000, 8_000] as const
