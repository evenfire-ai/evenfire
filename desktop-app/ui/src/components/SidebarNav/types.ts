import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import type { SidebarResizeControls } from '@hooks/useSidebarResize'
import type { GfsPreviewResource } from '@lib/gfsPreview'
import type { CopyIdFocusRecovery, GfsResourceActionId } from '@lib/gfsResourceActions'
import type { ActiveSandboxUiApp, NavItem, Tone } from '@/uiTypes'

export type CompactMenuCloseFocus = 'preserve-destination-focus'

export type SidebarNavProps = {
  navItem: NavItem
  collapsed: boolean
  compactMode: boolean
  compactMenuOpen: boolean
  /** Preserve focus when this action's destination explicitly owns focus. */
  onCompactMenuOpenChange: (open: boolean, closeFocus?: CompactMenuCloseFocus) => void
  resize?: SidebarResizeControls
  activeSandboxUiApp: ActiveSandboxUiApp | null
  availableSandboxUiApps: ActiveSandboxUiApp[]
  onCollapsedChange: (collapsed: boolean) => void
  onNewChat: () => void
  onOpenSandboxUiApp: (app: ActiveSandboxUiApp) => void
  onSettingsMenuOpenChange?: (open: boolean) => void
  onSelect: (item: NavItem) => void
  /** Open (or focus) a files tab at a folder's gfsUri — the file explorer's
   *  double-click / Enter action on a folder. */
  onOpenFilesSection: (gfsUri: string) => void
  /** Open (or focus) a preview tab — the file explorer's single-click / Enter
   *  action on a previewable file. */
  onOpenPreviewSection: (preview: GfsPreviewResource) => void
  /** Dispatch a sidebar action for its exact resource row. */
  onGfsResourceAction?: (
    resource: GfsBrowserChild,
    actionId: GfsResourceActionId,
    file?: File,
    renderedSessionGeneration?: number | null,
    copyIdFocusRecovery?: CopyIdFocusRecovery
  ) => void
  getCopyIdFocusOwner?: (
    resource: GfsBrowserChild,
    sessionGeneration: number | null
  ) => { isCurrent: () => boolean } | undefined
  /** Transient feedback for the file explorer's download fallback. */
  pushToast: (message: string, tone: Tone) => void
  toggleRequestId?: number
}
