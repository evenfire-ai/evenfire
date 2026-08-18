export type AppHeaderProps = {
  notificationTrayMode?: 'overlay' | 'drawer'
  notificationTrayReady?: boolean
  onNotificationTrayOpenChange?: (open: boolean) => void
  onShellOverlayOpenChange?: (open: boolean) => void
}

export type SearchMemberResult = {
  email: string
  id: string
  key: string
  label: string
  role: string
  teamId: string
  teamName: string
}

export type SearchEntityResult = {
  fromSelectedScope: boolean
  fromUserScope: boolean
  key: string
  teamNames: string[]
  /** Stable identifier (agent `metadata.name` / context id) — used for keys, navigation and filtering. */
  value: string
  /** Human-visible label rendered to the user (agent `spec.host` / context `spec.displayName`). */
  display: string
}

export type SearchTeamResult = {
  id: string
  name: string
  memberCount: number
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
