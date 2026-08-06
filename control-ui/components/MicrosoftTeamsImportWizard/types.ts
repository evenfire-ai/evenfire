import type {
  MicrosoftDirectoryResponse,
  MicrosoftIdentityProviderSetup,
  MicrosoftIdentityProviderSetupDraft,
  MicrosoftImportExecutionResult,
  MicrosoftSetupMemberDraft,
  MicrosoftSetupOptions,
  MicrosoftSetupTeamDraft,
} from '@lib/identityProviders.types'

export type {
  MicrosoftDirectoryResponse,
  MicrosoftIdentityProviderSetup,
  MicrosoftIdentityProviderSetupDraft,
  MicrosoftImportExecutionResult,
  MicrosoftSetupMemberDraft,
  MicrosoftSetupOptions,
  MicrosoftSetupTeamDraft,
}

export type ReviewTeam = {
  key: string
  name: string
  existing: boolean
  contextIds: string[]
  agentNames: string[]
  members: MicrosoftSetupMemberDraft[]
}

export type MicrosoftSetupGuideStepsProps = {
  step: number
  draft: MicrosoftIdentityProviderSetupDraft
  fallbackIntegrationName: string
  callbackUrl: string
  clientSecret: string
  hasClientSecret: boolean
  saving: boolean
  authorized: boolean
  canAuthorize: boolean
  onDraftChange: (patch: Partial<MicrosoftIdentityProviderSetupDraft>) => void
  onClientSecretChange: (value: string) => void
  onBegin: () => void
  onAuthorize: () => void
}

export type MicrosoftTeamsMappingStepProps = {
  directory: MicrosoftDirectoryResponse
  teams: MicrosoftSetupTeamDraft[]
  duplicateTeamIds: ReadonlySet<string>
  onReplaceTeams: (teams: MicrosoftSetupTeamDraft[]) => void
  onUpdateTeam: (teamId: string, patch: Partial<MicrosoftSetupTeamDraft>) => void
  onUpdateTeamDestination: (teamId: string, name: string) => void
  onAddManualTeam: () => void
}

export type MicrosoftMembersMappingStepProps = {
  directory: MicrosoftDirectoryResponse
  teams: MicrosoftSetupTeamDraft[]
  members: MicrosoftSetupMemberDraft[]
  onReplaceMembers: (members: MicrosoftSetupMemberDraft[]) => void
  onUpdateMember: (memberId: string, patch: Partial<MicrosoftSetupMemberDraft>) => void
}

export type MicrosoftImportReviewStepProps = {
  reviewTeams: ReviewTeam[]
  options: MicrosoftSetupOptions
  showCreateTeams: boolean
  hasAssignedMembers: boolean
  onUpdateOptions: (patch: Partial<MicrosoftSetupOptions>) => void
}
