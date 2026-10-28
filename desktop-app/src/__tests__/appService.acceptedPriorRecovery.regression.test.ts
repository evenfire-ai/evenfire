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
vi.mock('../chatStoreBinding.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../chatStoreBinding.js')>()
  return {
    ...actual,
    bindChatStoreForUser: vi.fn(),
    unbindChatStore: vi.fn(),
  }
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
let previousRestUrl: string | undefined
let previousRpcUrl: string | undefined
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.doMock('keytar', () => boundary)
  boundary.keychain.clear()
  boundary.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-journal-producer-'))
  previousRestUrl = process.env.EXTERNAL_REST_API_BASE_URL
  previousRpcUrl = process.env.RPC_PROXY_BASE_URL
  process.env.EXTERNAL_REST_API_BASE_URL = 'http://rest.accepted-prior.test'
  process.env.RPC_PROXY_BASE_URL = 'http://rpc.accepted-prior.test'
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
  if (previousRestUrl === undefined) delete process.env.EXTERNAL_REST_API_BASE_URL
  else process.env.EXTERNAL_REST_API_BASE_URL = previousRestUrl
  if (previousRpcUrl === undefined) delete process.env.RPC_PROXY_BASE_URL
  else process.env.RPC_PROXY_BASE_URL = previousRpcUrl
  boundary.keychain.clear()
  vi.resetModules()
})

async function harness() {
  const [{ AppService }, { TokenStore }, acceptance, config] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../sessionAuthorityAcceptance.js'),
    import('../config.js'),
  ])
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
  const envKey = config.getActiveEnvKey()
  return { service, state, tokenStore, acceptance, envKey, reportFailure }
}

describe('R21-M15 verified live prior recovery retains its original accepted authority', () => {
  it('preserves the exact accepted source after a rejected public password replacement', async () => {
    const h = await harness()
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: homeToken,
      me: homeMe,
    })
    await h.service.passwordLogin(homeMe.email, 'fixture-password')

    const acceptedBefore = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(acceptedBefore.status).toBe('accepted')
    if (acceptedBefore.status !== 'accepted')
      throw new Error('The public password producer did not select Home')
    expect(acceptedBefore.session.token).toBe(homeToken)
    expect(acceptedBefore.session.accepted.record.frame.source).toMatchObject({
      kind: 'keytar',
      format: 'v1',
      accountId: homeMe.id,
    })

    boundary.setPassword.mockImplementationOnce(async (service, account, token) => {
      boundary.keychain.set(keyOf(service, account), token)
      throw new Error('fixture-candidate setter rejected after publication')
    })
    vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
      token: freshToken,
      me: freshMe,
    })
    await expect(h.service.passwordLogin(freshMe.email, 'fixture-password')).rejects.toThrow()
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)

    const acceptedAfter = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(acceptedAfter.status).toBe('accepted')
    if (acceptedAfter.status !== 'accepted')
      throw new Error('Rejected replacement removed the prior accepted source')
    expect(acceptedAfter.session.token).toBe(homeToken)
    expect(acceptedAfter.session.accepted.record.frame.source?.sourceRef).toBe(
      acceptedBefore.session.accepted.record.frame.source?.sourceRef
    )

    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledTimes(1)
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(freshToken)
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)
  })
})
