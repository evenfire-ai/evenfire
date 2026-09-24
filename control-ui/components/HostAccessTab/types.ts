import type { ReactNode } from 'react'

export type AccessSubTab = 'members' | 'teams'

export type AccessUserRow = {
  id: string
  email: string
  name: string | null
  displayName: string | null
}

export type AccessTeamRow = {
  id: string
  name: string
}

export type AccessTeamDirectoryRow = AccessTeamRow & {
  memberCount: number
}

export type HostAccessTabProps = {
  hostName: string
  onActionsChange?: (actions: ReactNode | null) => void
}
