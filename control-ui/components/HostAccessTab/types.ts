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
  // True when the parent has a pending rename. Mirrors the
  // `hasPendingRename` from the host detail page so this extracted tab can
  // honour the "Save agent rename before changing user or team access"
  // warning without having to thread extra state through the parent.
  hasPendingRename?: boolean
  hostName: string
}
