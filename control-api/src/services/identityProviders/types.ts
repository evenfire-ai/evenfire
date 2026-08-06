export type IdentityProvider = 'microsoft'

export type IdentityProviderConnectionStatus = 'pending' | 'connected' | 'disconnected' | 'error'

export type IdentityProviderConnection = {
  id: string
  provider: IdentityProvider
  displayName: string
  directoryTenantId: string
  clientId: string
  hasClientSecret: boolean
  allowMemberLogin: boolean
  allowedEmailDomains: string[]
  clientSecretExpiresAt: string | null
  validForLogin: boolean
  status: IdentityProviderConnectionStatus
  grantedScopes: string[]
  connectedAt: string | null
  disconnectedAt: string | null
  lastError: string | null
  createdAt: string
}

export type IdentityProviderSetupStatus =
  | 'draft'
  | 'authorizing'
  | 'configuring'
  | 'importing'
  | 'completed'
  | 'cancelled'

export type IdentityProviderSetupSession = {
  id: string
  provider: IdentityProvider
  status: IdentityProviderSetupStatus
  currentStep: number
  draft: Record<string, unknown>
  hasClientSecret: boolean
  connectionId: string | null
  execution: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type MicrosoftDirectoryUser = {
  id: string
  displayName: string
  email: string
  userPrincipalName: string
  accountEnabled: boolean
  imported: boolean
  invitationPending: boolean
  microsoftTeamIds: string[]
  existingMemberId: string | null
  existingMemberName: string | null
}

export type MicrosoftDirectoryTeam = {
  id: string
  displayName: string
  description: string
  importedTeamId: string | null
  importedTeamName: string | null
}

export type IdentityProviderLoginFlow =
  | 'admin_connect'
  | 'profile_login'
  | 'desktop_login'
  | 'invitation_link'
