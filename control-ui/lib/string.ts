export function toKebabCase(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function toKebabInput(input: string): string {
  const formatted = input
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')

  return formatted.startsWith('-') ? formatted.replace(/^-+/, '') : formatted
}

export function deriveUsernameFromEmail(email: string): string {
  const localPart = email.split('@')[0] || ''
  const username = localPart.toLowerCase().replace(/[^a-z0-9]/g, '')
  return username || 'admin'
}
