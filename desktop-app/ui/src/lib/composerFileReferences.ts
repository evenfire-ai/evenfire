import {
  FILE_REFERENCE_MAX_COUNT,
  type FileReferenceV1,
  buildGfsFileReference,
  classifyBytes,
} from '@clerum/gfs-interaction-policy'
import type { ComposerGlobalFileReference, ComposerReferenceAttachment } from '../uiTypes'

/**
 * Builds the structured FileReference v1 for one Global Files selection
 * (#666). The picker lists no media type and no bytes: classification falls
 * back to the name, and a zero-byte selection classifies as empty text;
 * mcp-host resolves the reference against GFS before the model sees it.
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
  const globalFiles = references.filter(
    (reference): reference is ComposerGlobalFileReference => reference.type === 'global_file'
  )
  if (globalFiles.length > FILE_REFERENCE_MAX_COUNT) {
    throw new Error(`A message can reference at most ${FILE_REFERENCE_MAX_COUNT} files.`)
  }
  return globalFiles.map(globalFileReference)
}
