import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react'
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
  /** Double-click / Enter on a folder → open (or focus) its files tab. */
  onOpenFolder: (gfsUri: string) => void
  /** Single-click / Enter on a previewable file → open (or focus) its preview tab. */
  onOpenPreview: (preview: GfsPreviewResource) => void
  /** Transient success/error feedback for the download fallback. */
  pushToast: (message: string, tone: Tone) => void
}

export interface FileExplorerNodeProps {
  node: GfsBrowserChild
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
  isExpanded: boolean
  /** Display name of the active drag's source, for reason copy that names it. */
  dragSourceName?: string | null
  onToggle: (resourceId: string) => void
  onActivateFolder: (node: GfsBrowserChild) => void
  onActivateFile: (node: GfsBrowserChild) => void
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
  /** Register the current node's keyboard action with the Ant Design Tree host. */
  registerKeyboardHandler: (
    resourceId: string,
    handler: (event: ReactKeyboardEvent<HTMLElement>) => void
  ) => () => void
  registerTreeNode: (metadata: FileExplorerTreeNodeMeta) => () => void
}

export interface FileExplorerNodeHandlers {
  onClick: (event: ReactMouseEvent<HTMLElement>) => void
  onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => void
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onDragEnterOrOver: (event: ReactDragEvent<HTMLElement>) => void
  onDragLeave: (event: ReactDragEvent<HTMLElement>, rowElement: HTMLElement | null) => void
  onDrop: (event: ReactDragEvent<HTMLElement>) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
}

export interface FileExplorerTreeNodeMeta {
  resourceNode: GfsBrowserChild
  rowHandlers: FileExplorerNodeHandlers
  dragEnabled: boolean
}
