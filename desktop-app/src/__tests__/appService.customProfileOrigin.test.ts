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
    const service = harness.service as LinkService
    const driver = await import('../sandboxUiDriver.js')
    vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/tasks/42',
    })
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
    service.stopAllStreams = vi.fn()
    service.ensureEntityChangeConnection = vi.fn()
    service.sessionToken = 'synthetic-session-custom'
    service.me = { id: 'user-1', email: 'user@example.test' }

    const resourceUri = 'gfs://main/0123456789abcdef0123456789abcdef'
    await expect(service.createSandboxUiDeepLink()).resolves.toEqual({
      url:
        'https://profile.customer.example.test:9444/open/apps/sandbox-recipes/task-board' +
        '?path=%2Ftasks%2F42',
    })
    await expect(service.createGfsResourceDeepLink(resourceUri)).resolves.toEqual({
      url:
        'https://profile.customer.example.test:9444/open/files?uri=' +
        encodeURIComponent(resourceUri),
    })

    await service.selectRuntimeConfig(harness.optionB.id)
    expect(service.sessionToken).toBeNull()
    expect(service.me).toBeNull()
    service.sessionToken = 'synthetic-session-development'
    service.me = { id: 'user-1', email: 'user@example.test' }
    await expect(service.createSandboxUiDeepLink()).resolves.toMatchObject({
      url: expect.stringMatching(/^https:\/\/profile\.dev\.example\.test\//),
    })
    await expect(service.createGfsResourceDeepLink(resourceUri)).resolves.toMatchObject({
      url: expect.stringMatching(/^https:\/\/profile\.dev\.example\.test\//),
    })
  })
})
