export const MAX_INVITATION_EMAIL_LENGTH = 320

export function normalizeInvitationEmail(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_INVITATION_EMAIL_LENGTH) return null

  const email = value.trim().toLowerCase()
  let atIndex = -1
  let atCount = 0

  for (let index = 0; index < email.length; index += 1) {
    const character = email[index]
    if (!character || character.trim() === '') return null
    if (character === '@') {
      atIndex = index
      atCount += 1
    }
  }

  if (atCount !== 1 || atIndex <= 0 || atIndex >= email.length - 1) return null

  const domainStart = atIndex + 1
  for (let index = domainStart + 1; index < email.length - 1; index += 1) {
    if (email[index] === '.') return email
  }

  return null
}
