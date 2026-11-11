import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
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

    // This valid but hostname-inconsistent operator pair is authoritative when its REST
    // binding matches the active deployment. Hostname naming is not deployment proof.
    await expectShareLinksAt(service, explicitProfile)
    expect(harness.runtimeConfig.getActiveDeploymentProfileUiBaseUrl()).toBe(explicitProfile)

    await service.selectRuntimeConfig(harness.optionB.id)
    expect(service.sessionToken).toBeNull()
    expect(service.me).toBeNull()
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

  it('derives from every nonmatching recognized REST host and restores the configured pair', async () => {
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
