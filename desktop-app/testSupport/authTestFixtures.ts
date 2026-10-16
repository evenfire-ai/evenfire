import type { LoginResult, SessionMe } from '../src/types.js'

export function testSessionMe(overrides: Partial<SessionMe> = {}): SessionMe {
  return {
    id: 'user-a',
    email: 'user-a@example.test',
    name: 'User A',
    picture: null,
    teamId: 'team-a',
    teamName: 'Team A',
    role: 'member',
    ...overrides,
  }
}

export function testLoginResult(
  token = 'synthetic-session-a',
  me: SessionMe = testSessionMe()
): LoginResult {
  return { token, me }
}

export function testTeamSwitchResult(teamId: string, token = `session-${teamId}`) {
  return {
    token,
    team: { id: teamId, name: teamId, role: 'member' as const },
  }
}
