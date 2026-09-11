export type TeamRole = 'admin' | 'inviter' | 'member'
export type InviteRole = TeamRole

export const TEAM_ROLES: TeamRole[] = ['admin', 'inviter', 'member']

export function normalizeTeamRoleInput(value: unknown): TeamRole | null {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (normalized === 'leader' || normalized === 'admin') return 'admin'
  if (normalized === 'participant' || normalized === 'member') return 'member'
  if (normalized === 'inviter') return 'inviter'
  return null
}

export function isTeamRole(value: unknown): value is TeamRole {
  return normalizeTeamRoleInput(value) === value
}

export function roleCanInviteMembers(role: TeamRole | null | undefined): boolean {
  return role === 'admin' || role === 'inviter'
}

export function roleCanDeleteMembers(role: TeamRole | null | undefined): boolean {
  return role === 'admin'
}

export type ChannelMapping = {
  emails: string[]
  telegramHandles: string[]
  slackUserNames: string[]
  telegramIds: string[]
  discordUserNames: string[]
  whatsappNumbers: string[]
}

export function normalizeChannels(input: unknown): ChannelMapping {
  const fallback: ChannelMapping = {
    emails: [],
    telegramHandles: [],
    slackUserNames: [],
    telegramIds: [],
    discordUserNames: [],
    whatsappNumbers: [],
  }

  if (!input || typeof input !== 'object') return fallback
  const value = input as Partial<ChannelMapping>
  return {
    emails: Array.isArray(value.emails)
      ? value.emails
          .map(String)
          .map(v => v.trim())
          .filter(Boolean)
      : [],
    telegramHandles: Array.isArray(value.telegramHandles)
      ? value.telegramHandles
          .map(String)
          .map(v => v.trim())
          .filter(Boolean)
      : [],
    slackUserNames: Array.isArray(value.slackUserNames)
      ? value.slackUserNames
          .map(String)
          .map(v => v.trim())
          .filter(Boolean)
      : [],
    telegramIds: Array.isArray(value.telegramIds)
      ? value.telegramIds
          .map(String)
          .map(v => v.trim())
          .filter(Boolean)
      : [],
    discordUserNames: Array.isArray(value.discordUserNames)
      ? value.discordUserNames
          .map(String)
          .map(v => v.trim())
          .filter(Boolean)
      : [],
    whatsappNumbers: Array.isArray(value.whatsappNumbers)
      ? value.whatsappNumbers
          .map(String)
          .map(v => v.trim())
          .filter(Boolean)
      : [],
  }
}

export type AdminDeleteUserResult =
  | { ok: true; id: string }
  | { error: 'not_found' | 'gfs_operator_link_history_retained' }
export type AdminDeleteTeamResult =
  | { ok: true; id: string }
  | { error: 'not_found' | 'team_not_empty' }
