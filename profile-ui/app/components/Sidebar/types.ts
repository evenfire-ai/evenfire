import type { ReactNode } from 'react'

export type ProfileRouteKey =
  | 'home'
  | 'members'
  | 'approvalChannels'
  | 'connectedAccounts'
  | 'settings'

export type ProfileSidebarItem = {
  label: string
  href: string
  icon: ReactNode
}

export type SidebarProps = {
  currentRoute: ProfileRouteKey
  isOpen?: boolean
  onNavigate?: () => void
  onLogout: () => void
}
