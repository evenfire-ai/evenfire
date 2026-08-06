export type IdentityProviderKind = 'microsoft'

export type IdentityProviderConnectionStatus = 'pending' | 'connected' | 'disconnected' | 'error'

export type IdentityProviderConnection = {
  id: string
  provider: IdentityProviderKind
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
  description: string | null
  importedTeamId: string | null
  importedTeamName: string | null
}

export type MicrosoftDirectoryResponse = {
  users: MicrosoftDirectoryUser[]
  teams: MicrosoftDirectoryTeam[]
  evenfireTeams: Array<{ id: string; name: string; memberCount: number }>
  agents: string[]
  contexts: string[]
  teamAgents: Record<string, string[]>
  teamContexts: Record<string, string[]>
}

export type MicrosoftSetupTeamDraft = {
  id: string
  selected: boolean
  manual: boolean
  externalTeamId: string | null
  externalTeamName: string | null
  existingTeamId: string | null
  name: string
  contextIds: string[]
  agentNames: string[]
}

export type MicrosoftSetupMemberDraft = {
  externalSubject: string
  selected: boolean
  microsoftDisplayName: string
  displayName: string
  email: string
  userPrincipalName: string
  teamRefs: string[]
  teamSelectionCustomized?: boolean
  existingMemberId: string | null
}

export type MicrosoftSetupOptions = {
  createTeams: boolean
  createMembers: boolean
  sendInvitations: boolean
  allowMemberLogin: boolean
}

export type MicrosoftIdentityProviderSetupDraft = {
  displayName?: string
  callbackUrl?: string
  tenantId?: string
  clientId?: string
  appRegistrationCreated?: boolean
  permissionsGranted?: boolean
  allowMemberLogin?: boolean
  teams?: MicrosoftSetupTeamDraft[]
  members?: MicrosoftSetupMemberDraft[]
  options?: MicrosoftSetupOptions
}

export type IdentityProviderSetupStatus =
  | 'draft'
  | 'authorizing'
  | 'configuring'
  | 'importing'
  | 'completed'
  | 'cancelled'

export type MicrosoftIdentityProviderSetup = {
  id: string
  provider: 'microsoft'
  status: IdentityProviderSetupStatus
  currentStep: number
  draft: MicrosoftIdentityProviderSetupDraft
  hasClientSecret: boolean
  connectionId: string | null
  execution: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type MicrosoftIdentityProviderSetupResponse = {
  setup: MicrosoftIdentityProviderSetup | null
  callbackUrl: string
  appName: string
}

export type MicrosoftImportExecutionResult = {
  complete: boolean
  stage: 'teams' | 'members' | 'complete'
  processed: number
  total: number
  percent: number
  createdTeams: number
  createdMembers: number
  existingMembers: number
  invitationsSent: number
  lastError: string | null
}
