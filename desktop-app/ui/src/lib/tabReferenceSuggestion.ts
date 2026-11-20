import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import { DESKTOP_ROUTES } from '@constants/navigation'
import type { ComposerReferenceAttachment, NavItem } from '@/uiTypes'
import type { GfsWatchEvent } from '../../../src/types'
import { parseGfsWatchKey } from './gfsWatchKeys'
import type {
  FilesResolvedLocation,
  ShownTabLocation,
  TabReferenceRevision,
  TabReferenceTarget,
} from './tabReferenceSuggestion.types'
import type { WorkspaceTab } from './workspaceTabs.types'

/**
 * What the active tab shows from GFS right now: a preview, or the location
 * Files has resolved at its path. The active tab only counts while its own
 * route is shown: an overlay route such as the apps picker keeps the tab active
 * without showing its file. The watch and the suggested reference both read
 * this, so the file the chat offers is always one the window is watching.
 */
export function shownTabLocation(
  activeTab: WorkspaceTab | null | undefined,
  navItem: NavItem,
  filesResolvedLocation: FilesResolvedLocation
): ShownTabLocation | null {
  if (activeTab?.kind === 'preview' && navItem === DESKTOP_ROUTES.preview) {
    return activeTab.preview ? { kind: 'preview', preview: activeTab.preview } : null
  }
  if (activeTab?.kind === 'files' && navItem === DESKTOP_ROUTES.files) {
    const path = activeTab.files?.path ?? null
    // The resolved location lags the tab's path by a commit while Files
    // navigates; until they agree, it describes the previous location.
    if (filesResolvedLocation === null || filesResolvedLocation.gfsUri !== path) return null
    return { kind: 'files', location: filesResolvedLocation }
  }
  return null
}

/**
 * The file the active tab offers as a chat reference, or `null` when it offers
 * none (no file in view, an unavailable preview, a folder, or a URI without a
 * stable rid).
 */
export function deriveTabReferenceTarget(
  activeTab: WorkspaceTab | null | undefined,
  navItem: NavItem,
  filesResolvedLocation: FilesResolvedLocation,
  revision: TabReferenceRevision
): TabReferenceTarget | null {
  const shown = shownTabLocation(activeTab, navItem, filesResolvedLocation)
  if (shown?.kind === 'preview') {
    const preview = shown.preview
    if (preview.unavailable) return null
    const gfsUri = normalizeGfsResourceUri(preview.gfsUri)
    if (!gfsUri) return null
    // A preview already re-keys on every observed change through
    // `reloadVersion`, so the watch revision is not part of its key.
    return {
      gfsUri,
      prefetchKey: `${gfsUri}#${preview.reloadVersion ?? 0}#${preview.resourceVersion ?? ''}`,
    }
  }
  if (shown?.kind === 'files') {
    if (shown.location.kind !== 'file') return null
    const gfsUri = normalizeGfsResourceUri(shown.location.gfsUri)
    if (!gfsUri) return null
    return { gfsUri, prefetchKey: `${gfsUri}#r${revision}` }
  }
  return null
}

/**
 * Whether the composer already references the file at `gfsUri`. Files are told
 * apart by their normalized URI, never by the reference id: the picker and a
 * resend build different ids for the same file.
 */
export function isGlobalFileReferenced(
  references: readonly ComposerReferenceAttachment[],
  gfsUri: string
): boolean {
  const target = normalizeGfsResourceUri(gfsUri)
  if (target === null) return false
  return references.some(
    reference =>
      reference.type === 'global_file' && normalizeGfsResourceUri(reference.gfsUri) === target
  )
}

/** The Global Files references a message would carry, the kind the file cap counts. */
export function countGlobalFileReferences(
  references: readonly ComposerReferenceAttachment[]
): number {
  return references.filter(reference => reference.type === 'global_file').length
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
