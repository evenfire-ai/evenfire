import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { desktopEnvironmentDiscoveryUrl } from '../desktopEnvironmentUrl.js'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupNativeCommitTestHarness()
})
const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
it.each(['app', 'gfs'] as const)(
  '%s share resolves with the selected origin without blocking the native owner',
  async kind => {
    const h = await createNativeCommitTestHarness()
    const service = h.service as unknown as {
      authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
      sessionToken: string | null
      me: { id: string; email: string } | null
      createSandboxUiDeepLink: () => Promise<{ url: string }>
      createGfsResourceDeepLink: (uri: string) => Promise<{ url: string }>
    }
    const driver = await import('../sandboxUiDriver.js')
    vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/tasks/42',
    })
    service.sessionToken = 'synthetic-session'
    service.me = { id: 'user-1', email: 'user@example.test' }
    const origin = 'https://profile-custom.example.test'
    const get = vi.fn().mockResolvedValue({
      externalRestApiBaseUrl: h.restA,
      responseUrl: desktopEnvironmentDiscoveryUrl(h.restA),
      rpcProxyBaseUrl: 'https://rpc-a.example.test',
      appName: 'Environment A',
      profileUiBaseUrl: origin,
    })
    service.authClient = { getDesktopEnvironmentForEndpoint: get }
    const indexPath = path.join(path.dirname(h.optionA.configPath!), 'index.json')
    const indexBefore = await fs.readFile(indexPath, 'utf8')
    const expected =
      kind === 'app'
        ? `${origin}/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42`
        : `${origin}/open/files?uri=${encodeURIComponent(uri)}`
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('share did not settle before deadline')), 3000)
    })
    try {
      const action =
        kind === 'app' ? service.createSandboxUiDeepLink() : service.createGfsResourceDeepLink(uri)
      await expect(Promise.race([action, deadline])).resolves.toEqual({ url: expected })
    } finally {
      if (timer) clearTimeout(timer)
    }
    expect(get).toHaveBeenCalledOnce()
    expect(JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8')).profileUiBaseUrl).toBe(
      origin
    )
    expect(await fs.readFile(indexPath, 'utf8')).toBe(indexBefore)
    expect(h.runtimeConfig.getActiveRuntimeConfigOptionId()).toBe(h.optionA.id)
  },
  10000
)
it.each(['app', 'gfs'] as const)(
  '%s share rejects after a profile switch during discovery',
  async kind => {
    const h = await createNativeCommitTestHarness()
    const service = h.service as unknown as {
      authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
      sessionToken: string | null
      me: { id: string; email: string } | null
      selectRuntimeConfig: (id: string) => Promise<unknown>
      createSandboxUiDeepLink: () => Promise<{ url: string }>
      createGfsResourceDeepLink: (uri: string) => Promise<{ url: string }>
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
      stopAllStreams: () => void
    }
    const driver = await import('../sandboxUiDriver.js')
    vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/tasks/42',
    })
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
    service.stopAllStreams = vi.fn()
    service.sessionToken = 'synthetic-session'
    service.me = { id: 'user-1', email: 'user@example.test' }
    let release!: (value: unknown) => void
    const held = new Promise(resolve => {
      release = resolve
    })
    const get = vi.fn().mockReturnValue(held)
    service.authClient = { getDesktopEnvironmentForEndpoint: get }
    const action =
      kind === 'app' ? service.createSandboxUiDeepLink() : service.createGfsResourceDeepLink(uri)
    void action.catch(() => undefined)
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
    await service.selectRuntimeConfig(h.optionB.id)
    release({
      externalRestApiBaseUrl: h.restA,
      responseUrl: desktopEnvironmentDiscoveryUrl(h.restA),
      rpcProxyBaseUrl: 'https://rpc-a.example.test',
      appName: 'Environment A',
      profileUiBaseUrl: 'https://profile-a.example.test',
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('share did not settle before deadline')), 3000)
    })
    try {
      await expect(
        Promise.race([
          action.then(
            () => 'returned',
            () => 'rejected'
          ),
          deadline,
        ])
      ).resolves.toBe('rejected')
    } finally {
      if (timer) clearTimeout(timer)
    }
    expect(h.runtimeConfig.getActiveRuntimeConfigOptionId()).toBe(h.optionB.id)
  },
  10000
)
