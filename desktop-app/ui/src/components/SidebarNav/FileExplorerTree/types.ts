import type { DragEvent as ReactDragEvent } from 'react'
import type { GfsHostActionTarget } from '@components/GfsActionHost/types'
import type { GfsResourceMenuPermissionStatus } from '@components/GfsResourceMenu/types'
import type { GfsBrowserChild, GfsCrumb } from '@hooks/domain/useGfsBrowserController'
import type { GfsPreviewResource } from '@lib/gfsPreview'
import type { GfsRowListing } from '@lib/gfsRowActionAvailability.types'
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
  /**
   * The folders currently expanded AND rendered, in the order they appear,
   * as their gfs:// URIs. Reported again on every change and as `[]` when
   * the tree unmounts, so the owner can watch exactly what is on screen.
   */
  onVisibleExpandedFoldersChange?: (gfsUris: string[]) => void
  /**
   * Open-state report of a row's resource menu, for the native-view gate.
   * Reports state only, `false` included when the tree unmounts with it open.
   */
  onGfsMenuOpenChange?: (open: boolean) => void
}

/** Where a row's resource menu opens: a viewport point. */
export interface FileExplorerMenuAnchor {
  x: number
  y: number
}

/**
 * The one open row menu. `token` is minted per opening and keys the menu, so
 * bits read for an earlier opening never reach a later one.
 */
export interface FileExplorerRowMenu {
  token: number
  target: GfsHostActionTarget
  listing: GfsRowListing
  anchor: FileExplorerMenuAnchor
  /** The session the menu opened under; its actions run only while it is live. */
  authority: { scope: string | null; generation: number }
  bits: GfsResourceMenuPermissionStatus
  rowAffordances: { held?: readonly string[] } | null
  parentAffordances: { held?: readonly string[] } | null
}

/** An expanded, rendered folder and its position in the tree (pre-order sibling indices). */
export interface VisibleExpandedFolder {
  gfsUri: string
  order: readonly number[]
}

export interface FileExplorerNodeProps {
  node: GfsBrowserChild
  /** 1-based ARIA depth (`aria-level`). */
  level: number
  /** Sibling index of this node and of each ancestor, root first: its on-screen order. */
  visibleOrder: readonly number[]
  /**
   * An expanded folder reports itself while rendered, and `null` when collapsed
   * or unmounted. `instanceKey` names the rendered copy, not the resource: one
   * folder can appear more than once in the forest.
   */
  onExpandedFolderVisibility: (instanceKey: string, folder: VisibleExpandedFolder | null) => void
  /** Cache-scope key shared with the Files page's TanStack queries. */
  scope: string
  /** Published main-process generation that owns this authority query. */
  sessionGeneration: number | null
  /** Session access is live: gates the per-node children fetch the same way the
   *  controller gates its own children query — a revoked session fetches nothing. */
  accessActive: boolean
  expandedIds: ReadonlySet<string>
  selectedId: string | null
  /** Resource id currently being moved (freezes drag starts), when a move the
   *  tree itself initiated is in flight. */
  movingResourceId?: string | null
  /** Resource the app-level action host is moving; that row cannot be dragged. */
  hostMovingResourceId?: string | null
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
  onAuthorityFailure: (message: string, scope: string, sessionGeneration: number) => void
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
  /** Open this row's resource menu (right-click, the ContextMenu key, Shift+F10). */
  onRequestMenu: (
    node: GfsBrowserChild,
    ancestorIds: readonly (string | null)[],
    ancestorCrumbs: readonly GfsCrumb[],
    anchor: FileExplorerMenuAnchor
  ) => void
}
