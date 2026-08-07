const ROUTE_CONTROL_OR_SEPARATOR = /[/\\\u0000-\u001f\u007f]/
const WINDOWS_INVALID_FILENAME_CHARACTER = /[<>:"|?*]/
const WINDOWS_RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export interface SafeRouteSegmentOptions {
  maxLength?: number
  allowColon?: boolean
}

/**
 * Keep desktop-side route validation aligned with rpc-proxy and mcp-host.
 * Encoding a segment is not sufficient: control characters still create
 * ambiguous logs and overlong values are rejected by the upstream services.
 */
export function assertSafeRouteSegment(
  label: string,
  value: string,
  options: SafeRouteSegmentOptions = {}
): void {
  const maxLength = options.maxLength ?? 500
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.length > maxLength ||
    ROUTE_CONTROL_OR_SEPARATOR.test(value) ||
    (options.allowColon === false && value.includes(':'))
  ) {
    throw new Error(`Invalid ${label}: unsafe path segment`)
  }
}

/**
 * Validate a value before using it as a directory or file-name component.
 * These rules intentionally use the Windows-compatible subset so a cache made
 * on one platform remains portable and cannot alias device names or trimmed
 * trailing characters on another.
 */
export function assertSafeFilesystemSegment(
  label: string,
  value: string,
  options: { reservedNames?: readonly string[] } = {}
): void {
  assertSafeRouteSegment(label, value, { maxLength: 200, allowColon: false })
  const normalized = value.toLowerCase()
  if (
    value.startsWith('.') ||
    /[ .]$/.test(value) ||
    WINDOWS_INVALID_FILENAME_CHARACTER.test(value) ||
    WINDOWS_RESERVED_FILENAME.test(value) ||
    options.reservedNames?.some(name => normalized === name.toLowerCase())
  ) {
    throw new Error(`Invalid ${label}: unsafe path segment`)
  }
}
