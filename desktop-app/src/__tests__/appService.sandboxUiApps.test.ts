import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildGfsResourceWebLink } from '@clerum/desktop-app-links'
import { AppService } from '../appService.js'
import { config } from '../config.js'
import { ApiError } from '../httpClient.js'

const {
  mockCancelSandboxUiRefresh,
  mockGetActiveSandboxUi,
  mockGetActiveSandboxUiLocation,
  mockInstallSandboxUiCookie,
  mockMountSandboxUiView,
  mockStartSandboxUiRefresh,
  mockUnmountSandboxUiView,
} = vi.hoisted(() => ({
  mockCancelSandboxUiRefresh: vi.fn(),
  mockGetActiveSandboxUi: vi.fn(),
  mockGetActiveSandboxUiLocation: vi.fn(),
  mockInstallSandboxUiCookie: vi.fn(),
  mockMountSandboxUiView: vi.fn(),
  mockStartSandboxUiRefresh: vi.fn(),
  mockUnmountSandboxUiView: vi.fn(),
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
  getActiveSandboxUi: mockGetActiveSandboxUi,
  getActiveSandboxUiLocation: mockGetActiveSandboxUiLocation,
  installSandboxUiCookie: mockInstallSandboxUiCookie,
  mountSandboxUiView: mockMountSandboxUiView,
  unmountSandboxUiView: mockUnmountSandboxUiView,
}))

vi.mock('../sandboxUiSessionRefresh.js', () => ({
  cancelSandboxUiRefresh: mockCancelSandboxUiRefresh,
  startSandboxUiRefresh: mockStartSandboxUiRefresh,
}))

vi.mock('../config.js', () => ({
  getActiveRuntimeConfigOptionId: () => null,
  getActiveEnvKey: () => 'test-env',
  config: {
    rpcProxyBaseUrl: 'http://proxy',
    externalRestApiBaseUrl: 'http://rest',
    desktopProfileUiBaseUrl: 'https://profile.example.com',
    desktopProfileUiBaseUrlExplicit: false,
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

describe('AppService sandbox UI lifecycle serialization', () => {
  const openArgs = (recipeName: string) => ({
    launchId: crypto.randomUUID(),
    recipeNs: 'sandbox-recipes',
    recipeName,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    parentWindow: {} as never,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockMountSandboxUiView.mockImplementation(
      async ({
        launchId,
        recipeNs,
        recipeName,
      }: {
        launchId: string
        recipeNs: string
        recipeName: string
      }) => {
        mockGetActiveSandboxUi.mockReturnValue({
          launchId,
          recipeNs,
          recipeName,
          appRef: `${recipeNs}/${recipeName}`,
          webContentsId: recipeName === 'first-app' ? 1 : 2,
        })
      }
    )
    mockInstallSandboxUiCookie.mockResolvedValue(undefined)
    mockUnmountSandboxUiView.mockResolvedValue(undefined)
  })

  it('finishes one mint, mount, and refresh setup before starting the next open', async () => {
    let resolveFirstMint!: (value: { setCookie: string }) => void
    let resolveSecondMint!: (value: { setCookie: string }) => void
    const firstMint = new Promise<{ setCookie: string }>(resolve => {
      resolveFirstMint = resolve
    })
    const secondMint = new Promise<{ setCookie: string }>(resolve => {
      resolveSecondMint = resolve
    })
    const service = makeService() as unknown as {
      mintSandboxUiSession: ReturnType<typeof vi.fn>
      openSandboxUi: AppService['openSandboxUi']
    }
    service.mintSandboxUiSession = vi
      .fn()
      .mockReturnValueOnce(firstMint)
      .mockReturnValueOnce(secondMint)

    const firstOpen = service.openSandboxUi(openArgs('first-app'))
    const secondOpen = service.openSandboxUi(openArgs('second-app'))

    await vi.waitFor(() => {
      expect(service.mintSandboxUiSession).toHaveBeenCalledTimes(1)
    })
    expect(mockMountSandboxUiView).not.toHaveBeenCalled()

    resolveFirstMint({
      setCookie:
        'clerum_sandbox_ui_session=first;' + ' Path=/api/v1/sandbox-ui/sandbox-recipes/first-app/',
    })
    await firstOpen
    expect(mockStartSandboxUiRefresh).toHaveBeenCalledTimes(1)
    expect(mockStartSandboxUiRefresh.mock.calls[0]?.[0]).toMatchObject({
      recipeNs: 'sandbox-recipes',
      recipeName: 'first-app',
      webContentsId: 1,
    })

    await vi.waitFor(() => {
      expect(service.mintSandboxUiSession).toHaveBeenCalledTimes(2)
    })
    resolveSecondMint({
      setCookie:
        'clerum_sandbox_ui_session=second;' +
        ' Path=/api/v1/sandbox-ui/sandbox-recipes/second-app/',
    })
    await secondOpen

    expect(mockMountSandboxUiView.mock.calls.map(call => call[0].recipeName)).toEqual([
      'first-app',
      'second-app',
    ])
    expect(mockStartSandboxUiRefresh.mock.calls[1]?.[0]).toMatchObject({
      recipeNs: 'sandbox-recipes',
      recipeName: 'second-app',
      webContentsId: 2,
    })
  })

  it('queues close behind an in-flight open so the final state stays closed', async () => {
    let resolveMint!: (value: { setCookie: string }) => void
    const mint = new Promise<{ setCookie: string }>(resolve => {
      resolveMint = resolve
    })
    const service = makeService() as unknown as {
      mintSandboxUiSession: ReturnType<typeof vi.fn>
      openSandboxUi: AppService['openSandboxUi']
      closeSandboxUi: AppService['closeSandboxUi']
    }
    service.mintSandboxUiSession = vi.fn().mockReturnValue(mint)

    const open = service.openSandboxUi(openArgs('first-app'))
    const close = service.closeSandboxUi()

    await vi.waitFor(() => {
      expect(service.mintSandboxUiSession).toHaveBeenCalledOnce()
    })
    // The open tears down whatever view was live BEFORE its mint (so a failed
    // mint never leaves the previous view behind); that is the only teardown so
    // far — the queued close has not run while the open is still in flight.
    expect(mockUnmountSandboxUiView).toHaveBeenCalledOnce()
    expect(mockMountSandboxUiView).not.toHaveBeenCalled()

    resolveMint({
      setCookie:
        'clerum_sandbox_ui_session=first;' + ' Path=/api/v1/sandbox-ui/sandbox-recipes/first-app/',
    })
    await open
    await close

    // The queued close runs strictly after the mount and refresh setup, so the
    // final state is closed: its unmount is the last driver call.
    expect(mockCancelSandboxUiRefresh).toHaveBeenCalledTimes(2)
    expect(mockUnmountSandboxUiView).toHaveBeenCalledTimes(2)
    const mountOrder = mockMountSandboxUiView.mock.invocationCallOrder[0]!
    const refreshStartOrder = mockStartSandboxUiRefresh.mock.invocationCallOrder[0]!
    const finalUnmountOrder = mockUnmountSandboxUiView.mock.invocationCallOrder[1]!
    const finalCancelOrder = mockCancelSandboxUiRefresh.mock.invocationCallOrder[1]!
    expect(finalUnmountOrder).toBeGreaterThan(mountOrder)
    expect(finalCancelOrder).toBeGreaterThan(refreshStartOrder)
  })

  it('refuses a refresh that lands after the session changed, without minting for the next session', async () => {
    const service = makeService() as unknown as {
      mintSandboxUiSession: ReturnType<typeof vi.fn>
      openSandboxUi: AppService['openSandboxUi']
      clearAuthenticatedSessionState(): void
      sessionToken: string | null
    }
    service.mintSandboxUiSession = vi.fn().mockResolvedValue({
      setCookie:
        'clerum_sandbox_ui_session=first;' + ' Path=/api/v1/sandbox-ui/sandbox-recipes/first-app/',
    })
    await service.openSandboxUi(openArgs('first-app'))
    const { refresh } = mockStartSandboxUiRefresh.mock.calls[0]![0] as {
      refresh: (ns: string, name: string) => Promise<{ setCookie: string }>
    }

    service.clearAuthenticatedSessionState()
    // A new user is signed in by the time the stale loop fires.
    service.sessionToken = 'next-session-token'

    await expect(refresh('sandbox-recipes', 'first-app')).rejects.toThrow(
      'The session changed while this app request was in flight'
    )
    expect(service.mintSandboxUiSession).toHaveBeenCalledOnce()
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

describe('AppService explicit Profile UI browser actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.desktopProfileUiBaseUrl = 'https://profile.example.com'
    config.desktopProfileUiBaseUrlExplicit = false
  })

  it('opens forgot-password and profile settings from a valid explicit root origin', async () => {
    config.desktopProfileUiBaseUrl = 'https://profile.self-hosted.example/'
    config.desktopProfileUiBaseUrlExplicit = true
    const service = new AppService() as unknown as {
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
      openProfileSettings: (
        email: string,
        options?: { section?: 'profile'; action?: 'password' }
      ) => Promise<{ profileUiUrl: string }>
    }
    const getInvitationProfile = vi.fn()
    service.memberRegistrationServiceClient = { getInvitationProfile } as never

    await expect(service.openForgotPassword(' User@Example.COM ')).resolves.toEqual({
      profileUiUrl: 'https://profile.self-hosted.example/forgot-password?email=user%40example.com',
    })
    await expect(
      service.openProfileSettings(' User@Example.COM ', {
        section: 'profile',
        action: 'password',
      })
    ).resolves.toEqual({
      profileUiUrl: 'https://profile.self-hosted.example/settings/profile?action=password',
    })
    const { shell } = await import('electron')

    expect(shell.openExternal).toHaveBeenNthCalledWith(
      1,
      'https://profile.self-hosted.example/forgot-password?email=user%40example.com'
    )
    expect(shell.openExternal).toHaveBeenNthCalledWith(
      2,
      'https://profile.self-hosted.example/settings/profile?action=password'
    )
    expect(getInvitationProfile).not.toHaveBeenCalled()
  })

  for (const [label, baseUrl] of [
    ['non-root pathname', 'https://profile.self-hosted.example/profile'],
    ['search parameters', 'https://profile.self-hosted.example?tenant=one'],
  ] as const) {
    it(`rejects an explicit Profile UI base URL with ${label}`, async () => {
      config.desktopProfileUiBaseUrl = baseUrl
      config.desktopProfileUiBaseUrlExplicit = true
      const service = new AppService() as unknown as {
        memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
        openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
        openProfileSettings: (email: string) => Promise<{ profileUiUrl: string }>
      }
      const getInvitationProfile = vi.fn()
      service.memberRegistrationServiceClient = { getInvitationProfile } as never

      await expect(service.openForgotPassword('user@example.com')).rejects.toThrow(
        'PROFILE_UI_BASE_URL must be an origin URL with a root pathname'
      )
      await expect(service.openProfileSettings('user@example.com')).rejects.toThrow(
        'PROFILE_UI_BASE_URL must be an origin URL with a root pathname'
      )
      const { shell } = await import('electron')

      expect(shell.openExternal).not.toHaveBeenCalled()
      expect(getInvitationProfile).not.toHaveBeenCalled()
    })
  }
})

describe('AppService profile UI link authority', () => {
  beforeEach(() => {
    config.desktopProfileUiBaseUrl = 'https://profile.example.com'
    config.desktopProfileUiBaseUrlExplicit = false
  })

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

  it('uses an explicit Profile UI base for shareable links without registration lookup', async () => {
    config.desktopProfileUiBaseUrl = 'https://profile.self-hosted.example'
    config.desktopProfileUiBaseUrlExplicit = true
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      createSandboxUiDeepLink: (teamId?: string) => Promise<{ url: string }>
    }
    service.me = { id: 'user-1', email: '' }
    service.memberRegistrationServiceClient = {
      getInvitationProfile: vi.fn().mockRejectedValue(new Error('lookup unavailable')),
    }
    mockGetActiveSandboxUiLocation.mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/tasks/42',
    })

    await expect(service.createSandboxUiDeepLink('team-1')).resolves.toEqual({
      url:
        'https://profile.self-hosted.example/open/apps/sandbox-recipes/task-board' +
        '?path=%2Ftasks%2F42&team=team-1',
    })
    expect(service.memberRegistrationServiceClient.getInvitationProfile).not.toHaveBeenCalled()
  })

  it('returns the effective authenticated Profile origin for link parsing', async () => {
    config.desktopProfileUiBaseUrl = 'https://profile.explicit.example'
    config.desktopProfileUiBaseUrlExplicit = true
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      sessionGeneration: number
      sessionToken: string
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      getGfsResourceProfileOrigin: () => Promise<{
        origin: string
        sessionGeneration: number
        envKey: string
      }>
    }
    service.me = { id: 'user-1', email: 'user@tenant.example' }
    service.sessionGeneration = 7
    service.memberRegistrationServiceClient = { getInvitationProfile: vi.fn() }

    await expect(service.getGfsResourceProfileOrigin()).resolves.toEqual({
      origin: 'https://profile.explicit.example',
      sessionGeneration: 7,
      envKey: 'test-env',
    })
    expect(service.memberRegistrationServiceClient.getInvitationProfile).not.toHaveBeenCalled()
  })

  it('returns a tenant-specific invitation origin rather than deriving from REST', async () => {
    config.desktopProfileUiBaseUrlExplicit = false
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      sessionGeneration: number
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      getGfsResourceProfileOrigin: () => Promise<{
        origin: string
        sessionGeneration: number
        envKey: string
      }>
    }
    service.me = { id: 'user-tenant', email: 'user@tenant.example' }
    service.sessionGeneration = 8
    service.memberRegistrationServiceClient = {
      getInvitationProfile: vi.fn().mockResolvedValue({
        profileUiBaseUrl: 'https://invitation-profile.tenant.example/',
      }),
    }

    await expect(service.getGfsResourceProfileOrigin()).resolves.toEqual({
      origin: 'https://invitation-profile.tenant.example',
      sessionGeneration: 8,
      envKey: 'test-env',
    })
  })

  it('creates a shareable GFS link with the canonical resource identity', async () => {
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      createGfsResourceDeepLink: (uri: string) => Promise<{ url: string }>
    }
    service.me = { id: 'user-1', email: 'user@tenant.example' }
    service.memberRegistrationServiceClient = {
      getInvitationProfile: vi.fn().mockResolvedValue({
        profileUiBaseUrl: 'https://profile.tenant.example',
      }),
    }
    const resourceUri = 'gfs://main/0123456789abcdef0123456789ABCDEF'

    await expect(service.createGfsResourceDeepLink(resourceUri)).resolves.toEqual({
      url: buildGfsResourceWebLink('https://profile.tenant.example', resourceUri),
    })
    expect(service.memberRegistrationServiceClient.getInvitationProfile).toHaveBeenCalledOnce()
    expect(service.memberRegistrationServiceClient.getInvitationProfile).toHaveBeenCalledWith(
      'user@tenant.example'
    )
  })

  it('uses the invitation-specific Profile origin and rejects a changed session', async () => {
    config.desktopProfileUiBaseUrlExplicit = false
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      sessionGeneration: number
      sessionToken: string
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      getGfsResourceProfileOrigin: () => Promise<unknown>
    }
    service.me = { id: 'user-1', email: 'user@tenant.example' }
    service.sessionGeneration = 11
    let releaseLookup!: (value: { profileUiBaseUrl: string }) => void
    service.memberRegistrationServiceClient = {
      getInvitationProfile: vi.fn(() => new Promise(resolve => (releaseLookup = resolve))),
    }
    const pending = service.getGfsResourceProfileOrigin()
    expect(releaseLookup).toBeTypeOf('function')
    service.sessionGeneration = 12
    releaseLookup({ profileUiBaseUrl: 'https://profile.tenant.example' })

    await expect(pending).rejects.toThrow('Desktop session changed')
  })

  it('coalesces concurrent Profile origin lookups for one session', async () => {
    config.desktopProfileUiBaseUrlExplicit = false
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      sessionGeneration: number
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      getGfsResourceProfileOrigin: () => Promise<{
        origin: string
        sessionGeneration: number
        envKey: string
      }>
    }
    service.me = { id: 'user-1', email: 'user@tenant.example' }
    service.sessionGeneration = 21
    let releaseLookup!: (value: { profileUiBaseUrl: string }) => void
    const lookup = vi.fn(
      () => new Promise<{ profileUiBaseUrl: string }>(resolve => (releaseLookup = resolve))
    )
    service.memberRegistrationServiceClient = { getInvitationProfile: lookup }

    const pending = Array.from({ length: 8 }, () => service.getGfsResourceProfileOrigin())
    expect(lookup).toHaveBeenCalledOnce()
    releaseLookup({ profileUiBaseUrl: 'https://invitation-profile.tenant.example' })

    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 8 }, () => ({
        origin: 'https://invitation-profile.tenant.example',
        sessionGeneration: 21,
        envKey: 'test-env',
      }))
    )
  })

  it('separates Profile origin lookups across session generations', async () => {
    config.desktopProfileUiBaseUrlExplicit = false
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      sessionGeneration: number
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      getGfsResourceProfileOrigin: () => Promise<{
        origin: string
        sessionGeneration: number
        envKey: string
      }>
    }
    service.me = { id: 'user-1', email: 'user@tenant.example' }
    service.sessionGeneration = 31
    let releaseOldLookup!: (value: { profileUiBaseUrl: string }) => void
    let releaseCurrentLookup!: (value: { profileUiBaseUrl: string }) => void
    const lookup = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<{ profileUiBaseUrl: string }>(resolve => (releaseOldLookup = resolve))
      )
      .mockImplementationOnce(
        () => new Promise<{ profileUiBaseUrl: string }>(resolve => (releaseCurrentLookup = resolve))
      )
    service.memberRegistrationServiceClient = { getInvitationProfile: lookup }

    const oldSession = service.getGfsResourceProfileOrigin()
    service.sessionGeneration = 32
    const currentSession = service.getGfsResourceProfileOrigin()
    expect(lookup).toHaveBeenCalledTimes(2)

    releaseCurrentLookup({ profileUiBaseUrl: 'https://current-profile.tenant.example' })
    await expect(currentSession).resolves.toMatchObject({
      origin: 'https://current-profile.tenant.example',
      sessionGeneration: 32,
    })
    releaseOldLookup({ profileUiBaseUrl: 'https://stale-profile.tenant.example' })
    await expect(oldSession).rejects.toThrow('Desktop session changed')

    await expect(service.getGfsResourceProfileOrigin()).resolves.toMatchObject({
      origin: 'https://current-profile.tenant.example',
      sessionGeneration: 32,
    })
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('clears a rejected Profile origin lookup so a later request can retry', async () => {
    config.desktopProfileUiBaseUrlExplicit = false
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      sessionGeneration: number
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      getGfsResourceProfileOrigin: () => Promise<{
        origin: string
        sessionGeneration: number
        envKey: string
      }>
    }
    service.me = { id: 'user-1', email: 'user@tenant.example' }
    service.sessionGeneration = 41
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary profile lookup failure'))
      .mockResolvedValueOnce({ profileUiBaseUrl: 'https://retry-profile.tenant.example' })
    service.memberRegistrationServiceClient = { getInvitationProfile: lookup }

    const failed = Array.from({ length: 4 }, () => service.getGfsResourceProfileOrigin())
    const failedResults = await Promise.allSettled(failed)
    expect(failedResults.every(result => result.status === 'rejected')).toBe(true)
    expect(lookup).toHaveBeenCalledOnce()

    await expect(service.getGfsResourceProfileOrigin()).resolves.toMatchObject({
      origin: 'https://retry-profile.tenant.example',
      sessionGeneration: 41,
    })
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the explicit Profile UI base is invalid', async () => {
    config.desktopProfileUiBaseUrl = 'javascript:alert(1)'
    config.desktopProfileUiBaseUrlExplicit = true
    const service = makeService() as unknown as {
      me: { id: string; email: string }
      memberRegistrationServiceClient: { getInvitationProfile: ReturnType<typeof vi.fn> }
      createSandboxUiDeepLink: () => Promise<{ url: string }>
    }
    service.me = { id: 'user-1', email: '' }
    service.memberRegistrationServiceClient = {
      getInvitationProfile: vi.fn().mockResolvedValue({
        profileUiBaseUrl: 'https://profile.tenant.example',
      }),
    }
    mockGetActiveSandboxUiLocation.mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/',
    })

    await expect(service.createSandboxUiDeepLink()).rejects.toThrow(
      'PROFILE_UI_BASE_URL must be an origin URL with a root pathname'
    )
    expect(service.memberRegistrationServiceClient.getInvitationProfile).not.toHaveBeenCalled()
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
