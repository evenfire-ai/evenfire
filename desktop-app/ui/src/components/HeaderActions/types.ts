export type HeaderActionsProps = {
  placement?: 'default' | 'titlebar'
  searchFocusRequestId?: number
  notificationOpenRequestId?: number
  notificationTrayMode?: 'overlay' | 'drawer'
  notificationTrayReady?: boolean
  notificationTrayLeft?: number | null
  onNotificationTrayOpenChange?: (open: boolean) => void
  onShellOverlayOpenChange?: (open: boolean) => void
  /**
   * Chat-drawer toggle (mini-spec 04a §C, R3). The toggle lives between the
   * search (`.header-left`) and the notification bell (`.header-utilities`). It
   * renders only when `drawerAvailable` — i.e. never on a chat tab.
   */
  drawerAvailable?: boolean
  /** Whether the chat drawer is currently open (effective visibility). */
  chatDrawerOpen?: boolean
  /** Toggles the chat drawer open/closed. */
  onToggleChatDrawer?: () => void
}

export type SearchEntityResult = {
  fromSelectedScope: boolean
  fromUserScope: boolean
  key: string
  teamNames: string[]
  /** Stable agent or connector identifier used for keys, navigation and filtering. */
  value: string
  /** Human-visible label rendered to the user. */
  display: string
}

export type SearchPluginResult = {
  key: string
  name: string
  namespace: string
  status: string | null
}

export type SearchAppResult = {
  key: string
  appRef: string
  label: string
  description: string | null
  ready: boolean
}
