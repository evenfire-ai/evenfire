import type { ActiveSandboxUiApp } from '@/uiTypes'

export type SandboxUiConversationOrigin = {
  agentName: string
  chatId: string
  title: string
}

export type SandboxUiPageProps = {
  boundsRefreshKey?: string | number
  conversationOrigin?: SandboxUiConversationOrigin | null
  headerShellOverlayOpen?: boolean
  sidebarShellOverlayOpen?: boolean
  toastShellOverlayOpen?: boolean
  shortcutApp?: ActiveSandboxUiApp | null
  shortcutOpenRequestId?: number
  onBackToConversation?: () => void
  onEmbeddedAppOpening?: (app: ActiveSandboxUiApp) => void
  onEmbeddedAppBack?: () => void
  onEmbeddedAppRemoved?: () => void
  onEmbedBoundsApplied?: () => void
}
