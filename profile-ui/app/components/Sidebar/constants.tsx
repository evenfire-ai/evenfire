import { IconApprovalChannels, IconConnectedAccounts, IconHome, IconMembers, IconSettings } from './icons'
import type { ProfileRouteKey, ProfileSidebarItem } from './types'

export const PROFILE_SIDEBAR_ITEMS: Record<ProfileRouteKey, ProfileSidebarItem> = {
  home: { label: 'Home', href: '/', icon: <IconHome /> },
  members: { label: 'Members', href: '/members', icon: <IconMembers /> },
  approvalChannels: {
    label: 'Approval Channels',
    href: '/approval-channels',
    icon: <IconApprovalChannels />,
  },
  connectedAccounts: {
    label: 'Connected Accounts',
    href: '/connected-accounts',
    icon: <IconConnectedAccounts />,
  },
  settings: { label: 'Settings', href: '/settings/profile', icon: <IconSettings /> },
}
