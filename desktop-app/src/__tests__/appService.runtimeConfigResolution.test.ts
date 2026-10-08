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
  it('rebinds the live session when a retry discovers RPC for its selected REST profile', async () => {
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
      getDependenciesHealth: () => Promise<unknown>
      getChatDeletionFenceAuthority: () => {
        authorityScope: { environmentKey: string }
        sessionGeneration: number
      }
    }
    app.authClient = {
      getDesktopEnvironment,
      googleLogin: vi.fn().mockResolvedValue(testLoginResult('session-token-a', me)),
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    }
    app.rpcClient = { health: vi.fn().mockResolvedValue({ status: 'ok' }) }

    await service.googleLogin('google-token-a')
    const generation = service.getSessionGeneration()
    expect(service.tokenStore.setSessionToken).toHaveBeenCalledWith(
      'session-token-a',
      restOnlyEnvKey
    )

    await app.getDependenciesHealth()

    const rpcConfiguredEnvKey = runtimeConfig.getDesktopRuntimeConfigState().envKey
    const { bindChatStoreForUser } = await import('../chatStoreBinding.js')
    expect(rpcConfiguredEnvKey).not.toBe(restOnlyEnvKey)
    expect(service.tokenStore.setSessionToken).toHaveBeenLastCalledWith(
      'session-token-a',
      rpcConfiguredEnvKey
    )
    expect(bindChatStoreForUser).toHaveBeenLastCalledWith(
      'user-a',
      rpcConfiguredEnvKey,
      expect.objectContaining({ legacyEnvKeys: [restOnlyEnvKey] })
    )
    expect(app.getChatDeletionFenceAuthority().authorityScope.environmentKey).toBe(
      rpcConfiguredEnvKey
    )
    expect(service.getSessionGeneration()).toBe(generation)
    expect(service.getCachedUserId()).toBe('user-a')
  })

  it('rolls back RPC metadata when a live session chat binding cannot migrate', async () => {
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
      getDependenciesHealth: () => Promise<unknown>
      getChatDeletionFenceAuthority: () => {
        authorityScope: { environmentKey: string }
      }
    }
    app.authClient = {
      getDesktopEnvironment,
      googleLogin: vi.fn().mockResolvedValue(testLoginResult('session-token-a', me)),
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    }
    app.rpcClient = { health: vi.fn().mockResolvedValue({ status: 'ok' }) }
    const { bindChatStoreForUser } = await import('../chatStoreBinding.js')

    await service.googleLogin('google-token-a')
    const generation = service.getSessionGeneration()
    vi.mocked(bindChatStoreForUser).mockRejectedValueOnce(new Error('chat migration failed'))

    await expect(app.getDependenciesHealth()).resolves.toBeDefined()

    const rpcConfiguredEnvKey = runtimeConfig.resolveEnvKey(
      restA,
      'https://rpc-discovered.example.test'
    )
    expect(runtimeConfig.getDesktopRuntimeConfigState().envKey).toBe(restOnlyEnvKey)
    expect(app.getChatDeletionFenceAuthority().authorityScope.environmentKey).toBe(restOnlyEnvKey)
    expect(bindChatStoreForUser).toHaveBeenLastCalledWith(
      'user-a',
      restOnlyEnvKey,
      expect.objectContaining({ legacyEnvKeys: [rpcConfiguredEnvKey] })
    )
    expect(service.tokenStore.setSessionToken).toHaveBeenLastCalledWith(
      'session-token-a',
      restOnlyEnvKey
    )
    expect(service.getSessionGeneration()).toBe(generation)
    expect(service.getCachedUserId()).toBe('user-a')
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
