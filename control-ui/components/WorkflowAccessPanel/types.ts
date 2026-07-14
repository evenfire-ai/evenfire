import type {
  AdminUser,
  TeamListItem,
  WorkflowApprovalAllowedTeam,
  WorkflowGrantTeam,
  WorkflowGrantUser,
} from '@lib/api'

export type WorkflowAccessPanelProps =
  | {
      mode: 'edit'
      namespace: string
      recipeName: string
      activeSection?: AccessContractKey
      selectedUserIds: string[]
      selectedTeamIds: string[]
      selectedApprovalTeamIds: string[]
      onSelectedUserIdsChange: (next: string[]) => void
      onSelectedTeamIdsChange: (next: string[]) => void
      onSelectedApprovalTeamIdsChange: (next: string[]) => void
      inlineError?: string | null
      showHeader?: boolean
    }
  | {
      mode: 'create'
      activeSection?: AccessContractKey
      selectedUserIds: string[]
      selectedTeamIds: string[]
      selectedApprovalTeamIds: string[]
      onSelectedUserIdsChange: (next: string[]) => void
      onSelectedTeamIdsChange: (next: string[]) => void
      onSelectedApprovalTeamIdsChange: (next: string[]) => void
      inlineError?: string | null
      showHeader?: boolean
    }

export type AccessEntityKind = 'user' | 'team'

export type AccessContractKey = 'trigger-users' | 'trigger-teams' | 'approval-target-teams'

export type AccessSectionDefinition = {
  key: AccessContractKey
  title: string
  description: string
  pickLabel: string
  emptyCreate: string
  emptyEdit: string
  grantLabel: string
  revokeLabel: string
  entityKind: AccessEntityKind
}

export type AccessUserOption = Pick<AdminUser, 'id' | 'email' | 'name' | 'displayName'>

export type AccessTeamOption = Pick<TeamListItem, 'id' | 'name'>

export type AccessUserRow = WorkflowGrantUser | AccessUserOption

export type AccessTeamRow = WorkflowGrantTeam | WorkflowApprovalAllowedTeam | AccessTeamOption
