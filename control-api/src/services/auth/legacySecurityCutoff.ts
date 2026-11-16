/**
 * The V1 security cutoff rule, defined once as the TypeScript comparator.
 *
 * A V1 session token is rejected when its whole-second `iat` is at or before
 * external_user_session_security_epochs.valid_after, compared as an exact
 * instant. Live security events store the second before the event; the
 * lifecycle generation bumped in the same transaction rejects tokens of the
 * previous generation issued in the event's own second. The historical
 * password backfill stores password_set_at, which had no generation bump, so
 * the whole second of that change is rejected.
 *
 * For a finite cutoff that a JavaScript Date can hold, pg parses timestamptz
 * to a millisecond Date by truncation; for an integer `iat` that gives the same
 * decision as the exact instant. PostgreSQL also stores infinity and dates
 * beyond the Date range. No writer produces them, and this comparator throws
 * on them instead of deciding.
 */
export function legacySecurityCutoffRejects(
  issuedAtSeconds: number,
  validAfter: Date | string | null | undefined
): boolean {
  if (validAfter === null || validAfter === undefined) return false
  const cutoffMs = (validAfter instanceof Date ? validAfter : new Date(validAfter)).getTime()
  if (!Number.isFinite(cutoffMs)) throw new Error('invalid V1 security cutoff')
  return issuedAtSeconds * 1000 <= cutoffMs
}
