import type { Role } from '@/app/types/profile'

export const TEAM_ROLE_LABELS: Record<Role, string> = {
  admin: 'Leader',
  inviter: 'Inviter',
  member: 'Participant',
}

export function formatTeamRole(role: Role | string | null | undefined): string {
  if (role === 'admin' || role === 'inviter' || role === 'member') return TEAM_ROLE_LABELS[role]
  return 'Participant'
}

export function permissionsForTeamRole(role: Role): {
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
): Role {
  if (canDeleteMembers) return 'admin'
  if (canInviteMembers) return 'inviter'
  return 'member'
}

export function setInvitePermission(role: Role, checked: boolean): Role {
  const current = permissionsForTeamRole(role)
  return teamRoleFromPermissions(checked, checked ? current.canDeleteMembers : false)
}

export function setDeletePermission(role: Role, checked: boolean): Role {
  return teamRoleFromPermissions(checked || permissionsForTeamRole(role).canInviteMembers, checked)
}
