import type { SandboxUiConversationOrigin } from '@pages/SandboxUiPage.types'
import type { PendingSandboxUiDeepLink, SandboxUiDeepLinkEnvelope } from '@/App.types'

export const MAX_PENDING_SANDBOX_UI_DEEP_LINKS = 20
export const MAX_SANDBOX_UI_DEEP_LINK_RETRY_ATTEMPTS = 5
export const SANDBOX_UI_DEEP_LINK_BASE_RETRY_DELAY_MS = 1_000
export const SANDBOX_UI_DEEP_LINK_MAX_RETRY_DELAY_MS = 15_000

export function shouldPurgeSandboxUiDeepLinks(
  previousIdentity: string | null | undefined,
  currentIdentity: string | null
): boolean {
  return (
    previousIdentity !== undefined &&
    previousIdentity !== currentIdentity &&
    !(previousIdentity === null && currentIdentity !== null)
  )
}

export function enqueuePendingSandboxUiDeepLink(
  current: PendingSandboxUiDeepLink[],
  link: SandboxUiDeepLinkEnvelope,
  conversationOrigin: SandboxUiConversationOrigin | null,
  receivedIdentity: string | null
): PendingSandboxUiDeepLink[] {
  const existing = current.find(item => item.link.id === link.id)
  const next = existing ? current : [...current, { link, conversationOrigin, receivedIdentity }]
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

export function isPendingSandboxUiDeepLinkAwaitingConfirmation(
  pending: PendingSandboxUiDeepLink,
  currentIdentity: string | null
): boolean {
  if (!currentIdentity) return false
  return pending.confirmedIdentity !== currentIdentity
}

export function isPendingSandboxUiDeepLinkStale(
  pending: PendingSandboxUiDeepLink,
  currentIdentity: string | null
): boolean {
  if (pending.receivedIdentity !== null && pending.receivedIdentity !== currentIdentity) {
    return true
  }
  return Boolean(pending.confirmedIdentity && pending.confirmedIdentity !== currentIdentity)
}

export function findPendingSandboxUiDeepLinkAwaitingConfirmation(
  current: PendingSandboxUiDeepLink[],
  currentIdentity: string | null
): PendingSandboxUiDeepLink | undefined {
  if (!currentIdentity) return undefined
  return current.find(
    item =>
      !isPendingSandboxUiDeepLinkStale(item, currentIdentity) &&
      isPendingSandboxUiDeepLinkAwaitingConfirmation(item, currentIdentity)
  )
}

export function confirmPendingSandboxUiDeepLink(
  current: PendingSandboxUiDeepLink[],
  linkId: number,
  currentIdentity: string
): PendingSandboxUiDeepLink[] {
  return current.map(item =>
    item.link.id === linkId
      ? {
          ...item,
          confirmedIdentity: currentIdentity,
          failedMessage: undefined,
          nextRetryAt: undefined,
        }
      : item
  )
}

export function nextSandboxUiDeepLinkRetryDelayMs(retryCount: number): number {
  const bounded = Math.max(0, Math.min(retryCount, MAX_SANDBOX_UI_DEEP_LINK_RETRY_ATTEMPTS - 1))
  return Math.min(
    SANDBOX_UI_DEEP_LINK_BASE_RETRY_DELAY_MS * 2 ** bounded,
    SANDBOX_UI_DEEP_LINK_MAX_RETRY_DELAY_MS
  )
}

export function deferPendingSandboxUiDeepLink(
  current: PendingSandboxUiDeepLink[],
  linkId: number,
  now: number
): PendingSandboxUiDeepLink[] {
  return current.map(item => {
    if (item.link.id !== linkId) return item
    const retryCount = (item.retryCount ?? 0) + 1
    return {
      ...item,
      retryCount,
      failedMessage: undefined,
      nextRetryAt: now + nextSandboxUiDeepLinkRetryDelayMs(retryCount - 1),
    }
  })
}

export function failPendingSandboxUiDeepLink(
  current: PendingSandboxUiDeepLink[],
  linkId: number,
  message: string
): PendingSandboxUiDeepLink[] {
  return current.map(item =>
    item.link.id === linkId
      ? {
          ...item,
          failedMessage: message,
          nextRetryAt: undefined,
        }
      : item
  )
}

export function resetPendingSandboxUiDeepLinkFailure(
  current: PendingSandboxUiDeepLink[],
  linkId: number
): PendingSandboxUiDeepLink[] {
  return current.map(item =>
    item.link.id === linkId
      ? {
          ...item,
          failedMessage: undefined,
          nextRetryAt: undefined,
          retryCount: 0,
        }
      : item
  )
}
