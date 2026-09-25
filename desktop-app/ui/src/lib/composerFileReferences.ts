import {
  type FileReferenceV1,
  buildGfsFileReference,
  classifyBytes,
} from '@clerum/gfs-interaction-policy'
import type { ComposerGlobalFileReference, ComposerReferenceAttachment } from '../uiTypes'

/**
 * Builds the structured FileReference v1 for one Global Files selection
 * (#666). The picker lists no media type and no bytes, so the class comes
 * from the file name alone (`detection: 'declared'`); mcp-host resolves the
 * reference against GFS before the model sees it.
 */
function globalFileReference(reference: ComposerGlobalFileReference): FileReferenceV1 {
  const built = buildGfsFileReference({
    drive: reference.drive,
    resourceId: reference.resourceId,
    gfsUri: reference.gfsUri,
    version: reference.version,
    name: reference.label,
    declaredMediaType: null,
    byteLength: reference.bytes,
    classification: classifyBytes({
      bytes: new Uint8Array(0),
      totalByteLength: reference.bytes,
      declaredMediaType: null,
      filename: reference.label,
    }),
  })
  if (!built.ok) {
    throw new Error(`Global file reference is invalid (${built.code}): ${built.message}`)
  }
  return built.value
}

export function buildComposerFileReferences(
  references: ComposerReferenceAttachment[]
): FileReferenceV1[] {
  return references
    .filter(
      (reference): reference is ComposerGlobalFileReference => reference.type === 'global_file'
    )
    .map(globalFileReference)
}
