import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const boundary = vi.hoisted(() => ({
  directory: '',
  keychain: new Map<string, string>(),
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
  notifySessionChanged: vi.fn(),
}))
const keyOf = (service: string, account: string) => `${service}::${account}`
vi.mock('keytar', () => boundary)
vi.mock('electron', () => ({
  app: { getPath: () => boundary.directory, isReady: () => true },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  },
}))
vi.mock('../chatStoreBinding.js', async () => {
  const { createChatStoreBindingMock } = await import('../../testSupport/chatStoreBindingMock.js')
  return createChatStoreBindingMock()
})
vi.mock('../pluginSdkRuntime.js', () => ({
  tryGetPluginSdkRuntime: () => ({
    notifySessionChanged: boundary.notifySessionChanged,
    unpinAllSandboxUiSurfaces: vi.fn(),
  }),
}))

const homeToken = 'fixture-journal-home'
const teamToken = 'fixture-journal-team'
const freshToken = 'fixture-journal-fresh'
const homeMe = {
  id: 'fixture-journal-home-user',
  email: 'fixture-journal@example.com',
  name: null,
  picture: null,
  teamId: 'fixture-home',
  teamName: 'Fixture home',
  role: 'member',
}
const freshMe = { ...homeMe, id: 'fixture-journal-fresh-user' }
const userFor = (token: string) =>
  token === freshToken
    ? freshMe
    : { ...homeMe, teamId: token === teamToken ? 'fixture-team' : homeMe.teamId }
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.doMock('keytar', () => boundary)
  boundary.keychain.clear()
  boundary.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-journal-producer-'))
  boundary.getPassword
    .mockReset()
    .mockImplementation(
      async (service, account) => boundary.keychain.get(keyOf(service, account)) ?? null
    )
  boundary.setPassword.mockReset().mockImplementation(async (service, account, token) => {
    boundary.keychain.set(keyOf(service, account), token)
  })
  boundary.deletePassword
    .mockReset()
    .mockImplementation(async (service, account) =>
      boundary.keychain.delete(keyOf(service, account))
    )
  boundary.notifySessionChanged.mockReset()
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(boundary.directory, { recursive: true, force: true })
  boundary.directory = ''
  boundary.keychain.clear()
  vi.resetModules()
})

async function harness() {
  const [{ AppService }, { TokenStore }, markers, journal, config] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../pendingExternalLogout.js'),
    import('../sessionPersistenceJournal.js'),
    import('../config.js'),
  ])
  await config.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'https://auth.example.test/api',
    rpcProxyBaseUrl: 'https://rpc.example.test',
    appName: 'Evenfire Test',
  })
  const tokenStore = new TokenStore()
  const reportFailure = vi.fn()
  const service = new AppService({
    tokenStore,
    getUserDataDirectory: () => boundary.directory,
    reportDeferredLogoutFailure: reportFailure,
  })
  const state = service as unknown as {
    sessionToken: string | null
    me: typeof homeMe | null
    authClient: {
      passwordLogin: (
        email: string,
        password: string
      ) => Promise<{ token: string; me: typeof homeMe }>
      getMe: (token: string) => Promise<typeof homeMe>
      switchTeam: (token: string, teamId: string) => Promise<{ token: string }>
    }
  }
  vi.spyOn(state.authClient, 'passwordLogin').mockResolvedValue({ token: homeToken, me: homeMe })
  vi.spyOn(state.authClient, 'getMe').mockImplementation(async token => userFor(token))
  vi.spyOn(state.authClient, 'switchTeam').mockResolvedValue({ token: teamToken })
  const envKey = config.getActiveEnvKey()
  return {
    service,
    state,
    tokenStore,
    markers,
    journal,
    envKey,
    reportFailure,
  }
}

describe('R21-M6 terminal live recovery metadata remains a pure ownership check', () => {
  it('preserves prior accepted authority after a public replacement login fails', async () => {
    const h = await harness()
    await expect(h.service.passwordLogin(homeMe.email, 'fixture-password')).resolves.toMatchObject({
      authenticated: true,
      me: homeMe,
    })
    const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
    const prior = await readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(prior.status).toBe('accepted')
    if (prior.status !== 'accepted') throw new Error('Expected the prior V1 source')
    const priorSource = prior.session.accepted.record.frame.source
    expect(priorSource).toMatchObject({ format: 'v1', kind: 'keytar' })
    if (!priorSource || priorSource.format !== 'v1' || priorSource.kind !== 'keytar')
      throw new Error('Expected the prior accepted Keytar source')
    const priorKeytarAccount = `session-v1:${priorSource.sourceRef}`
    const priorStoredValue = boundary.keychain.get(keyOf('Evenfire', priorKeytarAccount))
    expect(priorStoredValue).toBeDefined()
    const { safeStorage } = await import('electron')
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    boundary.setPassword.mockImplementationOnce(async (service, account, token) => {
      boundary.keychain.set(keyOf(service, account), token)
      throw new Error('fixture-Fresh setter rejected after publication')
    })
    const notifyBefore = boundary.notifySessionChanged.mock.calls.length
    vi.mocked(h.state.authClient.passwordLogin).mockResolvedValueOnce({
      token: freshToken,
      me: freshMe,
    })
    await expect(h.service.passwordLogin(freshMe.email, 'fixture-password')).rejects.toThrow(
      'fixture-Fresh setter rejected after publication'
    )
    expect(boundary.keychain.get(keyOf('Evenfire', priorKeytarAccount))).toBe(priorStoredValue)
    const liveToken = h.state.sessionToken
    const liveMe = h.state.me
    const notifications = boundary.notifySessionChanged.mock.calls.slice(notifyBefore)
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(freshToken)
    expect(liveToken).toBe(homeToken)
    expect(liveMe).toEqual(homeMe)
    expect(notifications).not.toContainEqual([false])
  })
})
