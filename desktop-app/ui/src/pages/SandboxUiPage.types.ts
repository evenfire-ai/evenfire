import type { ActiveSandboxUiApp, Tone } from '@/uiTypes'

export type SandboxUiConversationOrigin = {
  agentName: string
  chatId: string
  title: string
  teamId?: string
}

export type SandboxUiLaunchApp = ActiveSandboxUiApp & {
  ready?: boolean
}

export type SandboxUiShortcutOpenResult =
  | { status: 'mounted' }
  | { status: 'failed'; message: string }

export type SandboxUiPageProps = {
  boundsRefreshKey?: string | number
  conversationOrigin?: SandboxUiConversationOrigin | null
  currentTeamId?: string
  headerShellOverlayOpen?: boolean
  sidebarShellOverlayOpen?: boolean
  toastShellOverlayOpen?: boolean
  shortcutApp?: ActiveSandboxUiApp | null
  shortcutOpenRequestId?: number
  onBackToConversation?: () => void | Promise<void>
  onEmbeddedAppOpening?: (app: ActiveSandboxUiApp) => void
  onEmbeddedAppBack?: () => void
  onEmbeddedAppRemoved?: () => void
  onEmbedBoundsApplied?: () => void
  onNotify?: (message: string, tone: Tone) => void
  onShortcutOpenResult?: (
    requestId: number,
    result: SandboxUiShortcutOpenResult
  ) => void | Promise<void>
}
