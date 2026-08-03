import type { SandboxUiDeepLinkEnvelope } from '@clerum/desktop-app-links'
import type { SandboxUiConversationOrigin } from '@pages/SandboxUiPage.types'

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
