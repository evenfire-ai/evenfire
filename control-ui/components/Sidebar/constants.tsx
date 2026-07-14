import {
  IconBroadcast,
  IconCable,
  IconFolder,
  IconGroupWork,
  IconKey,
  IconOutputs,
  IconPublish,
  IconRobot,
  IconSettings,
  IconSharedFiles,
  IconStore,
  IconUsage,
  IconUsers,
  IconWorkflow,
} from './icons'
import type { SidebarItem, SidebarTab } from './types'

export const SIDEBAR_TABS: Record<SidebarTab, SidebarItem> = {
  hosts: { label: 'Agents', href: '/hosts', icon: <IconRobot /> },
  'mcp-servers': { label: 'Connectors', href: '/mcp-servers', icon: <IconCable /> },
  'workflow-recipes': { label: 'Plugins', href: '/workflow-recipes', icon: <IconWorkflow /> },
  'shared-filesystems': {
    label: 'Shared Files',
    href: '/shared-filesystems',
    icon: <IconSharedFiles />,
  },
  gfs: { label: 'Global Files', href: '/gfs', icon: <IconFolder /> },
  'registry-catalog': { label: 'Marketplace', href: '/registry', icon: <IconStore /> },
  publisher: { label: 'Publisher', href: '/publisher', icon: <IconPublish /> },
  'communication-channels': {
    label: 'External Channels',
    href: '/communication-channels',
    icon: <IconBroadcast />,
  },
  'profile-admin': { label: 'Users & Teams', href: '/profile-admin/users', icon: <IconUsers /> },
  contexts: { label: 'Contexts', href: '/contexts', icon: <IconGroupWork /> },
  'llm-secrets': { label: 'Secrets', href: '/secrets', icon: <IconKey /> },
  outputs: { label: 'Outputs', href: '/outputs', icon: <IconOutputs /> },
  cost: { label: 'Cost & Usage', href: '/cost/usage', icon: <IconUsage /> },
  settings: { label: 'Settings', href: '/settings', icon: <IconSettings /> },
}
