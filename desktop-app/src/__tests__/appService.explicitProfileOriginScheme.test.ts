import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

afterEach(async () => {
  await cleanupNativeCommitTestHarness()
  vi.restoreAllMocks()
})

type DeepLinkService = {
  me: { id: string; email: string } | null
  sessionToken: string | null
  createSandboxUiDeepLink: () => Promise<{ url: string }>
  createGfsResourceDeepLink: (uri: string) => Promise<{ url: string }>
  openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
}

const resourceUri = 'gfs://main/0123456789abcdef0123456789abcdef'

async function makeService(rest: string, profile: string) {
  const harness = await createNativeCommitTestHarness({
    configuredRest: rest,
    profileUiBaseUrl: profile,
    restA: rest,
  })
  const driver = await import('../sandboxUiDriver.js')
  vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue({
    recipeNs: 'sandbox-recipes',
    recipeName: 'task-board',
    path: '/tasks/42',
  })
  const service = harness.service as unknown as DeepLinkService
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
  service.stopAllStreams = vi.fn()
  service.sessionToken = 'synthetic-session-origin-test'
  service.me = { id: 'user-1', email: 'user@example.test' }
  return { ...harness, service }
}

describe('App/GFS explicit Profile UI origin scheme', () => {
  it.each(['app', 'gfs'] as const)(
    'rejects a non-loopback HTTP explicit origin before returning the %s URL',
    async kind => {
      const rest = 'https://api.customer.example.test'
      const insecureOrigin = `http://profile.${['example', 'test'].join('.')}`
      const { service } = await makeService(rest, insecureOrigin)
      const result = await (
        kind === 'app'
          ? service.createSandboxUiDeepLink()
          : service.createGfsResourceDeepLink(resourceUri)
      ).then(
        value => value,
        error => ({ error })
      )

      expect(result).not.toHaveProperty('url')
      if ('error' in result) {
        expect(result.error.message).toBe(
          'Cannot resolve a shareable Profile UI link for the active desktop deployment'
        )
      }
    }
  )

  it('accepts private HTTPS and produces exact App and GFS links', async () => {
    const rest = 'https://api.customer.example.test'
    const privateAddress = ['10', '0', '0', '5'].join('.')
    const origin = `https://${privateAddress}`
    const { service } = await makeService(rest, origin)

    await expect(service.createSandboxUiDeepLink()).resolves.toEqual({
      url: `${origin}/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42`,
    })
    await expect(service.createGfsResourceDeepLink(resourceUri)).resolves.toEqual({
      url: `${origin}/open/files?uri=${encodeURIComponent(resourceUri)}`,
    })
  })

  it('allows paired HTTP loopback and rejects a loopback Profile origin with remote REST', async () => {
    const loopback = ['127', '0', '0', '1'].join('.')
    const localRest = `http://${loopback}:9081/api`
    const localProfile = `http://${loopback}:3001`
    const local = await makeService(localRest, localProfile)

    await expect(local.service.createSandboxUiDeepLink()).resolves.toMatchObject({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:3001\//),
    })
    await expect(local.service.createGfsResourceDeepLink(resourceUri)).resolves.toMatchObject({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:3001\//),
    })

    const remote = await makeService('https://api.customer.example.test', localProfile)
    await expect(remote.service.createSandboxUiDeepLink()).rejects.toThrow(
      'Cannot resolve a shareable Profile UI link for the active desktop deployment'
    )
    await expect(remote.service.createGfsResourceDeepLink(resourceUri)).rejects.toThrow(
      'Cannot resolve a shareable Profile UI link for the active desktop deployment'
    )
  })

  it('preserves the reciprocal loopback REST guard and explicit-pair fallback precedence', async () => {
    const loopback = ['127', '0', '0', '1'].join('.')
    const localRest = `http://${loopback}:9081/api`
    const remoteProfile = 'https://profile.customer.example.test'
    const local = await makeService(localRest, remoteProfile)

    expect(() => local.runtimeConfig.getActiveDeploymentProfileUiBaseUrl()).toThrow(
      'Cannot resolve a shareable Profile UI link for the active desktop deployment'
    )

    const rest = 'https://api.dev.example.test'
    const explicitProfile = 'https://profile.prod.example.test'
    const fallbackHarness = await makeService(rest, explicitProfile)
    expect(fallbackHarness.runtimeConfig.getActiveDeploymentProfileUiBaseUrl()).toBe(
      explicitProfile
    )

    fallbackHarness.runtimeConfig.config.externalRestApiBaseUrl = 'https://api.other.example.test'
    expect(fallbackHarness.runtimeConfig.getActiveDeploymentProfileUiBaseUrl()).toBe(
      'https://profile.other.example.test'
    )
  })

  it('rejects browser dispatch for explicit non-loopback HTTP', async () => {
    const { service } = await makeService(
      'https://api.customer.example.test',
      `http://profile.${['example', 'test'].join('.')}`
    )
    const electron = (await import('electron')) as unknown as {
      shell: { openExternal: ReturnType<typeof vi.fn> }
    }

    await expect(service.openForgotPassword('user@example.test')).rejects.toThrow()
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it.each(['app', 'gfs'] as const)(
    'does not write an invalid %s origin to the trusted renderer clipboard',
    async kind => {
      const { service } = await makeService(
        'https://api.customer.example.test',
        `http://profile.${['example', 'test'].join('.')}`
      )
      const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
      const writeText = vi.fn().mockResolvedValue(undefined)
      vi.doMock('electron', () => ({
        BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
        Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
        app: { on: vi.fn(), getPath: vi.fn(), getVersion: vi.fn() },
        clipboard: { writeText },
        dialog: { showSaveDialog: vi.fn() },
        ipcMain: {
          handle: vi.fn(
            (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
              handlers.set(channel, handler)
            }
          ),
          on: vi.fn(),
          removeHandler: vi.fn(),
        },
        shell: { openExternal: vi.fn() },
      }))
      const { registerIpcHandlers } = await import('../ipc.js')
      registerIpcHandlers(service as never, async () => 0)
      const channel = kind === 'app' ? 'sandboxUi:copyDeepLink' : 'gfs:copyDeepLink'
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`${channel} handler was not registered`)

      await expect(
        handler(
          { senderFrame: { url: 'file:///app/index.html' } },
          kind === 'app' ? {} : { uri: resourceUri }
        )
      ).rejects.toThrow(
        'Cannot resolve a shareable Profile UI link for the active desktop deployment'
      )
      expect(writeText).not.toHaveBeenCalled()
    }
  )

  it('dispatches a valid explicit HTTPS browser URL exactly once', async () => {
    const { service } = await makeService(
      'https://api.customer.example.test',
      'https://profile.customer.example.test'
    )
    const electron = (await import('electron')) as unknown as {
      shell: { openExternal: ReturnType<typeof vi.fn> }
    }

    const result = await service.openForgotPassword('user@example.test')
    expect(result.profileUiUrl).toBe(
      'https://profile.customer.example.test/forgot-password?email=user%40example.test'
    )
    expect(electron.shell.openExternal).toHaveBeenCalledOnce()
    expect(electron.shell.openExternal).toHaveBeenCalledWith(result.profileUiUrl)
  })
})
