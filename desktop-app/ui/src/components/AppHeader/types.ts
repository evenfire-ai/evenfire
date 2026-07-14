export type AppHeaderProps = {
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
