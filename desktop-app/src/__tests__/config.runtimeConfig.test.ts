import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

describe('desktop runtime config', () => {
  const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
  const originalExternalRestApiBaseUrl = process.env.EXTERNAL_REST_API_BASE_URL
  const originalRpcProxyBaseUrl = process.env.RPC_PROXY_BASE_URL
  const originalDesktopAppName = process.env.DESKTOP_APP_NAME
  const originalArgv = [...process.argv]
  const originalRendererUrl = process.env.EVENFIRE_RENDERER_URL
  let tempUserDataDir: string | null = null

  beforeEach(() => {
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

    const { config, getDesktopRuntimeConfigState, selectDesktopRuntimeConfigOption } =
      await import('../config.js')

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

    const { config, getDesktopRuntimeConfigState } = await import('../config.js')

    expect(config.externalRestApiBaseUrl).toBe('https://api.remote.example.com')
    expect(config.rpcProxyBaseUrl).toBe('https://rpc.remote.example.com')
    expect(getDesktopRuntimeConfigState().activeOptionId).toBe('remote')
  })
})
