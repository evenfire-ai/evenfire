import type { ReactNode } from 'react'

export type SidebarTab =
  | 'hosts'
  | 'contexts'
  | 'mcp-servers'
  | 'shared-filesystems'
  | 'gfs'
  | 'communication-channels'
  | 'llm-secrets'
  | 'profile-admin'
  | 'workflow-recipes'
  | 'publisher'
  | 'outputs'
  | 'cost'
  | 'registry-catalog'
  | 'settings'

export type SidebarItem = {
  href: string
  icon: ReactNode
  label: string
}

export type SidebarProps = {
  currentTab: SidebarTab
  onLogout?: () => void
}
