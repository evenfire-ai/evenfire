import { ControlApiError, controlApiRequest } from '../controlApiClient.js'
import { TeamAgentsResponse, TeamRole } from '../types.js'

type AuthContext = {
  userId: string
  email: string
  teamId: string
  role: TeamRole
  sessionToken: string
}

// A team management failure reported without the upstream path or message.
export class TeamRequestError extends Error {
  status: number
  constructor(status: number) {
    super(status >= 500 ? 'Team service unavailable' : 'Team request failed')
    this.name = 'TeamRequestError'
    this.status = status
  }
}

// Control API authorizes team management from the caller's current team
// membership; translate its refusals instead of re-deciding from the session.
function controlApiRefusal(error: unknown): 'forbidden' | 'not_found' {
  if (!(error instanceof ControlApiError)) throw error
  if (error.status === 403) return 'forbidden'
  if (error.status === 404) return 'not_found'
  throw new TeamRequestError(error.status >= 400 && error.status < 500 ? error.status : 502)
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

  const { token } = await controlApiRequest<{ token: string }>(
    'POST',
    '/external/auth/session-token',
    {
      body: {
        userId: auth.userId,
        email: auth.email,
        teamId: team.id,
        role: 'admin',
      },
    }
  )

  return {
    team: {
      id: team.id,
      name: team.name,
      role: 'admin' as const,
    },
    token,
  }
}

export async function renameTeam(
  auth: Pick<AuthContext, 'teamId' | 'role' | 'sessionToken'>,
  name: string
) {
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
  } catch (error) {
    return { error: controlApiRefusal(error) }
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
  if (targetUserId === auth.userId) {
    return { error: 'bad_request' }
  }
  let target: { role: TeamRole }
  try {
    target = await controlApiRequest<{ role: TeamRole }>(
      'GET',
      `/external/teams/${encodeURIComponent(auth.teamId)}/members/${encodeURIComponent(targetUserId)}/role`,
      { userSessionToken: auth.sessionToken }
    )
  } catch (error) {
    return { error: controlApiRefusal(error) }
  }
  try {
    const updated = await controlApiRequest<unknown>(
      'PATCH',
      `/external/teams/${encodeURIComponent(auth.teamId)}/members/${encodeURIComponent(targetUserId)}/role`,
      {
        body: {
          role: newRole,
        },
        userSessionToken: auth.sessionToken,
      }
    )
    return { data: updated }
  } catch (error) {
    return { error: controlApiRefusal(error) }
  }
}

export async function inviteMember(auth: AuthContext, email: string, role: TeamRole) {
  try {
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
  } catch (error) {
    if (controlApiRefusal(error) === 'forbidden') return { error: 'forbidden' as const }
    throw new TeamRequestError(404)
  }
}

export async function deleteMember(auth: AuthContext, userId: string) {
  if (!userId || userId === auth.userId) {
    return { error: 'bad_request' as const }
  }

  let deleted: unknown
  try {
    deleted = await controlApiRequest<unknown>(
      'DELETE',
      `/external/teams/${encodeURIComponent(auth.teamId)}/members/${encodeURIComponent(userId)}`,
      {
        userSessionToken: auth.sessionToken,
      }
    )
  } catch (error) {
    return { error: controlApiRefusal(error) }
  }
  return { deleted }
}
