export const MAX_INVITATION_EMAIL_LENGTH = 320

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeInvitationEmail(value: unknown): string | null {
  // The length bound comes first: EMAIL_PATTERN alone accepts longer addresses.
  if (typeof value !== 'string' || value.length > MAX_INVITATION_EMAIL_LENGTH) return null

  const email = value.trim().toLowerCase()
  return EMAIL_PATTERN.test(email) ? email : null
}
