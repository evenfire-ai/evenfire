import { vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))

export type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

export type NativeCommitTestService = {
  authClient: { googleLogin: ReturnType<typeof vi.fn> }
  tokenStore: {
    clearSessionToken: ReturnType<typeof vi.fn>
    getSessionToken: ReturnType<typeof vi.fn>
    setSessionToken: ReturnType<typeof vi.fn>
  }
  sessionToken: string | null
  me: { id: string } | null
  gfsScopeIdentity: { ownerId: string; environmentKey: string; baseUrl: string } | null
  updateDesktopGfsUploadState: ReturnType<typeof vi.fn>
  readDesktopGfsUploadState: ReturnType<typeof vi.fn>
  googleLogin: (token: string) => Promise<unknown>
  logout: () => Promise<number>
  selectRuntimeConfig: (optionId: string) => Promise<unknown>
  getSessionState: () => Promise<unknown>
  getCachedUserId: () => string | null
  listGfsUploadSessions: () => Promise<unknown>
}

const originalEnvironment = {
  appData: process.env.APPDATA,
  configPath: process.env.CLERUM_DESKTOP_CONFIG_PATH,
  externalRest: process.env.EXTERNAL_REST_API_BASE_URL,
  rpcProxy: process.env.RPC_PROXY_BASE_URL,
  profileUi: process.env.PROFILE_UI_BASE_URL,
}
const tempDirs = new Set<string>()

export async function createNativeCommitTestHarness() {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-native-commit-'))
  tempDirs.add(userDataDir)
  delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  delete process.env.EXTERNAL_REST_API_BASE_URL
  delete process.env.RPC_PROXY_BASE_URL
  delete process.env.PROFILE_UI_BASE_URL
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: {
      getPath: vi.fn((name: string) =>
        name === 'appData' ? path.dirname(userDataDir) : userDataDir
      ),
      isPackaged: false,
      isReady: vi.fn(() => true),
      setName: vi.fn(),
      setPath: vi.fn(),
    },
  }))

  const [{ AppService }, runtimeConfig] = await Promise.all([
    import('../appService.js'),
    import('../config.js'),
  ])
  const restA = 'https://api-a.example.test'
  const restB = 'https://api-b.example.test'
  await runtimeConfig.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: restA,
    rpcProxyBaseUrl: 'https://rpc-a.example.test',
    appName: 'Environment A',
  })
  const optionA = runtimeConfig
    .getDesktopRuntimeConfigState()
    .options.find(option => option.externalRestApiBaseUrl === restA)
  await runtimeConfig.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: restB,
    rpcProxyBaseUrl: 'https://rpc-b.example.test',
    appName: 'Environment B',
  })
  const optionB = runtimeConfig
    .getDesktopRuntimeConfigState()
    .options.find(option => option.externalRestApiBaseUrl === restB)
  if (!optionA || !optionB) throw new Error('test runtime profiles were not created')
  await runtimeConfig.selectDesktopRuntimeConfigOption(optionA.id)

  const service = new AppService() as unknown as NativeCommitTestService
  service.tokenStore = {
    clearSessionToken: vi.fn().mockResolvedValue(undefined),
    getSessionToken: vi.fn().mockResolvedValue(null),
    setSessionToken: vi.fn().mockResolvedValue(undefined),
  } as never
  service.updateDesktopGfsUploadState = vi.fn().mockResolvedValue(undefined)
  service.readDesktopGfsUploadState = vi.fn().mockResolvedValue({ version: 1, records: [] })

  return { service, runtimeConfig, restA, restB, optionA, optionB }
}

export async function cleanupNativeCommitTestHarness(): Promise<void> {
  for (const [key, value] of Object.entries({
    APPDATA: originalEnvironment.appData,
    CLERUM_DESKTOP_CONFIG_PATH: originalEnvironment.configPath,
    EXTERNAL_REST_API_BASE_URL: originalEnvironment.externalRest,
    RPC_PROXY_BASE_URL: originalEnvironment.rpcProxy,
    PROFILE_UI_BASE_URL: originalEnvironment.profileUi,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
  await Promise.all([...tempDirs].map(dir => fs.rm(dir, { recursive: true, force: true })))
  tempDirs.clear()
}
