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
  token = testSessionTokenWithExpiry(),
  me: SessionMe = testSessionMe()
): LoginResult {
  return { token, me }
}

export function testSessionTokenWithExpiry(expiresAt = Date.now() + 60 * 60 * 1000): string {
  const header = Buffer.from(JSON.stringify({ alg: 'test', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString(
    'base64url'
  )
  return `${header}.${payload}.test-signature`
}

export function testSessionTokenForIdentity(
  userId: string,
  teamId: string | null,
  expiresAt = Date.now() + 60 * 60 * 1000
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'test', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      teamId,
      exp: Math.floor(expiresAt / 1000),
      jti: `test-session-${userId}-${teamId ?? 'teamless'}`,
    })
  ).toString('base64url')
  return `${header}.${payload}.test-signature`
}

export function testTeamSwitchResult(teamId: string, token = `session-${teamId}`) {
  return {
    token,
    team: { id: teamId, name: teamId, role: 'member' as const },
  }
}
