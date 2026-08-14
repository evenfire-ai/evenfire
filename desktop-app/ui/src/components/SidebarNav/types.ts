import type { ActiveSandboxUiApp, NavItem } from '@/uiTypes'

export type SidebarNavProps = {
  navItem: NavItem
  collapsed: boolean
  activeSandboxUiApp: ActiveSandboxUiApp | null
  availableSandboxUiApps: ActiveSandboxUiApp[]
  onCollapsedChange: (collapsed: boolean) => void
  onOpenSandboxUiApp: (app: ActiveSandboxUiApp) => void
  onSettingsMenuOpenChange?: (open: boolean) => void
  onSelect: (item: NavItem) => void
  toggleRequestId?: number
}
