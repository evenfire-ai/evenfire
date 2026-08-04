import type { ApprovalChannelTarget } from '../app/types/approvalChannels'
import type { ManageableTeam, Role } from '../app/types/profile'
import { readProfileAccessCache } from './profileAccess'

export type ProfileAccessDataState = {
  approvalTargets: ApprovalChannelTarget[]
  approvalTargetsError: boolean
  approvalTargetsLoading: boolean
  manageableTeams: ManageableTeam[]
  manageableTeamsError: boolean
  manageableTeamsLoading: boolean
}

export function canManageMembersForAccess(
  role: Role | null | undefined,
  manageableTeams: ManageableTeam[]
): boolean {
  return role === 'admin' || role === 'inviter' || manageableTeams.length > 0
}

export function profileAccessStateForUser(userId: string): ProfileAccessDataState {
  if (!userId) {
    return {
      approvalTargets: [],
      approvalTargetsError: false,
      approvalTargetsLoading: false,
      manageableTeams: [],
      manageableTeamsError: false,
      manageableTeamsLoading: false,
    }
  }

  const cached = readProfileAccessCache(userId)
  return {
    approvalTargets: cached.approvalTargets ?? [],
    approvalTargetsError: false,
    approvalTargetsLoading: !cached.approvalTargets,
    manageableTeams: cached.manageableTeams ?? [],
    manageableTeamsError: false,
    manageableTeamsLoading: !cached.manageableTeams,
  }
}

export function profileAccessStateAfterManageableTeamsError(
  previous: ProfileAccessDataState
): ProfileAccessDataState {
  return {
    ...previous,
    manageableTeamsError: true,
    manageableTeamsLoading: false,
  }
}

export function profileAccessStateAfterApprovalTargetsError(
  previous: ProfileAccessDataState
): ProfileAccessDataState {
  return {
    ...previous,
    approvalTargetsError: true,
    approvalTargetsLoading: false,
  }
}
