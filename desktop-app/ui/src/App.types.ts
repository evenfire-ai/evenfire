import type { SandboxUiDeepLinkEnvelope } from '@clerum/desktop-app-links'
import type { SandboxUiConversationOrigin } from '@pages/SandboxUiPage.types'
import type { ActiveSandboxUiApp } from '@/uiTypes'

export type { SandboxUiDeepLinkEnvelope } from '@clerum/desktop-app-links'

export type PendingSandboxUiDeepLink = {
  link: SandboxUiDeepLinkEnvelope
  conversationOrigin: SandboxUiConversationOrigin | null
  receivedIdentity: string | null
  confirmedIdentity?: string | null
  retryCount?: number
  nextRetryAt?: number
  failedMessage?: string
}

/**
 * Which launch a gesture asks for once its commit landed. `activeTab` (reveal
 * gestures, and Refresh/Reopen/Retry with `replace`) launches the app tab the
 * commit left active, so the launch always names the tab that is actually
 * shown. `newTab` (grid pick, deep link) launches the tab the gesture opened.
 */
export type EmbedLaunchPlan =
  /**
   * `onlyIfActivated`: launch only when the commit changed which app tab is
   * active, so a gesture that leaves the active tab alone (closing another tab)
   * does not relaunch it.
   */
  | { kind: 'activeTab'; replace?: boolean; onlyIfActivated?: boolean }
  | { kind: 'newTab'; tabId: string; app: ActiveSandboxUiApp }
