export type Role = 'admin' | 'inviter' | 'member'

export type Channels = {
  emails: string[]
  telegramHandles: string[]
  slackUserNames: string[]
  telegramIds: string[]
  discordUserNames: string[]
  whatsappNumbers: string[]
}

export type Me = {
  id: string
  email: string
  name?: string
  picture?: string
  role: Role | null
  teamId: string | null
  teamName: string | null
  profile: { displayName: string; channels: Channels }
}

export type ProfileUpdateResponse = {
  userId: string
  displayName: string | null
  channels: Channels
}

export type ManageableTeam = {
  id: string
  name: string
  role: Role
  canAssignLeader: boolean
}

export type ManagedMemberTeam = {
  id: string
  name: string
  role: Role
  managerRole: Role
  canEdit: boolean
  canDelete: boolean
}

export type ManagedMember = {
  id: string
  email: string
  name: string | null
  picture: string | null
  displayName: string | null
  passwordPendingFromAcceptedInvitation?: boolean
  teams: ManagedMemberTeam[]
}

export type ManagedPendingInvitation = {
  id: string
  email: string
  role: Role
  status: string
  expiresAt: string
  teams: Array<{ id: string; name: string; role: Role }>
  canCancel: boolean
  canResend: boolean
}

export type NotificationPreferenceMedium = 'telegram' | 'slack' | 'teams'

export type NotificationPreferences = {
  preferredMedium: NotificationPreferenceMedium | null
  preferredAccountId: string | null
  channelFallbackEnabled: boolean
  verifiedMedia: NotificationPreferenceMedium[]
}

export type UpdateNotificationPreferencesInput = {
  preferredMedium: NotificationPreferenceMedium | null
  preferredAccountId: string | null
  channelFallbackEnabled: boolean
}
