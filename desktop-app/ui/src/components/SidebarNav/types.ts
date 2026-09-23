import type { GfsPreviewResource } from '@lib/gfsPreview'
import type { ActiveSandboxUiApp, NavItem, Tone } from '@/uiTypes'

export type SidebarNavProps = {
  navItem: NavItem
  collapsed: boolean
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
  /** Transient feedback for the file explorer's download fallback. */
  pushToast: (message: string, tone: Tone) => void
  toggleRequestId?: number
}
