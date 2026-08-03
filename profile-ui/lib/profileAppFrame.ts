const PUBLIC_PROFILE_UI_PREFIXES = ['/desktop-setup', '/forgot-password', '/invitations'] as const

export function isPublicProfileUiPath(pathname: string): boolean {
  return PUBLIC_PROFILE_UI_PREFIXES.some(
    prefix => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

export type ProfileRouteKey =
  | 'home'
  | 'members'
  | 'approvalChannels'
  | 'connectedAccounts'
  | 'settings'

export function profileRouteForPathname(pathname: string): ProfileRouteKey {
  if (pathname === '/approval-channels' || pathname.startsWith('/approval-channels/')) {
    return 'approvalChannels'
  }
  if (pathname === '/connected-accounts' || pathname.startsWith('/connected-accounts/')) {
    return 'connectedAccounts'
  }
  if (pathname === '/members' || pathname.startsWith('/members/')) return 'members'
  if (pathname === '/settings' || pathname.startsWith('/settings/')) return 'settings'
  return 'home'
}
