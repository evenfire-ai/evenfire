export const MAX_INVITATION_EMAIL_LENGTH = 320

export function isInvitationEmailFormatValid(value: string): boolean {
  if (value.length > MAX_INVITATION_EMAIL_LENGTH) return false

  const email = value.trim()
  let atIndex = -1
  let atCount = 0

  for (let index = 0; index < email.length; index += 1) {
    const character = email[index]
    if (!character || character.trim() === '') return false
    if (character === '@') {
      atIndex = index
      atCount += 1
    }
  }

  if (atCount !== 1 || atIndex <= 0 || atIndex >= email.length - 1) return false

  const domainStart = atIndex + 1
  for (let index = domainStart + 1; index < email.length - 1; index += 1) {
    if (email[index] === '.') return true
  }

  return false
}
