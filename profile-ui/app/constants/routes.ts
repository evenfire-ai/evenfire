import type { OidcRefusalReason } from '../api/oidc/types'

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
  root: '/',
  login: (query?: ProfileRouteQuery) => withQuery('/', query),
  channels: {
    root: '/channels',
    channel: (network: string) => `/channels/${segment(network)}`,
  },
  connectedAccounts: '/connected-accounts',
  desktopSetup: '/desktop-setup',
  forgotPassword: (query?: ProfileRouteQuery) => withQuery('/forgot-password', query),
  invitation: (token: string) => `/invitations/${segment(token)}`,
  openDesktopApp: (recipeNs: string, recipeName: string) =>
    `/open/apps/${segment(recipeNs)}/${segment(recipeName)}`,
  oidcStart: '/api/oidc/start',
  oidcSignedIn: '/oidc/signed-in',
  oidcResult: (reason: OidcRefusalReason) => withQuery('/oidc/result', { reason }),
  members: {
    root: '/members',
    invite: '/members/invite',
    detail: (userId: string) => `/members/${segment(userId)}`,
  },
  settings: {
    root: '/settings/profile',
    profile: '/settings/profile',
    approvalChannels: '/settings/approval-channels',
  },
} as const
