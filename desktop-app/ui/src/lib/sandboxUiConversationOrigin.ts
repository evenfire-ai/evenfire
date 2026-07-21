import { DESKTOP_ROUTES } from '@constants/navigation'
import type { SandboxUiConversationOrigin } from '@pages/SandboxUiPage.types'
import type { NavItem } from '@/uiTypes'

export function getConversationOriginForNavigation(
  item: NavItem,
  activeConversationOrigin: SandboxUiConversationOrigin | null
): SandboxUiConversationOrigin | null {
  return item === DESKTOP_ROUTES.apps ? activeConversationOrigin : null
}

export function getConversationOriginForAppLaunch(
  currentItem: NavItem,
  activeConversationOrigin: SandboxUiConversationOrigin | null,
  preservedConversationOrigin: SandboxUiConversationOrigin | null
): SandboxUiConversationOrigin | null {
  return (
    activeConversationOrigin ??
    (currentItem === DESKTOP_ROUTES.apps ? preservedConversationOrigin : null)
  )
}
