import type { InternalToolResult } from './types'

/** Workflow records and prompts share this explicit nonvisual projection. */
export function projectInternalToolResult(result: InternalToolResult): InternalToolResult {
  if (!result.success) return { success: false, error: result.error }
  const projected: InternalToolResult = { success: true }
  if (result.content !== undefined) projected.content = result.content
  if (result.artifact) {
    const { name, format, path, sizeBytes, createdAt } = result.artifact
    projected.artifact = { name, format, path, sizeBytes, createdAt }
  }
  if (result.images?.length) {
    // A consumer that cannot deliver image parts must never claim image delivery.
    projected.content = JSON.stringify({
      delivery: 'reference_only',
      reason: 'image_input_unavailable_in_workflow',
      resources: result.images.map(({ source, mimeType, sizeBytes, width, height }) => ({
        source: {
          kind: source.kind,
          drive: source.drive,
          resourceId: source.resourceId,
          gfsUri: source.gfsUri,
          version: source.version,
          name: source.name,
        },
        mimeType,
        sizeBytes,
        width,
        height,
      })),
    })
  }
  return projected
}
