import type { ManagedMember } from '@/app/types/profile'

export function displayMemberName(member: ManagedMember): string {
  return member.displayName || member.name || member.email
}

export function canDeleteMemberAccount(member: ManagedMember, currentUserId: string): boolean {
  return (
    member.id !== currentUserId &&
    member.teams.length > 0 &&
    member.teams.every(team => team.canDelete)
  )
}

export function memberDeleteTooltip(member: ManagedMember, currentUserId: string): string {
  if (member.id === currentUserId) return 'You cannot delete yourself.'
  if (member.teams.length === 0) return 'This member has no visible active teams.'
  if (member.teams.every(team => team.canDelete)) return `Delete ${displayMemberName(member)}.`
  if (member.teams.some(team => team.canDelete)) {
    return 'You are not leader of all teams this member belongs to. Open details to remove them from teams you control.'
  }
  return 'You are not leader of all teams this member belongs to.'
}
