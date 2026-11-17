import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

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

const appLocation = {
  recipeNs: 'sandbox-recipes',
  recipeName: 'task-board',
  path: '/tasks/42',
}
const gfsUri = 'gfs://main/0123456789abcdef0123456789abcdef'

async function useRealAppServiceLocation(service: LinkService): Promise<void> {
  const driver = await import('../sandboxUiDriver.js')
  vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue(appLocation)
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
  service.stopAllStreams = vi.fn()
  service.ensureEntityChangeConnection = vi.fn()
}

function authenticate(service: LinkService, suffix: string): void {
  service.sessionToken = `synthetic-session-${suffix}`
  service.me = { id: 'user-1', email: 'user@example.test' }
}

function expectedAppLink(profileOrigin: string): string {
  return `${profileOrigin}/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42`
}

function expectedGfsLink(profileOrigin: string): string {
  return `${profileOrigin}/open/files?uri=${encodeURIComponent(gfsUri)}`
}

describe('AppService active Profile origin pairing', () => {
  it('uses real App and GFS producers through development-to-custom-production and reverse switches', async () => {
    const developmentRest = 'https://api.dev.example.test'
    const productionRest = 'https://customer-rest.example.test:9443/api?tenant=one'
    const productionProfile = 'https://profile.customer.example.test:9444'
    const harness = await createNativeCommitTestHarness({
      configuredRest: productionRest,
      profileUiBaseUrl: productionProfile,
      restA: developmentRest,
      restB: productionRest,
    })
    const service = harness.service as LinkService
    await useRealAppServiceLocation(service)

    expect(harness.runtimeConfig.getActiveDeploymentProfileUiBaseUrl()).toBe(
      'https://profile.dev.example.test'
    )
    authenticate(service, 'development')
    await expect(service.createSandboxUiDeepLink()).resolves.toEqual({
      url: expectedAppLink('https://profile.dev.example.test'),
    })
    await expect(service.createGfsResourceDeepLink(gfsUri)).resolves.toEqual({
      url: expectedGfsLink('https://profile.dev.example.test'),
    })

    await service.selectRuntimeConfig(harness.optionB.id)
    expect(harness.runtimeConfig.config.externalRestApiBaseUrl).toBe(productionRest)
    expect(service.sessionToken).toBeNull()
    expect(service.me).toBeNull()
    authenticate(service, 'production')
    await expect(service.createSandboxUiDeepLink()).resolves.toEqual({
      url: expectedAppLink(productionProfile),
    })
    await expect(service.createGfsResourceDeepLink(gfsUri)).resolves.toEqual({
      url: expectedGfsLink(productionProfile),
    })

    await service.selectRuntimeConfig(harness.optionA.id)
    expect(harness.runtimeConfig.config.externalRestApiBaseUrl).toBe(developmentRest)
    expect(service.sessionToken).toBeNull()
    expect(service.me).toBeNull()
    authenticate(service, 'development-again')
    await expect(service.createSandboxUiDeepLink()).resolves.toEqual({
      url: expectedAppLink('https://profile.dev.example.test'),
    })
    await expect(service.createGfsResourceDeepLink(gfsUri)).resolves.toEqual({
      url: expectedGfsLink('https://profile.dev.example.test'),
    })
  })

  it('preserves the paired loopback Profile scheme, host alias, and nondefault port', async () => {
    const harness = await createNativeCommitTestHarness({
      configuredRest: 'http://localhost:27191',
      profileUiBaseUrl: 'https://127.0.0.1:27101',
      restA: 'http://[::1]:27191',
      restB: 'https://api.prod.example.test',
    })
    const service = harness.service as LinkService
    await useRealAppServiceLocation(service)
    authenticate(service, 'loopback')

    await expect(service.createSandboxUiDeepLink()).resolves.toEqual({
      url: expectedAppLink('https://127.0.0.1:27101'),
    })
    await expect(service.createGfsResourceDeepLink(gfsUri)).resolves.toEqual({
      url: expectedGfsLink('https://127.0.0.1:27101'),
    })

    const restIdentity = await import('../desktopEnvironmentUrl.js')
    expect(
      restIdentity.sameDesktopRestEndpoint('http://localhost:27191', 'http://[::1]:27191')
    ).toBe(false)
  })

  it.each([
    ['credentials', 'https://user:secret@profile.customer.example.test:9444'],
    ['a non-root path', 'https://profile.customer.example.test:9444/profile'],
    ['a query', 'https://profile.customer.example.test:9444?tenant=one'],
    ['a fragment', 'https://profile.customer.example.test:9444#profile'],
    ['an unsupported scheme', 'file:///tmp/profile'],
  ])(
    'rejects a matching custom REST pair with Profile origin containing %s',
    async (_label, profile) => {
      const productionRest = 'https://customer-rest.example.test:9443/api?tenant=one'
      const harness = await createNativeCommitTestHarness({
        configuredRest: productionRest,
        profileUiBaseUrl: profile,
        restA: productionRest,
        restB: 'https://api.dev.example.test',
      })
      const service = harness.service as LinkService
      await useRealAppServiceLocation(service)
      authenticate(service, 'invalid-origin')

      await expect(service.createSandboxUiDeepLink()).rejects.toThrow(
        'Cannot resolve a shareable Profile UI link for the active desktop deployment'
      )
      await expect(service.createGfsResourceDeepLink(gfsUri)).rejects.toThrow(
        'Cannot resolve a shareable Profile UI link for the active desktop deployment'
      )
    }
  )

  it('fails closed for an unpaired custom active REST environment', async () => {
    const configuredRest = 'https://customer-rest.example.test:9443/api?tenant=one'
    const profileOrigin = 'https://profile.customer.example.test:9444'
    const activeRest = 'https://unpaired-rest.example.test:9443/api?tenant=one'
    const harness = await createNativeCommitTestHarness({
      configuredRest,
      profileUiBaseUrl: profileOrigin,
      restA: configuredRest,
      restB: activeRest,
    })
    const service = harness.service as LinkService
    await useRealAppServiceLocation(service)
    await service.selectRuntimeConfig(harness.optionB.id)
    authenticate(service, 'unpaired')

    await expect(service.createSandboxUiDeepLink()).rejects.toThrow(
      'Cannot resolve a shareable Profile UI link for the active desktop deployment'
    )
    await expect(service.createGfsResourceDeepLink(gfsUri)).rejects.toThrow(
      'Cannot resolve a shareable Profile UI link for the active desktop deployment'
    )
  })
})
