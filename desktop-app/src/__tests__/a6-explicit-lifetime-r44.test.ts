import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))
const oldEnv = {
  config: process.env.CLERUM_DESKTOP_CONFIG_PATH,
  rest: process.env.EXTERNAL_REST_API_BASE_URL,
  rpc: process.env.RPC_PROXY_BASE_URL,
  profile: process.env.PROFILE_UI_BASE_URL,
}
let dir = ''
afterEach(async () => {
  for (const [key, value] of Object.entries({
    CLERUM_DESKTOP_CONFIG_PATH: oldEnv.config,
    EXTERNAL_REST_API_BASE_URL: oldEnv.rest,
    RPC_PROXY_BASE_URL: oldEnv.rpc,
    PROFILE_UI_BASE_URL: oldEnv.profile,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.resetModules()
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})
it('does not populate an explicit replacement with the old response', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-explicit-'))
  const file = path.join(dir, 'runtime.json')
  const rest = 'https://api-a.example.test',
    rpc = 'https://rpc-a.example.test',
    oldOrigin = 'https://old-profile.example.test'
  await fs.writeFile(
    file,
    JSON.stringify({ externalRestApiBaseUrl: rest, rpcProxyBaseUrl: rpc, appName: 'A' })
  )
  process.env.CLERUM_DESKTOP_CONFIG_PATH = file
  delete process.env.EXTERNAL_REST_API_BASE_URL
  delete process.env.RPC_PROXY_BASE_URL
  delete process.env.PROFILE_UI_BASE_URL
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: {
      getPath: () => dir,
      isPackaged: false,
      isReady: () => true,
      setName: vi.fn(),
      setPath: vi.fn(),
    },
    shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
  }))
  const [{ AppService }, cfg] = await Promise.all([
    import('../appService.js'),
    import('../config.js'),
  ])
  const service = new AppService() as unknown as {
    authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
    tokenStore: unknown
    openForgotPassword: (email: string) => Promise<unknown>
    deleteRuntimeConfig: (id: string) => Promise<unknown>
    saveRuntimeConfig: (config: {
      externalRestApiBaseUrl: string
      rpcProxyBaseUrl: string
      appName: string
    }) => Promise<unknown>
    suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    stopAllStreams: () => void
  }
  service.tokenStore = {
    clearSessionToken: vi.fn().mockResolvedValue(undefined),
    getSessionToken: vi.fn().mockResolvedValue(null),
    setSessionToken: vi.fn().mockResolvedValue(undefined),
  }
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
  service.stopAllStreams = vi.fn()
  let release!: (value: unknown) => void
  const held = new Promise(resolve => {
    release = resolve
  })
  const get = vi
    .fn()
    .mockReturnValueOnce(held)
    .mockRejectedValue(new Error('replacement discovery offline'))
  service.authClient = { getDesktopEnvironmentForEndpoint: get }
  expect(cfg.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
  const action = service.openForgotPassword('user@example.test')
  void action.catch(() => undefined)
  await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
  await service.deleteRuntimeConfig('custom-file')
  await expect(fs.readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await service
    .saveRuntimeConfig({ externalRestApiBaseUrl: rest, rpcProxyBaseUrl: rpc, appName: 'A' })
    .catch(() => undefined)
  expect(cfg.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
  expect(JSON.parse(await fs.readFile(file, 'utf8')).externalRestApiBaseUrl).toBe(rest)
  release({
    externalRestApiBaseUrl: rest,
    responseUrl: `${rest}/api/v1/desktop/environment`,
    rpcProxyBaseUrl: rpc,
    appName: 'A',
    profileUiBaseUrl: oldOrigin,
  })
  await action.catch(() => undefined)
  const replacement = JSON.parse(await fs.readFile(file, 'utf8'))
  expect(replacement.profileUiBaseUrl).not.toBe(oldOrigin)
}, 15000)
