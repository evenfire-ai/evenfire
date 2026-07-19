import type { ReactNode } from 'react'

export type SidebarTab =
  | 'hosts'
  | 'contexts'
  | 'mcp-servers'
  | 'files'
  | 'communication-channels'
  | 'llm-secrets'
  | 'llm-models'
  | 'profile-admin'
  | 'workflow-recipes'
  | 'publisher'
  | 'cost'
  | 'registry-catalog'
  | 'settings'
  | 'traces'

export type SidebarItem = {
  children?: SidebarChildItem[]
  href: string
  hidden?: boolean
  icon: ReactNode
  label: string
}

export type SidebarChildItem = {
  href: string
  icon: ReactNode
  label: string
  matchPath?: string
}

export type SidebarProps = {
  currentTab: SidebarTab
  isOpen?: boolean
  onNavigate?: () => void
  onLogout?: () => void
}
