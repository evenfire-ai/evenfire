import type { Role } from './profile'

export type InvitationPreview = {
  id: string
  teamId: string | null
  teamName: string | null
  teams?: Array<{ id: string; name: string; role: string }>
  email: string
  role: string
  purpose?: 'member_invitation' | 'password_reset' | 'admin_desktop_access'
  status: string
  expiresAt: string
  acceptedAt: string | null
  userId: string | null
  passwordPending: boolean
  identityProvider: 'microsoft' | null
  identityProviderConnectionId: string | null
  identityProviderLinked: boolean
}

export type AcceptInvitationResponse = {
  accepted: true
  id: string
  teamId: string | null
  teamName: string | null
  teams?: Array<{ id: string; name: string; role: string }>
  role: string
  purpose?: 'member_invitation' | 'password_reset' | 'admin_desktop_access'
  status: string
  expiresAt: string
  acceptedAt: string | null
  userId: string | null
  passwordPending: boolean
  identityProvider: 'microsoft' | null
  identityProviderConnectionId: string | null
  identityProviderLinked: boolean
  email: string
}

export type DesktopAuthorizationResponse = {
  authorizationToken: string
  expiresInSeconds: number
}

export type DesktopEnvironmentResponse = {
  appName: string
  externalRestApiBaseUrl: string
  rpcProxyBaseUrl: string
}

export type PasswordLoginResponse = {
  me: {
    id: string
    email: string
    name?: string | null
    picture?: string | null
    teamId: string | null
    teamName: string | null
    role: Role | null
  }
}
