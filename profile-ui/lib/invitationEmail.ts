export const MAX_INVITATION_EMAIL_LENGTH = 320

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isInvitationEmailFormatValid(value: string): boolean {
  // The length bound comes first: EMAIL_PATTERN alone accepts longer addresses.
  if (value.length > MAX_INVITATION_EMAIL_LENGTH) return false

  return EMAIL_PATTERN.test(value.trim())
}
