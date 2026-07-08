/**
 * Shared encoding utilities.
 *
 * These utilities are used across multiple services (channel-reader, mcp-host).
 * In a future refactoring, these should be moved to a shared npm package.
 */

/**
 * Calculate approximate decoded byte size of a base64 string.
 *
 * This is useful for validating attachment sizes before decoding.
 * Accounts for base64 padding characters.
 *
 * @param base64 - The base64 encoded string
 * @returns Approximate decoded byte count
 *
 * @example
 * ```ts
 * const size = approxDecodedBytes("SGVsbG8gd29ybGQh"); // ≈ 13 bytes
 * ```
 */
export function approxDecodedBytes(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Validate if a base64 string is within size limits.
 *
 * @param base64 - The base64 encoded string
 * @param maxBytes - Maximum allowed decoded bytes
 * @returns true if within limits, false otherwise
 */
export function isValidBase64Size(base64: string, maxBytes: number): boolean {
  return approxDecodedBytes(base64) <= maxBytes;
}
