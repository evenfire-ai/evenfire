import type { PreviewTabPayload } from './workspaceTabs.types'

/**
 * The location a Files page has resolved: its leaf `gfsUri` and whether it is
 * a file or a folder. `null` at the virtual root or once the page unmounts.
 */
export type FilesResolvedLocation = { gfsUri: string; kind: 'file' | 'directory' } | null

/**
 * The file the active tab points at, and the key its prefetch is cached under.
 * `gfsUri` is always in the canonical `gfs://<drive>/<rid>` form.
 */
export type TabReferenceTarget = {
  gfsUri: string
  prefetchKey: string
}

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
