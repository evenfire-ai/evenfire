import type { EmbedOwnershipMachine } from '@lib/embedOwnershipMachine.types'
import type { ActiveSandboxUiApp, Tone } from '@/uiTypes'

export type SandboxUiConversationOrigin = {
  agentName: string
  chatId: string
  title: string
  teamId?: string
}

export type SandboxUiRefreshError = { launchId: string; message: string }

export type SandboxUiPageProps = {
  /** Who owns the embed: the page paints its state and measures the slot for it. */
  embed: EmbedOwnershipMachine
  /** The app of the active app tab, naming a failed launch in its banner. */
  activeAppRef?: string | null
  /** The latest session refresh failure of the launch that owned the embed when it arrived. */
  refreshError?: SandboxUiRefreshError | null
  boundsRefreshKey?: string | number
  currentTeamId?: string
  headerShellOverlayOpen?: boolean
  sidebarShellOverlayOpen?: boolean
  toastShellOverlayOpen?: boolean
  deepLinkShellOverlayOpen?: boolean
  localSearchRequestId?: number
  titlebarLeadingContainer?: HTMLElement | null
  // The picker grid hands the chosen app to the owner instead of opening it
  // itself, so every embed is opened against a workspace tab that owns it.
  onLaunchApp: (app: ActiveSandboxUiApp) => void
  /** Refreshes the content of the active tab's app (Refresh). */
  onRefresh?: () => void
  /** Tears the active tab's view down and opens a fresh one (Reopen, Retry). */
  onRelaunch?: () => void
  onEmbedBoundsApplied?: () => void
  onEmbedSlotTopChange?: (topPx: number) => void
  onEmbedSlotRightChange?: (rightPx: number) => void
  onNotify?: (message: string, tone: Tone) => void
}
