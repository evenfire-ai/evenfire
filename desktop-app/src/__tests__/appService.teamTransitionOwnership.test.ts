import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService deliberate team transition ownership', () => {
  it('returns a committed same-team approval before a queued logout', async () => {
    const { service } = await createNativeCommitTestHarness()
    const decisionResponse = deferred<{ approvalId: string; status: string }>()
    const decisionStarted = deferred<void>()
    const logoutCleanupStarted = vi.fn()
    const me = {
      id: 'user-a',
      email: 'user-a@example.test',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const app = service as unknown as {
      authClient: unknown
      decideWorkflowApproval(
        approvalId: string,
        decision: 'approve' | 'reject',
        note?: string,
        options?: { teamId?: string | null }
      ): Promise<{ approvalId: string; status: string }>
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    app.authClient = {
      googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-session-a', me }),
      decideWorkflowApproval: vi.fn(() => {
        decisionStarted.resolve()
        return decisionResponse.promise
      }),
    }
    app.suspendDesktopGfsUploadsForAuthBoundary = vi.fn(async () => {
      logoutCleanupStarted()
    })
    await service.googleLogin('synthetic-google-token')

    const decision = app.decideWorkflowApproval('approval-a', 'approve', undefined, {
      teamId: 'team-a',
    })
    await decisionStarted.promise
    const logout = service.logout()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(logoutCleanupStarted).not.toHaveBeenCalled()

    const committedResponse = { approvalId: 'approval-a', status: 'approved' }
    decisionResponse.resolve(committedResponse)
    await expect(decision).resolves.toEqual(committedResponse)
    await expect(logout).resolves.toBeTypeOf('number')
  })

  it('keeps a saved-session restore when RPC discovery completes before getMe', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const discovery = deferred<{
      externalRestApiBaseUrl: string
      rpcProxyBaseUrl: string
      appName: string
    }>()
    const discoveryStarted = deferred<void>()
    const getMeResponse = deferred<{
      id: string
      email: string
      name: string
      picture: null
      teamId: string
      teamName: string
      role: string
    }>()
    const getMeStarted = deferred<void>()
    const me = {
      id: 'user-a',
      email: 'user-a@example.test',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const app = service as unknown as {
      authClient: unknown
      rpcClient: unknown
      tokenStore: { getSessionToken: ReturnType<typeof vi.fn> }
      getDependenciesHealth(): Promise<unknown>
    }
    app.tokenStore.getSessionToken.mockResolvedValue('saved-session-a')
    const getMe = vi.fn(() => {
      getMeStarted.resolve()
      return getMeResponse.promise
    })
    const getDesktopEnvironment = vi.fn(() => {
      discoveryStarted.resolve()
      return discovery.promise
    })
    app.authClient = {
      getDesktopEnvironment,
      getMe,
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    }
    app.rpcClient = { health: vi.fn().mockResolvedValue({ status: 'ok' }) }

    const healthRequest = app.getDependenciesHealth()
    await discoveryStarted.promise
    const restore = service.getSessionState()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getMe).not.toHaveBeenCalled()
    discovery.resolve({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
      appName: 'Environment A',
    })
    await healthRequest
    await getMeStarted.promise
    getMeResponse.resolve(me)

    await expect(restore).resolves.toEqual({ authenticated: true, me })
  })

  it('accepts Google login when RPC discovery enriches its captured REST profile', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const discovery = deferred<{
      externalRestApiBaseUrl: string
      rpcProxyBaseUrl: string
      appName: string
    }>()
    const discoveryStarted = deferred<void>()
    const getDesktopEnvironment = vi.fn(() => {
      discoveryStarted.resolve()
      return discovery.promise
    })
    const loginResponse = deferred<{
      token: string
      me: {
        id: string
        email: string
        name: string
        picture: null
        teamId: string
        teamName: string
        role: string
      }
    }>()
    const loginStarted = deferred<void>()
    const me = {
      id: 'user-a',
      email: 'user-a@example.test',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const app = service as unknown as {
      authClient: unknown
      rpcClient: unknown
      getDependenciesHealth(): Promise<unknown>
    }
    const googleLogin = vi.fn(() => {
      loginStarted.resolve()
      return loginResponse.promise
    })
    app.authClient = {
      getDesktopEnvironment,
      googleLogin,
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    }
    app.rpcClient = { health: vi.fn().mockResolvedValue({ status: 'ok' }) }

    const login = service.googleLogin('synthetic-google-token')
    const healthRequest = app.getDependenciesHealth()
    await discoveryStarted.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(googleLogin).not.toHaveBeenCalled()
    discovery.resolve({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
      appName: 'Environment A',
    })
    await healthRequest
    await loginStarted.promise
    loginResponse.resolve({ token: 'synthetic-session-a', me })

    await expect(login).resolves.toEqual({ authenticated: true, me })
  })

  it('persists RPC discovery after a saved-session restore advances the generation', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    const discovery = deferred<{
      externalRestApiBaseUrl: string
      rpcProxyBaseUrl: string
      appName: string
    }>()
    const discoveryStarted = deferred<void>()
    const me = {
      id: 'user-a',
      email: 'user-a@example.test',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const app = service as unknown as {
      authClient: unknown
      rpcClient: unknown
      tokenStore: { getSessionToken: ReturnType<typeof vi.fn> }
      getDependenciesHealth(): Promise<unknown>
      saveRuntimeConfig(config: {
        externalRestApiBaseUrl: string
        rpcProxyBaseUrl: string
        appName: string
      }): Promise<unknown>
    }
    app.tokenStore.getSessionToken.mockResolvedValue('saved-session-a')
    const getMe = vi.fn().mockResolvedValue(me)
    const getDesktopEnvironment = vi.fn(() => {
      discoveryStarted.resolve()
      return discovery.promise
    })
    app.authClient = {
      getDesktopEnvironment,
      getMe,
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    }
    app.rpcClient = { health: vi.fn().mockResolvedValue({ status: 'ok' }) }

    const save = app.saveRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    await discoveryStarted.promise
    const restore = service.getSessionState()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getMe).not.toHaveBeenCalled()
    discovery.resolve({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
      appName: 'Environment A',
    })
    await save
    await expect(restore).resolves.toEqual({ authenticated: true, me })
    expect(getDesktopEnvironment).toHaveBeenCalledOnce()

    expect(runtimeConfig.getDesktopRuntimeConfigState().currentConfig.rpcProxyBaseUrl).toBe(
      'https://rpc-discovered.example.test'
    )
  })

  it('keeps the public session generation stable through transient team hops', async () => {
    const { service } = await createNativeCommitTestHarness()
    const meA = {
      id: 'user-a',
      email: 'user-a@example.test',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const meB = { ...meA, teamId: 'team-b', teamName: 'Team B' }
    const app = service as unknown as {
      authClient: unknown
      readWorkflow(ns: string, name: string): Promise<unknown>
      workflowTeamByKey: Map<string, string>
      workflowKey(ns: string, name: string): string
      getSessionGeneration(): number
    }
    let currentTeamId = 'team-a'
    app.authClient = {
      googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-session-a', me: meA }),
      switchTeam: vi.fn(async (_token: string, teamId: string) => {
        currentTeamId = teamId
        return { token: `session-${teamId}`, team: { id: teamId, name: teamId, role: 'member' } }
      }),
      getMe: vi.fn(async () => (currentTeamId === 'team-a' ? meA : meB)),
      readWorkflow: vi.fn().mockResolvedValue({ workflow: 'result' }),
    }
    await service.googleLogin('synthetic-google-token')
    app.workflowTeamByKey.set(app.workflowKey('team-a', 'flow-a'), 'team-b')
    const sessionGeneration = app.getSessionGeneration()

    await expect(app.readWorkflow('team-a', 'flow-a')).resolves.toEqual({ workflow: 'result' })

    expect(app.getSessionGeneration()).toBe(sessionGeneration)
  })

  it('advances session generation when a failed restore leaves the borrowed team active', async () => {
    const { service } = await createNativeCommitTestHarness()
    const meA = {
      id: 'user-a',
      email: 'user-a@example.test',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const meB = { ...meA, teamId: 'team-b', teamName: 'Team B' }
    const app = service as unknown as {
      authClient: unknown
      me: { teamId: string } | null
      sessionToken: string | null
      readWorkflow(ns: string, name: string): Promise<unknown>
      workflowTeamByKey: Map<string, string>
      workflowKey(ns: string, name: string): string
      getSessionGeneration(): number
    }
    let currentTeamId = 'team-a'
    app.authClient = {
      googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-session-a', me: meA }),
      switchTeam: vi.fn(async (_token: string, teamId: string) => {
        if (teamId === 'team-a' && currentTeamId === 'team-b') {
          throw new Error('restore rejected')
        }
        currentTeamId = teamId
        return { token: `session-${teamId}`, team: { id: teamId, name: teamId, role: 'member' } }
      }),
      getMe: vi.fn(async () => (currentTeamId === 'team-a' ? meA : meB)),
      readWorkflow: vi.fn().mockResolvedValue({ workflow: 'result' }),
    }
    await service.googleLogin('synthetic-google-token')
    app.workflowTeamByKey.set(app.workflowKey('team-a', 'flow-a'), 'team-b')
    const previousGeneration = app.getSessionGeneration()

    await expect(app.readWorkflow('team-a', 'flow-a')).rejects.toThrow('restore rejected')

    expect(app.me?.teamId).toBe('team-b')
    expect(app.sessionToken).toBe('session-team-b')
    expect(app.getSessionGeneration()).toBe(previousGeneration + 1)
  })

  it.each(['Google', 'password'])(
    '%s login continues when optional RPC discovery fails',
    async loginMethod => {
      const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
      await runtimeConfig.saveDesktopRuntimeConfig({
        externalRestApiBaseUrl: restA,
        rpcProxyBaseUrl: '',
        appName: 'Environment A',
      })
      const me = {
        id: 'user-a',
        email: 'user-a@example.test',
        name: 'User A',
        picture: null,
        teamId: 'team-a',
        teamName: 'Team A',
        role: 'member',
      }
      const getDesktopEnvironment = vi
        .fn()
        .mockRejectedValue(new Error('RPC discovery unavailable'))
      const googleLogin = vi.fn().mockResolvedValue({ token: 'google-session-a', me })
      const passwordLogin = vi.fn().mockResolvedValue({ token: 'password-session-a', me })
      const app = service as unknown as { authClient: unknown }
      app.authClient = { getDesktopEnvironment, googleLogin, passwordLogin }

      const result =
        loginMethod === 'Google'
          ? await service.googleLogin('synthetic-google-token')
          : await service.passwordLogin('user-a@example.test', 'synthetic-password')

      expect(result).toMatchObject({ authenticated: true, me })
      expect(getDesktopEnvironment).toHaveBeenCalledOnce()
      if (loginMethod === 'Google') {
        expect(googleLogin).toHaveBeenCalledWith('synthetic-google-token')
        expect(passwordLogin).not.toHaveBeenCalled()
      } else {
        expect(passwordLogin).toHaveBeenCalledWith('user-a@example.test', 'synthetic-password')
        expect(googleLogin).not.toHaveBeenCalled()
      }
    }
  )

  it('rejects a stale handoff generation after a public login advances the session', async () => {
    const { service, runtimeConfig, optionA } = await createNativeCommitTestHarness()
    const app = service as unknown as {
      authClient: unknown
      selectRuntimeConfigForHandoff(optionId: string, generation: number): Promise<unknown>
    }
    app.authClient = {
      googleLogin: vi.fn().mockResolvedValue({
        token: 'fixture-session-a',
        me: {
          id: 'user-a',
          email: 'user-a@example.test',
          name: 'User A',
          picture: null,
          teamId: 'team-a',
          teamName: 'Team A',
          role: 'member',
        },
      }),
    }
    const previousGeneration = service.getSessionGeneration()
    await service.googleLogin('synthetic-google-token')

    await expect(app.selectRuntimeConfigForHandoff(optionA.id, previousGeneration)).rejects.toThrow(
      'stale_session_generation'
    )
    expect(runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(optionA.id)
  })

  it('keeps REST discovery for the same profile when logout advances session generation', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    const discovery = deferred<{
      externalRestApiBaseUrl: string
      rpcProxyBaseUrl: string
      appName: string
    }>()
    const discoveryStarted = deferred<void>()
    const getDesktopEnvironment = vi.fn(() => {
      discoveryStarted.resolve()
      return discovery.promise
    })
    const app = service as unknown as {
      sessionToken: string | null
      me: { id: string; email: string; name: string; picture: null; teamId: string; role: string }
      authClient: unknown
      rpcClient: unknown
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
      getDependenciesHealth(): Promise<unknown>
    }
    app.authClient = {
      googleLogin: vi.fn().mockResolvedValue({
        token: 'synthetic-session-a',
        me: {
          id: 'user-a',
          email: 'user-a@example.test',
          name: 'User A',
          picture: null,
          teamId: 'team-a',
          teamName: 'Team A',
          role: 'member',
        },
      }),
      getDesktopEnvironment,
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    }
    app.rpcClient = { health: vi.fn().mockResolvedValue({ status: 'ok' }) }
    await service.googleLogin('synthetic-google-token')
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    app.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)

    const healthRequest = app.getDependenciesHealth()
    await discoveryStarted.promise
    await expect(service.logout()).resolves.toBeTypeOf('number')
    discovery.resolve({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
      appName: 'Environment A',
    })
    await healthRequest

    expect(app.sessionToken).toBeNull()
    expect(runtimeConfig.getDesktopRuntimeConfigState().currentConfig.rpcProxyBaseUrl).toBe(
      'https://rpc-discovered.example.test'
    )
  })

  it('lets logout commit while a same-team request is pending and rejects its stale result', async () => {
    const { service } = await createNativeCommitTestHarness()
    const request = deferred<string>()
    const requestStarted = deferred<void>()
    const app = service as unknown as {
      sessionToken: string | null
      me: {
        id: string
        email: string
        name: string
        picture: null
        teamId: string
        teamName: string
        role: string
      } | null
      runWithTeamContext<T>(teamId: string, operation: (token: string) => Promise<T>): Promise<T>
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    app.authClient = {
      googleLogin: vi.fn().mockResolvedValue({
        token: 'synthetic-session-a',
        me: {
          id: 'user-a',
          email: 'user-a@example.test',
          name: 'User A',
          picture: null,
          teamId: 'team-a',
          teamName: 'Team A',
          role: 'member',
        },
      }),
    }
    await service.googleLogin('synthetic-google-token')
    app.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
    const operation = app.runWithTeamContext('team-a', async () => {
      requestStarted.resolve()
      return request.promise
    })
    await requestStarted.promise

    await expect(service.logout()).resolves.toBeTypeOf('number')
    request.resolve('old-session-result')

    await expect(operation).rejects.toThrow(/stale_(auth_epoch|session_generation)/)
    expect(app.sessionToken).toBeNull()
  })

  it('lets logout commit during teamless session scope discovery', async () => {
    const { service } = await createNativeCommitTestHarness()
    const meResponse = deferred<{
      id: string
      email: string
      name: string
      picture: null
      teamId: string
      teamName: string
      role: string
    }>()
    const discoveryStarted = deferred<void>()
    const logoutStarted = deferred<void>()
    const app = service as unknown as {
      sessionToken: string | null
      me: {
        id: string
        email: string
        name: string
        picture: null
        teamId: string | null
        teamName: string | null
        role: string
      } | null
      authClient: unknown
      runWithTeamContext<T>(teamId: string, operation: (token: string) => Promise<T>): Promise<T>
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    app.authClient = {
      googleLogin: vi.fn().mockResolvedValue({
        token: 'synthetic-session-a',
        me: {
          id: 'user-a',
          email: 'user-a@example.test',
          name: 'User A',
          picture: null,
          teamId: null,
          teamName: null,
          role: 'member',
        },
      }),
      getMe: vi.fn(() => {
        discoveryStarted.resolve()
        return meResponse.promise
      }),
    }
    await service.googleLogin('synthetic-google-token')
    app.suspendDesktopGfsUploadsForAuthBoundary = vi.fn(async () => logoutStarted.resolve())
    const operation = vi.fn(async () => 'team result')
    const contextRequest = app.runWithTeamContext('team-a', operation)
    await discoveryStarted.promise

    const logout = service.logout()
    const logoutWasResponsive = await Promise.race([
      logoutStarted.promise.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
    ])
    meResponse.resolve({
      id: 'user-a',
      email: 'user-a@example.test',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    })

    await expect(contextRequest).rejects.toThrow(/stale_(auth_epoch|session_generation)/)
    await expect(logout).resolves.toBeTypeOf('number')
    expect(logoutWasResponsive).toBe(true)
    expect(operation).not.toHaveBeenCalled()
    expect(app.sessionToken).toBeNull()
  })

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
