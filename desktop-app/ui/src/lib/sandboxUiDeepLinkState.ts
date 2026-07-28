import type { SandboxUiConversationOrigin } from '@pages/SandboxUiPage.types'
import type { PendingSandboxUiDeepLink, SandboxUiDeepLinkEnvelope } from '@/App.types'

export const MAX_PENDING_SANDBOX_UI_DEEP_LINKS = 20

export function shouldPurgeSandboxUiDeepLinks(
  previousIdentity: string | null | undefined,
  currentIdentity: string | null
): boolean {
  return (
    previousIdentity !== undefined &&
    previousIdentity !== null &&
    previousIdentity !== currentIdentity
  )
}

export function enqueuePendingSandboxUiDeepLink(
  current: PendingSandboxUiDeepLink[],
  link: SandboxUiDeepLinkEnvelope,
  conversationOrigin: SandboxUiConversationOrigin | null
): PendingSandboxUiDeepLink[] {
  const existing = current.find(item => item.link.id === link.id)
  const next = existing ? current : [...current, { link, conversationOrigin }]
  return [...next]
    .sort((left, right) => left.link.id - right.link.id)
    .slice(-MAX_PENDING_SANDBOX_UI_DEEP_LINKS)
}

export function removePendingSandboxUiDeepLink(
  current: PendingSandboxUiDeepLink[],
  linkId: number
): PendingSandboxUiDeepLink[] {
  return current.filter(item => item.link.id !== linkId)
}
