import { controlApiRequest } from '../controlApiClient.js'
import { ChannelMapping, TeamDirectoryResult, TeamRole, UserAgentsResponse } from '../types.js'

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

export async function listTeams(userId: string, currentTeamId: string, sessionToken: string) {
  return controlApiRequest<{
    currentTeamId: string
    items: Array<{ id: string; name: string; role: TeamRole }>
  }>('GET', `/external/users/${userId}/teams`, {
    query: { currentTeamId },
    userSessionToken: sessionToken,
  })
}

export async function getMyTeamDirectory(userId: string, sessionToken: string) {
  return controlApiRequest<TeamDirectoryResult>('GET', `/external/users/${userId}/team-directory`, {
    userSessionToken: sessionToken,
  })
}

export async function switchTeam(
  userId: string,
  email: string,
  nextTeamId: string,
  sessionToken: string
) {
  let membership: { team_id: string; role: TeamRole; team_name: string }
  try {
    membership = await controlApiRequest<{ team_id: string; role: TeamRole; team_name: string }>(
      'GET',
      `/external/users/${userId}/memberships/${nextTeamId}`,
      { userSessionToken: sessionToken }
    )
  } catch {
    return null
  }

  const role = membership.role as TeamRole
  const { token } = await controlApiRequest<{ token: string }>(
    'POST',
    '/external/auth/session-token',
    {
      body: {
        userId,
        email,
        teamId: membership.team_id,
        role,
      },
      userSessionToken: sessionToken,
    }
  )
  return {
    token,
    team: {
      id: membership.team_id,
      name: membership.team_name,
      role,
    },
  }
}

export async function getMe(userId: string, teamId: string, sessionToken: string) {
  try {
    const result = await controlApiRequest<{
      id: string
      email: string
      name: string | null
      picture: string | null
      teamId: string | null
      teamName: string | null
      role: TeamRole | null
      profile: { displayName: string; channels: unknown }
    }>('GET', `/external/users/${userId}/me`, { query: { teamId }, userSessionToken: sessionToken })
    return {
      ...result,
      profile: {
        displayName: result.profile.displayName,
        channels: normalizeChannels(result.profile.channels),
      },
    }
  } catch {
    return null
  }
}

export async function getMyContexts(userId: string, sessionToken: string) {
  return controlApiRequest<{ userId: string; contextIds: string[] }>(
    'GET',
    `/external/users/${userId}/contexts`,
    { userSessionToken: sessionToken }
  )
}

export async function getMyAgents(userId: string, sessionToken: string) {
  return controlApiRequest<UserAgentsResponse>('GET', `/external/users/${userId}/agents`, {
    userSessionToken: sessionToken,
  })
}

export async function updateProfile(
  userId: string,
  displayName: string,
  channelsInput: unknown,
  sessionToken: string
) {
  const channels = normalizeChannels(channelsInput)
  const result = await controlApiRequest<{
    userId: string
    displayName: string | null
    channels: unknown
  }>('PUT', `/external/users/${userId}/profile`, {
    body: {
      displayName: displayName || null,
      channels,
    },
    userSessionToken: sessionToken,
  })
  return {
    userId: result.userId,
    displayName: result.displayName,
    channels: normalizeChannels(result.channels),
  }
}

export async function updatePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  sessionToken: string
) {
  return controlApiRequest<{ updated: true }>('PUT', `/external/users/${userId}/password`, {
    body: {
      currentPassword,
      newPassword,
    },
    userSessionToken: sessionToken,
  })
}
