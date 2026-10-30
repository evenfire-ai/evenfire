import { vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const appServicePriorRecoveryFixture = {
  directory: '',
  keychain: new Map<string, string>(),
  getPassword: vi.fn(
    async (service: string, account: string) =>
      appServicePriorRecoveryFixture.keychain.get(`${service}::${account}`) ?? null
  ),
  setPassword: vi.fn(async (service: string, account: string, token: string) => {
    appServicePriorRecoveryFixture.keychain.set(`${service}::${account}`, token)
  }),
  deletePassword: vi.fn(async (service: string, account: string) =>
    appServicePriorRecoveryFixture.keychain.delete(`${service}::${account}`)
  ),
  notifySessionChanged: vi.fn(),
  previousRestUrl: undefined as string | undefined,
  previousRpcUrl: undefined as string | undefined,
}

export const homeToken = 'fixture-journal-home'
export const teamToken = 'fixture-journal-team'
export const freshToken = 'fixture-journal-fresh'
export const homeMe = {
  id: 'fixture-journal-home-user',
  email: 'fixture-journal@example.com',
  name: null,
  picture: null,
  teamId: 'fixture-home',
  teamName: 'Fixture home',
  role: 'member',
}
export const freshMe = { ...homeMe, id: 'fixture-journal-fresh-user' }

export function keyOf(service: string, account: string): string {
  return `${service}::${account}`
}

export function useAppServicePriorRecoveryEnvironmentUrls(): void {
  process.env.EXTERNAL_REST_API_BASE_URL = 'http://rest.accepted-prior.test'
  process.env.RPC_PROXY_BASE_URL = 'http://rpc.accepted-prior.test'
}

export function restoreAppServicePriorRecoveryEnvironmentUrls(): void {
  const fixture = appServicePriorRecoveryFixture
  if (fixture.previousRestUrl === undefined) delete process.env.EXTERNAL_REST_API_BASE_URL
  else process.env.EXTERNAL_REST_API_BASE_URL = fixture.previousRestUrl
  if (fixture.previousRpcUrl === undefined) delete process.env.RPC_PROXY_BASE_URL
  else process.env.RPC_PROXY_BASE_URL = fixture.previousRpcUrl
}

export function userFor(token: string) {
  return token === freshToken
    ? freshMe
    : { ...homeMe, teamId: token === teamToken ? 'fixture-team' : homeMe.teamId }
}

export function createAppServicePriorRecoveryElectronFixture() {
  return {
    app: { getPath: () => appServicePriorRecoveryFixture.directory, isReady: () => true },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
      decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
    },
  }
}

export function createAppServicePriorRecoveryKeytarFixture() {
  return {
    getPassword: appServicePriorRecoveryFixture.getPassword,
    setPassword: appServicePriorRecoveryFixture.setPassword,
    deletePassword: appServicePriorRecoveryFixture.deletePassword,
  }
}

export async function resetAppServicePriorRecoveryFixture(): Promise<void> {
  const fixture = appServicePriorRecoveryFixture
  vi.resetModules()
  vi.clearAllMocks()
  fixture.keychain.clear()
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-prior-recovery-'))
  fixture.previousRestUrl = process.env.EXTERNAL_REST_API_BASE_URL
  fixture.previousRpcUrl = process.env.RPC_PROXY_BASE_URL
  useAppServicePriorRecoveryEnvironmentUrls()
  fixture.getPassword
    .mockReset()
    .mockImplementation(
      async (service, account) => fixture.keychain.get(keyOf(service, account)) ?? null
    )
  fixture.setPassword.mockReset().mockImplementation(async (service, account, token) => {
    fixture.keychain.set(keyOf(service, account), token)
  })
  fixture.deletePassword
    .mockReset()
    .mockImplementation(async (service, account) =>
      fixture.keychain.delete(keyOf(service, account))
    )
  fixture.notifySessionChanged.mockReset()
  vi.doMock('keytar', () => createAppServicePriorRecoveryKeytarFixture())
  vi.doMock('electron', () => createAppServicePriorRecoveryElectronFixture())
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
}

export async function disposeAppServicePriorRecoveryFixture(): Promise<void> {
  const fixture = appServicePriorRecoveryFixture
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
  fixture.directory = ''
  restoreAppServicePriorRecoveryEnvironmentUrls()
  fixture.keychain.clear()
  vi.resetModules()
}

export async function createAppServicePriorRecoveryHarness(options?: {
  persistRuntimeConfig?: boolean
}) {
  if (options?.persistRuntimeConfig) restoreAppServicePriorRecoveryEnvironmentUrls()
  else useAppServicePriorRecoveryEnvironmentUrls()
  const [{ AppService }, { TokenStore }, acceptance, config] = await Promise.all([
    import('../src/appService.js'),
    import('../src/tokenStore.js'),
    import('../src/sessionAuthorityAcceptance.js'),
    import('../src/config.js'),
  ])
  if (options?.persistRuntimeConfig) {
    await config.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'https://auth.example.test/api',
      rpcProxyBaseUrl: 'https://rpc.example.test',
      appName: 'Evenfire Test',
    })
  }
  const tokenStore = new TokenStore()
  const reportFailure = vi.fn()
  const service = new AppService({
    tokenStore,
    getUserDataDirectory: () => appServicePriorRecoveryFixture.directory,
    reportDeferredLogoutFailure: reportFailure,
  })
  const state = service as unknown as {
    sessionToken: string | null
    me: typeof homeMe | null
    authClient: {
      getMe: (token: string) => Promise<typeof homeMe>
      switchTeam: (token: string, teamId: string) => Promise<{ token: string }>
      passwordLogin: (
        email: string,
        password: string
      ) => Promise<{ token: string; me: typeof homeMe }>
    }
  }
  vi.spyOn(state.authClient, 'getMe').mockImplementation(async token => userFor(token))
  vi.spyOn(state.authClient, 'switchTeam').mockResolvedValue({ token: teamToken })
  vi.spyOn(state.authClient, 'passwordLogin').mockResolvedValue({ token: homeToken, me: homeMe })
  return {
    service,
    state,
    tokenStore,
    acceptance,
    config,
    envKey: config.getActiveEnvKey(),
    reportFailure,
  }
}
