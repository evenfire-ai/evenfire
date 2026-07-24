type QueryValue = boolean | number | string | null | undefined
type ProfileRouteQuery = Record<string, QueryValue>

function segment(value: string): string {
  return encodeURIComponent(value)
}

function withQuery(path: string, query?: ProfileRouteQuery): string {
  if (!query) return path
  const params = new URLSearchParams()
  Object.entries(query).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      params.set(key, String(value))
    }
  })
  const search = params.toString()
  return search ? `${path}?${search}` : path
}

export const PROFILE_ROUTES = {
  home: '/',
  login: (query?: ProfileRouteQuery) => withQuery('/', query),
  approvalChannels: '/approval-channels',
  connectedAccounts: '/connected-accounts',
  desktopSetup: '/desktop-setup',
  forgotPassword: (query?: ProfileRouteQuery) => withQuery('/forgot-password', query),
  invitation: (token: string) => `/invitations/${segment(token)}`,
  members: {
    root: '/members',
    invite: '/members/invite',
    detail: (userId: string) => `/members/${segment(userId)}`,
  },
  settings: {
    root: '/settings/profile',
    profile: '/settings/profile',
    social: (network: string) => `/settings/social/${segment(network)}`,
  },
} as const
