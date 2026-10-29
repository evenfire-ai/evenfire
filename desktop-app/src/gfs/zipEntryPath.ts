/**
 * ZIP entry-path SAFETY rules (folder-zip export), shared by the renderer
 * (which sanitizes the names it builds) and the main process (which REJECTS
 * any name that could escape the extraction directory).
 *
 * The main process is the trust boundary: the renderer is a web page in an
 * Electron window, so a compromised or buggy renderer must not be able to
 * write outside the directory the user chose. Every rule below is therefore
 * enforced on the MAIN side before a single byte of entry data is written
 * (R3-M1); the renderer's sanitizer is a convenience, not the guarantee.
 *
 * Pure TS, no Electron/DOM: safe to import from either bundle.
 */

/**
 * Windows reserved device basenames. A file called `NUL`, `CON` or `COM1` is
 * the console device, not a file: extracting such an archive on Windows either
 * fails or writes to the device. The basename is the part BEFORE the first
 * dot, so `CON.txt` is reserved too — the extension does not make it safe.
 */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
])

/** The basename of a path segment: everything before the FIRST dot. */
function deviceBaseName(segment: string): string {
  const dot = segment.indexOf('.')
  const base = dot >= 0 ? segment.slice(0, dot) : segment
  return base.toUpperCase()
}

/** True when `segment` names a Windows device and cannot be extracted there. */
export function isReservedWindowsDeviceName(segment: string): boolean {
  if (!segment) return false
  return WINDOWS_RESERVED_DEVICE_NAMES.has(deviceBaseName(segment))
}

/**
 * The naming policy for reserved device names: prefix the segment with `_`
 * (`CON` -> `_CON`, `nul.txt` -> `_nul.txt`). The result is an ordinary name
 * on every supported platform, so the archive extracts on Windows instead of
 * failing or touching a device.
 */
export function escapeReservedWindowsDeviceName(segment: string): string {
  if (!segment || !isReservedWindowsDeviceName(segment)) return segment
  return `_${segment}`
}

/** Characters Windows forbids in a path segment. */
const WINDOWS_FORBIDDEN_CHARACTERS = /[:*?"<>|]/

/** Control characters (including NUL and DEL) are never legal in a name. */
// eslint-disable-next-line no-control-regex -- the point is to REJECT control characters.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/**
 * Validates a renderer-supplied ZIP entry name. Returns `null` when the name
 * is safe to write, or a short human-readable reason when it is not.
 *
 * The name must be a CANONICAL RELATIVE path: `/`-separated, no empty
 * segment, no `.`/`..` segment, no rooted or drive-qualified prefix, and no
 * segment that a portable extractor could interpret as something other than a
 * plain name.
 */
export function validateZipEntryPath(name: string): string | null {
  if (!name) return 'entry name is empty'
  if (CONTROL_CHARACTERS.test(name)) return 'entry name contains a control character'
  if (name.includes('\\')) return 'entry name contains a backslash'
  if (name.startsWith('/')) return 'entry name is a rooted path'
  if (/^[A-Za-z]:/.test(name)) return 'entry name is a drive-qualified path'

  const segments = name.split('/')
  for (const segment of segments) {
    if (!segment) return 'entry name contains an empty path segment'
    if (segment === '.' || segment === '..') return 'entry name contains a traversal segment'
    if (WINDOWS_FORBIDDEN_CHARACTERS.test(segment))
      return 'entry name contains a character Windows forbids'
    if (/[ .]$/.test(segment)) return 'entry name segment ends with a dot or a space'
    if (isReservedWindowsDeviceName(segment))
      return 'entry name segment is a reserved Windows device name'
  }
  return null
}
