import type { GfsDriveResource } from '../pages/FilesPage.types'
import { gfsImagePreviewMimeType } from './gfsImagePreview'
import { isGfsMarkdownPreviewFile } from './gfsMarkdownPreview'
import { gfsVideoPreviewMimeType } from './gfsVideoPreview'

/**
 * The minimal shape a preview surface needs to render a GFS file, tagged by the
 * `kind` it was detected as. Lives here (not in `FilesPage.types.ts`) so BOTH
 * the files browser (spec 18 S1) and the sidebar file tree (S2) build the same
 * descriptor from the same detection rule — there is one place that decides
 * "previewable, and as what" (spec 18 §3.B.2).
 */
export type GfsPreviewResource = Pick<GfsDriveResource, 'bytes' | 'gfsUri' | 'name'> &
  Partial<Pick<GfsDriveResource, 'version'>> &
  ({ kind: 'image'; mimeType: string } | { kind: 'markdown' } | { kind: 'video'; mimeType: string })

/**
 * Decide whether a resource is previewable and, if so, as which kind — the
 * single source of the preview-vs-download branch (spec 18 §3.B.2). Detection is
 * by file extension via the existing per-kind helpers; the precedence
 * (image → markdown → video) matches the modal-era `openFilePreview` it
 * replaces. Returns `null` for anything with no inline preview (the caller
 * falls back to download).
 */
export function resolveGfsPreview(
  resource: Pick<GfsDriveResource, 'bytes' | 'gfsUri' | 'name'> &
    Partial<Pick<GfsDriveResource, 'version'>>
): GfsPreviewResource | null {
  const imageMimeType = gfsImagePreviewMimeType(resource.name)
  if (imageMimeType) {
    return {
      gfsUri: resource.gfsUri,
      kind: 'image',
      mimeType: imageMimeType,
      name: resource.name,
      bytes: resource.bytes,
      ...(resource.version !== undefined ? { version: resource.version } : {}),
    }
  }
  if (isGfsMarkdownPreviewFile(resource.name)) {
    return {
      gfsUri: resource.gfsUri,
      kind: 'markdown',
      name: resource.name,
      bytes: resource.bytes,
      ...(resource.version !== undefined ? { version: resource.version } : {}),
    }
  }
  const videoMimeType = gfsVideoPreviewMimeType(resource.name)
  if (videoMimeType) {
    return {
      gfsUri: resource.gfsUri,
      kind: 'video',
      mimeType: videoMimeType,
      name: resource.name,
      bytes: resource.bytes,
      ...(resource.version !== undefined ? { version: resource.version } : {}),
    }
  }
  return null
}

/** Extension-only previewability check (no bytes/gfsUri needed) — the gate for
 *  "show the Preview affordance" on a row/menu. Mirrors `resolveGfsPreview`. */
export function isGfsPreviewFile(fileName: string): boolean {
  return (
    gfsImagePreviewMimeType(fileName) !== null ||
    isGfsMarkdownPreviewFile(fileName) ||
    gfsVideoPreviewMimeType(fileName) !== null
  )
}

export type GfsResourceOpenTarget =
  | { kind: 'preview'; preview: GfsPreviewResource }
  | { kind: 'files'; gfsUri: string }

/**
 * Where a resolved GFS resource opens inside the app: previewable files in a
 * preview, everything else (folders, non-previewable files) in the files
 * browser at the resolved `gfsUri`.
 */
export function gfsResourceOpenTarget(resource: {
  gfsUri: string
  name: string
  kind: string
  bytes?: number | null
  version?: number
}): GfsResourceOpenTarget {
  // Only a file can be previewable: a folder named `notes.md` still opens in the browser.
  const preview =
    resource.kind === 'file'
      ? resolveGfsPreview({
          gfsUri: resource.gfsUri,
          name: resource.name,
          bytes: resource.bytes ?? 0,
          version: resource.version,
        })
      : null
  return preview ? { kind: 'preview', preview } : { kind: 'files', gfsUri: resource.gfsUri }
}
