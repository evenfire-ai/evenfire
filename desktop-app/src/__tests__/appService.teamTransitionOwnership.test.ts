import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService deliberate team transition ownership', () => {
  it('finishes GFS activation before a queued workflow read borrows another team', async () => {
    const { service, restA } = await createNativeCommitTestHarness()
    const teamBResponse = deferred<{
      token: string
      team: { id: string; name: string; role: string }
    }>()
    const switchStarted = deferred<void>()
    const tokenTeams = new Map<string, string>([['synthetic-session-a', 'team-a']])
    let issuedToken = 0
    const user = {
      id: 'user-a',
      email: 'user-a@example.test',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const authClient = {
      googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-session-a', me: user }),
      switchTeam: vi.fn(async (_token: string, teamId: string) => {
        if (teamId === 'team-b') {
          switchStarted.resolve()
          const response = await teamBResponse.promise
          tokenTeams.set(response.token, teamId)
          return response
        }
        const token = `synthetic-${teamId}-${++issuedToken}`
        tokenTeams.set(token, teamId)
        return { token, team: { id: teamId, name: teamId, role: 'member' } }
      }),
      getMe: vi.fn(async (token: string) => {
        const teamId = tokenTeams.get(token) || 'team-a'
        return { ...user, teamId, teamName: teamId === 'team-b' ? 'Team B' : 'Team A' }
      }),
      readWorkflow: vi.fn(async (token: string) => ({ token })),
    }
    const app = service as unknown as {
      authClient: typeof authClient
      googleLogin: (token: string) => Promise<unknown>
      switchTeam: (teamId: string) => Promise<unknown>
      readWorkflow: (namespace: string, name: string) => Promise<unknown>
      workflowKey: (namespace: string, name: string) => string
      workflowTeamByKey: Map<string, string>
      activateGfsAuthScope: () => void
      me: { teamId: string } | null
      gfsScopeIdentity: { teamId: string | null; baseUrl: string } | null
      gfsDispatchBlocked: boolean
      gfsTransientTeamHopDepth: number
    }
    app.authClient = authClient
    const activateGfsAuthScope = vi.spyOn(app, 'activateGfsAuthScope')
    await app.googleLogin('synthetic-google-token')
    activateGfsAuthScope.mockClear()
    app.workflowTeamByKey.set(app.workflowKey('workflows', 'approval'), 'team-a')

    const switching = app.switchTeam('team-b')
    await switchStarted.promise
    const workflowRead = app.readWorkflow('workflows', 'approval')
    teamBResponse.resolve({
      token: 'synthetic-session-b',
      team: { id: 'team-b', name: 'Team B', role: 'member' },
    })

    const [switchResult, workflowResult] = await Promise.all([switching, workflowRead])

    expect(switchResult).toMatchObject({ authenticated: true, me: { teamId: 'team-b' } })
    expect(tokenTeams.get(authClient.readWorkflow.mock.calls[0][0])).toBe('team-a')
    expect(workflowResult).toMatchObject({ token: expect.any(String) })
    expect(activateGfsAuthScope).toHaveBeenCalledOnce()
    expect(activateGfsAuthScope.mock.invocationCallOrder[0]).toBeLessThan(
      authClient.readWorkflow.mock.invocationCallOrder[0]
    )
    expect(app.me?.teamId).toBe('team-b')
    expect(app.gfsScopeIdentity).toMatchObject({ teamId: 'team-b', baseUrl: restA })
    expect(app.gfsDispatchBlocked).toBe(false)
    expect(app.gfsTransientTeamHopDepth).toBe(0)
  })
})
