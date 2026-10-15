import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
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
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  },
}))
vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))
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
const releases = new Set<() => void>()
const operations = new Set<Promise<unknown>>()

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = () => {
      releases.delete(resolve)
      done()
    }
  })
  releases.add(resolve)
  return { promise, resolve }
}

function own<T>(operation: Promise<T>): Promise<T> {
  operations.add(operation)
  void operation.then(
    () => operations.delete(operation),
    () => operations.delete(operation)
  )
  return operation
}

async function entered(phase: Promise<void>, producer: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      phase.then(() => 'entered'),
      producer.then(
        () => 'settled',
        () => 'settled'
      ),
      new Promise<string>(resolve => {
        timer = setTimeout(() => resolve('deadline'), 5_000)
      }),
    ])
    expect(result, 'The real migration must reach authentication validation').toBe('entered')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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
  for (const release of releases) release()
  await Promise.allSettled([...operations])
  releases.clear()
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
    installAuthenticatedLogin: (value: { token: string; me: typeof homeMe }) => Promise<unknown>
    authClient: {
      getMe: (token: string) => Promise<typeof homeMe>
      switchTeam: (token: string, teamId: string) => Promise<{ token: string }>
    }
  }
  vi.spyOn(state.authClient, 'getMe').mockImplementation(async token => userFor(token))
  vi.spyOn(state.authClient, 'switchTeam').mockResolvedValue({ token: teamToken })
  const envKey = config.getActiveEnvKey()
  const digest = createHash('sha256').update(envKey).digest('hex')
  return {
    service,
    state,
    tokenStore,
    markers,
    journal,
    envKey,
    reportFailure,
    journalPath: path.join(boundary.directory, `session-persistence-journal-${digest}`),
    markerPath: path.join(boundary.directory, `pending-external-logout-${digest}`),
    encryptedPath: path.join(boundary.directory, `session-token-${envKey}.enc`),
  }
}

describe('R21-M10 automatic acceptance rechecks unresolved same-hash authority', () => {
  it.each(['getMe', 'chat-bind'] as const)(
    'preserves a later rejected same-hash login while automatic restore awaits %s',
    async boundaryPhase => {
      const original = await harness()
      await original.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      const validationEntered = gate()
      const validationRelease = gate()
      const { bindChatStoreForUser } = await import('../chatStoreBinding.js')
      if (boundaryPhase === 'getMe') {
        vi.mocked(original.state.authClient.getMe).mockImplementationOnce(async () => {
          validationEntered.resolve()
          await validationRelease.promise
          return homeMe
        })
      } else {
        vi.mocked(bindChatStoreForUser).mockImplementationOnce(async () => {
          validationEntered.resolve()
          await validationRelease.promise
        })
      }
      const restore = own(original.service.initialize())
      const restoreOutcome = restore.then(
        value => value,
        error => error
      )
      await entered(validationEntered.promise, restore)
      const rejected = await harness()
      vi.mocked(bindChatStoreForUser).mockRejectedValueOnce(
        new Error('fixture-independent chat bind failed')
      )
      boundary.deletePassword.mockImplementation(async (service, account) => {
        if (account === 'session-token::' + rejected.envKey)
          throw new Error('fixture-independent native rollback failed')
        return boundary.keychain.delete(keyOf(service, account))
      })
      const rejection = await rejected.state
        .installAuthenticatedLogin({ token: homeToken, me: homeMe })
        .then(
          () => null,
          error => error
        )
      expect(rejection).toBeInstanceOf(Error)
      expect(await rejected.tokenStore.getKeytarSessionToken(rejected.envKey)).toBe(homeToken)
      expect(
        rejected.markers.readPendingExternalLogoutMarker(boundary.directory, rejected.envKey)
      ).toBeNull()
      expect(
        rejected.journal.isSessionPersistenceCandidateDenied(
          rejected.journal.readSessionPersistenceJournal(boundary.directory, rejected.envKey),
          homeToken
        )
      ).toBe(true)
      validationRelease.resolve()
      const outcome = await restoreOutcome
      const restarted = await harness()
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: false,
        me: null,
      })
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
      expect(
        rejected.journal.isSessionPersistenceCandidateDenied(
          rejected.journal.readSessionPersistenceJournal(boundary.directory, rejected.envKey),
          homeToken
        )
      ).toBe(true)
      expect(outcome).toEqual({ authenticated: false, me: null })
      expect(original.state.sessionToken).toBeNull()
      expect(original.state.me).toBeNull()
      expect(await rejected.tokenStore.getKeytarSessionToken(rejected.envKey)).toBe(homeToken)

      // A new explicitly authenticated secure producer may accept this same hash.
      // That is distinct from laundering it through an already-started restore.
      const fresh = await harness()
      await expect(
        fresh.state.installAuthenticatedLogin({ token: homeToken, me: homeMe })
      ).resolves.toEqual({ authenticated: true, me: homeMe })
      expect(
        fresh.journal.isSessionPersistenceCandidateDenied(
          fresh.journal.readSessionPersistenceJournal(boundary.directory, fresh.envKey),
          homeToken
        )
      ).toBe(false)
      expect(await fresh.tokenStore.getKeytarSessionToken(fresh.envKey)).toBe(homeToken)
      const recoveredRestart = await harness()
      await expect(recoveredRestart.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: homeMe,
      })
      expect(recoveredRestart.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    }
  )
})
