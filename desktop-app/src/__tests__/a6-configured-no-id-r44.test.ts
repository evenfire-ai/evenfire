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
it('uses configured REST origin without a saved profile ID', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-no-id-'))
  const rest = 'https://api-configured.example.test',
    rpc = 'https://rpc-configured.example.test',
    origin = 'https://profile-configured.example.test'
  delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  delete process.env.PROFILE_UI_BASE_URL
  process.env.EXTERNAL_REST_API_BASE_URL = rest
  process.env.RPC_PROXY_BASE_URL = rpc
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
  const [{ AppService }, cfg] = await Promise.all([
    import('../appService.js'),
    import('../config.js'),
  ])
  const service = new AppService() as unknown as {
    authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
    openForgotPassword: (email: string) => Promise<unknown>
  }
  const get = vi.fn().mockResolvedValue({
    externalRestApiBaseUrl: rest,
    responseUrl: `${rest}/api/v1/desktop/environment`,
    rpcProxyBaseUrl: rpc,
    appName: 'A',
    profileUiBaseUrl: origin,
  })
  service.authClient = { getDesktopEnvironmentForEndpoint: get }
  expect(cfg.getDesktopRuntimeConfigState().activeOptionId).toBeNull()
  await expect(service.openForgotPassword('user@example.test')).resolves.toBeDefined()
  expect(openExternal).toHaveBeenCalledWith(`${origin}/forgot-password?email=user%40example.test`)
  expect(cfg.getDesktopRuntimeConfigState().activeOptionId).toBeNull()
  await expect(fs.access(path.join(dir, 'runtime-configs', 'index.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
}, 15000)
