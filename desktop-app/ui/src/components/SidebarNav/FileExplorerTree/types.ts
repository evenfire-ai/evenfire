import type { DragEvent as ReactDragEvent } from 'react'
import type { GfsBrowserChild, GfsCrumb } from '@hooks/domain/useGfsBrowserController'
import type { GfsPreviewResource } from '@lib/gfsPreview'
import type { GfsDropVerdict } from '@/gfs/dragSession'
import type { Tone } from '@/uiTypes'

/**
 * Actions the sidebar file explorer hands back to the app. A file activates on
 * single-click; a folder opens its files tab on double-click / Enter (its
 * single-click only toggles expand/collapse inside the tree).
 */
export interface FileExplorerTreeProps {
  /** Double-click / Enter on a folder → open (or focus) its files tab at that
   *  `gfsUri`; the "Shared with me" label opens `GFS_SHARED_WITH_ME_LOCATION`. */
  onOpenFolder: (location: string) => void
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
  /** The caller's home root, when one exists. It is a governed root: the server
   *  refuses to move or rename it, so its row is never a drag source and offers
   *  no Move action. */
  homeResourceId: string | null
  expandedIds: ReadonlySet<string>
  /** Render the node as a section of the tree, like "Shared with me": a label
   *  with no toggle or icon whose children are always listed. Activating the
   *  label opens the folder. Used for the caller's own home. */
  section?: boolean
  selectedId: string | null
  /** Resource id currently being moved (freezes drag starts), when a move the
   *  tree itself initiated is in flight. */
  movingResourceId?: string | null
  /** Loaded ancestors of this node, NEAREST-FIRST; drives the drag structure
   *  facts (common-anchor / descendant observations). */
  ancestorIds: readonly (string | null)[]
  /** Same ancestors as crumbs, ROOT-FIRST, for the Move dialog's initial path. */
  ancestorCrumbs: readonly GfsCrumb[]
  /** Live hover verdict for directory nodes (drop feedback). The FULL verdict
   *  is carried — not just its state — so the deny reason reaches the row
   *  (`data-drop-reason`), the tooltip and the announcements (UX matrix §5.1). */
  dropState?: GfsDropVerdict
  /** Verdict map shared with descendant nodes (render feedback only). */
  dropStatesByResourceId: Readonly<Record<string, GfsDropVerdict>>
  /** Display name of the active drag's source, for reason copy that names it. */
  dragSourceName?: string | null
  onToggle: (resourceId: string) => void
  onActivateFolder: (node: GfsBrowserChild) => void
  onActivateFile: (node: GfsBrowserChild) => void
  /** Fail-closed hook: a listing authority error revokes the session. */
  onAuthorityFailure: (message: string) => void
  onNodeDragStart: (
    node: GfsBrowserChild,
    event: ReactDragEvent<HTMLElement>,
    ancestorIds: readonly (string | null)[]
  ) => void
  onNodeDragEnd: () => void
  onNodeDragOver: (
    node: GfsBrowserChild,
    event: ReactDragEvent<HTMLElement>,
    ancestorIds: readonly (string | null)[]
  ) => void
  onNodeDragLeave: (node: GfsBrowserChild, event: ReactDragEvent<HTMLElement>) => void
  onNodeDrop: (
    node: GfsBrowserChild,
    event: ReactDragEvent<HTMLElement>,
    ancestorIds: readonly (string | null)[]
  ) => void
  /** Open the existing Move dialog for this node (row action / Shift+F10). */
  onRequestMove: (node: GfsBrowserChild, ancestorCrumbs: readonly GfsCrumb[]) => void
}
