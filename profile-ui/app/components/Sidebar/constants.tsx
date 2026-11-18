import { PROFILE_ROUTES } from '@constants/routes'
import { IconConnectedAccounts, IconMembers, IconSettings, IconSocialChannels } from './icons'
import type { ProfileRouteKey, ProfileSidebarItem } from './types'

export const PROFILE_SIDEBAR_ITEMS: Record<ProfileRouteKey, ProfileSidebarItem> = {
  socialChannels: {
    label: 'Social channels',
    href: PROFILE_ROUTES.channels.root,
    icon: <IconSocialChannels />,
  },
  members: { label: 'Members', href: PROFILE_ROUTES.members.root, icon: <IconMembers /> },
  connectedAccounts: {
    label: 'Connected Accounts',
    href: PROFILE_ROUTES.connectedAccounts,
    icon: <IconConnectedAccounts />,
  },
  settings: { label: 'Settings', href: PROFILE_ROUTES.settings.profile, icon: <IconSettings /> },
}
