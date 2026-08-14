export type AppHeaderProps = {
  searchFocusRequestId?: number
  notificationOpenRequestId?: number
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
  value: string
}

export type SearchTeamResult = {
  id: string
  name: string
  memberCount: number
}
