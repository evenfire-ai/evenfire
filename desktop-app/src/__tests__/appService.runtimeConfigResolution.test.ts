import { afterEach, describe, expect, it, vi } from 'vitest'
import { persistAcceptedPasswordSession } from '../../testSupport/acceptedPasswordSession.js'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import {
  testLoginResult,
  testSessionMe,
  testSessionTokenWithExpiry,
} from '../../testSupport/authTestFixtures.js'

afterEach(cleanupNativeCommitTestHarness)

type DesktopEnvironmentDiscovery = {
  externalRestApiBaseUrl: string
  rpcProxyBaseUrl: string
  appName: string
}

describe('AppService runtime config discovery ownership', () => {
  it('uses RPC discovery completed before the signed-out login result is installed', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const restOnlyEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    const me = testSessionMe()
    const app = service as unknown as {
      authClient: {
        getDesktopEnvironment: ReturnType<typeof vi.fn>
        passwordLogin: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
      }
    }
    app.authClient = {
      getDesktopEnvironment: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: restA,
        rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
        appName: 'Environment A',
      }),
      passwordLogin: vi.fn().mockResolvedValue(testLoginResult(testSessionTokenWithExpiry(), me)),
      getMe: vi.fn().mockResolvedValue(me),
    }

    const candidateWrite = vi.spyOn(service.tokenStore, 'writeSessionTokenCandidate')
    await service.passwordLogin('user-a@example.test', 'fixture-password')

    const rpcEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    expect(rpcEnvKey).not.toBe(restOnlyEnvKey)
    expect(candidateWrite).not.toHaveBeenCalled()
    expect(service.sessionToken).not.toBeNull()
    const { getChatStore } = await import('../chatStoreBinding.js')
    expect(getChatStore().getAuthorityScope()).toEqual({
      environmentKey: rpcEnvKey,
      userId: me.id,
      teamId: me.teamId,
    })
  })

  it('uses late RPC discovery for the active session without rebinding its durable identity', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const restOnlyEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    const me = testSessionMe()
    const getDesktopEnvironment = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary discovery failure'))
      .mockResolvedValue({
        externalRestApiBaseUrl: restA,
        rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
        appName: 'Environment A',
      })
    const app = service as unknown as {
      authClient: {
        getDesktopEnvironment: typeof getDesktopEnvironment
        passwordLogin: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
        health: ReturnType<typeof vi.fn>
      }
      rpcClient: { health: ReturnType<typeof vi.fn> }
      getEffectiveRpcProxyBaseUrl: () => string
      getDependenciesHealth: () => Promise<unknown>
      getChatDeletionFenceAuthority: () => {
        authorityScope: { environmentKey: string }
        sessionGeneration: number
      }
      openDesktop: (hostRef: string) => Promise<void>
      gfsScopeIdentity: { environmentKey: string } | null
    }
    app.authClient = {
      getDesktopEnvironment,
      passwordLogin: vi
        .fn()
        .mockResolvedValueOnce(testLoginResult(testSessionTokenWithExpiry(), me))
        .mockResolvedValueOnce(
          testLoginResult(testSessionTokenWithExpiry(Date.now() + 2 * 60 * 60 * 1000), me)
        ),
      getMe: vi.fn().mockResolvedValue(me),
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    }
    const { AuthClient } = await import('../authClient.js')
    vi.spyOn(AuthClient.prototype, 'issueRpcToken').mockResolvedValue({
      token: 'fixture-rpc-token',
      accessScope: 'team',
      teamId: 'team-a',
      scopes: ['desktop:view'],
      hostRefs: ['chatllm'],
      expiresInSeconds: 60,
    })
    app.rpcClient = { health: vi.fn().mockResolvedValue({ status: 'ok' }) }

    const candidateWrite = vi.spyOn(service.tokenStore, 'writeSessionTokenCandidate')
    await service.passwordLogin('user-a@example.test', 'fixture-password')
    const generation = service.getSessionGeneration()
    const { bindChatStoreForUser } = await import('../chatStoreBinding.js')
    const activeBindingCount = vi.mocked(bindChatStoreForUser).mock.calls.length
    expect(candidateWrite).not.toHaveBeenCalled()
    const firstToken = service.sessionToken
    expect(firstToken).not.toBeNull()

    await app.getDependenciesHealth()
    await app.getDependenciesHealth()
    await app.getDependenciesHealth()

    expect(runtimeConfig.getDesktopRuntimeConfigState().envKey).toBe(restOnlyEnvKey)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('')
    expect(app.getEffectiveRpcProxyBaseUrl()).toBe('https://rpc-discovered.example.test')
    expect(getDesktopEnvironment).toHaveBeenCalledTimes(2)
    expect(candidateWrite).not.toHaveBeenCalled()
    expect(vi.mocked(bindChatStoreForUser)).toHaveBeenCalledTimes(activeBindingCount)
    expect(app.getChatDeletionFenceAuthority().authorityScope.environmentKey).toBe(restOnlyEnvKey)
    expect(service.getSessionGeneration()).toBe(generation)
    expect(service.getCachedUserId()).toBe('user-a')
    expect(app.gfsScopeIdentity?.environmentKey).toBe(restOnlyEnvKey)

    const openDesktopWindow = vi.fn().mockResolvedValue(undefined)
    vi.doMock('../desktopWindow.js', () => ({
      openDesktopWindow,
      closeAllDesktopWindows: vi.fn().mockResolvedValue(undefined),
    }))
    await app.openDesktop('chatllm')
    expect(openDesktopWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        hostRef: 'chatllm',
        rpcProxyUrl: 'https://rpc-discovered.example.test',
      })
    )

    await service.logout()

    const rpcConfiguredEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    // M logout keeps the configured durable identity unchanged. Discovery made while the
    // previous session was active is applied only when a new auth boundary starts.
    expect(rpcConfiguredEnvKey).toBe(restOnlyEnvKey)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('')
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    expect(
      await readSessionAuthoritySourceSelection({
        tokenStore: service.tokenStore,
        envKey: restOnlyEnvKey,
      })
    ).toMatchObject({ status: 'denied', frameMode: 'logged-out' })
    expect(app.gfsScopeIdentity).toBeNull()

    await service.passwordLogin('user-a@example.test', 'fixture-password')
    const nextConfiguredEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    expect(nextConfiguredEnvKey).not.toBe(restOnlyEnvKey)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
    expect(candidateWrite).not.toHaveBeenCalled()
    expect(service.sessionToken).not.toBe(firstToken)
    const { getChatStore } = await import('../chatStoreBinding.js')
    expect(getChatStore().getAuthorityScope()).toEqual({
      environmentKey: nextConfiguredEnvKey,
      userId: 'user-a',
      teamId: 'team-a',
    })
  })

  it('uses discovery completed during saved-session restore without changing durable identity', async () => {
    const { service, runtimeConfig, restA, userDataDir } = await createNativeCommitTestHarness({
      keytarAvailable: true,
    })
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const restOnlyEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    const discovery = deferred<DesktopEnvironmentDiscovery>()
    const discoveryStarted = deferred<void>()
    const restoredMe = deferred<ReturnType<typeof testSessionMe>>()
    const getDesktopEnvironment = vi
      .fn()
      .mockRejectedValueOnce(new Error('startup discovery unavailable'))
      .mockImplementationOnce(() => {
        discoveryStarted.resolve()
        return discovery.promise
      })
      .mockRejectedValueOnce(new Error('later discovery must not be needed'))
    const getMeStarted = deferred<void>()
    const getMe = vi.fn(() => {
      getMeStarted.resolve()
      return restoredMe.promise
    })
    const me = testSessionMe()
    const app = service as unknown as {
      authClient: {
        getDesktopEnvironment: typeof getDesktopEnvironment
        getMe: typeof getMe
        health: ReturnType<typeof vi.fn>
      }
      resolveRuntimeConfigIfNeeded: () => Promise<void>
      getEffectiveRpcProxyBaseUrl: () => string
      getDependenciesHealth: () => Promise<unknown>
      rpcClient: { health: ReturnType<typeof vi.fn> }
      gfsScopeIdentity: { environmentKey: string } | null
    }
    app.authClient = {
      getDesktopEnvironment,
      getMe,
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    }
    app.rpcClient = { health: vi.fn().mockResolvedValue({ status: 'ok' }) }
    await persistAcceptedPasswordSession({
      tokenStore: service.tokenStore,
      userDataDirectory: userDataDir,
      token: 'synthetic-saved-session-a',
    })
    service.tokenStore.setSessionToken.mockClear()
    const { getChatStore } = await import('../chatStoreBinding.js')

    const restore = service.getSessionState()
    await getMeStarted.promise
    const discoveryRequest = app.resolveRuntimeConfigIfNeeded()
    await discoveryStarted.promise
    discovery.resolve({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
      appName: 'Environment A',
    })
    await discoveryRequest

    expect(runtimeConfig.getDesktopRuntimeConfigState().envKey).toBe(restOnlyEnvKey)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('')

    restoredMe.resolve(me)
    await expect(restore).resolves.toMatchObject({ authenticated: true, me })
    expect(service.tokenStore.setSessionToken).not.toHaveBeenCalled()
    expect(getChatStore().getAuthorityScope()).toEqual({
      environmentKey: restOnlyEnvKey,
      userId: 'user-a',
      teamId: 'team-a',
    })
    expect(app.gfsScopeIdentity?.environmentKey).toBe(restOnlyEnvKey)
    expect(service.getCachedUserId()).toBe('user-a')
    expect(app.getEffectiveRpcProxyBaseUrl()).toBe('https://rpc-discovered.example.test')

    await expect(app.getDependenciesHealth()).resolves.toMatchObject({
      externalRestApi: { ok: true },
      rpcProxy: { ok: true },
    })
    expect(app.rpcClient.health).toHaveBeenCalledOnce()
    expect(getDesktopEnvironment).toHaveBeenCalledTimes(2)

    await service.logout()
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
    expect(app.gfsScopeIdentity).toBeNull()
  })

  it('keeps the durable selector when restore-pending discovery would replace its identity', async () => {
    const { service, runtimeConfig, restA, userDataDir } = await createNativeCommitTestHarness({
      keytarAvailable: true,
    })
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const restOnlyEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    const app = service as unknown as {
      authClient: {
        getDesktopEnvironment: ReturnType<typeof vi.fn>
        passwordLogin: ReturnType<typeof vi.fn>
        getMe: ReturnType<typeof vi.fn>
        health: ReturnType<typeof vi.fn>
      }
      getDependenciesHealth: () => Promise<unknown>
    }
    const restoredMe = deferred<ReturnType<typeof testSessionMe>>()
    const restoreStarted = deferred<void>()
    const { RpcProxyClient } = await import('../rpcProxyClient.js')
    vi.spyOn(RpcProxyClient.prototype, 'health').mockResolvedValue({ status: 'ok' })
    await persistAcceptedPasswordSession({
      tokenStore: service.tokenStore,
      userDataDirectory: userDataDir,
      token: 'synthetic-saved-session',
    })
    service.tokenStore.setSessionToken.mockClear()
    app.authClient = {
      getDesktopEnvironment: vi
        .fn()
        .mockRejectedValueOnce(new Error('initial discovery unavailable'))
        .mockResolvedValue({
          externalRestApiBaseUrl: restA,
          rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
          appName: 'Environment A',
        }),
      passwordLogin: vi
        .fn()
        .mockResolvedValue(testLoginResult(testSessionTokenWithExpiry(), testSessionMe())),
      getMe: vi.fn((token: string) => {
        if (token === 'synthetic-saved-session') {
          restoreStarted.resolve()
          return restoredMe.promise
        }
        return Promise.resolve(testSessionMe())
      }),
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    }

    const restore = service.getSessionState()
    await restoreStarted.promise
    await app.getDependenciesHealth()
    await service.passwordLogin('user-a@example.test', 'fixture-password')
    restoredMe.resolve(testSessionMe())
    await restore

    const rpcAwareEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    expect(rpcAwareEnvKey).toBe(restOnlyEnvKey)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('')
    await expect(service.getSessionState()).resolves.toMatchObject({
      authenticated: true,
      me: { id: 'user-a' },
    })
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    await expect(
      readSessionAuthoritySourceSelection({
        tokenStore: service.tokenStore,
        envKey: rpcAwareEnvKey,
      })
    ).resolves.toMatchObject({
      status: 'accepted',
      session: { token: expect.any(String) },
    })
  })

  it('discards a stale effective endpoint when a different REST-only profile is selected', async () => {
    const { service, runtimeConfig, restA, restB } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restB,
      rpcProxyBaseUrl: '',
      appName: 'Environment B',
    })
    const optionA = runtimeConfig
      .getDesktopRuntimeConfigState()
      .options.find(option => option.externalRestApiBaseUrl === restA)
    const optionB = runtimeConfig
      .getDesktopRuntimeConfigState()
      .options.find(option => option.externalRestApiBaseUrl === restB)
    if (!optionA || !optionB) throw new Error('test runtime profiles were not created')
    await runtimeConfig.selectDesktopRuntimeConfigOption(optionA.id)
    const app = service as unknown as {
      effectiveRuntimeRpcEndpoint:
        | (DesktopEnvironmentDiscovery & { profileId: string | null })
        | null
      pendingRuntimeConfigDiscovery:
        | (DesktopEnvironmentDiscovery & { profileId: string | null })
        | null
      getEffectiveRpcProxyBaseUrl: () => string
    }
    const { AuthClient } = await import('../authClient.js')
    vi.spyOn(AuthClient.prototype, 'getDesktopEnvironment')
      .mockRejectedValueOnce(new Error('initial discovery unavailable'))
      .mockResolvedValue({
        externalRestApiBaseUrl: restA,
        rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
        appName: 'A',
      })
    vi.spyOn(AuthClient.prototype, 'passwordLogin').mockResolvedValue(testLoginResult())
    vi.spyOn(AuthClient.prototype, 'getMe').mockResolvedValue(testSessionMe())
    vi.spyOn(AuthClient.prototype, 'health').mockResolvedValue({ status: 'ok' })
    const { RpcProxyClient } = await import('../rpcProxyClient.js')
    vi.spyOn(RpcProxyClient.prototype, 'health').mockResolvedValue({ status: 'ok' })
    await service.passwordLogin('user-a@example.test', 'fixture-password')
    const { AppService } = await import('../appService.js')
    await (service as unknown as InstanceType<typeof AppService>).getDependenciesHealth()

    await service.logout()
    await service.selectRuntimeConfig(optionB.id)

    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restB)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('')
    expect(app.getEffectiveRpcProxyBaseUrl()).toBe('')
    expect(app.effectiveRuntimeRpcEndpoint).toBeNull()
    expect(app.pendingRuntimeConfigDiscovery).toBeNull()
  })

  it.each([
    [
      'password',
      (service: { passwordLogin: (email: string, password: string) => Promise<unknown> }) =>
        service.passwordLogin('user@example.test', 'password'),
    ],
  ])('commits matching discovery after a failed %s login', async (_kind, login) => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const app = service as unknown as {
      authClient: {
        getDesktopEnvironment: ReturnType<typeof vi.fn>
        passwordLogin: ReturnType<typeof vi.fn>
      }
      passwordLogin: (email: string, password: string) => Promise<unknown>
    }
    app.authClient = {
      getDesktopEnvironment: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: restA,
        rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
        appName: 'Environment A',
      }),
      passwordLogin: vi.fn().mockRejectedValue(new Error('password login rejected')),
    }

    await expect(login(app)).rejects.toThrow('login rejected')

    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
    expect(service.tokenStore.setSessionToken).not.toHaveBeenCalled()
  })

  it('shares a pending discovery for the same profile and REST endpoint', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })

    const discovery = deferred<DesktopEnvironmentDiscovery>()
    const discoveryStarted = deferred<void>()
    const getDesktopEnvironment = vi.fn(() => {
      discoveryStarted.resolve()
      return discovery.promise
    })
    const app = service as unknown as {
      authClient: { getDesktopEnvironment: ReturnType<typeof vi.fn> }
      resolveRuntimeConfigIfNeeded: () => Promise<void>
    }
    app.authClient = { getDesktopEnvironment }

    const first = app.resolveRuntimeConfigIfNeeded()
    await discoveryStarted.promise
    const second = app.resolveRuntimeConfigIfNeeded()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getDesktopEnvironment).toHaveBeenCalledOnce()

    discovery.resolve({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
      appName: 'Environment A',
    })
    await Promise.all([first, second])

    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
  })

  it('clears a rejected discovery entry so the next call can retry', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })

    const getDesktopEnvironment = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary discovery failure'))
      .mockResolvedValue({
        externalRestApiBaseUrl: restA,
        rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
        appName: 'Environment A',
      })
    const app = service as unknown as {
      authClient: { getDesktopEnvironment: ReturnType<typeof vi.fn> }
      resolveRuntimeConfigIfNeeded: () => Promise<void>
    }
    app.authClient = { getDesktopEnvironment }

    await expect(app.resolveRuntimeConfigIfNeeded()).rejects.toThrow('temporary discovery failure')

    await expect(app.resolveRuntimeConfigIfNeeded()).resolves.toBeUndefined()

    expect(getDesktopEnvironment).toHaveBeenCalledTimes(2)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
  })
})
