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
  actionRequest?: {
    id: number
    action: 'refresh' | 'back-to-apps'
  } | null
  boundsRefreshKey?: string | number
  currentTeamId?: string
  headerShellOverlayOpen?: boolean
  sidebarShellOverlayOpen?: boolean
  toastShellOverlayOpen?: boolean
  deepLinkShellOverlayOpen?: boolean
  shortcutApp?: ActiveSandboxUiApp | null
  shortcutOpenRequestId?: number
  localSearchRequestId?: number
  titlebarLeadingContainer?: HTMLElement | null
  onEmbeddedAppOpening?: (app: ActiveSandboxUiApp) => void
  onEmbeddedAppMounted?: () => void
  onEmbeddedAppBack?: () => void
  onEmbeddedAppRemoved?: () => void
  onEmbedBoundsApplied?: () => void
  onEmbedSlotTopChange?: (topPx: number) => void
  onEmbedSlotRightChange?: (rightPx: number) => void
  onNotify?: (message: string, tone: Tone) => void
  onShortcutOpenResult?: (
    requestId: number,
    result: SandboxUiShortcutOpenResult
  ) => void | Promise<void>
}
