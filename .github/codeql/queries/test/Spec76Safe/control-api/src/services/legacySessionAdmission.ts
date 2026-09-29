export const LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE = 60

export function legacySessionAdmissionBucketKey(subject: string): string {
  return `legacy-session:${subject}`
}
