import type { FileReferenceV1 } from '@clerum/gfs-interaction-policy'
import { GFS_FILE_LIMITS } from '../internalTools/gfsFilePolicy'

export interface GfsReferenceSurfaceCapability {
  readonly metadata: true
  readonly inline: boolean
  readonly workspace: boolean
  readonly localExecutor: boolean
  readonly visual: boolean
}

export interface GfsSurfaceRuntimeCapability {
  readonly workspaceFile: boolean
  readonly localExecutor: boolean
  readonly visual: boolean
}

/**
 * Classify only surfaces proven by producer-owned byte admission and the
 * current Host runtime. Filenames and media types are never evidence.
 */
export function classifyGfsReferenceSurfaces(
  reference: Pick<FileReferenceV1, 'byteLength' | 'reader' | 'modelImageInput'>,
  runtime: GfsSurfaceRuntimeCapability
): GfsReferenceSurfaceCapability {
  const withinSourceLimit = reference.byteLength <= GFS_FILE_LIMITS.maxFileBytes
  const workspace = runtime.workspaceFile && withinSourceLimit
  return {
    metadata: true,
    inline: reference.reader === 'text' && reference.byteLength <= GFS_FILE_LIMITS.inlineTextBytes,
    workspace,
    localExecutor: workspace && runtime.localExecutor,
    visual: reference.modelImageInput === 'candidate' && runtime.visual && withinSourceLimit,
  }
}
