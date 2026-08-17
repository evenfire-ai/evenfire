/**
 * Real-Postgres suites remain opt-in for the normal unit matrix, but an
 * explicit T1 gate must fail rather than silently report a skipped suite.
 */
if (
  process.env.CONTROL_API_REAL_PG_REQUIRED === '1' &&
  !process.env.CONTROL_API_REAL_PG_ADMIN_URL
) {
  throw new Error(
    'CONTROL_API_REAL_PG_ADMIN_URL is required when CONTROL_API_REAL_PG_REQUIRED=1'
  )
}
