import type { ReactNode } from 'react'
import type { ProfileRouteKey } from '@lib/profileAppFrame'

export type { ProfileRouteKey } from '@lib/profileAppFrame'

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
