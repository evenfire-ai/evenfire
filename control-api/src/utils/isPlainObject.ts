/**
 * Narrow an unknown value to a plain object (non-null, non-array). Shared by
 * the plugin-workload-sdk admin and mcp-host routers so request-body shape
 * guarding stays consistent in one place.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
