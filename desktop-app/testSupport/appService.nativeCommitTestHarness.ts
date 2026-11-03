import { vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DesktopLogoutOutcome } from '../src/types.js'

vi.mock('../src/chatStoreBinding.js', async () => {
  const { createChatStoreBindingMock } = await import('./chatStoreBindingMock.js')
  return createChatStoreBindingMock()
})

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
  authClient: {
    googleLogin: ReturnType<typeof vi.fn>
    passwordLogin: ReturnType<typeof vi.fn>
    getMe: ReturnType<typeof vi.fn>
  }
  tokenStore: {
    clearSessionToken: ReturnType<typeof vi.fn>
    clearSessionTokenStrictly: ReturnType<typeof vi.fn>
    getSessionToken: ReturnType<typeof vi.fn>
    setSessionToken: ReturnType<typeof vi.fn>
  }
  sessionToken: string | null
  me: { id: string } | null
  gfsScopeIdentity: { ownerId: string; environmentKey: string; baseUrl: string } | null
  googleLogin: (token: string) => Promise<unknown>
  passwordLogin: (email: string, password: string) => Promise<unknown>
  logout: () => Promise<DesktopLogoutOutcome>
  selectRuntimeConfig: (optionId: string) => Promise<unknown>
  getSessionState: () => Promise<unknown>
  getSessionGeneration: () => number
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

export async function createNativeCommitTestHarness(options: { keytarAvailable?: boolean } = {}) {
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
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
      getSelectedStorageBackend: vi.fn(() => 'basic_text'),
      encryptString: vi.fn((value: string) => Buffer.from(value)),
      decryptString: vi.fn((value: Uint8Array) => Buffer.from(value).toString()),
    },
  }))
  if (options.keytarAvailable) {
    const keychain = new Map<string, string>()
    const keyOf = (service: string, account: string) => `${service}::${account}`
    vi.doMock('keytar', () => ({
      getPassword: vi.fn(
        async (service: string, account: string) => keychain.get(keyOf(service, account)) ?? null
      ),
      setPassword: vi.fn(async (service: string, account: string, token: string) => {
        keychain.set(keyOf(service, account), token)
      }),
      deletePassword: vi.fn(async (service: string, account: string) =>
        keychain.delete(keyOf(service, account))
      ),
    }))
  }

  const [{ AppService }, { TokenStore }, runtimeConfig] = await Promise.all([
    import('../src/appService.js'),
    import('../src/tokenStore.js'),
    import('../src/config.js'),
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

  const tokenStore = options.keytarAvailable
    ? new TokenStore()
    : new TokenStore({ isolatedUserDataPath: userDataDir })
  const service = new AppService({
    tokenStore,
    getUserDataDirectory: () => userDataDir,
  }) as unknown as NativeCommitTestService
  const clearSessionToken = tokenStore.clearSessionToken.bind(tokenStore)
  const clearSessionTokenStrictly = tokenStore.clearSessionTokenStrictly.bind(tokenStore)
  const getSessionToken = tokenStore.getSessionToken.bind(tokenStore)
  const setSessionToken = tokenStore.setSessionToken.bind(tokenStore)
  vi.spyOn(tokenStore, 'clearSessionToken').mockImplementation(clearSessionToken)
  vi.spyOn(tokenStore, 'clearSessionTokenStrictly').mockImplementation(clearSessionTokenStrictly)
  vi.spyOn(tokenStore, 'getSessionToken').mockImplementation(getSessionToken)
  vi.spyOn(tokenStore, 'setSessionToken').mockImplementation(setSessionToken)
  return { service, runtimeConfig, restA, restB, optionA, optionB, userDataDir }
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
