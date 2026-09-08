export type HeaderActionsProps = {
  placement?: 'default' | 'titlebar'
  searchFocusRequestId?: number
  notificationOpenRequestId?: number
  notificationTrayMode?: 'overlay' | 'drawer'
  notificationTrayReady?: boolean
  onNotificationTrayOpenChange?: (open: boolean) => void
  onShellOverlayOpenChange?: (open: boolean) => void
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
