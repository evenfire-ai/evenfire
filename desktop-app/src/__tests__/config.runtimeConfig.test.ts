import { afterEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

describe('desktop runtime config', () => {
  const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
  const originalExternalRestApiBaseUrl = process.env.EXTERNAL_REST_API_BASE_URL
  const originalRpcProxyBaseUrl = process.env.RPC_PROXY_BASE_URL
  const originalDesktopAppName = process.env.DESKTOP_APP_NAME
  let tempUserDataDir: string | null = null

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
})
