/**
 * Real-Postgres suites are intentionally opt-in for the ordinary unit matrix.
 * A gate that explicitly requests them must never turn a missing DSN into a
 * green run with skipped files.
 */
if (
  process.env.CONTROL_API_REAL_PG_REQUIRED === '1' &&
  !process.env.CONTROL_API_REAL_PG_ADMIN_URL
) {
  throw new Error('CONTROL_API_REAL_PG_ADMIN_URL is required when CONTROL_API_REAL_PG_REQUIRED=1')
}
