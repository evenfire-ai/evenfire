import { RFC1123_MAX_LENGTH, isValidK8sName } from './k8sValidation'

export { RFC1123_MAX_LENGTH }

/**
 * A derived slug is server-acceptable only when it is a valid RFC1123 DNS label
 * (non-empty, lowercase alphanumerics + interior hyphens, ≤63 chars). Gates that
 * only checked `toKebabCase(x).length > 0` let e.g. a 70-char name through the
 * client; the server then rejects it (`invalid_name`) after siblings created
 * first are already orphaned. This mirrors the server constraint client-side.
 * Reuses the shared K8s validator (`lib/k8sValidation`).
 */
export function isValidResourceSlug(rawName: string): boolean {
  return isValidK8sName(toKebabCase(rawName))
}

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
