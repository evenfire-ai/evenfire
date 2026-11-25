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
it('reads the producer-persisted origin after restart with discovery offline', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-offline-'))
  const file = path.join(dir, 'runtime.json'),
    rest = 'https://api-a.example.test',
    rpc = 'https://rpc-a.example.test',
    origin = 'https://profile-unique.example.test'
  await fs.writeFile(
    file,
    JSON.stringify({ externalRestApiBaseUrl: rest, rpcProxyBaseUrl: rpc, appName: 'A' })
  )
  process.env.CLERUM_DESKTOP_CONFIG_PATH = file
  delete process.env.EXTERNAL_REST_API_BASE_URL
  delete process.env.RPC_PROXY_BASE_URL
  delete process.env.PROFILE_UI_BASE_URL
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
  const { AppService } = await import('../appService.js')
  const first = new AppService() as unknown as {
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
  first.authClient = { getDesktopEnvironmentForEndpoint: get }
  await first.openForgotPassword('user@example.test')
  expect(get).toHaveBeenCalledOnce()
  expect(JSON.parse(await fs.readFile(file, 'utf8')).profileUiBaseUrl).toBe(origin)
  vi.resetModules()
  const { AppService: Restarted } = await import('../appService.js')
  const second = new Restarted() as unknown as typeof first
  const offline = vi.fn().mockRejectedValue(new Error('offline'))
  second.authClient = { getDesktopEnvironmentForEndpoint: offline }
  await second.openForgotPassword('user@example.test')
  expect(openExternal).toHaveBeenLastCalledWith(
    `${origin}/forgot-password?email=user%40example.test`
  )
  expect(offline).not.toHaveBeenCalled()
}, 15000)
