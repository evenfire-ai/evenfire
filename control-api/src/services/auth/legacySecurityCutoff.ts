/**
 * The V1 security cutoff rule, defined once for the TypeScript and SQL
 * comparators.
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
 * to a millisecond Date by truncation and SQL compares the exact numeric
 * epoch; for an integer `iat` both give the same decision. PostgreSQL also
 * stores infinity and dates beyond the Date range. No writer produces them,
 * and the TypeScript form throws on them instead of deciding.
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

/**
 * SQL form of legacySecurityCutoffRejects. Both arguments are constant SQL
 * expressions written at the call site, never request input.
 */
export function legacySecurityCutoffRejectsSql(
  issuedAtSecondsSql: string,
  validAfterSql: string
): string {
  return `${issuedAtSecondsSql} <= EXTRACT(EPOCH FROM ${validAfterSql})`
}
