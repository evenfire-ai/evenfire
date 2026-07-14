import type { TeamRole } from './api'

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  admin: 'Leader',
  inviter: 'Inviter',
  member: 'Participant',
}

export function formatTeamRole(role: TeamRole | string | null | undefined): string {
  if (role === 'admin' || role === 'inviter' || role === 'member') return TEAM_ROLE_LABELS[role]
  return 'Participant'
}

export function permissionsForTeamRole(role: TeamRole): {
  canInviteMembers: boolean
  canDeleteMembers: boolean
} {
  return {
    canInviteMembers: role === 'admin' || role === 'inviter',
    canDeleteMembers: role === 'admin',
  }
}

export function teamRoleFromPermissions(
  canInviteMembers: boolean,
  canDeleteMembers: boolean
): TeamRole {
  if (canDeleteMembers) return 'admin'
  if (canInviteMembers) return 'inviter'
  return 'member'
}

export function setInvitePermission(role: TeamRole, checked: boolean): TeamRole {
  const current = permissionsForTeamRole(role)
  return teamRoleFromPermissions(checked, checked ? current.canDeleteMembers : false)
}

export function setDeletePermission(role: TeamRole, checked: boolean): TeamRole {
  return teamRoleFromPermissions(checked || permissionsForTeamRole(role).canInviteMembers, checked)
}
