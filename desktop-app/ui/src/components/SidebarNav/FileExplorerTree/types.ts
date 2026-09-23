import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import type { GfsPreviewResource } from '@lib/gfsPreview'
import type { Tone } from '@/uiTypes'

/**
 * Actions the sidebar file explorer hands back to the app. A file activates on
 * single-click; a folder opens its files tab on double-click / Enter (its
 * single-click only toggles expand/collapse inside the tree).
 */
export interface FileExplorerTreeProps {
  /** Double-click / Enter on a folder → open (or focus) its files tab. */
  onOpenFolder: (gfsUri: string) => void
  /** Single-click / Enter on a previewable file → open (or focus) its preview tab. */
  onOpenPreview: (preview: GfsPreviewResource) => void
  /** Transient success/error feedback for the download fallback. */
  pushToast: (message: string, tone: Tone) => void
}

export interface FileExplorerNodeProps {
  node: GfsBrowserChild
  /** 1-based ARIA depth (`aria-level`). */
  level: number
  /** Cache-scope key shared with the Files page's TanStack queries. */
  scope: string
  /** Session access is live: gates the per-node children fetch the same way the
   *  controller gates its own children query — a revoked session fetches nothing. */
  accessActive: boolean
  expandedIds: ReadonlySet<string>
  selectedId: string | null
  onToggle: (resourceId: string) => void
  onActivateFolder: (node: GfsBrowserChild) => void
  onActivateFile: (node: GfsBrowserChild) => void
  /** Fail-closed hook: a listing authority error revokes the session. */
  onAuthorityFailure: (message: string) => void
}
