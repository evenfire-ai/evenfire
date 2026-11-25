import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

describe('desktop runtime config', () => {
  const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
  const originalExternalRestApiBaseUrl = process.env.EXTERNAL_REST_API_BASE_URL
  const originalProfileUiBaseUrl = process.env.PROFILE_UI_BASE_URL
  const originalRpcProxyBaseUrl = process.env.RPC_PROXY_BASE_URL
  const originalDesktopAppName = process.env.DESKTOP_APP_NAME
  const originalArgv = [...process.argv]
  const originalRendererUrl = process.env.EVENFIRE_RENDERER_URL
  let tempUserDataDir: string | null = null

  it('does not treat a hostname with a 127 prefix as an IPv4 loopback address', async () => {
    const runtime = await import('../config.js')
    expect(() =>
      runtime.validateProfileUiOrigin('http://127.attacker.example', 'http://127.0.0.1:8091')
    ).toThrow()
  })

  it('treats the absolute localhost DNS name as loopback for pairing checks', async () => {
    const runtime = await import('../config.js')
    expect(runtime.validateProfileUiOrigin('http://localhost.:3001', 'http://127.0.0.1:8091')).toBe(
      'http://localhost.:3001'
    )
    expect(() =>
      runtime.validateProfileUiOrigin('https://localhost.', 'https://api.remote.example.test')
    ).toThrow()
  })

  it.each([
    ['dot segments', 'http://localhost.:3001/..'],
    ['encoded dot segments', 'http://localhost.:3001/%2e%2e'],
    ['empty query delimiter', 'http://localhost.:3001/?'],
    ['empty fragment delimiter', 'http://localhost.:3001/#'],
    ['trailing backslash', 'http://localhost.:3001\\'],
  ])('rejects raw Profile UI URL syntax with %s before URL normalization', async (_label, raw) => {
    const runtime = await import('../config.js')
    expect(() => runtime.validateProfileUiOrigin(raw, 'http://127.0.0.1:8091')).toThrow()
  })

  it.each([
    'https://192.0.2.3',
    'https://198.51.100.2',
    'https://203.0.113.3',
    'https://[::ffff:192.0.2.3]',
    'https://[fec0::1]',
    'https://[ff02::1]',
    'https://[ff05::1]',
  ])('accepts a valid HTTPS Profile UI address %s', async origin => {
    const runtime = await import('../config.js')
    expect(runtime.validateProfileUiOrigin(origin, 'https://api.example.test')).toBe(
      new URL(origin).origin
    )
  })

  beforeEach(async () => {
    tempUserDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'evenfire-runtime-config-'))
    process.env.CLERUM_DESKTOP_CONFIG_PATH = path.join(tempUserDataDir, 'runtime-config.json')
    vi.doUnmock('electron')
    vi.resetModules()
  })

  afterEach(async () => {
    if (originalConfigPath === undefined) {
      delete process.env.CLERUM_DESKTOP_CONFIG_PATH
    } else {
      process.env.CLERUM_DESKTOP_CONFIG_PATH = originalConfigPath
    }
    if (originalExternalRestApiBaseUrl === undefined) {
      delete process.env.EXTERNAL_REST_API_BASE_URL
    } else {
      process.env.EXTERNAL_REST_API_BASE_URL = originalExternalRestApiBaseUrl
    }
    if (originalProfileUiBaseUrl === undefined) {
      delete process.env.PROFILE_UI_BASE_URL
    } else {
      process.env.PROFILE_UI_BASE_URL = originalProfileUiBaseUrl
    }
    if (originalRpcProxyBaseUrl === undefined) {
      delete process.env.RPC_PROXY_BASE_URL
    } else {
      process.env.RPC_PROXY_BASE_URL = originalRpcProxyBaseUrl
    }
    if (originalDesktopAppName === undefined) {
      delete process.env.DESKTOP_APP_NAME
    } else {
      process.env.DESKTOP_APP_NAME = originalDesktopAppName
    }
    process.argv.splice(0, process.argv.length, ...originalArgv)
    if (originalRendererUrl === undefined) {
      delete process.env.EVENFIRE_RENDERER_URL
    } else {
      process.env.EVENFIRE_RENDERER_URL = originalRendererUrl
    }

    if (tempUserDataDir) {
      await fsp.rm(tempUserDataDir, { recursive: true, force: true })
      tempUserDataDir = null
    }

    vi.doUnmock('electron')
    vi.resetModules()
  })

  it('derives the Profile origin from the active REST deployment when the operator pair does not match', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://api.prod.evenfire.test'
    process.env.PROFILE_UI_BASE_URL = 'https://profile.prod.evenfire.test'
    vi.doMock('electron', () => ({
      app: {
        getPath: () => '/tmp/evenfire',
        isPackaged: false,
        isReady: () => false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))
    const runtime = await import('../config.js')
    runtime.config.externalRestApiBaseUrl = 'https://customer-rest.example.test:9443/api?tenant=one'

    runtime.config.externalRestApiBaseUrl = 'https://api.dev.evenfire.test'
    expect(runtime.config.desktopProfileUiBaseUrl).toBe('https://profile.prod.evenfire.test')
    expect(runtime.getActiveDeploymentProfileUiBaseUrl()).toBe('https://profile.dev.evenfire.test')

    runtime.config.externalRestApiBaseUrl = 'https://api.prod.evenfire.test'
    expect(runtime.getActiveDeploymentProfileUiBaseUrl()).toBe('https://profile.prod.evenfire.test')
  })

  it('uses the explicit Profile origin for its matching custom REST binding', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL =
      'https://customer-rest.example.test:9443/api?tenant=one'
    process.env.PROFILE_UI_BASE_URL = 'https://profile.customer.example.test:9444'
    vi.doMock('electron', () => ({
      app: {
        getPath: () => '/tmp/evenfire',
        isPackaged: false,
        isReady: () => false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))
    const runtime = await import('../config.js')

    expect(runtime.getActiveDeploymentProfileUiBaseUrl()).toBe(
      'https://profile.customer.example.test:9444'
    )
  })

  it('refuses an unknown active deployment instead of using a configured fallback origin', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://configured-customer.example'
    process.env.PROFILE_UI_BASE_URL = 'https://profile.customer.example'
    vi.doMock('electron', () => ({
      app: {
        getPath: () => '/tmp/evenfire',
        isPackaged: false,
        isReady: () => false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))
    const runtime = await import('../config.js')
    runtime.config.externalRestApiBaseUrl = 'https://active-customer.example'

    expect(() => runtime.getActiveDeploymentProfileUiBaseUrl()).toThrow(
      'Cannot resolve a shareable Profile UI link for the active desktop deployment'
    )
  })

  it('persists a discovered origin permanently with its exact legacy environment', async () => {
    const rest = 'https://api.legacy-customer.example.test:9443/api?tenant=legacy'
    const profile = 'https://profile.customer.example.test:9444'
    process.env.EXTERNAL_REST_API_BASE_URL = rest
    delete process.env.PROFILE_UI_BASE_URL
    vi.doMock('electron', () => ({
      app: {
        getPath: () => '/tmp/evenfire',
        isPackaged: false,
        isReady: () => false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))
    const runtime = await import('../config.js')
    await runtime.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: 'https://rpc.customer.example.test',
      appName: 'Legacy Customer',
    })
    const identity = runtime.captureProfileOriginBinding()
    if (!identity.profileId || !identity.filePath)
      throw new Error('saved environment binding is unavailable')
    await runtime.persistProfileOriginForBinding(identity, profile)
    const savedPath = runtime
      .getDesktopRuntimeConfigState()
      .options.find(option => option.id === identity.profileId)?.configPath
    expect(savedPath).toBeTruthy()
    expect(JSON.parse(await fsp.readFile(savedPath!, 'utf8'))).toMatchObject({
      externalRestApiBaseUrl: rest,
      profileUiBaseUrl: profile,
    })

    vi.resetModules()
    const restarted = await import('../config.js')
    expect(restarted.captureProfileOriginBinding()).toMatchObject({
      profileId: identity.profileId,
      restBaseUrl: rest,
      profileUiBaseUrl: profile,
    })
  })

  it('preserves the saved origin through a generic save for the same deployment binding', async () => {
    const rest = 'https://api.customer.example.test:9443/api?tenant=save'
    const profile = 'https://profile.customer.example.test:9444'
    process.env.EXTERNAL_REST_API_BASE_URL = rest
    delete process.env.PROFILE_UI_BASE_URL
    vi.doMock('electron', () => ({
      app: {
        getPath: () => '/tmp/evenfire',
        isPackaged: false,
        isReady: () => false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))
    const runtime = await import('../config.js')
    await runtime.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: 'https://rpc.customer.example.test',
      appName: 'Customer',
    })
    const identity = runtime.captureProfileOriginBinding()
    if (!identity.profileId) throw new Error('saved environment binding is unavailable')
    await runtime.persistProfileOriginForBinding(identity, profile)

    await runtime.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: 'https://rpc.customer.example.test',
      appName: 'Customer Updated',
    })

    expect(runtime.captureProfileOriginBinding()).toMatchObject({
      profileId: identity.profileId,
      restBaseUrl: rest,
      profileUiBaseUrl: profile,
    })
  })

  it('does not publish a Profile origin when writing the saved record fails', async () => {
    const rest = 'https://api.customer.example.test:9443/api?tenant=failed-write'
    const profile = 'https://profile.customer.example.test:9444'
    process.env.EXTERNAL_REST_API_BASE_URL = rest
    delete process.env.PROFILE_UI_BASE_URL
    vi.doMock('electron', () => ({
      app: {
        getPath: () => '/tmp/evenfire',
        isPackaged: false,
        isReady: () => false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))
    const runtime = await import('../config.js')
    await runtime.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'Customer',
    })
    const identity = runtime.captureProfileOriginBinding()
    if (!identity.profileId) throw new Error('saved environment binding is unavailable')
    const option = runtime
      .getDesktopRuntimeConfigState()
      .options.find(candidate => candidate.id === identity.profileId)
    if (!option?.configPath) throw new Error('saved environment file is unavailable')

    const write = fsp.writeFile.bind(fsp)
    const failure = vi.spyOn(fsp, 'writeFile').mockImplementation((...args: any[]) => {
      if (String(args[0]) === option.configPath) throw new Error('fixture profile write denied')
      return write(...(args as Parameters<typeof fsp.writeFile>))
    })
    try {
      await expect(runtime.persistProfileOriginForBinding(identity, profile)).rejects.toThrow(
        'fixture profile write denied'
      )
    } finally {
      failure.mockRestore()
    }

    expect(runtime.captureProfileOriginBinding()).not.toHaveProperty('profileUiBaseUrl')
    expect(JSON.parse(await fsp.readFile(option.configPath, 'utf8'))).not.toHaveProperty(
      'profileUiBaseUrl'
    )
  })

  it('removes the permanently saved Profile origin with its deleted environment', async () => {
    const rest = 'https://api.delete-origin.example.test'
    const profile = 'https://profile.delete-origin.example.test'
    process.env.EXTERNAL_REST_API_BASE_URL = rest
    delete process.env.PROFILE_UI_BASE_URL
    vi.doMock('electron', () => ({
      app: {
        getPath: () => '/tmp/evenfire',
        isPackaged: false,
        isReady: () => false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))
    const runtime = await import('../config.js')
    await runtime.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'Delete origin',
    })
    const identity = runtime.captureProfileOriginBinding()
    if (!identity.profileId) throw new Error('saved environment binding is unavailable')
    const option = runtime
      .getDesktopRuntimeConfigState()
      .options.find(candidate => candidate.id === identity.profileId)
    if (!option?.configPath) throw new Error('saved environment file is unavailable')
    await runtime.persistProfileOriginForBinding(identity, profile)
    expect(JSON.parse(await fsp.readFile(option.configPath, 'utf8'))).toMatchObject({
      profileUiBaseUrl: profile,
    })

    await runtime.deleteDesktopRuntimeConfigOption(identity.profileId)

    expect(runtime.getDesktopRuntimeConfigState().options).not.toContainEqual(
      expect.objectContaining({ id: identity.profileId })
    )
    await expect(fsp.access(option.configPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps saved loopback environments persistent while Localhost stays a static preset', async () => {
    const rest = 'http://127.0.0.1:27191'
    const rpc = 'http://127.0.0.1:27194'
    const oldProfile = 'http://127.0.0.1:27101'
    const newProfile = 'http://127.0.0.1:27201'
    process.env.EXTERNAL_REST_API_BASE_URL = rest
    process.env.RPC_PROXY_BASE_URL = rpc
    delete process.env.PROFILE_UI_BASE_URL
    vi.doMock('electron', () => ({
      app: {
        getPath: () => '/tmp/evenfire',
        isPackaged: false,
        isReady: () => false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))
    const runtime = await import('../config.js')
    const initialState = runtime.getDesktopRuntimeConfigState()
    expect(initialState.options).toContainEqual(
      expect.objectContaining({ id: '__localhost__', source: 'localhost', configPath: null })
    )
    await runtime.selectDesktopRuntimeConfigOption('__localhost__')
    expect(runtime.getActiveDeploymentProfileUiBaseUrl()).toBe('http://127.0.0.1:3001')

    await runtime.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: rpc,
      appName: 'User loopback',
    })
    let identity = runtime.captureProfileOriginBinding()
    if (!identity.profileId) throw new Error('saved user profile binding is unavailable')
    await runtime.persistProfileOriginForBinding(identity, oldProfile)
    let option = runtime
      .getDesktopRuntimeConfigState()
      .options.find(candidate => candidate.id === identity!.profileId)
    if (!option?.configPath) throw new Error('saved user profile file is unavailable')
    expect(JSON.parse(await fsp.readFile(option.configPath, 'utf8'))).toMatchObject({
      profileUiBaseUrl: oldProfile,
    })

    await runtime.deleteDesktopRuntimeConfigOption(identity.profileId)
    await runtime.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: rpc,
      appName: 'User loopback',
    })
    identity = runtime.captureProfileOriginBinding()
    if (!identity.profileId) throw new Error('re-added user profile binding is unavailable')
    expect(identity).not.toHaveProperty('profileUiBaseUrl')
    await runtime.persistProfileOriginForBinding(identity, newProfile)
    option = runtime
      .getDesktopRuntimeConfigState()
      .options.find(candidate => candidate.id === identity!.profileId)
    if (!option?.configPath) throw new Error('re-added user profile file is unavailable')
    expect(JSON.parse(await fsp.readFile(option.configPath, 'utf8'))).toMatchObject({
      profileUiBaseUrl: newProfile,
    })
  })

  it('uses the paired configured local Profile port for real App and GFS share links', async () => {
    process.env.EXTERNAL_REST_API_BASE_URL = 'http://127.0.0.1:27191'
    process.env.RPC_PROXY_BASE_URL = 'http://127.0.0.1:27194'
    process.env.PROFILE_UI_BASE_URL = 'https://127.0.0.1:27101'
    process.env.EVENFIRE_RENDERER_URL = 'http://127.0.0.1:5173'
    vi.doMock('electron', () => ({
      app: {
        getPath: () => '/tmp/evenfire',
        isPackaged: false,
        isReady: () => false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      },
      shell: { openExternal: vi.fn() },
    }))
    const runtime = await import('../config.js')
    await runtime.selectDesktopRuntimeConfigOption('__localhost__')
    runtime.config.externalRestApiBaseUrl = 'http://127.0.0.1:27191'
    runtime.config.rpcProxyBaseUrl = 'http://127.0.0.1:27194'

    vi.doMock('../sandboxUiDriver.js', () => ({
      getActiveSandboxUi: vi.fn(),
      getActiveSandboxUiLocation: vi.fn(() => ({
        recipeNs: 'sandbox-recipes',
        recipeName: 'task-board',
        path: '/tasks/42',
      })),
      installSandboxUiCookie: vi.fn(),
      mountSandboxUiView: vi.fn(),
      unmountSandboxUiView: vi.fn(),
    }))
    vi.doMock('../sandboxUiSessionRefresh.js', () => ({
      cancelSandboxUiRefresh: vi.fn(),
      startSandboxUiRefresh: vi.fn(),
    }))
    vi.doMock('../rpcTokenManager.js', () => ({
      RpcTokenManager: class {
        getOrIssue = vi.fn()
        clear = vi.fn()
        getMetadata = vi.fn()
      },
    }))
    vi.doMock('../rpcProxyClient.js', () => ({
      RpcProxyClient: class {
        health = vi.fn()
        listSandboxUiApps = vi.fn()
      },
    }))
    vi.doMock('../authClient.js', () => ({
      AuthClient: class {
        health = vi.fn()
        getMe = vi.fn()
      },
    }))
    vi.doMock('../tokenStore.js', () => ({
      TokenStore: class {
        getSessionToken = vi.fn()
        setSessionToken = vi.fn()
        clearSessionToken = vi.fn()
      },
    }))
    const { AppService } = await import('../appService.js')
    const service = new AppService() as unknown as {
      me: { id: string; email: string }
      sessionToken: string
      createSandboxUiDeepLink: () => Promise<{ url: string }>
      createGfsResourceDeepLink: (uri: string) => Promise<{ url: string }>
    }
    service.me = { id: 'local-user', email: 'local@example.test' }
    service.sessionToken = 'session-token'

    const resourceUri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const [app, gfs] = await Promise.all([
      service.createSandboxUiDeepLink(),
      service.createGfsResourceDeepLink(resourceUri),
    ])

    expect({ app: app.url, gfs: gfs.url }).toEqual({
      app: 'https://127.0.0.1:27101/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42',
      gfs: 'https://127.0.0.1:27101/open/files?uri=' + encodeURIComponent(resourceUri),
    })
    expect(runtime.getActiveDeploymentProfileUiBaseUrl()).toBe('https://127.0.0.1:27101')

    for (const invalidOrigin of [
      'http://user:secret@127.0.0.1:27101',
      'http://127.0.0.1:27101/profile',
      'http://127.0.0.1:27101?tenant=one',
      'http://127.0.0.1:27101#fragment',
    ]) {
      runtime.config.desktopProfileUiBaseUrl = invalidOrigin
      expect(() => runtime.getActiveDeploymentProfileUiBaseUrl()).toThrow(
        'Cannot resolve a shareable Profile UI link for the active desktop deployment'
      )
    }
    runtime.config.desktopProfileUiBaseUrl = 'https://unrelated.example.test'
    expect(() => runtime.getActiveDeploymentProfileUiBaseUrl()).toThrow(
      'Cannot resolve a shareable Profile UI link for the active desktop deployment'
    )

    runtime.config.desktopProfileUiBaseUrl = 'http://127.0.0.1:27101'
    runtime.config.externalRestApiBaseUrl = 'http://localhost:27191'
    expect(runtime.getActiveDeploymentProfileUiBaseUrl()).toBe('http://127.0.0.1:27101')
    runtime.config.desktopProfileUiBaseUrl = 'https://127.0.0.1:27101'
    runtime.config.externalRestApiBaseUrl = 'http://[::1]:27191'
    expect(runtime.getActiveDeploymentProfileUiBaseUrl()).toBe('https://127.0.0.1:27101')
    runtime.config.externalRestApiBaseUrl = 'http://[::1]:27192'
    expect(runtime.getActiveDeploymentProfileUiBaseUrl()).toBe('http://[::1]:3001')
    runtime.config.externalRestApiBaseUrl = 'https://api.customer.example.test:8443/base'
    expect(runtime.getActiveDeploymentProfileUiBaseUrl()).toBe(
      'https://profile.customer.example.test:8443'
    )
    runtime.config.externalRestApiBaseUrl = 'https://customer.example.test'
    expect(() => runtime.getActiveDeploymentProfileUiBaseUrl()).toThrow(
      'Cannot resolve a shareable Profile UI link for the active desktop deployment'
    )
  })

  it('keeps same-named profiles independent when saved in the same millisecond', async () => {
    tempUserDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'evenfire-user-data-'))
    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) =>
          name === 'userData' ? tempUserDataDir : path.dirname(tempUserDataDir || os.tmpdir())
        ),
        isPackaged: true,
        isReady: vi.fn(() => true),
        setName: vi.fn(),
      },
    }))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000)
    try {
      const runtimeConfig = await import('../config.js')
      const firstConfig = {
        appName: 'Example tenant',
        externalRestApiBaseUrl: 'https://first-api.example.test',
        rpcProxyBaseUrl: 'https://first-rpc.example.test',
      }
      const secondConfig = {
        appName: firstConfig.appName,
        externalRestApiBaseUrl: 'https://second-api.example.test',
        rpcProxyBaseUrl: 'https://second-rpc.example.test',
      }
      await runtimeConfig.saveDesktopRuntimeConfig(firstConfig)
      await runtimeConfig.saveDesktopRuntimeConfig(secondConfig)
      const options = runtimeConfig.getDesktopRuntimeConfigState().options
      const first = options.find(
        option => option.externalRestApiBaseUrl === firstConfig.externalRestApiBaseUrl
      )
      const second = options.find(
        option => option.externalRestApiBaseUrl === secondConfig.externalRestApiBaseUrl
      )
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      expect(first!.id).not.toBe(second!.id)

      await runtimeConfig.selectDesktopRuntimeConfigOption(first!.id)
      expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(firstConfig.externalRestApiBaseUrl)
      await runtimeConfig.deleteDesktopRuntimeConfigOption(first!.id)
      expect(runtimeConfig.getDesktopRuntimeConfigState().options).toContainEqual(
        expect.objectContaining({ id: second!.id, ...secondConfig })
      )

      vi.resetModules()
      const reloaded = await import('../config.js')
      expect(reloaded.getDesktopRuntimeConfigState().options).toContainEqual(
        expect.objectContaining({ id: second!.id, ...secondConfig })
      )
      expect(reloaded.getDesktopRuntimeConfigState().options).not.toContainEqual(
        expect.objectContaining({ id: first!.id })
      )
    } finally {
      clock.mockRestore()
    }
  })

  it('keeps localhost selectable in packaged builds with prod env defaults', async () => {
    tempUserDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'evenfire-user-data-'))
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://example.com'
    process.env.RPC_PROXY_BASE_URL = 'https://example.com'

    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) =>
          name === 'userData' ? tempUserDataDir : path.dirname(tempUserDataDir || os.tmpdir())
        ),
        isPackaged: true,
        isReady: vi.fn(() => true),
        setName: vi.fn(),
      },
    }))

    const {
      config,
      getActiveDeploymentProfileUiBaseUrl,
      getDesktopRuntimeConfigState,
      selectDesktopRuntimeConfigOption,
    } = await import('../config.js')

    expect(config.externalRestApiBaseUrl).toBe('https://example.com')
    expect(config.rpcProxyBaseUrl).toBe('https://example.com')

    const initialState = getDesktopRuntimeConfigState()
    const localhostOption = initialState.options.find(option => option.id === '__localhost__')

    expect(initialState.configured).toBe(false)
    expect(initialState.activeOptionId).toBeNull()
    expect(initialState.storagePath).toBe(path.join(tempUserDataDir, 'runtime-configs'))
    expect(localhostOption).toMatchObject({
      label: 'Localhost',
      externalRestApiBaseUrl: 'http://127.0.0.1:8091',
      rpcProxyBaseUrl: 'http://127.0.0.1:8094',
    })

    await selectDesktopRuntimeConfigOption('__localhost__')

    expect(getDesktopRuntimeConfigState()).toMatchObject({
      configured: true,
      activeOptionId: '__localhost__',
    })
    expect(config.externalRestApiBaseUrl).toBe('http://127.0.0.1:8091')
    expect(config.rpcProxyBaseUrl).toBe('http://127.0.0.1:8094')
    expect(getActiveDeploymentProfileUiBaseUrl()).toBe('http://127.0.0.1:3001')
    expect(
      getDesktopRuntimeConfigState().options.find(option => option.id === '__localhost__')
    ).toMatchObject({ configPath: null, source: 'localhost' })
  })

  it('ignores CLERUM_DESKTOP_CONFIG_PATH in packaged builds', async () => {
    tempUserDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'evenfire-user-data-'))
    const explicitConfigPath = path.join(tempUserDataDir, 'explicit-runtime-config.json')
    await fsp.writeFile(
      explicitConfigPath,
      JSON.stringify({
        externalRestApiBaseUrl: 'https://explicit-api.example.com',
        rpcProxyBaseUrl: 'https://explicit-rpc.example.com',
        appName: 'Explicit',
      })
    )
    process.env.CLERUM_DESKTOP_CONFIG_PATH = explicitConfigPath
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://packaged-api.example.com'
    process.env.RPC_PROXY_BASE_URL = 'https://packaged-rpc.example.com'

    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) =>
          name === 'userData' ? tempUserDataDir : path.dirname(tempUserDataDir || os.tmpdir())
        ),
        isPackaged: true,
        isReady: vi.fn(() => true),
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))

    const { config, getDesktopRuntimeConfigState } = await import('../config.js')

    expect(config.externalRestApiBaseUrl).toBe('https://packaged-api.example.com')
    expect(config.rpcProxyBaseUrl).toBe('https://packaged-rpc.example.com')
    expect(getDesktopRuntimeConfigState().storagePath).toBe(
      path.join(tempUserDataDir, 'runtime-configs')
    )
  })

  it('selects localhost for the packaged development app used by npm run ui', async () => {
    tempUserDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'evenfire-user-data-'))
    const runtimeConfigDir = path.join(tempUserDataDir, 'runtime-configs')
    await fsp.mkdir(runtimeConfigDir, { recursive: true })
    await fsp.writeFile(
      path.join(runtimeConfigDir, 'index.json'),
      JSON.stringify({
        version: 1,
        activeProfileId: 'prod',
        profiles: [
          {
            id: 'prod',
            appName: 'Production',
            fileName: 'runtime-config-prod.json',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    )
    await fsp.writeFile(
      path.join(runtimeConfigDir, 'runtime-config-prod.json'),
      JSON.stringify({
        externalRestApiBaseUrl: 'https://api.example.com',
        rpcProxyBaseUrl: 'https://rpc.example.com',
        appName: 'Production',
      })
    )
    delete process.env.CLERUM_DESKTOP_CONFIG_PATH
    delete process.env.DESKTOP_APP_NAME
    process.env.EXTERNAL_REST_API_BASE_URL = 'http://127.0.0.1:8091'
    process.env.RPC_PROXY_BASE_URL = 'http://127.0.0.1:8094'
    process.env.EVENFIRE_RENDERER_URL = 'http://127.0.0.1:5173'
    process.argv.push('--evenfire-desktop-dev-package')

    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) =>
          name === 'userData' ? tempUserDataDir : path.dirname(tempUserDataDir || os.tmpdir())
        ),
        isPackaged: true,
        isReady: vi.fn(() => true),
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))

    const { config, getDesktopRuntimeConfigState } = await import('../config.js')

    expect(config.externalRestApiBaseUrl).toBe('http://127.0.0.1:8091')
    expect(config.rpcProxyBaseUrl).toBe('http://127.0.0.1:8094')

    expect(getDesktopRuntimeConfigState()).toMatchObject({
      configured: true,
      isLocalhost: true,
      activeOptionId: '__localhost__',
    })
  })

  it('does not let the packaged-development escape hatch activate remote endpoints', async () => {
    tempUserDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'evenfire-user-data-'))
    delete process.env.CLERUM_DESKTOP_CONFIG_PATH
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://attacker.example.com'
    process.env.RPC_PROXY_BASE_URL = 'https://rpc.attacker.example.com'
    process.argv.push('--evenfire-desktop-dev-package')

    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) =>
          name === 'userData' ? tempUserDataDir : path.dirname(tempUserDataDir || os.tmpdir())
        ),
        isPackaged: true,
        isReady: vi.fn(() => true),
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))

    const { getDesktopRuntimeConfigState } = await import('../config.js')

    expect(getDesktopRuntimeConfigState()).toMatchObject({
      configured: false,
      activeOptionId: null,
    })
  })

  it('does not let the packaged-development escape hatch select arbitrary loopback ports', async () => {
    tempUserDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'evenfire-user-data-'))
    delete process.env.CLERUM_DESKTOP_CONFIG_PATH
    process.env.EXTERNAL_REST_API_BASE_URL = 'http://127.0.0.1:21770'
    process.env.RPC_PROXY_BASE_URL = 'http://127.0.0.1:21773'
    process.argv.push('--evenfire-desktop-dev-package')

    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) =>
          name === 'userData' ? tempUserDataDir : path.dirname(tempUserDataDir || os.tmpdir())
        ),
        isPackaged: true,
        isReady: vi.fn(() => true),
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))

    const { getDesktopRuntimeConfigState } = await import('../config.js')

    expect(getDesktopRuntimeConfigState()).toMatchObject({
      configured: false,
      activeOptionId: null,
    })
  })

  it('preserves env-provided localhost runtime ports without selecting the fixed localhost profile', async () => {
    tempUserDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'evenfire-user-data-'))
    delete process.env.CLERUM_DESKTOP_CONFIG_PATH
    delete process.env.DESKTOP_APP_NAME
    process.env.EXTERNAL_REST_API_BASE_URL = 'http://127.0.0.1:21770'
    process.env.RPC_PROXY_BASE_URL = 'http://127.0.0.1:21773'

    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) =>
          name === 'userData' ? tempUserDataDir : path.dirname(tempUserDataDir || os.tmpdir())
        ),
        isPackaged: false,
        isReady: vi.fn(() => true),
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))

    const { config, getDesktopRuntimeConfigState } = await import('../config.js')

    expect(config.externalRestApiBaseUrl).toBe('http://127.0.0.1:21770')
    expect(config.rpcProxyBaseUrl).toBe('http://127.0.0.1:21773')

    const state = getDesktopRuntimeConfigState()
    const localhostOption = state.options.find(option => option.id === '__localhost__')

    expect(state.configured).toBe(true)
    expect(state.isLocalhost).toBe(true)
    expect(state.activeOptionId).toBeNull()
    expect(localhostOption).toMatchObject({
      externalRestApiBaseUrl: 'http://127.0.0.1:8091',
      rpcProxyBaseUrl: 'http://127.0.0.1:8094',
    })
  })

  it('keeps a saved remote profile when an unpackaged run lacks the renderer dev flag', async () => {
    tempUserDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'evenfire-user-data-'))
    const runtimeConfigDir = path.join(tempUserDataDir, 'runtime-configs')
    await fsp.mkdir(runtimeConfigDir, { recursive: true })
    await fsp.writeFile(
      path.join(runtimeConfigDir, 'index.json'),
      JSON.stringify({
        version: 1,
        activeProfileId: 'remote',
        profiles: [
          {
            id: 'remote',
            appName: 'Remote',
            fileName: 'runtime-config-remote.json',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'remote-other-rpc',
            appName: 'Remote Other RPC',
            fileName: 'runtime-config-remote-other-rpc.json',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    )
    await fsp.writeFile(
      path.join(runtimeConfigDir, 'runtime-config-remote.json'),
      JSON.stringify({
        externalRestApiBaseUrl: 'https://api.remote.example.com',
        rpcProxyBaseUrl: 'https://rpc.remote.example.com',
        appName: 'Remote',
      })
    )
    await fsp.writeFile(
      path.join(runtimeConfigDir, 'runtime-config-remote-other-rpc.json'),
      JSON.stringify({
        externalRestApiBaseUrl: 'https://api.remote.example.com',
        rpcProxyBaseUrl: 'https://rpc-alt.remote.example.com',
        appName: 'Remote Other RPC',
      })
    )
    delete process.env.CLERUM_DESKTOP_CONFIG_PATH
    delete process.env.EVENFIRE_RENDERER_URL
    process.env.EXTERNAL_REST_API_BASE_URL = 'http://127.0.0.1:8091'
    process.env.RPC_PROXY_BASE_URL = 'http://127.0.0.1:8094'

    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) =>
          name === 'userData' ? tempUserDataDir : path.dirname(tempUserDataDir || os.tmpdir())
        ),
        isPackaged: false,
        isReady: vi.fn(() => true),
        setName: vi.fn(),
        setPath: vi.fn(),
      },
    }))

    const { config, getActiveLegacyEnvKeys, getDesktopRuntimeConfigState } =
      await import('../config.js')

    expect(config.externalRestApiBaseUrl).toBe('https://api.remote.example.com')
    expect(config.rpcProxyBaseUrl).toBe('https://rpc.remote.example.com')
    expect(getDesktopRuntimeConfigState().activeOptionId).toBe('remote')
    expect(getActiveLegacyEnvKeys()).toEqual([])
  })
})
