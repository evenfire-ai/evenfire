import { controlApiRequest } from '../controlApiClient.js'
import { TeamAgentsResponse, TeamRole } from '../types.js'

type AuthContext = {
  userId: string
  email: string
  teamId: string
  role: TeamRole
  sessionToken: string
}

function canInvite(role: TeamRole): boolean {
  return role === 'admin' || role === 'inviter'
}

function canDelete(role: TeamRole): boolean {
  return role === 'admin'
}

function canManageRoles(role: TeamRole): boolean {
  return role === 'admin'
}

export async function getCurrentTeam(auth: AuthContext) {
  try {
    return await controlApiRequest<{ id: string; name: string; role: TeamRole }>(
      'GET',
      `/external/teams/${auth.teamId}/users/${auth.userId}/current`,
      { userSessionToken: auth.sessionToken }
    )
  } catch {
    return null
  }
}

export async function createTeamForUser(
  auth: Pick<AuthContext, 'userId' | 'email' | 'sessionToken'>,
  name: string
) {
  const team = await controlApiRequest<{ id: string; name: string }>('POST', '/external/teams', {
    body: {
      userId: auth.userId,
      name,
    },
    userSessionToken: auth.sessionToken,
  })

  return {
    team: {
      id: team.id,
      name: team.name,
      role: 'admin' as const,
    },
    token: auth.sessionToken,
  }
}

export async function renameTeam(
  auth: Pick<AuthContext, 'teamId' | 'role' | 'sessionToken'>,
  name: string
) {
  if (auth.role !== 'admin') {
    return { error: 'forbidden' as const }
  }

  let team: { id: string; name: string }
  try {
    team = await controlApiRequest<{ id: string; name: string }>(
      'PUT',
      `/external/teams/${auth.teamId}/name`,
      {
        body: { name },
        userSessionToken: auth.sessionToken,
      }
    )
  } catch {
    return { error: 'not_found' as const }
  }

  return {
    team: {
      id: team.id,
      name: team.name,
    },
  }
}

export async function listMembers(teamId: string, sessionToken: string) {
  const result = await controlApiRequest<{ items: unknown[] }>(
    'GET',
    `/external/teams/${teamId}/members`,
    {
      userSessionToken: sessionToken,
    }
  )
  return result.items
}

export async function getTeamContexts(teamId: string, sessionToken: string) {
  return controlApiRequest<{ teamId: string; contextIds: string[] }>(
    'GET',
    `/external/teams/${teamId}/contexts`,
    {
      userSessionToken: sessionToken,
    }
  )
}

export async function getTeamAgents(teamId: string, sessionToken: string) {
  return controlApiRequest<TeamAgentsResponse>('GET', `/external/teams/${teamId}/agents`, {
    userSessionToken: sessionToken,
  })
}

export async function updateMemberRole(
  auth: AuthContext,
  targetUserId: string,
  newRole: TeamRole
): Promise<{ error?: 'forbidden' | 'not_found' | 'bad_request'; data?: unknown }> {
  if (!canManageRoles(auth.role)) {
    return { error: 'forbidden' }
  }
  if (targetUserId === auth.userId) {
    return { error: 'bad_request' }
  }
  let target: { role: TeamRole }
  try {
    target = await controlApiRequest<{ role: TeamRole }>(
      'GET',
      `/external/teams/${auth.teamId}/members/${targetUserId}/role`,
      { userSessionToken: auth.sessionToken }
    )
  } catch {
    return { error: 'not_found' }
  }
  const updated = await controlApiRequest<unknown>(
    'PATCH',
    `/external/teams/${auth.teamId}/members/${targetUserId}/role`,
    {
      body: {
        role: newRole,
      },
      userSessionToken: auth.sessionToken,
    }
  )
  return { data: updated }
}

export async function inviteMember(auth: AuthContext, email: string, role: TeamRole) {
  if (!canInvite(auth.role)) {
    return { error: 'forbidden' as const }
  }

  const invited = await controlApiRequest<{ email: string; token: string }>(
    'POST',
    `/external/teams/${auth.teamId}/invitations`,
    {
      body: {
        email,
        role,
      },
      userSessionToken: auth.sessionToken,
    }
  )
  return { invited }
}

export async function deleteMember(auth: AuthContext, userId: string) {
  if (!canDelete(auth.role)) {
    return { error: 'forbidden' as const }
  }
  if (!userId || userId === auth.userId) {
    return { error: 'bad_request' as const }
  }

  let deleted: unknown
  try {
    deleted = await controlApiRequest<unknown>(
      'DELETE',
      `/external/teams/${auth.teamId}/members/${userId}`,
      {
        userSessionToken: auth.sessionToken,
      }
    )
  } catch {
    return { error: 'not_found' as const }
  }
  return { deleted }
}
