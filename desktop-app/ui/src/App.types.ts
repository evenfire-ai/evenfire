import type { SandboxUiDeepLinkEnvelope } from '@clerum/desktop-app-links'
import type { SandboxUiConversationOrigin } from '@pages/SandboxUiPage.types'

export type { SandboxUiDeepLinkEnvelope } from '@clerum/desktop-app-links'

export type PendingSandboxUiDeepLink = {
  link: SandboxUiDeepLinkEnvelope
  conversationOrigin: SandboxUiConversationOrigin | null
}
