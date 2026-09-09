export const GFS_RESOURCE_NAME_MAX_LENGTH = 255
const GFS_RESOURCE_NAME_HASH_LENGTH = 12
const GFS_RESOURCE_EXTENSION_MAX_LENGTH = 48

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function extensionOf(name: string): string {
  const lastDot = name.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === name.length - 1) return ''
  const extension = name.slice(lastDot)
  return extension.length <= GFS_RESOURCE_EXTENSION_MAX_LENGTH ? extension : ''
}

function truncatedBaseForSuffix(base: string, suffix: string): string {
  const maxBaseLength = GFS_RESOURCE_NAME_MAX_LENGTH - suffix.length
  if (maxBaseLength <= 0) throw new Error('Could not create a unique GFS resource name.')
  const truncatedBase = base.slice(0, maxBaseLength).replace(/[\s._-]+$/g, '')
  return truncatedBase || base.slice(0, maxBaseLength)
}

/**
 * Returns the first available sibling name using the familiar `(1)`, `(2)`
 * suffix convention. The extension stays at the end and the result remains
 * within the same limit as normalizeGfsResourceName.
 * Precondition: `name` has already passed through normalizeGfsResourceName.
 */
export function nextAvailableGfsResourceName(
  name: string,
  occupiedNames: Iterable<string>
): string {
  const normalized = name.normalize('NFC')
  const occupied = new Set(Array.from(occupiedNames, value => value.normalize('NFC')))
  if (!occupied.has(normalized)) return normalized

  const extension = extensionOf(normalized)
  const base = extension ? normalized.slice(0, -extension.length) : normalized
  for (let index = 1; index <= 10_000; index += 1) {
    const suffix = ` (${index})${extension}`
    const candidate = `${truncatedBaseForSuffix(base, suffix)}${suffix}`
    if (!occupied.has(candidate)) return candidate
  }

  throw new Error('Could not create a unique GFS resource name.')
}

export async function normalizeGfsResourceName(name: string): Promise<string> {
  const normalized = name.normalize('NFC')
  if (normalized === '.' || normalized === '..' || /[\/\\\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('File and folder names cannot contain path separators or control characters.')
  }
  if (normalized.length <= GFS_RESOURCE_NAME_MAX_LENGTH) return normalized

  const extension = extensionOf(normalized)
  const base = extension ? normalized.slice(0, -extension.length) : normalized
  const hash = (await sha256Hex(normalized)).slice(0, GFS_RESOURCE_NAME_HASH_LENGTH)
  const suffix = `-${hash}${extension}`
  const safeBase = truncatedBaseForSuffix(base, suffix)

  return `${safeBase}${suffix}`
}
