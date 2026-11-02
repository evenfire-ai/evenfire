/** Lifecycle failures that invalidate session-wide GFS access. */
export const GFS_SESSION_AUTHORITY_ERROR_CODES = [
  'desktop_user_retired',
  'operator_link_inactive',
  'operator_link_invalid',
  'gfs_operator_link_invalid',
] as const
