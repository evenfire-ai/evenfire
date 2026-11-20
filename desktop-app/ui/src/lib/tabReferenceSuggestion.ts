import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import { DESKTOP_ROUTES } from '@constants/navigation'
import type { NavItem } from '@/uiTypes'
import type { GfsWatchEvent } from '../../../src/types'
import { parseGfsWatchKey } from './gfsWatchKeys'
import type {
  FilesResolvedLocation,
  TabReferenceRevision,
  TabReferenceTarget,
} from './tabReferenceSuggestion.types'
import type { WorkspaceTab } from './workspaceTabs.types'

/**
 * The file the active tab offers as a chat reference, or `null` when it offers
 * none (no file in view, an unavailable preview, or a URI without a stable rid).
 * The active tab only counts while its own route is shown: an overlay route
 * such as the apps picker keeps the tab active without showing its file.
 */
export function deriveTabReferenceTarget(
  activeTab: WorkspaceTab | null | undefined,
  navItem: NavItem,
  filesResolvedLocation: FilesResolvedLocation,
  revision: TabReferenceRevision
): TabReferenceTarget | null {
  if (activeTab?.kind === 'preview' && navItem === DESKTOP_ROUTES.preview) {
    const preview = activeTab.preview
    if (!preview || preview.unavailable) return null
    const gfsUri = normalizeGfsResourceUri(preview.gfsUri)
    if (!gfsUri) return null
    // A preview already re-keys on every observed change through
    // `reloadVersion`, so the watch revision is not part of its key.
    return {
      gfsUri,
      prefetchKey: `${gfsUri}#${preview.reloadVersion ?? 0}#${preview.resourceVersion ?? ''}`,
    }
  }
  if (activeTab?.kind === 'files' && navItem === DESKTOP_ROUTES.files) {
    const path = activeTab.files?.path ?? null
    // The resolved location lags the tab's path by a commit while Files
    // navigates; until they agree, its kind describes the previous location.
    if (
      filesResolvedLocation === null ||
      filesResolvedLocation.gfsUri !== path ||
      filesResolvedLocation.kind !== 'file'
    ) {
      return null
    }
    const gfsUri = normalizeGfsResourceUri(filesResolvedLocation.gfsUri)
    if (!gfsUri) return null
    return { gfsUri, prefetchKey: `${gfsUri}#r${revision}` }
  }
  return null
}

/**
 * The file URIs a watch event reports as changed. A `rejected` key was refused
 * by the server, so it carries no news about the file and yields nothing.
 */
export function fileUrisOfWatchEvent(event: GfsWatchEvent): string[] {
  if (event.type !== 'changed' && event.type !== 'resync') return []
  const uris = new Set<string>()
  for (const key of event.keys) {
    const parts = parseGfsWatchKey(key)
    if (parts?.kind === 'file') uris.add(`gfs://${parts.drive}/${parts.rid}`)
  }
  return Array.from(uris)
}

/**
 * Count an observed change of `uri` if it is the current target. The count is
 * shared by every target on purpose: a per-file count that restarts would let
 * a file come back to a key it already had before it changed.
 */
export function bumpRevision(
  revision: TabReferenceRevision,
  uri: string,
  targetGfsUri: string | null
): TabReferenceRevision {
  const gfsUri = normalizeGfsResourceUri(uri)
  return gfsUri !== null && gfsUri === targetGfsUri ? revision + 1 : revision
}
