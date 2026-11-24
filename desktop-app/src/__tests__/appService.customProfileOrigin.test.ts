import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import fsp from 'node:fs/promises'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
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
  service.sessionToken = sessionToken
  service.me = { id: 'user-1', email: 'user@example.test' }
  return service
}

async function expectShareLinksAt(service: LinkService, profileOrigin: string): Promise<void> {
  const resourceUri = 'gfs://main/0123456789abcdef0123456789abcdef'
  const app = await service.createSandboxUiDeepLink()
  const gfs = await service.createGfsResourceDeepLink(resourceUri)

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

    const invalidOriginAction = service.createSandboxUiDeepLink()
    const invalidOriginFailure = await invalidOriginAction.then(
      () => null,
      error => error
    )
    expect(discovery).not.toHaveBeenCalled()
    expect(invalidOriginFailure).toMatchObject({ message: 'Invalid Profile UI origin' })
    expect(JSON.parse(await fsp.readFile(activeOption.configPath, 'utf8'))).toMatchObject({
      profileUiBaseUrl: invalidSavedOrigin,
    })
  })

  it('accepts a saved IPv6 site-local HTTPS Profile UI origin without rediscovery', async () => {
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

    await expect(service.createSandboxUiDeepLink()).resolves.toMatchObject({
      url: `${invalidSavedOrigin}/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42`,
    })

    expect(discovery).not.toHaveBeenCalled()
  })

  it('reuses a saved origin for normal actions after the server advertises a changed host', async () => {
    const rest = 'https://api-stable.example.test'
    const savedProfile = 'https://profile-old.example.test'
    const harness = await createNativeCommitTestHarness({
      configuredRest: rest,
      restA: rest,
    })
    const identity = harness.runtimeConfig.captureProfileOriginBinding()
    if (!identity) throw new Error('saved environment identity is unavailable')
    await harness.runtimeConfig.persistProfileOriginForBinding(identity, savedProfile)
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
    expect(harness.runtimeConfig.captureProfileOriginBinding()).toMatchObject({
      restBaseUrl: rest,
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
    expect(harness.runtimeConfig.captureProfileOriginBinding()).toMatchObject({
      restBaseUrl: rest,
      profileUiBaseUrl: profileOrigin,
    })
  })

  it('fails safely when an older remote server omits the Profile UI origin', async () => {
    const rest = 'https://api-legacy.example.test'
    const harness = await createNativeCommitTestHarness({
      configuredRest: rest,
      restA: rest,
    })
    const option = harness.runtimeConfig
      .getDesktopRuntimeConfigState()
      .options.find(candidate => candidate.externalRestApiBaseUrl === rest)
    if (!option?.configPath) throw new Error('legacy environment JSON is unavailable')
    const service = await authenticatedLinkService(harness, 'synthetic-session-legacy-remote')
    const { AuthClient } = await import('../authClient.js')
    const discovery = vi
      .spyOn(AuthClient.prototype, 'getDesktopEnvironmentForEndpoint')
      .mockResolvedValue({
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: 'https://rpc-legacy.example.test',
        appName: 'Legacy remote',
        responseUrl: `${rest}/api/v1/desktop/environment`,
      })

    await expect(service.createSandboxUiDeepLink()).rejects.toThrow(
      'Cannot resolve a shareable Profile UI link for the active desktop deployment'
    )
    expect(discovery).toHaveBeenCalledOnce()
    expect(JSON.parse(await fsp.readFile(option.configPath, 'utf8'))).not.toHaveProperty(
      'profileUiBaseUrl'
    )
  })

  it('discovers a Profile origin for a REST path and query without changing endpoint identity', async () => {
    const rest = 'https://customer-rest.example.test/api?tenant=one'
    const profileOrigin = 'https://profile.customer.example.test'
    const harness = await createNativeCommitTestHarness({ configuredRest: rest, restA: rest })
    const service = await authenticatedLinkService(harness, 'synthetic-session-discovery')
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

    await expect(service.createSandboxUiDeepLink()).resolves.toMatchObject({
      url: `${profileOrigin}/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42`,
    })
    expect(discovery).toHaveBeenCalledWith(rest)
    expect(harness.runtimeConfig.captureProfileOriginBinding()).toMatchObject({
      restBaseUrl: rest,
      profileUiBaseUrl: profileOrigin,
    })
  })

  it('preserves the REST-derived fallback when an older server omits the Profile origin', async () => {
    const rest = 'https://customer-rest.example.test/api?tenant=one'
    const harness = await createNativeCommitTestHarness({ configuredRest: rest, restA: rest })
    const service = await authenticatedLinkService(harness, 'synthetic-session-legacy')
    const { AuthClient } = await import('../authClient.js')
    const discovery = vi
      .spyOn(AuthClient.prototype, 'getDesktopEnvironmentForEndpoint')
      .mockResolvedValue({
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: '',
        appName: 'Customer',
        responseUrl: desktopEnvironmentDiscoveryUrl(rest),
      })
    await expect(service.createSandboxUiDeepLink()).rejects.toThrow(
      'Cannot resolve a shareable Profile UI link for the active desktop deployment'
    )
    expect(discovery).toHaveBeenCalledOnce()
    expect(harness.runtimeConfig.captureProfileOriginBinding()).not.toHaveProperty(
      'profileUiBaseUrl'
    )
  })

  it('persists discovered origin to the selected profile before returning its share link', async () => {
    const rest = 'https://api-timeout.example.test'
    const profileOrigin = 'https://profile-timeout.example.test'
    const harness = await createNativeCommitTestHarness({ configuredRest: rest, restA: rest })
    const service = await authenticatedLinkService(harness, 'synthetic-session-persist-origin')
    const identity = harness.runtimeConfig.captureProfileOriginBinding()
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

    const result = await service.createSandboxUiDeepLink()
    expect(result.url).toBe(
      `${profileOrigin}/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42`
    )
    const saved = JSON.parse(await fsp.readFile(activeOption.configPath, 'utf8')) as {
      profileUiBaseUrl?: string
    }
    expect(saved.profileUiBaseUrl).toBe(profileOrigin)
    expect(await fsp.readFile(activeOption.configPath, 'utf8')).not.toBe(before)
  })

  it('uses the approved loopback fallback for an old server without persisting it', async () => {
    const rest = 'http://127.0.0.1:8091'
    const harness = await createNativeCommitTestHarness({ configuredRest: rest, restA: rest })
    const service = harness.service as unknown as {
      openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
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

    await expect(service.openForgotPassword('user@example.test')).resolves.toMatchObject({
      profileUiUrl: 'http://127.0.0.1:3001/forgot-password?email=user%40example.test',
    })
    expect(discovery).toHaveBeenCalledOnce()
    expect(harness.runtimeConfig.captureProfileOriginBinding()).not.toHaveProperty(
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
    const developmentIdentity = harness.runtimeConfig.captureProfileOriginBinding()
    if (!developmentIdentity) throw new Error('development profile identity is unavailable')
    await harness.runtimeConfig.persistProfileOriginForBinding(
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
    const otherIdentity = harness.runtimeConfig.captureProfileOriginBinding()
    if (!otherIdentity) throw new Error('other profile identity is unavailable')
    await harness.runtimeConfig.persistProfileOriginForBinding(
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
        expect(harness.runtimeConfig.getActiveDeploymentProfileUiBaseUrl()).toBe(
          `https://profile.other-${deploymentId}.evenfire.test`
        )

        harness.runtimeConfig.config.externalRestApiBaseUrl = devRest
        expect(harness.runtimeConfig.getActiveDeploymentProfileUiBaseUrl()).toBe(explicitProfile)
      }),
      { numRuns: 10_000 }
    )
  })
})
