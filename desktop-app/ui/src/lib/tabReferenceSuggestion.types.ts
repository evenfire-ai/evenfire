import type { ComposerGlobalFileReference, ComposerGlobalFolderReference } from '@/uiTypes'
import type { PreviewTabPayload } from './workspaceTabs.types'

/**
 * The location a Files page has resolved: its leaf `gfsUri` and whether it is
 * a file or a folder. `null` at the virtual root or once the page unmounts.
 */
export type FilesResolvedLocation = { gfsUri: string; kind: 'file' | 'directory' } | null

/**
 * What the active tab points at, and the key its prefetch is cached under:
 * a file, or the folder Files is open on. `gfsUri` is always in the canonical
 * `gfs://<drive>/<rid>` form. A file target carries no `kind`, so its shape
 * is the same whether or not folders are offered.
 */
export type TabReferenceTarget =
  | { kind?: undefined; gfsUri: string; prefetchKey: string }
  | { kind: 'folder'; gfsUri: string; prefetchKey: string }

/** A reference the active tab offers to the chat composer. */
export type SuggestedReference = ComposerGlobalFileReference | ComposerGlobalFolderReference

/**
 * Observed changes of whichever file was the target when each one arrived. It
 * is not per file and never goes down, so a file's key cannot come back to a
 * value it had before a change, even after visiting other targets.
 */
export type TabReferenceRevision = number

/** What the active tab shows from GFS while its own route is on screen. */
export type ShownTabLocation =
  | { kind: 'preview'; preview: PreviewTabPayload }
  | { kind: 'files'; location: NonNullable<FilesResolvedLocation> }
