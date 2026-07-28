import { DESKTOP_ROUTES } from '@constants/navigation'
import type { SandboxUiConversationOrigin } from '@pages/SandboxUiPage.types'
import type { NavItem } from '@/uiTypes'

function resolveConversationOrigin(
  item: NavItem,
  activeConversationOrigin: SandboxUiConversationOrigin | null,
  preservedConversationOrigin: SandboxUiConversationOrigin | null
): SandboxUiConversationOrigin | null {
  return (
    activeConversationOrigin ?? (item === DESKTOP_ROUTES.apps ? preservedConversationOrigin : null)
  )
}

export function getConversationOriginForNavigation(
  item: NavItem,
  activeConversationOrigin: SandboxUiConversationOrigin | null,
  preservedConversationOrigin: SandboxUiConversationOrigin | null
): SandboxUiConversationOrigin | null {
  if (item !== DESKTOP_ROUTES.apps) return null
  return resolveConversationOrigin(item, activeConversationOrigin, preservedConversationOrigin)
}

export function getConversationOriginForAppLaunch(
  currentItem: NavItem,
  activeConversationOrigin: SandboxUiConversationOrigin | null,
  preservedConversationOrigin: SandboxUiConversationOrigin | null
): SandboxUiConversationOrigin | null {
  return resolveConversationOrigin(
    currentItem,
    activeConversationOrigin,
    preservedConversationOrigin
  )
}
