import { DESKTOP_LOGIN_PATH } from '@clerum/desktop-app-links'
import type { OidcRefusalReason } from '../api/oidc/types'
import type { OidcReturnTo } from './oidc'

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
  desktopLogin: DESKTOP_LOGIN_PATH,
  desktopSetup: '/desktop-setup',
  forgotPassword: (query?: ProfileRouteQuery) => withQuery('/forgot-password', query),
  invitation: (token: string) => `/invitations/${segment(token)}`,
  openDesktopApp: (recipeNs: string, recipeName: string) =>
    `/open/apps/${segment(recipeNs)}/${segment(recipeName)}`,
  oidcStart: '/api/oidc/start',
  oidcDesktopStart: '/api/oidc/desktop-start',
  oidcSignedIn: '/oidc/signed-in',
  oidcSignedInWithReturn: (returnTo: OidcReturnTo) =>
    withQuery('/oidc/signed-in', { next: returnTo }),
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

/** Where `/oidc/signed-in?next=<value>` sends the member after an OIDC sign-in. */
export const OIDC_RETURN_TO_ROUTES: Readonly<Record<OidcReturnTo, string>> = {
  'desktop-setup': PROFILE_ROUTES.desktopSetup,
}
