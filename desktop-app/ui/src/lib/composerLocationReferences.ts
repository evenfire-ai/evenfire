import {
  LOCATION_REFERENCE_MAX_COUNT,
  type LocationReferenceV1,
  buildGfsLocationReference,
} from '@clerum/gfs-interaction-policy'
import { LOCATION_REFERENCE_LIMIT_REASON } from '@constants/tabReferenceSuggestion'
import type { ComposerGlobalFolderReference, ComposerReferenceAttachment } from '../uiTypes'

function globalFolderReference(reference: ComposerGlobalFolderReference): LocationReferenceV1 {
  const built = buildGfsLocationReference({
    drive: reference.drive,
    resourceId: reference.resourceId,
    gfsUri: reference.gfsUri,
    name: reference.label,
  })
  if (!built.ok) {
    throw new Error(`Global folder reference is invalid (${built.code}): ${built.message}`)
  }
  return built.value
}

/**
 * The structured LocationReference v1 of the folders a message is about.
 * mcp-host resolves each one against GFS before the model sees it.
 */
export function buildComposerLocationReferences(
  references: ComposerReferenceAttachment[]
): LocationReferenceV1[] {
  const folders = references.filter(
    (reference): reference is ComposerGlobalFolderReference => reference.type === 'global_folder'
  )
  if (folders.length > LOCATION_REFERENCE_MAX_COUNT) {
    throw new Error(`${LOCATION_REFERENCE_LIMIT_REASON}.`)
  }
  return folders.map(globalFolderReference)
}
