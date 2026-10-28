const RESERVED_NAMES = new Set(['users', 'shared', 'system', 'org', 'admin', 'root', 'public'])
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Normalize before reserving a storage name; the result contains only ASCII. */
export function normalizeUserHomeName(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[\s\p{Z}/\\]+/gu, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
}

/** Used by both automatic reservation and operator-provided retry names. */
export function isValidUserHomeName(name: string, userId: string): boolean {
  if (!name || Buffer.byteLength(name, 'utf8') > 64 || normalizeUserHomeName(name) !== name) {
    return false
  }
  if (RESERVED_NAMES.has(name)) return false
  return !UUID_SHAPE.test(name) || name === userId.toLowerCase()
}

/** Candidates are ordered so the UUID always remains available to its owner. */
export function userHomeNameCandidates(user: {
  id: string
  name: string | null
  email: string
}): string[] {
  const userId = user.id.toLowerCase()
  const displayName = normalizeUserHomeName(user.name ?? '')
  const emailName = normalizeUserHomeName(user.email.split('@', 1)[0] ?? '')
  const base = (displayName.length >= 2 ? displayName : emailName.length >= 2 ? emailName : '')
    .slice(0, 48)
    .replace(/[.-]+$/g, '')
  const candidates = base
    ? [base, `${base}-${userId.replace(/-/g, '').slice(0, 8)}`, userId]
    : [userId]
  return [...new Set(candidates.filter(candidate => isValidUserHomeName(candidate, userId)))]
}
