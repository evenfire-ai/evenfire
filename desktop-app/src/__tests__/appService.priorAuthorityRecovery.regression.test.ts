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
const rejectedToken = 'fixture-journal-rejected'
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
let previousRestUrl: string | undefined
let previousRpcUrl: string | undefined

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
  previousRestUrl = process.env.EXTERNAL_REST_API_BASE_URL
  previousRpcUrl = process.env.RPC_PROXY_BASE_URL
  process.env.EXTERNAL_REST_API_BASE_URL = 'http://rest-prior-authority.test'
  process.env.RPC_PROXY_BASE_URL = 'http://rpc-prior-authority.test'
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

async function acceptPasswordLogin(
  h: Awaited<ReturnType<typeof harness>>,
  token: string,
  me: typeof homeMe
) {
  vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({ token, me })
  return h.service.passwordLogin(me.email, 'fixture-password')
}

describe('R21-M11 prior accepted authority survives candidate rejection and supersession', () => {
  it('retains the exact accepted V1 Keytar source after a partial team-candidate write', async () => {
    const h = await harness()
    await acceptPasswordLogin(h, homeToken, homeMe)
    const original = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(original.status).toBe('accepted')
    if (original.status !== 'accepted') throw new Error('Expected Home to be accepted')
    expect(original.session.token).toBe(homeToken)
    expect(original.session.accepted.record.frame.source).toMatchObject({
      format: 'v1',
      kind: 'keytar',
      accountId: homeMe.id,
    })

    boundary.setPassword.mockImplementation(async (service, account, serialized) => {
      boundary.keychain.set(keyOf(service, account), serialized)
      try {
        const envelope = JSON.parse(serialized) as { sessionToken?: string }
        if (envelope.sessionToken === teamToken)
          throw new Error('fixture-team candidate failed after publication')
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'fixture-team candidate failed after publication'
        )
          throw error
      }
    })

    await expect(h.service.switchTeam('fixture-team')).rejects.toThrow()
    expect(h.state.sessionToken).toBe(homeToken)
    expect(h.state.me).toEqual(homeMe)

    const selected = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Rejected candidate displaced Home')
    expect(selected.session.token).toBe(homeToken)
    expect(selected.session.accepted.record.frame.source?.sourceRef).toBe(
      original.session.accepted.record.frame.source?.sourceRef
    )
    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: homeMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
  })

  it('does not replace the accepted team source when a later team candidate fails identity', async () => {
    const h = await harness()
    await acceptPasswordLogin(h, homeToken, homeMe)
    await expect(h.service.switchTeam('fixture-team')).resolves.toMatchObject({
      authenticated: true,
      me: { ...homeMe, teamId: 'fixture-team' },
    })
    const before = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(before.status).toBe('accepted')
    if (before.status !== 'accepted') throw new Error('Expected the Home team candidate to commit')
    expect(before.session.token).toBe(teamToken)

    vi.mocked(h.state.authClient.switchTeam).mockResolvedValueOnce({ token: rejectedToken })
    await expect(h.service.switchTeam('fixture-rejected')).rejects.toThrow()
    expect(h.state.sessionToken).toBe(teamToken)
    expect(h.state.me).toEqual({ ...homeMe, teamId: 'fixture-team' })

    const after = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(after.status).toBe('accepted')
    if (after.status !== 'accepted') throw new Error('Rejected team candidate displaced prior team')
    expect(after.session.token).toBe(teamToken)
    expect(after.session.accepted.record.frame.source).toEqual(
      before.session.accepted.record.frame.source
    )

    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: { ...homeMe, teamId: 'fixture-team' },
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(teamToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(rejectedToken)
  })

  it('keeps a newer password owner when a paused team candidate resumes', async () => {
    const h = await harness()
    await acceptPasswordLogin(h, homeToken, homeMe)
    const enteredIdentity = gate()
    const releaseIdentity = gate()
    vi.spyOn(h.state.authClient, 'getMe').mockImplementation(async token => {
      if (token === teamToken) {
        enteredIdentity.resolve()
        await releaseIdentity.promise
      }
      return userFor(token)
    })

    const staleTeam = own(h.service.switchTeam('fixture-team'))
    const staleOutcome = staleTeam.then(
      () => null,
      error => error
    )
    await entered(enteredIdentity.promise, staleTeam)

    const winner = await harness()
    try {
      await expect(acceptPasswordLogin(winner, freshToken, freshMe)).resolves.toMatchObject({
        authenticated: true,
        me: freshMe,
      })
    } finally {
      releaseIdentity.resolve()
    }
    expect(await staleOutcome).toBeInstanceOf(Error)

    const selected = await h.acceptance.readSessionAuthoritySourceSelection({
      tokenStore: h.tokenStore,
      envKey: h.envKey,
    })
    expect(selected.status).toBe('accepted')
    if (selected.status !== 'accepted') throw new Error('Newer password owner was not accepted')
    expect(selected.session.token).toBe(freshToken)
    expect(selected.session.accepted.record.frame.source?.accountId).toBe(freshMe.id)

    const restarted = await harness()
    await expect(restarted.service.initialize()).resolves.toEqual({
      authenticated: true,
      me: freshMe,
    })
    expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(freshToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(homeToken)
    expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(teamToken)
  })
})
