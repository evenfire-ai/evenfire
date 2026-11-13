import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { desktopEnvironmentDiscoveryUrl } from '../desktopEnvironmentUrl.js'

afterEach(async () => {
  await cleanupNativeCommitTestHarness()
  vi.restoreAllMocks()
})

type LinkService = {
  me: { id: string; email: string } | null
  sessionToken: string | null
  selectRuntimeConfig: (id: string) => Promise<unknown>
  createSandboxUiDeepLink: () => Promise<{ url: string }>
  createGfsResourceDeepLink: (uri: string) => Promise<{ url: string }>
  suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
  stopAllStreams: () => void
  ensureEntityChangeConnection: () => void
}

async function authenticatedLinkService(
  harness: Awaited<ReturnType<typeof createNativeCommitTestHarness>>,
  sessionToken: string
): Promise<LinkService> {
  const driver = await import('../sandboxUiDriver.js')
  vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue({
    recipeNs: 'sandbox-recipes',
    recipeName: 'task-board',
    path: '/tasks/42',
  })
  const service = harness.service as unknown as LinkService
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
  service.stopAllStreams = vi.fn()
  service.ensureEntityChangeConnection = vi.fn()
  service.sessionToken = sessionToken
  service.me = { id: 'user-1', email: 'user@example.test' }
  return service
}

async function expectShareLinksAt(service: LinkService, profileOrigin: string): Promise<void> {
  const resourceUri = 'gfs://main/0123456789abcdef0123456789abcdef'
  const [app, gfs] = await Promise.all([
    service.createSandboxUiDeepLink(),
    service.createGfsResourceDeepLink(resourceUri),
  ])

  expect({ app: app.url, gfs: gfs.url }).toEqual({
    app: `${profileOrigin}/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42`,
    gfs: `${profileOrigin}/open/files?uri=${encodeURIComponent(resourceUri)}`,
  })
}

describe('AppService configured custom Profile origin', () => {
  it('fails closed for an invalid saved origin without replacing it from discovery', async () => {
    const rest = 'https://api-stable.example.test'
    const invalidSavedOrigin = 'https://profile.example.test/unsafe-path'
    const harness = await createNativeCommitTestHarness({
      configuredRest: rest,
      restA: rest,
    })
    const activeOption = harness.runtimeConfig
      .getDesktopRuntimeConfigState()
      .options.find(option => option.externalRestApiBaseUrl === rest)
    if (!activeOption?.configPath) throw new Error('saved profile file is unavailable')
    const savedConfig = JSON.parse(await fsp.readFile(activeOption.configPath, 'utf8'))
    await fsp.writeFile(
      activeOption.configPath,
      JSON.stringify({ ...savedConfig, profileUiBaseUrl: invalidSavedOrigin }, null, 2)
    )

    vi.resetModules()
    const runtimeConfig = await import('../config.js')
    const { AppService } = await import('../appService.js')
    const service = await authenticatedLinkService(
      { ...harness, runtimeConfig, service: new AppService() } as typeof harness,
      'synthetic-session-invalid-origin'
    )
    const { AuthClient } = await import('../authClient.js')
    const discovery = vi
      .spyOn(AuthClient.prototype, 'getDesktopEnvironmentForEndpoint')
      .mockResolvedValue({
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: 'https://rpc-stable.example.test',
        profileUiBaseUrl: 'https://profile-new.example.test',
        appName: 'Stable',
        responseUrl: `${rest}/api/v1/desktop/environment`,
      })

    await expect(service.createSandboxUiDeepLink()).rejects.toThrow('saved_profile_origin_invalid')

    expect(discovery).not.toHaveBeenCalled()
    expect(runtimeConfig.getActiveRuntimeConfigProfileIdentity()).toMatchObject({
      externalRestApiBaseUrl: rest,
      profileUiBaseUrl: invalidSavedOrigin,
    })
  })

  it('rejects saved IPv6 site-local Profile UI origins without rediscovery', async () => {
    const rest = 'https://api-stable.example.test'
    const invalidSavedOrigin = 'https://[fec0::1]'
    const harness = await createNativeCommitTestHarness({
      configuredRest: rest,
      restA: rest,
    })
    const activeOption = harness.runtimeConfig
      .getDesktopRuntimeConfigState()
      .options.find(option => option.externalRestApiBaseUrl === rest)
    if (!activeOption?.configPath) throw new Error('saved profile file is unavailable')
    const savedConfig = JSON.parse(await fsp.readFile(activeOption.configPath, 'utf8'))
    await fsp.writeFile(
      activeOption.configPath,
      JSON.stringify({ ...savedConfig, profileUiBaseUrl: invalidSavedOrigin }, null, 2)
    )

    vi.resetModules()
    const runtimeConfig = await import('../config.js')
    const { AppService } = await import('../appService.js')
    const service = await authenticatedLinkService(
      { ...harness, runtimeConfig, service: new AppService() } as typeof harness,
      'synthetic-session-invalid-site-local-origin'
    )
    const { AuthClient } = await import('../authClient.js')
    const discovery = vi
      .spyOn(AuthClient.prototype, 'getDesktopEnvironmentForEndpoint')
      .mockResolvedValue({
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: 'https://rpc-stable.example.test',
        profileUiBaseUrl: 'https://profile-new.example.test',
        appName: 'Stable',
        responseUrl: `${rest}/api/v1/desktop/environment`,
      })

    await expect(service.createSandboxUiDeepLink()).rejects.toThrow('saved_profile_origin_invalid')

    expect(discovery).not.toHaveBeenCalled()
  })

  it('reuses a saved origin for normal actions after the server advertises a changed host', async () => {
    const rest = 'https://api-stable.example.test'
    const savedProfile = 'https://profile-old.example.test'
    const harness = await createNativeCommitTestHarness({
      configuredRest: rest,
      restA: rest,
    })
    const identity = harness.runtimeConfig.getActiveRuntimeConfigProfileIdentity()
    if (!identity) throw new Error('saved environment identity is unavailable')
    await harness.runtimeConfig.persistProfileUiOrigin(identity, savedProfile)
    const service = await authenticatedLinkService(harness, 'synthetic-session-stable')
    const { AuthClient } = await import('../authClient.js')
    const discovery = vi
      .spyOn(AuthClient.prototype, 'getDesktopEnvironmentForEndpoint')
      .mockResolvedValue({
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: 'https://rpc-stable.example.test',
        profileUiBaseUrl: 'https://profile-new.example.test',
        appName: 'Stable',
        responseUrl: `${rest}/api/v1/desktop/environment`,
      })

    await expectShareLinksAt(service, savedProfile)

    expect(discovery).not.toHaveBeenCalled()
    expect(harness.runtimeConfig.getActiveRuntimeConfigProfileIdentity()).toMatchObject({
      externalRestApiBaseUrl: rest,
      profileUiBaseUrl: savedProfile,
    })
  })

  it('persists first-use discovery without changing authenticated environment identity', async () => {
    const rest = 'https://api-active.example.test'
    const profileOrigin = 'https://profile-active.example.test'
    const harness = await createNativeCommitTestHarness({
      configuredRest: rest,
      restA: rest,
    })
    const service = await authenticatedLinkService(harness, 'synthetic-session-active')
    const sessionGeneration = (harness.service as unknown as { sessionGeneration: number })
      .sessionGeneration
    const environmentKey = harness.runtimeConfig.getActiveEnvKey()
    const { AuthClient } = await import('../authClient.js')
    const discovery = vi
      .spyOn(AuthClient.prototype, 'getDesktopEnvironmentForEndpoint')
      .mockResolvedValue({
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: 'https://rpc-active.example.test',
        profileUiBaseUrl: profileOrigin,
        appName: 'Active',
        responseUrl: `${rest}/api/v1/desktop/environment`,
      })

    await expectShareLinksAt(service, profileOrigin)

    expect(discovery).toHaveBeenCalledOnce()
    expect(service.sessionToken).toBe('synthetic-session-active')
    expect(service.me).toEqual({ id: 'user-1', email: 'user@example.test' })
    expect((harness.service as unknown as { sessionGeneration: number }).sessionGeneration).toBe(
      sessionGeneration
    )
    expect(harness.runtimeConfig.getActiveEnvKey()).toBe(environmentKey)
    expect(harness.runtimeConfig.getActiveRuntimeConfigProfileIdentity()).toMatchObject({
      externalRestApiBaseUrl: rest,
      profileUiBaseUrl: profileOrigin,
    })
  })

  it('discovers a Profile origin for a REST path and query without changing endpoint identity', async () => {
    const rest = 'https://customer-rest.example.test/api?tenant=one'
    const profileOrigin = 'https://profile.customer.example.test'
    const harness = await createNativeCommitTestHarness({ configuredRest: rest, restA: rest })
    const service = harness.service as unknown as {
      resolveProfileUiBaseUrl: () => Promise<string>
    }
    const { AuthClient } = await import('../authClient.js')
    const discovery = vi
      .spyOn(AuthClient.prototype, 'getDesktopEnvironmentForEndpoint')
      .mockResolvedValue({
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: 'https://rpc.customer.example.test',
        profileUiBaseUrl: profileOrigin,
        appName: 'Customer',
        responseUrl: desktopEnvironmentDiscoveryUrl(rest),
      })

    await expect(service.resolveProfileUiBaseUrl()).resolves.toBe(profileOrigin)
    expect(discovery).toHaveBeenCalledWith(rest, expect.any(AbortSignal))
    expect(harness.runtimeConfig.getActiveRuntimeConfigProfileIdentity()).toMatchObject({
      externalRestApiBaseUrl: rest,
      profileUiBaseUrl: profileOrigin,
    })
  })

  it('cooldowns legacy remote discovery after an omitted Profile origin', async () => {
    const rest = 'https://customer-rest.example.test/api?tenant=one'
    const harness = await createNativeCommitTestHarness({ configuredRest: rest, restA: rest })
    const service = harness.service as unknown as {
      resolveProfileUiBaseUrl: () => Promise<string>
    }
    const { AuthClient } = await import('../authClient.js')
    const discovery = vi
      .spyOn(AuthClient.prototype, 'getDesktopEnvironmentForEndpoint')
      .mockResolvedValue({
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: '',
        appName: 'Customer',
        responseUrl: desktopEnvironmentDiscoveryUrl(rest),
      })
    let now = 100_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    await expect(service.resolveProfileUiBaseUrl()).rejects.toThrow(
      'profile_ui_origin_unavailable_from_server'
    )
    now += 999
    await expect(service.resolveProfileUiBaseUrl()).rejects.toThrow('profile_ui_retry_cooldown')
    expect(discovery).toHaveBeenCalledOnce()

    now += 1
    await expect(service.resolveProfileUiBaseUrl()).rejects.toThrow(
      'profile_ui_origin_unavailable_from_server'
    )
    expect(discovery).toHaveBeenCalledTimes(2)
    expect(harness.runtimeConfig.getActiveRuntimeConfigProfileIdentity()).not.toHaveProperty(
      'profileUiBaseUrl'
    )
  })

  it('bounds Profile origin staging and fences a late stage completion', async () => {
    const rest = 'https://api-timeout.example.test'
    const profileOrigin = 'https://profile-timeout.example.test'
    const harness = await createNativeCommitTestHarness({ configuredRest: rest, restA: rest })
    const service = harness.service as unknown as {
      resolveProfileUiBaseUrl: () => Promise<string>
    }
    const identity = harness.runtimeConfig.getActiveRuntimeConfigProfileIdentity()
    if (!identity) throw new Error('saved environment identity is unavailable')
    const activeOption = harness.runtimeConfig
      .getDesktopRuntimeConfigState()
      .options.find(option => option.id === identity.profileId)
    if (!activeOption?.configPath) throw new Error('saved profile file is unavailable')
    const before = await fsp.readFile(activeOption.configPath, 'utf8')
    const { AuthClient } = await import('../authClient.js')
    vi.spyOn(AuthClient.prototype, 'getDesktopEnvironmentForEndpoint').mockResolvedValue({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      profileUiBaseUrl: profileOrigin,
      appName: 'Timeout',
      responseUrl: desktopEnvironmentDiscoveryUrl(rest),
    })

    const controller = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    const stage = deferred<void>()
    const stageStarted = deferred<void>()
    const originalWriteFile = fsp.writeFile.bind(fsp)
    const fsPromises = fsp as unknown as { writeFile: (...args: any[]) => Promise<void> }
    let held = false
    const writeSpy = vi.spyOn(fsPromises, 'writeFile').mockImplementation((...args: any[]) => {
      if (!held && String(args[0]).includes('.runtime-config-stage-')) {
        held = true
        stageStarted.resolve()
        return stage.promise.then(() =>
          originalWriteFile(...(args as Parameters<typeof fsp.writeFile>))
        )
      }
      return originalWriteFile(...(args as Parameters<typeof fsp.writeFile>))
    })

    try {
      const action = service.resolveProfileUiBaseUrl()
      await stageStarted.promise
      expect(timeoutSpy).toHaveBeenCalledWith(10_000)
      controller.abort()
      await expect(action).rejects.toThrow('profile_ui_action_timeout')
      expect(await fsp.readFile(activeOption.configPath, 'utf8')).toBe(before)

      stage.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(await fsp.readFile(activeOption.configPath, 'utf8')).toBe(before)
      expect(
        (await fsp.readdir(path.dirname(activeOption.configPath))).filter(name =>
          name.includes('.runtime-config-stage-')
        )
      ).toEqual([])
    } finally {
      stage.resolve()
      writeSpy.mockRestore()
    }
  })

  it('uses the approved loopback fallback for an old server without persisting it', async () => {
    const rest = 'http://127.0.0.1:8091'
    const harness = await createNativeCommitTestHarness({ configuredRest: rest, restA: rest })
    const service = harness.service as unknown as {
      resolveProfileUiBaseUrl: () => Promise<string>
    }
    const { AuthClient } = await import('../authClient.js')
    const discovery = vi
      .spyOn(AuthClient.prototype, 'getDesktopEnvironmentForEndpoint')
      .mockResolvedValue({
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: '',
        appName: 'Local',
        responseUrl: desktopEnvironmentDiscoveryUrl(rest),
      })

    await expect(service.resolveProfileUiBaseUrl()).resolves.toBe('http://127.0.0.1:3001')
    await expect(service.resolveProfileUiBaseUrl()).resolves.toBe('http://127.0.0.1:3001')
    expect(discovery).toHaveBeenCalledOnce()
    expect(harness.runtimeConfig.getActiveRuntimeConfigProfileIdentity()).not.toHaveProperty(
      'profileUiBaseUrl'
    )
  })

  it('uses only the matching REST pair and falls back after switching to development', async () => {
    const customRest = 'https://customer-rest.example.test:9443/api?tenant=one'
    const customProfile = 'https://profile.customer.example.test:9444'
    const harness = await createNativeCommitTestHarness({
      configuredRest: customRest,
      profileUiBaseUrl: customProfile,
      restA: customRest,
      restB: 'https://api.dev.example.test',
    })
    const service = await authenticatedLinkService(harness, 'synthetic-session-custom')

    await expectShareLinksAt(service, 'https://profile.customer.example.test:9444')

    await service.selectRuntimeConfig(harness.optionB.id)
    expect(service.sessionToken).toBeNull()
    expect(service.me).toBeNull()
    const developmentIdentity = harness.runtimeConfig.getActiveRuntimeConfigProfileIdentity()
    if (!developmentIdentity) throw new Error('development profile identity is unavailable')
    await harness.runtimeConfig.persistProfileUiOrigin(
      developmentIdentity,
      'https://profile.dev.example.test'
    )
    service.sessionToken = 'synthetic-session-development'
    service.me = { id: 'user-1', email: 'user@example.test' }
    await expectShareLinksAt(service, 'https://profile.dev.example.test')

    await service.selectRuntimeConfig(harness.optionA.id)
    expect(service.sessionToken).toBeNull()
    expect(service.me).toBeNull()
    await expect(service.createSandboxUiDeepLink()).rejects.toThrow('Not authenticated')
    service.sessionToken = 'synthetic-session-custom-restored'
    service.me = { id: 'user-1', email: 'user@example.test' }
    await expectShareLinksAt(service, 'https://profile.customer.example.test:9444')
  })

  it('honors an explicit api.dev/profile.prod pair and isolates other active deployments', async () => {
    const devRest = 'https://api.dev.evenfire.test'
    const explicitProfile = 'https://profile.prod.evenfire.test'
    const otherRest = 'https://api.other.evenfire.test'
    const harness = await createNativeCommitTestHarness({
      configuredRest: devRest,
      profileUiBaseUrl: explicitProfile,
      restA: devRest,
      restB: otherRest,
    })
    const service = await authenticatedLinkService(harness, 'synthetic-session-dev-pair')
    const { AuthClient } = await import('../authClient.js')
    const discovery = vi
      .spyOn(AuthClient.prototype, 'getDesktopEnvironmentForEndpoint')
      .mockResolvedValue({
        externalRestApiBaseUrl: devRest,
        rpcProxyBaseUrl: 'https://rpc.dev.evenfire.test',
        profileUiBaseUrl: 'https://profile.discovered.evenfire.test',
        appName: 'Development',
        responseUrl: `${devRest}/api/v1/desktop/environment`,
      })

    // This valid but hostname-inconsistent operator pair is authoritative when its REST
    // binding matches the active deployment. Hostname naming is not deployment proof.
    await expectShareLinksAt(service, explicitProfile)
    expect(discovery).not.toHaveBeenCalled()
    expect(harness.runtimeConfig.getActiveDeploymentProfileUiBaseUrl()).toBe(explicitProfile)

    await service.selectRuntimeConfig(harness.optionB.id)
    expect(service.sessionToken).toBeNull()
    expect(service.me).toBeNull()
    const otherIdentity = harness.runtimeConfig.getActiveRuntimeConfigProfileIdentity()
    if (!otherIdentity) throw new Error('other profile identity is unavailable')
    await harness.runtimeConfig.persistProfileUiOrigin(
      otherIdentity,
      'https://profile.other.evenfire.test'
    )
    await expect(service.createSandboxUiDeepLink()).rejects.toThrow('Not authenticated')
    service.sessionToken = 'synthetic-session-other-deployment'
    service.me = { id: 'user-1', email: 'user@example.test' }
    await expectShareLinksAt(service, 'https://profile.other.evenfire.test')

    await service.selectRuntimeConfig(harness.optionA.id)
    expect(service.sessionToken).toBeNull()
    expect(service.me).toBeNull()
    service.sessionToken = 'synthetic-session-dev-pair-restored'
    service.me = { id: 'user-1', email: 'user@example.test' }
    await expectShareLinksAt(service, explicitProfile)
  })

  it('never guesses a host for a nonmatching REST host and restores the configured pair', async () => {
    const devRest = 'https://api.dev.evenfire.test'
    const explicitProfile = 'https://profile.prod.evenfire.test'
    const harness = await createNativeCommitTestHarness({
      configuredRest: devRest,
      profileUiBaseUrl: explicitProfile,
      restA: devRest,
      restB: 'https://api.other.evenfire.test',
    })

    await fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), deploymentId => {
        const activeRest = `https://api.other-${deploymentId}.evenfire.test`
        harness.runtimeConfig.config.externalRestApiBaseUrl = activeRest
        expect(() => harness.runtimeConfig.getActiveDeploymentProfileUiBaseUrl()).toThrow(
          'profile_ui_origin_missing'
        )

        harness.runtimeConfig.config.externalRestApiBaseUrl = devRest
        expect(harness.runtimeConfig.getActiveDeploymentProfileUiBaseUrl()).toBe(explicitProfile)
      }),
      { numRuns: 10_000 }
    )
  })
})
