import type { SandboxUiConversationOrigin } from '@pages/SandboxUiPage.types'

export type SandboxUiDeepLinkEnvelope = {
  id: number
  appRef: string
  path: string
  teamId?: string
}

export type PendingSandboxUiDeepLink = {
  link: SandboxUiDeepLinkEnvelope
  conversationOrigin: SandboxUiConversationOrigin | null
}
