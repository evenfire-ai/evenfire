import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtime = vi.hoisted(() => ({ directory: '', keychain: new Map<string, string>() }))
const { notifySessionChanged } = vi.hoisted(() => ({ notifySessionChanged: vi.fn() }))
const keytarBoundary = vi.hoisted(() => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
}))
const keyOf = (service: string, account: string) => `${service}::${account}`
vi.mock('keytar', () => keytarBoundary)
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => runtime.directory), isReady: vi.fn(() => true) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().replace(/^encrypted:/, '')),
  },
}))
vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))
vi.mock('../pluginSdkRuntime.js', () => ({
  tryGetPluginSdkRuntime: () => ({ notifySessionChanged, unpinAllSandboxUiSurfaces: vi.fn() }),
}))

const homeToken = 'fixture-home-session'
const homeMe = {
  id: 'fixture-user',
  email: 'fixture@example.com',
  name: null,
  picture: null,
  teamId: 'fixture-home',
  teamName: 'Fixture home',
  role: 'member',
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.doMock('keytar', () => keytarBoundary)
  runtime.keychain.clear()
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-marker-persistence-'))
  const keytar = await import('keytar')
  vi.mocked(keytar.getPassword)
    .mockReset()
    .mockImplementation(
      async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
    )
  vi.mocked(keytar.setPassword)
    .mockReset()
    .mockImplementation(async (service, account, token) => {
      runtime.keychain.set(keyOf(service, account), token)
    })
  vi.mocked(keytar.deletePassword)
    .mockReset()
    .mockImplementation(async (service, account) =>
      runtime.keychain.delete(keyOf(service, account))
    )
  const { safeStorage } = await import('electron')
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(runtime.directory, { recursive: true, force: true })
  runtime.directory = ''
  runtime.keychain.clear()
  vi.resetModules()
})

async function harness() {
  const [{ AppService }, { TokenStore }, markers, config] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
    import('../pendingExternalLogout.js'),
    import('../config.js'),
  ])
  const tokenStore = new TokenStore()
  const reportFailure = vi.fn()
  const service = new AppService({
    tokenStore,
    getUserDataDirectory: () => runtime.directory,
    reportDeferredLogoutFailure: reportFailure,
  })
  const state = service as unknown as {
    sessionToken: string | null
    me: typeof homeMe | null
    installAuthenticatedLogin: (result: { token: string; me: typeof homeMe }) => Promise<unknown>
    runWithTeamContext: <T>(team: string, operation: (token: string) => Promise<T>) => Promise<T>
    authClient: {
      getMe: (token: string) => Promise<typeof homeMe>
      switchTeam: (token: string, teamId: string) => Promise<{ token: string }>
    }
  }
  vi.spyOn(state.authClient, 'getMe').mockImplementation(async token => ({
    ...homeMe,
    teamId: token === homeToken ? homeMe.teamId : 'fixture-other',
  }))
  vi.spyOn(state.authClient, 'switchTeam').mockImplementation(async (_token, teamId) => ({
    token: teamId === homeMe.teamId ? homeToken : 'fixture-other-session',
  }))
  return { service, tokenStore, markers, envKey: config.getActiveEnvKey(), state, reportFailure }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('failed login fences an already-admitted logout', () => {
  it('does not restore a rejected credential after the older logout finishes', async () => {
    const h = await harness()
    h.markers.recordPendingExternalLogout(runtime.directory, h.envKey)
    const entered = deferred()
    const release = deferred()
    const keytar = await import('keytar')
    const activeAccount = `session-token::${h.envKey}`
    let firstActiveDelete = true
    vi.mocked(keytar.deletePassword).mockImplementation(async (service, account) => {
      if (account === activeAccount && firstActiveDelete) {
        firstActiveDelete = false
        const deleted = runtime.keychain.delete(keyOf(service, account))
        entered.resolve()
        await release.promise
        return deleted
      }
      if (runtime.keychain.get(keyOf(service, account)) === 'fixture-rejected-session') {
        throw new Error('fixture-rollback deletion failed')
      }
      return runtime.keychain.delete(keyOf(service, account))
    })
    vi.mocked(keytar.getPassword).mockImplementation(async (service, account) => {
      const token = runtime.keychain.get(keyOf(service, account)) ?? null
      if (token === 'fixture-rejected-session') throw new Error('fixture-read-back failed')
      return token
    })
    const oldLogout = h.service.logout()
    await entered.promise
    try {
      await expect(
        h.state.installAuthenticatedLogin({ token: 'fixture-rejected-session', me: homeMe })
      ).rejects.toThrow('Fresh session token could not be verified')
    } finally {
      release.resolve()
      await oldLogout
    }
    vi.mocked(keytar.getPassword).mockImplementation(
      async (service, account) => runtime.keychain.get(keyOf(service, account)) ?? null
    )
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: false,
      me: null,
    })
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith('fixture-rejected-session')
    expect(restarted.service.getCachedUserId()).toBeNull()
  })
})
