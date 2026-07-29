import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
import { ApiError } from '../httpClient.js'

const { mockGetActiveSandboxUiLocation } = vi.hoisted(() => ({
  mockGetActiveSandboxUiLocation: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/clerum-desktop-test'),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(),
  },
}))

vi.mock('../sandboxUiDriver.js', () => ({
  getActiveSandboxUiLocation: mockGetActiveSandboxUiLocation,
}))

vi.mock('../config.js', () => ({
  getActiveEnvKey: () => 'test-env',
  config: {
    rpcProxyBaseUrl: 'http://proxy',
    externalRestApiBaseUrl: 'http://rest',
    desktopProfileUiBaseUrl: 'https://profile.example.com',
    enableDevLoginUi: false,
    requestTimeoutMs: 60000,
    appName: 'test',
  },
}))

const mockGetOrIssue = vi.fn()
const mockRpcTokenManagerClear = vi.fn()
const mockRpcTokenManagerGetMetadata = vi.fn().mockReturnValue({
  expiresAtMs: null,
  scopes: [],
  hostRefs: [],
})

vi.mock('../rpcTokenManager.js', () => ({
  RpcTokenManager: class {
    getOrIssue = mockGetOrIssue
    clear = mockRpcTokenManagerClear
    getMetadata = mockRpcTokenManagerGetMetadata
  },
}))

const mockListSandboxUiApps = vi.fn()
const mockHealth = vi.fn().mockResolvedValue({ status: 'ok' })

vi.mock('../rpcProxyClient.js', () => ({
  RpcProxyClient: class {
    health = mockHealth
    listSandboxUiApps = mockListSandboxUiApps
  },
}))

vi.mock('../authClient.js', () => ({
  AuthClient: class {
    health = vi.fn().mockResolvedValue({ status: 'ok' })
    getMe = vi.fn()
  },
}))

vi.mock('../tokenStore.js', () => ({
  TokenStore: class {
    getSessionToken = vi.fn().mockResolvedValue(null)
    setSessionToken = vi.fn()
    clearSessionToken = vi.fn()
  },
}))

function makeService(): AppService {
  const svc = new AppService()
  ;(svc as unknown as { sessionToken: string }).sessionToken = 'session-token'
  return svc
}

describe('AppService.listSandboxUiApps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetOrIssue.mockResolvedValue({ token: 'rpc-token' })
    mockListSandboxUiApps.mockResolvedValue({ apps: [] })
  })

  it('issues a sandbox:ui:view RPC token using the Sandbox UI sentinel hostRef', async () => {
    mockListSandboxUiApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
        {
          appRef: 'sandbox-recipes/support-desk',
          title: 'Support Desk',
          defaultPath: '/tickets',
          ready: false,
          phase: 'deploying',
          updatedAt: null,
        },
      ],
    })

    const result = await makeService().listSandboxUiApps()

    expect(mockGetOrIssue).toHaveBeenCalledWith(
      'session-token',
      ['sandbox:ui:view'],
      ['sandbox-ui']
    )
    expect(mockListSandboxUiApps).toHaveBeenCalledWith('rpc-token')
    expect(result.apps.map(app => app.title)).toEqual(["Andy's Sales CRM", 'Support Desk'])
  })

  it('clears and reissues the RPC token when rpc-proxy reports a missing sandbox UI scope', async () => {
    mockGetOrIssue
      .mockResolvedValueOnce({ token: 'stale-rpc-token' })
      .mockResolvedValueOnce({ token: 'fresh-rpc-token' })
    mockListSandboxUiApps
      .mockRejectedValueOnce(new ApiError('403 Forbidden: missing scope', 403, 'missing scope'))
      .mockResolvedValueOnce({ apps: [] })

    await makeService().listSandboxUiApps()

    expect(mockRpcTokenManagerClear).toHaveBeenCalledOnce()
    expect(mockGetOrIssue).toHaveBeenNthCalledWith(
      1,
      'session-token',
      ['sandbox:ui:view'],
      ['sandbox-ui']
    )
    expect(mockGetOrIssue).toHaveBeenNthCalledWith(
      2,
      'session-token',
      ['sandbox:ui:view'],
      ['sandbox-ui']
    )
    expect(mockListSandboxUiApps).toHaveBeenNthCalledWith(1, 'stale-rpc-token')
    expect(mockListSandboxUiApps).toHaveBeenNthCalledWith(2, 'fresh-rpc-token')
  })
})

describe('AppService.openForgotPassword', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens the Profile UI forgot-password page without requiring an email', async () => {
    const service = new AppService() as unknown as {
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
    }
    const getInvitationProfile = vi.fn()
    service.memberRegistrationServiceClient = { getInvitationProfile } as never

    const result = await service.openForgotPassword('')
    const { shell } = await import('electron')

    expect(getInvitationProfile).not.toHaveBeenCalled()
    expect(shell.openExternal).toHaveBeenCalledWith('https://profile.example.com/forgot-password')
    expect(result).toEqual({ profileUiUrl: 'https://profile.example.com/forgot-password' })
  })

  it('opens the configured Profile UI forgot-password page with the login email prefilled', async () => {
    const service = new AppService() as unknown as {
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
    }
    const getInvitationProfile = vi.fn()
    service.memberRegistrationServiceClient = { getInvitationProfile } as never

    const result = await service.openForgotPassword(' User@Example.COM ')
    const { shell } = await import('electron')

    expect(getInvitationProfile).not.toHaveBeenCalled()
    expect(shell.openExternal).toHaveBeenCalledWith(
      'https://profile.example.com/forgot-password?email=user%40example.com'
    )
    expect(result).toEqual({
      profileUiUrl: 'https://profile.example.com/forgot-password?email=user%40example.com',
    })
  })
})

describe('AppService profile UI link authority', () => {
  it('uses and memoizes the authenticated invitation profile for shareable links', async () => {
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      resolveProfileUiBaseUrl: () => Promise<string>
      createSandboxUiDeepLink: (teamId?: string) => Promise<{ url: string }>
    }
    service.me = { id: 'user-1', email: 'user@tenant.example' }
    service.memberRegistrationServiceClient = {
      getInvitationProfile: vi.fn().mockResolvedValue({
        profileUiBaseUrl: 'https://profile.tenant.example',
      }),
    }
    mockGetActiveSandboxUiLocation.mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/tasks/42',
    })

    await expect(service.resolveProfileUiBaseUrl()).resolves.toBe('https://profile.tenant.example')
    await expect(service.createSandboxUiDeepLink('team-1')).resolves.toEqual({
      url:
        'https://profile.tenant.example/open/apps/sandbox-recipes/task-board' +
        '?path=%2Ftasks%2F42&team=team-1',
    })
    expect(service.memberRegistrationServiceClient.getInvitationProfile).toHaveBeenCalledTimes(1)
    expect(service.memberRegistrationServiceClient.getInvitationProfile).toHaveBeenCalledWith(
      'user@tenant.example'
    )
  })

  it('fails visibly instead of copying a localhost fallback after a lookup error', async () => {
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      createSandboxUiDeepLink: () => Promise<{ url: string }>
    }
    service.me = { id: 'user-1', email: 'user@tenant.example' }
    service.memberRegistrationServiceClient = {
      getInvitationProfile: vi.fn().mockRejectedValue(new Error('network unavailable')),
    }
    mockGetActiveSandboxUiLocation.mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/',
    })

    await expect(service.createSandboxUiDeepLink()).rejects.toThrow(
      'Cannot resolve a shareable Profile UI link'
    )
  })

  it('omits the path when the active app is still on its default route', async () => {
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      createSandboxUiDeepLink: (teamId?: string) => Promise<{ url: string }>
    }
    service.me = { id: 'user-1', email: 'user@tenant.example' }
    service.memberRegistrationServiceClient = {
      getInvitationProfile: vi.fn().mockResolvedValue({
        profileUiBaseUrl: 'https://profile.tenant.example',
      }),
    }
    mockGetActiveSandboxUiLocation.mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
    })

    await expect(service.createSandboxUiDeepLink('team-1')).resolves.toEqual({
      url: 'https://profile.tenant.example/open/apps/sandbox-recipes/task-board' + '?team=team-1',
    })
  })

  it('fails visibly when a successful profile lookup omits the Profile UI URL', async () => {
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      createSandboxUiDeepLink: () => Promise<{ url: string }>
    }
    service.me = { id: 'user-1', email: 'user@tenant.example' }
    service.memberRegistrationServiceClient = {
      getInvitationProfile: vi.fn().mockResolvedValue({ profileUiBaseUrl: '' }),
    }
    mockGetActiveSandboxUiLocation.mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/',
    })

    await expect(service.createSandboxUiDeepLink()).rejects.toThrow(
      'the invitation profile did not provide a Profile UI URL'
    )
    await expect(service.createSandboxUiDeepLink()).rejects.toThrow(
      'the invitation profile did not provide a Profile UI URL'
    )
    expect(service.memberRegistrationServiceClient.getInvitationProfile).toHaveBeenCalledTimes(2)
  })

  it('surfaces an invalid active app URL instead of copying its initial route', async () => {
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      createSandboxUiDeepLink: () => Promise<{ url: string }>
    }
    service.me = { id: 'user-1', email: 'user@tenant.example' }
    service.memberRegistrationServiceClient = {
      getInvitationProfile: vi.fn().mockResolvedValue({
        profileUiBaseUrl: 'https://profile.tenant.example',
      }),
    }
    mockGetActiveSandboxUiLocation.mockImplementation(() => {
      throw new Error('Cannot read the current app route')
    })

    await expect(service.createSandboxUiDeepLink()).rejects.toThrow(
      'Cannot read the current app route'
    )
    expect(service.memberRegistrationServiceClient.getInvitationProfile).not.toHaveBeenCalled()
  })
})
