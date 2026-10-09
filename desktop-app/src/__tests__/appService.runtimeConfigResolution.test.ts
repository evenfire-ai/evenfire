import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { testLoginResult, testSessionMe } from '../../testSupport/authTestFixtures.js'

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
        googleLogin: ReturnType<typeof vi.fn>
      }
    }
    app.authClient = {
      getDesktopEnvironment: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: restA,
        rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
        appName: 'Environment A',
      }),
      googleLogin: vi.fn().mockResolvedValue(testLoginResult('session-token-a', me)),
    }

    await service.googleLogin('google-token-a')

    const rpcEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    const { bindChatStoreForUser } = await import('../chatStoreBinding.js')
    expect(rpcEnvKey).not.toBe(restOnlyEnvKey)
    expect(service.tokenStore.setSessionToken).toHaveBeenCalledWith('session-token-a', rpcEnvKey)
    expect(bindChatStoreForUser).toHaveBeenLastCalledWith(
      me.id,
      rpcEnvKey,
      expect.objectContaining({ legacyEnvKeys: [restOnlyEnvKey] })
    )
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
        googleLogin: ReturnType<typeof vi.fn>
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
      rpcTokenManager: {
        getOrIssue: ReturnType<typeof vi.fn>
        clear: ReturnType<typeof vi.fn>
      }
    }
    app.authClient = {
      getDesktopEnvironment,
      googleLogin: vi
        .fn()
        .mockResolvedValueOnce(testLoginResult('session-token-a', me))
        .mockResolvedValueOnce(testLoginResult('session-token-b', me)),
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    }
    app.rpcClient = { health: vi.fn().mockResolvedValue({ status: 'ok' }) }

    await service.googleLogin('google-token-a')
    const generation = service.getSessionGeneration()
    const { bindChatStoreForUser } = await import('../chatStoreBinding.js')
    const activeBindingCount = vi.mocked(bindChatStoreForUser).mock.calls.length
    expect(service.tokenStore.setSessionToken).toHaveBeenCalledWith(
      'session-token-a',
      restOnlyEnvKey
    )

    await app.getDependenciesHealth()
    await app.getDependenciesHealth()
    await app.getDependenciesHealth()

    expect(runtimeConfig.getDesktopRuntimeConfigState().envKey).toBe(restOnlyEnvKey)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('')
    expect(app.getEffectiveRpcProxyBaseUrl()).toBe('https://rpc-discovered.example.test')
    expect(getDesktopEnvironment).toHaveBeenCalledTimes(2)
    expect(service.tokenStore.setSessionToken).toHaveBeenCalledTimes(1)
    expect(vi.mocked(bindChatStoreForUser)).toHaveBeenCalledTimes(activeBindingCount)
    expect(app.getChatDeletionFenceAuthority().authorityScope.environmentKey).toBe(restOnlyEnvKey)
    expect(service.getSessionGeneration()).toBe(generation)
    expect(service.getCachedUserId()).toBe('user-a')
    expect(app.gfsScopeIdentity?.environmentKey).toBe(restOnlyEnvKey)

    const openDesktopWindow = vi.fn().mockResolvedValue(undefined)
    vi.doMock('../desktopWindow.js', () => ({ openDesktopWindow }))
    app.rpcTokenManager = {
      getOrIssue: vi.fn().mockResolvedValue({ token: 'desktop-rpc-token' }),
      clear: vi.fn(),
    }
    await app.openDesktop('chatllm')
    expect(openDesktopWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        hostRef: 'chatllm',
        rpcProxyUrl: 'https://rpc-discovered.example.test',
      })
    )

    await service.logout()

    const rpcConfiguredEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    expect(rpcConfiguredEnvKey).not.toBe(restOnlyEnvKey)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
    expect(service.tokenStore.clearSessionToken).toHaveBeenCalledWith(
      restOnlyEnvKey,
      expect.any(Object)
    )
    expect(app.gfsScopeIdentity).toBeNull()

    await service.googleLogin('google-token-b')
    expect(service.tokenStore.setSessionToken).toHaveBeenLastCalledWith(
      'session-token-b',
      rpcConfiguredEnvKey
    )
    expect(bindChatStoreForUser).toHaveBeenLastCalledWith(
      'user-a',
      rpcConfiguredEnvKey,
      expect.objectContaining({ legacyEnvKeys: [restOnlyEnvKey] })
    )
  })

  it('uses discovery completed during saved-session restore without changing durable identity', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
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
    service.tokenStore.getSessionToken.mockResolvedValue('synthetic-saved-session-a')
    const { bindChatStoreForUser } = await import('../chatStoreBinding.js')

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
    expect(service.tokenStore.getSessionToken).toHaveBeenCalledWith(restOnlyEnvKey, {
      legacyEnvKeys: [],
    })
    expect(service.tokenStore.setSessionToken).not.toHaveBeenCalled()
    expect(bindChatStoreForUser).toHaveBeenLastCalledWith(
      'user-a',
      restOnlyEnvKey,
      expect.objectContaining({ legacyEnvKeys: [] })
    )
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

  it('commits a restore-pending discovery before an interactive login captures its binding', async () => {
    const { service, runtimeConfig, restA } = await createNativeCommitTestHarness()
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })
    const restOnlyEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    const app = service as unknown as {
      authClient: {
        getDesktopEnvironment: ReturnType<typeof vi.fn>
        googleLogin: ReturnType<typeof vi.fn>
      }
      restoreSavedSessionInFlight: Promise<unknown>
      restoreSavedSessionReservationStarted: boolean
      pendingRuntimeConfigDiscovery:
        | (DesktopEnvironmentDiscovery & { profileId: string | null })
        | null
    }
    app.restoreSavedSessionInFlight = Promise.resolve({ authenticated: false })
    app.restoreSavedSessionReservationStarted = true
    app.pendingRuntimeConfigDiscovery = {
      profileId: runtimeConfig.getDesktopRuntimeConfigState().activeOptionId,
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
      appName: 'Environment A',
    }
    app.authClient = {
      getDesktopEnvironment: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: restA,
        rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
        appName: 'Environment A',
      }),
      googleLogin: vi.fn().mockResolvedValue(testLoginResult('session-token-a', testSessionMe())),
    }

    await service.googleLogin('google-token-a')

    const rpcAwareEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    expect(rpcAwareEnvKey).not.toBe(restOnlyEnvKey)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('https://rpc-discovered.example.test')
    expect(service.tokenStore.setSessionToken).toHaveBeenCalledWith(
      'session-token-a',
      rpcAwareEnvKey
    )
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
    app.effectiveRuntimeRpcEndpoint = {
      profileId: optionA.id,
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: 'https://rpc-discovered.example.test',
      appName: 'Environment A',
    }
    app.pendingRuntimeConfigDiscovery = app.effectiveRuntimeRpcEndpoint

    await service.selectRuntimeConfig(optionB.id)

    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restB)
    expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('')
    expect(app.getEffectiveRpcProxyBaseUrl()).toBe('')
    expect(app.effectiveRuntimeRpcEndpoint).toBeNull()
    expect(app.pendingRuntimeConfigDiscovery).toBeNull()
  })

  it.each([
    [
      'Google',
      (service: { googleLogin: (idToken: string) => Promise<unknown> }) =>
        service.googleLogin('token'),
    ],
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
        googleLogin: ReturnType<typeof vi.fn>
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
      googleLogin: vi.fn().mockRejectedValue(new Error('Google login rejected')),
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
