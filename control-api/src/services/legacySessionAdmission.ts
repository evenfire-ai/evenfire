export const LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE = 60

/** The bucket deliberately excludes route, Host, recipe, team and token identifiers. */
export function legacySessionAdmissionBucketKey(subject: string): string {
  return `legacy-session:${subject}`
}
