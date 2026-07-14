/**
 * Shared constants and enums for the control API.
 *
 * Replaces "stringly-typed" code with proper constants.
 */

/**
 * Team member roles.
 */
export const TEAM_ROLES = {
  ADMIN: 'admin',
  INVITER: 'inviter',
  MEMBER: 'member',
} as const

/**
 * Invitation roles.
 */
export const INVITE_ROLES = TEAM_ROLES

/**
 * Team member statuses.
 */
export const MEMBER_STATUSES = {
  ACTIVE: 'active',
  PENDING: 'pending',
  DELETED: 'deleted',
} as const

/**
 * Invitation statuses.
 */
export const INVITE_STATUSES = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
} as const

/**
 * Type definitions derived from constants.
 */
export type TeamRole = (typeof TEAM_ROLES)[keyof typeof TEAM_ROLES]
export type InviteRole = TeamRole
export type MemberStatus = (typeof MEMBER_STATUSES)[keyof typeof MEMBER_STATUSES]
export type InviteStatus = (typeof INVITE_STATUSES)[keyof typeof INVITE_STATUSES]

/**
 * Validation sets for runtime checks.
 */
export const TEAM_ROLE_SET = new Set<TeamRole>(Object.values(TEAM_ROLES))
export const INVITE_ROLE_SET = TEAM_ROLE_SET
export const MEMBER_STATUS_SET = new Set<MemberStatus>(Object.values(MEMBER_STATUSES))

/**
 * Validate a team role.
 */
export function isValidTeamRole(value: string): value is TeamRole {
  return TEAM_ROLE_SET.has(value as TeamRole)
}

/**
 * Validate an invitation role.
 */
export function isValidInviteRole(value: string): value is InviteRole {
  return isValidTeamRole(value)
}

/**
 * Validate a member status.
 */
export function isValidMemberStatus(value: string): value is MemberStatus {
  return MEMBER_STATUS_SET.has(value as MemberStatus)
}
