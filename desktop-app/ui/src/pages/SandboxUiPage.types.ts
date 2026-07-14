import type { ActiveSandboxUiApp } from '@/uiTypes'

export type SandboxUiPageProps = {
  boundsRefreshKey?: string | number
  headerShellOverlayOpen?: boolean
  sidebarShellOverlayOpen?: boolean
  shortcutApp?: ActiveSandboxUiApp | null
  shortcutOpenRequestId?: number
  onEmbeddedAppOpening?: (app: ActiveSandboxUiApp) => void
  onEmbeddedAppBack?: () => void
  onEmbeddedAppRemoved?: () => void
}
