import { PROFILE_ROUTES } from '@constants/routes'
import {
  IconApprovalChannels,
  IconConnectedAccounts,
  IconHome,
  IconMembers,
  IconSettings,
} from './icons'
import type { ProfileRouteKey, ProfileSidebarItem } from './types'

export const PROFILE_SIDEBAR_ITEMS: Record<ProfileRouteKey, ProfileSidebarItem> = {
  home: { label: 'Home', href: PROFILE_ROUTES.home, icon: <IconHome /> },
  members: { label: 'Members', href: PROFILE_ROUTES.members.root, icon: <IconMembers /> },
  approvalChannels: {
    label: 'Approval Channels',
    href: PROFILE_ROUTES.approvalChannels,
    icon: <IconApprovalChannels />,
  },
  connectedAccounts: {
    label: 'Connected Accounts',
    href: PROFILE_ROUTES.connectedAccounts,
    icon: <IconConnectedAccounts />,
  },
  settings: { label: 'Settings', href: PROFILE_ROUTES.settings.profile, icon: <IconSettings /> },
}
