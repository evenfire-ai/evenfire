import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))
const saved = {
  config: process.env.CLERUM_DESKTOP_CONFIG_PATH,
  rest: process.env.EXTERNAL_REST_API_BASE_URL,
  rpc: process.env.RPC_PROXY_BASE_URL,
  profile: process.env.PROFILE_UI_BASE_URL,
}
let dir = ''
afterEach(async () => {
  for (const [key, value] of Object.entries({
    CLERUM_DESKTOP_CONFIG_PATH: saved.config,
    EXTERNAL_REST_API_BASE_URL: saved.rest,
    RPC_PROXY_BASE_URL: saved.rpc,
    PROFILE_UI_BASE_URL: saved.profile,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.resetModules()
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})
const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
it.each(['forgot', 'password', 'social', 'app', 'gfs'] as const)(
  'preserves legacy paired override precedence for %s',
  async kind => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-legacy-'))
    const file = path.join(dir, 'runtime.json'),
      rest = 'https://api.a.example.test',
      rpc = 'https://rpc.a.example.test',
      explicit = 'https://override.example.test'
    await fs.writeFile(
      file,
      JSON.stringify({ externalRestApiBaseUrl: rest, rpcProxyBaseUrl: rpc, appName: 'A' })
    )
    process.env.CLERUM_DESKTOP_CONFIG_PATH = file
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://api.a.example.test'
    process.env.RPC_PROXY_BASE_URL = 'https://rpc.other.example.test'
    process.env.PROFILE_UI_BASE_URL = explicit
    vi.resetModules()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    vi.doMock('electron', () => ({
      app: {
        getPath: () => dir,
        isPackaged: false,
        isReady: () => true,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      shell: { openExternal },
    }))
    const [{ AppService }, cfg, driver] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
      import('../sandboxUiDriver.js'),
    ])
    vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/tasks/42',
    })
    const service = new AppService() as unknown as {
      authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
      sessionToken: string | null
      me: { id: string; email: string } | null
      openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
      openProfileSettings: (email: string, options: object) => Promise<{ profileUiUrl: string }>
      createSandboxUiDeepLink: () => Promise<{ url: string }>
      createGfsResourceDeepLink: (uri: string) => Promise<{ url: string }>
    }
    service.sessionToken = 'synthetic-session'
    service.me = { id: 'user-1', email: 'user@example.test' }
    service.authClient = {
      getDesktopEnvironmentForEndpoint: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: rest,
        responseUrl: `${rest}/api/v1/desktop/environment`,
        rpcProxyBaseUrl: rpc,
        appName: 'A',
      }),
    }
    expect(cfg.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
    if (kind === 'forgot') {
      const r = await service.openForgotPassword('User@example.test')
      expect(r.profileUiUrl).toBe(`${explicit}/forgot-password?email=user%40example.test`)
      expect(openExternal).toHaveBeenCalledWith(r.profileUiUrl)
    }
    if (kind === 'password') {
      const r = await service.openProfileSettings('user@example.test', { action: 'password' })
      expect(r.profileUiUrl).toBe(`${explicit}/settings/profile?action=password`)
      expect(openExternal).toHaveBeenCalledWith(r.profileUiUrl)
    }
    if (kind === 'social') {
      const r = await service.openProfileSettings('user@example.test', {
        section: 'social',
        network: 'slack',
      })
      expect(r.profileUiUrl).toBe(`${explicit}/channels/slack`)
      expect(openExternal).toHaveBeenCalledWith(r.profileUiUrl)
    }
    if (kind === 'app')
      await expect(service.createSandboxUiDeepLink()).resolves.toEqual({
        url: `${derived}/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42`,
      })
    if (kind === 'gfs')
      await expect(service.createGfsResourceDeepLink(uri)).resolves.toEqual({
        url: `${derived}/open/files?uri=${encodeURIComponent(uri)}`,
      })
  },
  15000
)

it.each(['forgot', 'password', 'social', 'app', 'gfs'] as const)(
  'preserves paired loopback browser and share rules for %s',
  async kind => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-legacy-'))
    const file = path.join(dir, 'runtime.json'),
      rest = 'http://127.0.0.1:19147',
      rpc = 'https://rpc.a.example.test',
      explicit = 'https://override.example.test'
    await fs.writeFile(
      file,
      JSON.stringify({ externalRestApiBaseUrl: rest, rpcProxyBaseUrl: rpc, appName: 'A' })
    )
    process.env.CLERUM_DESKTOP_CONFIG_PATH = file
    process.env.EXTERNAL_REST_API_BASE_URL = rest
    process.env.RPC_PROXY_BASE_URL = 'https://rpc.other.example.test'
    process.env.PROFILE_UI_BASE_URL = explicit
    vi.resetModules()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    vi.doMock('electron', () => ({
      app: {
        getPath: () => dir,
        isPackaged: false,
        isReady: () => true,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      shell: { openExternal },
    }))
    const [{ AppService }, cfg, driver] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
      import('../sandboxUiDriver.js'),
    ])
    vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/tasks/42',
    })
    const service = new AppService() as unknown as {
      authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
      sessionToken: string | null
      me: { id: string; email: string } | null
      openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
      openProfileSettings: (email: string, options: object) => Promise<{ profileUiUrl: string }>
      createSandboxUiDeepLink: () => Promise<{ url: string }>
      createGfsResourceDeepLink: (uri: string) => Promise<{ url: string }>
    }
    service.sessionToken = 'synthetic-session'
    service.me = { id: 'user-1', email: 'user@example.test' }
    service.authClient = {
      getDesktopEnvironmentForEndpoint: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: rest,
        responseUrl: `${rest}/api/v1/desktop/environment`,
        rpcProxyBaseUrl: rpc,
        appName: 'A',
      }),
    }
    expect(cfg.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
    if (kind === 'forgot') {
      const r = await service.openForgotPassword('User@example.test')
      expect(r.profileUiUrl).toBe(`${explicit}/forgot-password?email=user%40example.test`)
      expect(openExternal).toHaveBeenCalledWith(r.profileUiUrl)
    }
    if (kind === 'password') {
      const r = await service.openProfileSettings('user@example.test', { action: 'password' })
      expect(r.profileUiUrl).toBe(`${explicit}/settings/profile?action=password`)
      expect(openExternal).toHaveBeenCalledWith(r.profileUiUrl)
    }
    if (kind === 'social') {
      const r = await service.openProfileSettings('user@example.test', {
        section: 'social',
        network: 'slack',
      })
      expect(r.profileUiUrl).toBe(`${explicit}/channels/slack`)
      expect(openExternal).toHaveBeenCalledWith(r.profileUiUrl)
    }
    if (kind === 'app') await expect(service.createSandboxUiDeepLink()).rejects.toThrow()
    if (kind === 'gfs') await expect(service.createGfsResourceDeepLink(uri)).rejects.toThrow()
  },
  15000
)

it.each(['forgot', 'password', 'social', 'app', 'gfs'] as const)(
  'preserves paired fragment browser and share rules for %s',
  async kind => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-legacy-'))
    const file = path.join(dir, 'runtime.json'),
      rest = 'https://api.a.example.test',
      rpc = 'https://rpc.a.example.test',
      explicit = 'https://override.example.test',
      derived = 'https://override.example.test'
    await fs.writeFile(
      file,
      JSON.stringify({ externalRestApiBaseUrl: rest, rpcProxyBaseUrl: rpc, appName: 'A' })
    )
    process.env.CLERUM_DESKTOP_CONFIG_PATH = file
    process.env.EXTERNAL_REST_API_BASE_URL = rest
    process.env.RPC_PROXY_BASE_URL = 'https://rpc.other.example.test'
    process.env.PROFILE_UI_BASE_URL = `${explicit}/#fragment`
    vi.resetModules()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    vi.doMock('electron', () => ({
      app: {
        getPath: () => dir,
        isPackaged: false,
        isReady: () => true,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      shell: { openExternal },
    }))
    const [{ AppService }, cfg, driver] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
      import('../sandboxUiDriver.js'),
    ])
    vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/tasks/42',
    })
    const service = new AppService() as unknown as {
      authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
      sessionToken: string | null
      me: { id: string; email: string } | null
      openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
      openProfileSettings: (email: string, options: object) => Promise<{ profileUiUrl: string }>
      createSandboxUiDeepLink: () => Promise<{ url: string }>
      createGfsResourceDeepLink: (uri: string) => Promise<{ url: string }>
    }
    service.sessionToken = 'synthetic-session'
    service.me = { id: 'user-1', email: 'user@example.test' }
    service.authClient = {
      getDesktopEnvironmentForEndpoint: vi.fn().mockResolvedValue({
        externalRestApiBaseUrl: rest,
        responseUrl: `${rest}/api/v1/desktop/environment`,
        rpcProxyBaseUrl: rpc,
        appName: 'A',
      }),
    }
    expect(cfg.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
    if (kind === 'forgot') {
      const r = await service.openForgotPassword('User@example.test')
      expect(r.profileUiUrl).toBe(`${explicit}/forgot-password?email=user%40example.test`)
      expect(openExternal).toHaveBeenCalledWith(r.profileUiUrl)
    }
    if (kind === 'password') {
      const r = await service.openProfileSettings('user@example.test', { action: 'password' })
      expect(r.profileUiUrl).toBe(`${explicit}/settings/profile?action=password`)
      expect(openExternal).toHaveBeenCalledWith(r.profileUiUrl)
    }
    if (kind === 'social') {
      const r = await service.openProfileSettings('user@example.test', {
        section: 'social',
        network: 'slack',
      })
      expect(r.profileUiUrl).toBe(`${explicit}/channels/slack`)
      expect(openExternal).toHaveBeenCalledWith(r.profileUiUrl)
    }
    if (kind === 'app') await expect(service.createSandboxUiDeepLink()).rejects.toThrow()
    if (kind === 'gfs') await expect(service.createGfsResourceDeepLink(uri)).rejects.toThrow()
  },
  15000
)
