import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const runtime = vi.hoisted(() => ({ userDataDirectory: '' }))
const keychain = vi.hoisted(() => new Map<string, string>())
const keyOf = (service: string, account: string) => `${service}::${account}`

vi.mock('electron', () => ({
  app: {
    isReady: vi.fn(() => true),
    getPath: vi.fn(() => runtime.userDataDirectory),
  },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}))

vi.mock('keytar', () => ({
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

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(async () => undefined),
  unbindChatStore: vi.fn(),
}))

type TestSessionMe = {
  id: string
  email: string
  name: string | null
  picture: string | null
  teamId: string
  teamName: string
  role: 'member'
}

type HopService = {
  sessionToken: string | null
  me: TestSessionMe | null
  authClient: {
    getMe(token: string): Promise<TestSessionMe>
    switchTeam(
      token: string,
      teamId: string
    ): Promise<{ token: string; team: { id: string; name: string } }>
  }
  runWithTeamContext<T>(teamId: string, operation: (token: string) => Promise<T>): Promise<T>
  switchTeam(teamId: string): Promise<unknown>
  prepareForQuit(): Promise<void>
  cancelQuitPreparation(): void
}

let scratchDirectory = ''
let restoreConfigPath: string | undefined
let AppServiceClass: typeof import('../appService.js').AppService
let TokenStoreClass: typeof import('../tokenStore.js').TokenStore

beforeEach(async () => {
  scratchDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-team-context-quit-'))
  runtime.userDataDirectory = path.join(scratchDirectory, 'user-data')
  await fs.mkdir(runtime.userDataDirectory)
  restoreConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
  process.env.CLERUM_DESKTOP_CONFIG_PATH = path.join(scratchDirectory, 'runtime-config.json')
  keychain.clear()
  vi.clearAllMocks()
  vi.resetModules()
  const [{ AppService }, { TokenStore }] = await Promise.all([
    import('../appService.js'),
    import('../tokenStore.js'),
  ])
  AppServiceClass = AppService
  TokenStoreClass = TokenStore
})

afterAll(async () => {
  if (restoreConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  else process.env.CLERUM_DESKTOP_CONFIG_PATH = restoreConfigPath
  if (scratchDirectory) await fs.rm(scratchDirectory, { recursive: true, force: true })
  runtime.userDataDirectory = ''
  vi.resetModules()
})

function createAuthenticatedService() {
  const tokenStore = new TokenStoreClass()
  const service = new AppServiceClass({ tokenStore }) as unknown as HopService
  service.sessionToken = 'team-home-token'
  service.me = {
    id: 'user-1',
    email: 'user@example.com',
    name: null,
    picture: null,
    teamId: 'team-home',
    teamName: 'Home team',
    role: 'member',
  }
  vi.spyOn(service.authClient, 'switchTeam').mockImplementation(async (_token, teamId) => ({
    token: `${teamId}-token`,
    team: { id: teamId, name: teamId },
  }))
  vi.spyOn(service.authClient, 'getMe').mockImplementation(async token => {
    const teamId = token.replace(/-token$/, '')
    return {
      id: 'user-1',
      email: 'user@example.com',
      name: null,
      picture: null,
      teamId,
      teamName: teamId,
      role: 'member',
    }
  })
  return { service, tokenStore }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('AppService team-context quit lifecycle', () => {
  it('drains accepted home joins before TokenStore and clears the completed hop', async () => {
    const hopOperation = deferred<string>()
    const hopStarted = deferred<void>()
    const homeOperation = deferred<void>()
    const homeStarted = deferred<void>()
    const lateHomeOperation = deferred<void>()
    const lateHomeStarted = deferred<void>()
    const { service, tokenStore } = createAuthenticatedService()
    const prepareTokenStore = vi.spyOn(tokenStore, 'prepareForQuit')

    const hop = service.runWithTeamContext('team-a', async () => {
      hopStarted.resolve()
      return hopOperation.promise
    })
    await hopStarted.promise
    const homeRead = service.runWithTeamContext('team-home', async token => {
      homeStarted.resolve()
      await homeOperation.promise
      return token
    })
    const preparation = service.prepareForQuit()
    const lateHomeRead = service.runWithTeamContext('team-home', async token => {
      lateHomeStarted.resolve()
      await lateHomeOperation.promise
      return token
    })
    let lateHomeSettled = false
    const lateHomeOutcome = lateHomeRead
      .then(
        value => ({ status: 'fulfilled' as const, value }),
        error => ({ status: 'rejected' as const, error })
      )
      .then(outcome => {
        lateHomeSettled = true
        return outcome
      })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(lateHomeSettled).toBe(false)

    expect(prepareTokenStore).not.toHaveBeenCalled()
    hopOperation.resolve('hop-complete')
    await homeStarted.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(prepareTokenStore).not.toHaveBeenCalled()
    homeOperation.resolve()
    await expect(homeRead).resolves.toBe('team-home-token')
    await Promise.all([hop, preparation])
    await lateHomeStarted.promise
    expect(prepareTokenStore).toHaveBeenCalledOnce()
    lateHomeOperation.resolve()
    await expect(lateHomeOutcome).resolves.toEqual({
      status: 'fulfilled',
      value: 'team-home-token',
    })

    service.cancelQuitPreparation()
    const postHopHomeRead = service.runWithTeamContext('team-home', async token => token)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const postHopOutcome = await Promise.race([
      postHopHomeRead.then(
        value => ({ status: 'fulfilled' as const, value }),
        error => ({ status: 'rejected' as const, error })
      ),
      new Promise<{ status: 'pending' }>(resolve => {
        timeout = setTimeout(() => resolve({ status: 'pending' }), 100)
      }),
    ])
    if (timeout) clearTimeout(timeout)
    expect(postHopOutcome).toEqual({ status: 'fulfilled', value: 'team-home-token' })
  })

  it('does not retain a hop rejected after a queued same-team request needs a switch', async () => {
    const sameTeamOperation = deferred<string>()
    const sameTeamStarted = deferred<void>()
    const { service } = createAuthenticatedService()

    const firstRead = service.runWithTeamContext('team-home', async () => {
      sameTeamStarted.resolve()
      return sameTeamOperation.promise
    })
    await sameTeamStarted.promise
    const queuedHomeRead = service.runWithTeamContext('team-home', async token => token)
    await service.switchTeam('team-b')
    await service.prepareForQuit()
    sameTeamOperation.resolve('current-team-read')

    await expect(firstRead).resolves.toBe('current-team-read')
    await expect(queuedHomeRead).rejects.toThrow('Application is shutting down')
    service.cancelQuitPreparation()

    await expect(
      service.runWithTeamContext('team-b', async token => `current:${token}`)
    ).resolves.toBe('current:team-b-token')
  })

  it('keeps a queued home read when an admitted hop is waiting on the team queue', async () => {
    const sameTeamOperation = deferred<string>()
    const sameTeamStarted = deferred<void>()
    const { service, tokenStore } = createAuthenticatedService()
    const prepareTokenStore = vi.spyOn(tokenStore, 'prepareForQuit')

    const currentTeamRead = service.runWithTeamContext('team-home', async () => {
      sameTeamStarted.resolve()
      return sameTeamOperation.promise
    })
    await sameTeamStarted.promise
    const queuedHop = service.runWithTeamContext('team-a', async token => token)
    const preparation = service.prepareForQuit()
    const queuedHomeRead = service.runWithTeamContext('team-home', async token => token)

    sameTeamOperation.resolve('current-team-read')
    await expect(currentTeamRead).resolves.toBe('current-team-read')
    await expect(queuedHop).resolves.toBe('team-a-token')
    await expect(queuedHomeRead).resolves.toBe('team-home-token')
    await preparation
    expect(prepareTokenStore).toHaveBeenCalledOnce()
  })

  it('restores queued home joins after the first team restoration fails', async () => {
    const teamSwitch = deferred<void>()
    const teamSwitchStarted = deferred<void>()
    const { service } = createAuthenticatedService()
    let failFirstHomeRestore = true
    vi.mocked(service.authClient.switchTeam).mockImplementation(async (_token, teamId) => {
      if (teamId === 'team-a') {
        teamSwitchStarted.resolve()
        await teamSwitch.promise
      } else if (teamId === 'team-home' && failFirstHomeRestore) {
        failFirstHomeRestore = false
        throw new Error('home-team restore failed once')
      }
      return { token: `${teamId}-token`, team: { id: teamId, name: teamId } }
    })

    const firstHop = service.runWithTeamContext('team-a', async () => 'team-a-complete')
    await teamSwitchStarted.promise
    const queuedHomeRead = service.runWithTeamContext('team-home', async token => token)
    teamSwitch.resolve()

    await expect(firstHop).rejects.toThrow('home-team restore failed once')
    await expect(queuedHomeRead).resolves.toBe('team-home-token')
    expect(vi.mocked(service.authClient.switchTeam).mock.calls.map(([, teamId]) => teamId)).toEqual(
      ['team-a', 'team-home', 'team-home']
    )
  })

  it('rejects a queued home hop after quit closes, then allows a retry after cancellation', async () => {
    const hopOperation = deferred<void>()
    const hopStarted = deferred<void>()
    const { service } = createAuthenticatedService()
    let failHomeRestore = true
    vi.mocked(service.authClient.switchTeam).mockImplementation(async (_token, teamId) => {
      if (teamId === 'team-home' && failHomeRestore) {
        failHomeRestore = false
        throw new Error('home restore failed')
      }
      return { token: `${teamId}-token`, team: { id: teamId, name: teamId } }
    })

    const hop = service.runWithTeamContext('team-a', async () => {
      hopStarted.resolve()
      await hopOperation.promise
      return 'team-a-complete'
    })
    await hopStarted.promise
    const preparation = service.prepareForQuit()
    const lateHomeRead = service.runWithTeamContext('team-home', async token => token)
    let lateHomeSettled = false
    const lateHomeOutcome = lateHomeRead
      .then(
        value => ({ status: 'fulfilled' as const, value }),
        error => ({ status: 'rejected' as const, error })
      )
      .then(outcome => {
        lateHomeSettled = true
        return outcome
      })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(lateHomeSettled).toBe(false)
    hopOperation.resolve()

    await expect(hop).rejects.toThrow('home restore failed')
    const lateHomeResult = await lateHomeOutcome
    expect(lateHomeResult.status).toBe('rejected')
    if (lateHomeResult.status === 'rejected') {
      expect(lateHomeResult.error).toMatchObject({ message: 'Application is shutting down' })
    }
    await preparation

    service.cancelQuitPreparation()
    await expect(service.runWithTeamContext('team-home', async token => token)).resolves.toBe(
      'team-home-token'
    )
  })

  it('reserves a queued hop against the stable home team while another hop is active', async () => {
    const hopOperation = deferred<void>()
    const hopStarted = deferred<void>()
    const { service } = createAuthenticatedService()

    const firstHop = service.runWithTeamContext('team-a', async () => {
      hopStarted.resolve()
      await hopOperation.promise
      return 'first-hop-complete'
    })
    await hopStarted.promise
    const queuedHop = service.runWithTeamContext('team-a', async token => token)
    const preparation = service.prepareForQuit()
    hopOperation.resolve()

    await expect(firstHop).resolves.toBe('first-hop-complete')
    await expect(queuedHop).resolves.toBe('team-a-token')
    await preparation
  })

  it('runs a queued home read when the initial team switch fails before leaving home', async () => {
    const switchStarted = deferred<void>()
    const finishFailedSwitch = deferred<void>()
    const { service } = createAuthenticatedService()
    vi.mocked(service.authClient.switchTeam).mockImplementation(async (_token, teamId) => {
      if (teamId === 'team-a') {
        switchStarted.resolve()
        await finishFailedSwitch.promise
        throw new Error('initial team switch failed')
      }
      throw new Error(`unexpected switch to ${teamId}`)
    })

    const firstHop = service.runWithTeamContext('team-a', async () => 'unreachable')
    await switchStarted.promise
    const homeRead = service.runWithTeamContext('team-home', async token => token)
    finishFailedSwitch.resolve()

    await expect(firstHop).rejects.toThrow('initial team switch failed')
    await expect(homeRead).resolves.toBe('team-home-token')
  })

  it('rejects a quit-time team hop promptly while an earlier team operation is queued', async () => {
    const operation = deferred<void>()
    const operationStarted = deferred<void>()
    const { service } = createAuthenticatedService()
    const earlierOperation = service.runWithTeamContext('team-home', async () => {
      operationStarted.resolve()
      await operation.promise
      return 'home-read'
    })
    await operationStarted.promise
    await service.prepareForQuit()

    const rejectedHop = service.runWithTeamContext('team-a', async token => token)
    const rejection = rejectedHop.then(
      () => null,
      error => error
    )
    let timeout: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      rejection,
      new Promise<'pending'>(resolve => {
        timeout = setTimeout(() => resolve('pending'), 100)
      }),
    ])
    if (timeout) clearTimeout(timeout)
    operation.resolve()
    await earlierOperation

    expect(outcome).toBeInstanceOf(Error)
    expect(outcome).toMatchObject({ message: 'Application is shutting down' })
  })

  it('does not keep quit open for queued work that no longer needs a team switch', async () => {
    const firstOperation = deferred<void>()
    const firstStarted = deferred<void>()
    const queuedOperation = deferred<void>()
    const queuedStarted = deferred<void>()
    const { service, tokenStore } = createAuthenticatedService()
    const prepareTokenStore = vi.spyOn(tokenStore, 'prepareForQuit')
    const firstRead = service.runWithTeamContext('team-home', async () => {
      firstStarted.resolve()
      await firstOperation.promise
      return 'home-read'
    })
    await firstStarted.promise
    const queuedRead = service.runWithTeamContext('team-a', async () => {
      queuedStarted.resolve()
      await queuedOperation.promise
      return 'team-a-read'
    })

    await service.switchTeam('team-a')
    const preparation = service.prepareForQuit()
    firstOperation.resolve()
    await queuedStarted.promise
    await preparation

    expect(prepareTokenStore).toHaveBeenCalledOnce()
    queuedOperation.resolve()
    await expect(firstRead).resolves.toBe('home-read')
    await expect(queuedRead).resolves.toBe('team-a-read')
  })

  it('continues draining home reads added while an earlier home read is running', async () => {
    const hopOperation = deferred<void>()
    const hopStarted = deferred<void>()
    const nestedHomeReadCompleted = deferred<void>()
    const { service } = createAuthenticatedService()
    let nestedHomeRead: Promise<string> | undefined

    const hop = service.runWithTeamContext('team-a', async () => {
      hopStarted.resolve()
      await hopOperation.promise
      return 'team-a-complete'
    })
    await hopStarted.promise
    const homeRead = service.runWithTeamContext('team-home', async token => {
      nestedHomeRead = service.runWithTeamContext('team-home', async nestedToken => {
        nestedHomeReadCompleted.resolve()
        return nestedToken
      })
      return token
    })
    hopOperation.resolve()

    await expect(hop).resolves.toBe('team-a-complete')
    await expect(homeRead).resolves.toBe('team-home-token')
    let timeout: ReturnType<typeof setTimeout> | undefined
    const drainOutcome = await Promise.race([
      nestedHomeReadCompleted.promise.then(() => 'completed' as const),
      new Promise<'pending'>(resolve => {
        timeout = setTimeout(() => resolve('pending'), 100)
      }),
    ])
    if (timeout) clearTimeout(timeout)
    expect(drainOutcome).toBe('completed')
    await expect(nestedHomeRead).resolves.toBe('team-home-token')
  })

  it('does not keep quit open for a same-team operation with no credential switch', async () => {
    const operation = deferred<string>()
    const operationStarted = deferred<void>()
    const { service, tokenStore } = createAuthenticatedService()
    const prepareTokenStore = vi.spyOn(tokenStore, 'prepareForQuit')
    const sameTeamRead = service.runWithTeamContext('team-home', async () => {
      operationStarted.resolve()
      return operation.promise
    })
    await operationStarted.promise

    await service.prepareForQuit()

    expect(prepareTokenStore).toHaveBeenCalledOnce()
    operation.resolve('same-team-read')
    await expect(sameTeamRead).resolves.toBe('same-team-read')
  })
})
