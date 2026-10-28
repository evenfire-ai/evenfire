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
let previousConfigPath: string | undefined
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
  previousConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
  process.env.CLERUM_DESKTOP_CONFIG_PATH = path.join(boundary.directory, 'runtime-config.json')
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
  const config = await import('../config.js')
  await config.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'https://auth.example.test/api',
    rpcProxyBaseUrl: 'https://rpc.example.test',
  })
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
  if (previousConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  else process.env.CLERUM_DESKTOP_CONFIG_PATH = previousConfigPath
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
  await config.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'https://auth.example.test/api',
    rpcProxyBaseUrl: 'https://rpc.example.test',
  })
  const state = service as unknown as {
    sessionToken: string | null
    me: typeof homeMe | null
    installAuthenticatedLogin: (value: { token: string; me: typeof homeMe }) => Promise<unknown>
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

async function loginWithPassword(
  h: Awaited<ReturnType<typeof harness>>,
  token: string,
  me: typeof homeMe
) {
  vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({ token, me })
  return h.service.passwordLogin(me.email, `fixture-password:${token}`)
}

async function expectSelectedSession(h: Awaited<ReturnType<typeof harness>>, token: string) {
  const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
  const selected = await readSessionAuthoritySourceSelection({
    tokenStore: h.tokenStore,
    envKey: h.envKey,
  })
  expect(selected.status).toBe('accepted')
  if (selected.status !== 'accepted') throw new Error('Expected accepted session authority')
  expect(selected.session.token).toBe(token)
  expect(selected.session.accepted.record.frame.source?.format).toBe('v1')
  return selected.session.accepted.record
}

describe('R21-M13 selected-source ownership after asynchronous cleanup', () => {
  it('keeps a newer accepted source when an older exact cleanup settles late', async () => {
    const first = await harness()
    await loginWithPassword(first, homeToken, homeMe)
    const firstRecord = await expectSelectedSession(first, homeToken)
    const replacement = await harness()
    const cleanupEntered = gate()
    const releaseCleanup = gate()
    const cleanupSources: unknown[] = []
    const deleteExact =
      replacement.tokenStore.deleteSessionCredentialSourceIfUnselectedWithProof.bind(
        replacement.tokenStore
      )
    vi.spyOn(
      replacement.tokenStore,
      'deleteSessionCredentialSourceIfUnselectedWithProof'
    ).mockImplementation(async (...args) => {
      cleanupSources.push(args[0])
      const result = await deleteExact(...args)
      cleanupEntered.resolve()
      await releaseCleanup.promise
      return result
    })
    const replacementMe = userFor(teamToken)
    const replacementLogin = own(loginWithPassword(replacement, teamToken, replacementMe))
    await entered(cleanupEntered.promise, replacementLogin)
    expect(cleanupSources).toEqual([firstRecord.frame.source])
    const replacementRecord = await expectSelectedSession(replacement, teamToken)
    expect(replacementRecord.frame.source?.sourceRef).not.toBe(firstRecord.frame.source?.sourceRef)

    const newest = await harness()
    try {
      await expect(loginWithPassword(newest, freshToken, freshMe)).resolves.toEqual({
        authenticated: true,
        me: freshMe,
      })
      const newestRecord = await expectSelectedSession(newest, freshToken)
      expect(newestRecord.frame.source?.sourceRef).not.toBe(
        replacementRecord.frame.source?.sourceRef
      )
    } finally {
      releaseCleanup.resolve()
    }
    await expect(replacementLogin).resolves.toEqual({
      authenticated: true,
      me: replacementMe,
    })

    const restart = await harness()
    await expect(restart.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restart.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
    expect(restart.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(restart.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
    await expectSelectedSession(restart, freshToken)
  })
})

describe('R21-M13 original publication cannot adopt a newer identical accepted source', () => {
  it('keeps the accepted same-token publisher through an older required binding failure', async () => {
    const older = await harness()
    const fresh = await harness()
    const preparedEntered = gate()
    const releasePrepared = gate()
    const { prepareChatStoreBindingForUser } = await import('../chatStoreBinding.js')
    const prepare = vi.mocked(prepareChatStoreBindingForUser).getMockImplementation()
    vi.mocked(prepareChatStoreBindingForUser).mockImplementationOnce(async (...args) => {
      preparedEntered.resolve()
      await releasePrepared.promise
      if (!prepare) throw new Error('Staged chat binding fixture is unavailable')
      return prepare(...args)
    })
    const oldLogin = own(loginWithPassword(older, homeToken, homeMe))
    const oldOutcome = oldLogin.then(
      value => ({ status: 'fulfilled' as const, value }),
      error => ({ status: 'rejected' as const, error })
    )
    await entered(preparedEntered.promise, oldLogin)
    const newLogin = await loginWithPassword(fresh, homeToken, homeMe)
    expect(newLogin).toEqual({ authenticated: true, me: homeMe })
    const freshRecord = await expectSelectedSession(fresh, homeToken)
    releasePrepared.resolve()
    const rejected = await oldOutcome
    expect(rejected.status).toBe('rejected')
    expect(older.state.sessionToken).toBeNull()
    expect(older.state.me).toBeNull()
    expect(fresh.state.sessionToken).toBe(homeToken)
    expect(fresh.state.me).toEqual(homeMe)

    const restart = await harness()
    await expect(restart.service.initialize()).resolves.toEqual({ authenticated: true, me: homeMe })
    expect(restart.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    const restartedRecord = await expectSelectedSession(restart, homeToken)
    expect(restartedRecord.frame.source?.sourceRef).toBe(freshRecord.frame.source?.sourceRef)
  })
})
