import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import {
  testLoginResult,
  testSessionMe,
  testTeamSwitchResult,
} from '../../testSupport/authTestFixtures.js'

afterEach(async () => {
  vi.useRealTimers()
  await cleanupNativeCommitTestHarness()
})

type Catalog = { userId: string; teamId: string | null; agentNames: string[] }
type App = {
  authClient: unknown
  me: { id: string; teamId: string } | null
  sessionToken: string | null
  sessionGeneration: number
  accessCatalog: Catalog | null
  rpcTokenManager: unknown
  googleLogin(token: string): Promise<unknown>
  listPendingWorkflowApprovals(limit?: number): Promise<unknown[]>
  listWorkflows(): Promise<unknown>
  switchTeam(teamId: string): Promise<unknown>
  logout(): Promise<number>
  refreshAccessCatalog(): Promise<Catalog>
  getAccessCatalog(): Promise<Catalog>
  issueRpcTokenForHostRefs(scopes: string[], refs: string[]): Promise<unknown>
}

async function setup(
  options: {
    pauseTeamBGetMe?: boolean
    pauseRestoreGetMe?: boolean
    homeWithoutTeam?: boolean
  } = {}
) {
  const { service } = await createNativeCommitTestHarness()
  const meA = testSessionMe()
  const meB = testSessionMe({ teamId: 'team-b', teamName: 'Team B' })
  // With homeWithoutTeam the login session has no team. Its token is the only
  // one that answers the no-team principal; the team tokens answer as before.
  const home = testSessionMe({ teamId: null, teamName: null })
  const hopOperation = deferred<{ items: unknown[] }>()
  const hopStarted = deferred<void>()
  const teamBGetMe = deferred<void>()
  const teamBGetMeStarted = deferred<void>()
  const restoreGetMe = deferred<void>()
  const restoreGetMeStarted = deferred<void>()
  const teamAgentsTokens: string[] = []
  const userAgentsTokens: string[] = []
  const switchCalls: string[] = []
  const buildHolds: Array<{
    gate: ReturnType<typeof deferred<void>>
    started: ReturnType<typeof deferred<void>>
  }> = []
  const app = service as unknown as App
  const teamOf = (token: string) => (token === 'synthetic-session-team-b' ? 'team-b' : 'team-a')
  const heldInTeamB = (token: string) => {
    if (token !== 'synthetic-session-team-b') return Promise.resolve({ items: [] })
    hopStarted.resolve()
    return hopOperation.promise
  }
  // Holds the build that consumes the next entry of buildHolds.
  const waitForBuildHold = async () => {
    const hold = buildHolds.shift()
    if (hold) {
      hold.started.resolve()
      await hold.gate.promise
    }
  }
  app.authClient = {
    googleLogin: vi
      .fn()
      .mockResolvedValue(
        testLoginResult('synthetic-session-a', options.homeWithoutTeam ? home : meA)
      ),
    switchTeam: vi.fn(async (_token: string, teamId: string) => {
      switchCalls.push(teamId)
      return testTeamSwitchResult(teamId, `synthetic-session-${teamId}`)
    }),
    getMe: vi.fn(async (token: string) => {
      if (options.pauseTeamBGetMe && token === 'synthetic-session-team-b') {
        teamBGetMeStarted.resolve()
        await teamBGetMe.promise
      }
      if (options.pauseRestoreGetMe && token === 'synthetic-session-team-a') {
        restoreGetMeStarted.resolve()
        await restoreGetMe.promise
      }
      if (options.homeWithoutTeam && token === 'synthetic-session-a') return home
      return teamOf(token) === 'team-a' ? meA : meB
    }),
    listTeams: vi.fn(async () => ({
      currentTeamId: 'team-a',
      items: [
        { id: 'team-a', name: 'Team A' },
        { id: 'team-b', name: 'Team B' },
      ],
    })),
    listPendingWorkflowApprovals: vi.fn(heldInTeamB),
    listWorkflows: vi.fn(heldInTeamB),
    getMyContexts: vi.fn(async () => ({ contextIds: [] })),
    getMyAgents: vi.fn(async (token: string) => {
      userAgentsTokens.push(token)
      // A session with no team issues no team-agents request, so its build is
      // held here instead.
      if (options.homeWithoutTeam) await waitForBuildHold()
      return { agentNames: ['direct-agent'], agents: [] }
    }),
    getTeamContexts: vi.fn(async (token: string) => ({ teamId: teamOf(token), contextIds: [] })),
    getTeamAgents: vi.fn(async (token: string) => {
      teamAgentsTokens.push(token)
      if (!options.homeWithoutTeam) await waitForBuildHold()
      return { teamId: teamOf(token), agentNames: [`${teamOf(token)}-agent`], agents: [] }
    }),
  }
  await app.googleLogin('synthetic-google-token')
  // Holds the next catalog build inside its team-agents request.
  const holdNextBuild = () => {
    const hold = { gate: deferred<void>(), started: deferred<void>() }
    buildHolds.push(hold)
    return hold
  }
  return {
    app,
    hopOperation,
    hopStarted,
    teamBGetMe,
    teamBGetMeStarted,
    restoreGetMe,
    restoreGetMeStarted,
    teamAgentsTokens,
    userAgentsTokens,
    switchCalls,
    holdNextBuild,
  }
}

// Gives already-runnable work time to run, for assertions that something has
// NOT happened. Each such assertion has a positive witness next to it.
const yieldToPendingWork = () => new Promise(resolve => setTimeout(resolve, 20))

// True as soon as the promise settles; false after the limit. Shows that an
// operation finishes while a catalog build is still held, without hanging the
// test when it does not.
const settlesWithin = (promise: Promise<unknown>, ms = 1000) =>
  Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms)),
  ])

const settled = (promise: Promise<Catalog>) =>
  promise.then(
    catalog => ({ resolved: { userId: catalog.userId, teamId: catalog.teamId } }),
    (error: unknown) => ({ rejected: error instanceof Error ? error.message : String(error) })
  )

describe('access catalog: the session is read while it is being replaced', () => {
  it.each([
    ['listPendingWorkflowApprovals', 'refreshAccessCatalog'],
    ['listWorkflows', 'refreshAccessCatalog'],
    ['listPendingWorkflowApprovals', 'getAccessCatalog'],
  ] as const)(
    'a catalog requested while a %s hop is open is built from the home session (%s)',
    async (hopSource, entry) => {
      const { app, hopOperation, hopStarted, teamAgentsTokens } = await setup()
      const hop =
        hopSource === 'listWorkflows' ? app.listWorkflows() : app.listPendingWorkflowApprovals(20)
      await hopStarted.promise
      expect({ me: app.me?.teamId, token: app.sessionToken }).toEqual({
        me: 'team-b',
        token: 'synthetic-session-team-b',
      })
      const generation = app.sessionGeneration
      const pending = app[entry]()
      await yieldToPendingWork()
      expect(teamAgentsTokens).toEqual([])
      hopOperation.resolve({ items: [] })
      await hop
      const catalog = await pending
      expect(teamAgentsTokens).toEqual(['synthetic-session-team-a'])
      expect(catalog.teamId).toBe('team-a')
      expect(catalog.agentNames).toEqual(['direct-agent', 'team-a-agent'])
      expect(app.accessCatalog?.teamId).toBe('team-a')
      expect(app.sessionGeneration).toBe(generation)
    }
  )

  it('a catalog requested while a hop commit is half applied is built from the home session', async () => {
    const { app, hopOperation, teamBGetMe, teamBGetMeStarted, teamAgentsTokens } = await setup({
      pauseTeamBGetMe: true,
    })
    const approvals = app.listPendingWorkflowApprovals(20)
    await teamBGetMeStarted.promise
    expect({ me: app.me?.teamId, token: app.sessionToken }).toEqual({
      me: 'team-a',
      token: 'synthetic-session-team-b',
    })
    const pending = app.refreshAccessCatalog()
    await yieldToPendingWork()
    expect(teamAgentsTokens).toEqual([])
    teamBGetMe.resolve()
    hopOperation.resolve({ items: [] })
    await approvals
    const catalog = await pending
    expect(teamAgentsTokens).toEqual(['synthetic-session-team-a'])
    expect(catalog.teamId).toBe('team-a')
    expect(catalog.agentNames).toEqual(['direct-agent', 'team-a-agent'])
  })

  it('a catalog requested while the hop restore is half applied is built from the home session', async () => {
    const { app, hopOperation, hopStarted, restoreGetMe, restoreGetMeStarted, teamAgentsTokens } =
      await setup({ pauseRestoreGetMe: true })
    const approvals = app.listPendingWorkflowApprovals(20)
    await hopStarted.promise
    hopOperation.resolve({ items: [] })
    await restoreGetMeStarted.promise
    expect({ me: app.me?.teamId, token: app.sessionToken }).toEqual({
      me: 'team-b',
      token: 'synthetic-session-team-a',
    })
    const pending = app.refreshAccessCatalog()
    await yieldToPendingWork()
    expect(teamAgentsTokens).toEqual([])
    restoreGetMe.resolve()
    await approvals
    const catalog = await pending
    expect(teamAgentsTokens).toEqual(['synthetic-session-team-a'])
    expect(catalog.teamId).toBe('team-a')
    expect(catalog.agentNames).toEqual(['direct-agent', 'team-a-agent'])
  })

  it('a catalog requested while a deliberate switch is half applied is built from the new session', async () => {
    const { app, teamBGetMe, teamBGetMeStarted, teamAgentsTokens } = await setup({
      pauseTeamBGetMe: true,
    })
    const switching = app.switchTeam('team-b')
    await teamBGetMeStarted.promise
    expect({ me: app.me?.teamId, token: app.sessionToken }).toEqual({
      me: 'team-a',
      token: 'synthetic-session-team-b',
    })
    const pending = app.refreshAccessCatalog()
    await yieldToPendingWork()
    expect(teamAgentsTokens).toEqual([])
    teamBGetMe.resolve()
    await switching
    const catalog = await pending
    expect(app.me?.teamId).toBe('team-b')
    expect(teamAgentsTokens).toEqual(['synthetic-session-team-b'])
    expect(catalog.teamId).toBe('team-b')
    expect(catalog.agentNames).toEqual(['direct-agent', 'team-b-agent'])
  })
})

describe('access catalog: a build in flight delays nothing else', () => {
  it('a hop that opens and closes during a build does not wait for it, and the catalog is published for the home session', async () => {
    const { app, hopOperation, hopStarted, teamAgentsTokens, holdNextBuild } = await setup()
    const { gate, started } = holdNextBuild()
    const pending = app.refreshAccessCatalog()
    await started.promise // the build is in flight, held in its team-agents request
    const approvals = app.listPendingWorkflowApprovals(20)
    // The hop's operation starts while the build is still held.
    expect(await settlesWithin(hopStarted.promise)).toBe(true)
    expect({ me: app.me?.teamId, token: app.sessionToken }).toEqual({
      me: 'team-b',
      token: 'synthetic-session-team-b',
    })
    hopOperation.resolve({ items: [] })
    await approvals
    // The hop closed with a new home token; the build still holds the earlier one.
    expect({ me: app.me?.teamId, token: app.sessionToken }).toEqual({
      me: 'team-a',
      token: 'synthetic-session-team-a',
    })
    gate.resolve()
    const catalog = await pending
    expect(teamAgentsTokens).toEqual(['synthetic-session-a'])
    expect(catalog.teamId).toBe('team-a')
    expect(catalog.agentNames).toEqual(['direct-agent', 'team-a-agent'])
    expect(app.accessCatalog?.teamId).toBe('team-a')
  })

  it('a build that finishes while a hop is open is published once, after the restore', async () => {
    const { app, hopOperation, hopStarted, teamAgentsTokens, holdNextBuild } = await setup()
    const { gate, started } = holdNextBuild()
    const pending = app.refreshAccessCatalog()
    await started.promise
    const approvals = app.listPendingWorkflowApprovals(20)
    expect(await settlesWithin(hopStarted.promise)).toBe(true)
    gate.resolve() // the build finishes while the hop is open
    await yieldToPendingWork()
    expect(app.me?.teamId).toBe('team-b') // the hop is still open
    hopOperation.resolve({ items: [] })
    await approvals
    const catalog = await pending
    expect(teamAgentsTokens).toEqual(['synthetic-session-a'])
    expect(catalog.teamId).toBe('team-a')
    expect(catalog.agentNames).toEqual(['direct-agent', 'team-a-agent'])
    expect(app.accessCatalog?.teamId).toBe('team-a')
  })

  it('rpc-token issuance for a team agent runs while a build is held', async () => {
    const { app, holdNextBuild } = await setup()
    const issued: string[] = []
    app.rpcTokenManager = {
      clear: vi.fn(),
      getOrIssue: vi.fn(async (token: string) => {
        issued.push(token)
        return { token: 'rpc-synthetic', expiresAt: Date.now() + 60_000 }
      }),
    }
    await app.refreshAccessCatalog() // publish a team-a catalog so the agent resolves to team-a
    const { gate, started } = holdNextBuild()
    const pending = app.refreshAccessCatalog()
    await started.promise
    const rpc = app.issueRpcTokenForHostRefs(['host:invoke'], ['team-a-agent'])
    expect(await settlesWithin(rpc)).toBe(true)
    expect(issued).toEqual(['synthetic-session-a'])
    gate.resolve()
    const catalog = await pending
    expect(catalog.teamId).toBe('team-a')
  })

  it('a deliberate switch completes while a build is held', async () => {
    const { app, holdNextBuild, switchCalls } = await setup()
    const { gate, started } = holdNextBuild()
    const pending = settled(app.refreshAccessCatalog())
    await started.promise
    expect(await settlesWithin(app.switchTeam('team-b'))).toBe(true)
    expect(switchCalls).toEqual(['team-b'])
    expect(app.me?.teamId).toBe('team-b')
    gate.resolve()
    await pending // what the request answers after the switch is tested below
  })

  it('logout completes while a build is held', async () => {
    const { app, holdNextBuild } = await setup()
    const generationBefore = app.sessionGeneration
    const { gate, started } = holdNextBuild()
    const pending = settled(app.refreshAccessCatalog())
    await started.promise
    expect(await settlesWithin(app.logout())).toBe(true)
    expect(app.sessionToken).toBeNull()
    expect(app.sessionGeneration).toBeGreaterThan(generationBefore)
    gate.resolve()
    await pending // what the request answers after the logout is tested below
  })

  it('hops from a session with no team move the team without a new generation, and the build is discarded', async () => {
    const { app, hopOperation, hopStarted, userAgentsTokens, holdNextBuild } = await setup({
      homeWithoutTeam: true,
    })
    expect({ team: app.me?.teamId ?? null, token: app.sessionToken }).toEqual({
      team: null,
      token: 'synthetic-session-a',
    })
    const generation = app.sessionGeneration
    const { gate, started } = holdNextBuild()
    const pending = app.refreshAccessCatalog()
    await started.promise // the build for the session with no team is in flight
    // The hops: into team-a with nothing to restore, then into team-b and back
    // to team-a.
    const approvals = app.listPendingWorkflowApprovals(20)
    await hopStarted.promise
    hopOperation.resolve({ items: [] })
    await approvals
    // Witness: the team moved and the generation did not, so only the team
    // comparison can tell the build's session from the current one.
    expect({
      team: app.me?.teamId,
      token: app.sessionToken,
      generation: app.sessionGeneration,
    }).toEqual({ team: 'team-a', token: 'synthetic-session-team-a', generation })
    gate.resolve()
    const catalog = await pending
    expect(catalog.teamId).toBe('team-a')
    expect(app.accessCatalog?.teamId).toBe('team-a')
    expect(userAgentsTokens).toEqual(['synthetic-session-a', 'synthetic-session-team-a'])
  })
})

describe('access catalog: the session is replaced during a build', () => {
  it('a deliberate switch during a build discards it, and the request answers with the new session', async () => {
    const { app, holdNextBuild, teamAgentsTokens } = await setup()
    const { gate, started } = holdNextBuild()
    const pending = app.refreshAccessCatalog()
    await started.promise
    expect(await settlesWithin(app.switchTeam('team-b'))).toBe(true)
    expect(app.me?.teamId).toBe('team-b')
    gate.resolve()
    const catalog = await pending
    // One build with the old session, then exactly one rebuild with the new one.
    expect(teamAgentsTokens).toEqual(['synthetic-session-a', 'synthetic-session-team-b'])
    expect(catalog.teamId).toBe('team-b')
    expect(catalog.agentNames).toEqual(['direct-agent', 'team-b-agent'])
    expect(app.accessCatalog?.teamId).toBe('team-b')
  })

  it('a logout during a build publishes nothing, and the request fails', async () => {
    const { app, holdNextBuild, teamAgentsTokens } = await setup()
    const { gate, started } = holdNextBuild()
    const pending = settled(app.refreshAccessCatalog())
    await started.promise
    expect(await settlesWithin(app.logout())).toBe(true)
    expect(app.sessionToken).toBeNull()
    gate.resolve()
    // Witness that the build ran to its end: its team-agents request was made
    // and released, and the request settled.
    expect(await pending).toEqual({ rejected: expect.stringContaining('stale_auth_epoch') })
    expect(teamAgentsTokens).toEqual(['synthetic-session-a'])
    expect(app.accessCatalog).toBeNull()
  })

  it('another user signing in during a build gets nothing from it, and the request fails', async () => {
    const { app, holdNextBuild, teamAgentsTokens } = await setup()
    const { gate, started } = holdNextBuild()
    const pending = settled(app.refreshAccessCatalog())
    await started.promise
    expect(await settlesWithin(app.logout())).toBe(true)
    const otherUser = testSessionMe({ id: 'user-b', email: 'user-b@example.test', name: 'User B' })
    Object.assign(app.authClient as object, {
      googleLogin: vi.fn().mockResolvedValue(testLoginResult('synthetic-session-b', otherUser)),
    })
    await app.googleLogin('synthetic-google-token-b')
    expect(app.me?.id).toBe('user-b') // witness: the other user is signed in
    gate.resolve()
    expect(await pending).toEqual({ rejected: expect.stringContaining('stale_auth_epoch') })
    // One build, with the first user's token; no request was made for the other user.
    expect(teamAgentsTokens).toEqual(['synthetic-session-a'])
    expect(app.accessCatalog).toBeNull()
  })

  it('a second session change during the rebuild fails loud after exactly two builds', async () => {
    const { app, holdNextBuild, teamAgentsTokens } = await setup()
    const first = holdNextBuild()
    const second = holdNextBuild()
    const pending = settled(app.refreshAccessCatalog())
    await first.started.promise
    expect(await settlesWithin(app.switchTeam('team-b'))).toBe(true)
    first.gate.resolve()
    // The rebuild is in flight with the team-b session.
    expect(await settlesWithin(second.started.promise)).toBe(true)
    expect(await settlesWithin(app.switchTeam('team-a'))).toBe(true)
    second.gate.resolve()
    expect(await pending).toEqual({ rejected: expect.stringContaining('stale_auth_epoch') })
    expect(teamAgentsTokens).toEqual(['synthetic-session-a', 'synthetic-session-team-b'])
    expect(app.accessCatalog).toBeNull()
  })

  it('the same user signing in again during a build gets a rebuild with the new session', async () => {
    const { app, holdNextBuild, teamAgentsTokens } = await setup()
    const { gate, started } = holdNextBuild()
    const pending = app.refreshAccessCatalog()
    await started.promise
    const generation = app.sessionGeneration
    expect(await settlesWithin(app.logout())).toBe(true)
    Object.assign(app.authClient as object, {
      googleLogin: vi
        .fn()
        .mockResolvedValue(testLoginResult('synthetic-session-a2', testSessionMe())),
    })
    await app.googleLogin('synthetic-google-token-a2')
    expect({ id: app.me?.id, team: app.me?.teamId, token: app.sessionToken }).toEqual({
      id: testSessionMe().id,
      team: 'team-a',
      token: 'synthetic-session-a2',
    })
    expect(app.sessionGeneration).toBeGreaterThan(generation)
    gate.resolve()
    const catalog = await pending
    expect(teamAgentsTokens).toEqual(['synthetic-session-a', 'synthetic-session-a2'])
    expect(catalog.teamId).toBe('team-a')
    expect(app.accessCatalog?.teamId).toBe('team-a')
  })
})
