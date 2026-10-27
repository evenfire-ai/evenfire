import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  testLoginResult,
  testSessionMe,
  testSessionTokenWithExpiry,
} from '../../testSupport/authTestFixtures.js'

const electronFixture = vi.hoisted(() => ({ userDataDirectory: '' }))
const keytarFixture = vi.hoisted(() => {
  const values = new Map<string, string>()
  const keyOf = (service: string, account: string) => `${service}::${account}`
  return {
    values,
    getPassword: vi.fn(
      async (service: string, account: string) => values.get(keyOf(service, account)) ?? null
    ),
    setPassword: vi.fn(async (service: string, account: string, token: string) => {
      values.set(keyOf(service, account), token)
    }),
    deletePassword: vi.fn(async (service: string, account: string) =>
      values.delete(keyOf(service, account))
    ),
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronFixture.userDataDirectory),
    isReady: vi.fn(() => true),
    setName: vi.fn(),
    setPath: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() =>
      process.platform === 'linux' ? 'gnome_libsecret' : 'test-secure-storage'
    ),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}))
vi.mock('keytar', () => keytarFixture)

const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
let isolatedConfigPath = ''
let AppServiceClass: typeof import('../appService.js').AppService
let TokenStoreClass: typeof import('../tokenStore.js').TokenStore
let SupersededBeforeWrite: typeof import('../tokenStore.js').SessionTokenStorageSupersededBeforeWriteError
let getDesktopRuntimeConfigState: typeof import('../config.js').getDesktopRuntimeConfigState
let userDataDirectory = ''

beforeAll(async () => {
  const isolatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-quit-preparation-'))
  isolatedConfigPath = path.join(isolatedDirectory, 'runtime-config.json')
  process.env.CLERUM_DESKTOP_CONFIG_PATH = isolatedConfigPath
  vi.resetModules()

  const [{ AppService }, configModule, tokenStoreModule] = await Promise.all([
    import('../appService.js'),
    import('../config.js'),
    import('../tokenStore.js'),
  ])
  AppServiceClass = AppService
  TokenStoreClass = tokenStoreModule.TokenStore
  SupersededBeforeWrite = tokenStoreModule.SessionTokenStorageSupersededBeforeWriteError
  getDesktopRuntimeConfigState = configModule.getDesktopRuntimeConfigState
})

afterAll(async () => {
  if (originalConfigPath === undefined) {
    delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  } else {
    process.env.CLERUM_DESKTOP_CONFIG_PATH = originalConfigPath
  }
  if (isolatedConfigPath) {
    await fs.rm(path.dirname(isolatedConfigPath), { recursive: true, force: true })
  }
  vi.resetModules()
})

beforeEach(async () => {
  keytarFixture.values.clear()
  userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-quit-preparation-data-'))
  electronFixture.userDataDirectory = userDataDirectory
})

afterEach(async () => {
  if (userDataDirectory) {
    await fs.rm(userDataDirectory, { recursive: true, force: true })
    userDataDirectory = ''
  }
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function requireProducerEntry(entry: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    expect(
      await Promise.race([
        entry.then(() => true),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), 2000)
        }),
      ]),
      'the admitted producer reached its real storage boundary'
    ).toBe(true)
  } finally {
    clearTimeout(timer)
  }
}

function createService(tokenStore = new TokenStoreClass()) {
  return new AppServiceClass({
    tokenStore,
    getUserDataDirectory: () => userDataDirectory,
  })
}

async function acceptPersistentSession(
  service: InstanceType<typeof AppServiceClass>,
  tokenStore: InstanceType<typeof TokenStoreClass>
): Promise<void> {
  const me = testSessionMe()
  const result = testLoginResult(testSessionTokenWithExpiry(), me)
  const authClient = (
    service as unknown as {
      authClient: {
        passwordLogin: (email: string, password: string) => Promise<typeof result>
        getMe: (token: string) => Promise<typeof me>
      }
    }
  ).authClient
  vi.spyOn(authClient, 'passwordLogin').mockResolvedValue(result)
  vi.spyOn(authClient, 'getMe').mockResolvedValue(me)
  const { saveDesktopRuntimeConfig, getActiveEnvKey } = await import('../config.js')
  await saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'https://quit-preparation.example.test',
    rpcProxyBaseUrl: 'https://rpc.quit-preparation.example.test',
    appName: 'Quit Preparation Test',
  })

  await expect(
    service.passwordLogin(me.email, 'synthetic-quit-preparation-password')
  ).resolves.toMatchObject({ authenticated: true, me })

  const { readSessionAuthoritySourceSelection } = await import('../sessionAuthorityAcceptance.js')
  const selection = await readSessionAuthoritySourceSelection({
    tokenStore,
    envKey: getActiveEnvKey(),
  })
  expect(selection.status).toBe('accepted')
  if (selection.status !== 'accepted')
    throw new Error('the public password-login fixture did not accept a persistent source')
  expect(selection.session.token).toBe(result.token)
  expect(selection.session.accepted.record.frame.source.format).toBe('v1')
}

describe('AppService quit preparation', () => {
  it('loads runtime config from this suite’s isolated path', () => {
    expect(getDesktopRuntimeConfigState().storagePath).toBe(isolatedConfigPath)
  })

  it('reopens credential admission when Electron cancels a quit attempt', async () => {
    const tokenStore = new TokenStoreClass()
    const prepareForQuit = vi.spyOn(tokenStore, 'prepareForQuit')
    const reopenAdmission = vi.spyOn(tokenStore, 'reopenAdmission')
    const clearSessionToken = vi.spyOn(tokenStore, 'clearSessionToken').mockResolvedValue()
    const deleteSelectedSource = vi.spyOn(
      tokenStore,
      'deleteSessionCredentialSourceIfUnselectedWithProof'
    )
    const service = createService(tokenStore)
    await acceptPersistentSession(service, tokenStore)

    await service.prepareForQuit()
    await expect(service.logout()).resolves.toMatchObject({
      kind: 'not-committed',
      reason: 'failed',
    })

    service.cancelQuitPreparation()
    await expect(service.logout()).resolves.toMatchObject({ kind: 'committed' })
    expect(clearSessionToken).not.toHaveBeenCalled()
    expect(deleteSelectedSource).toHaveBeenCalledOnce()
    expect(reopenAdmission).toHaveBeenCalledOnce()
    expect(prepareForQuit).toHaveBeenCalledOnce()
  })

  it('keeps quit waiting for accepted logout cleanup beyond a two-minute bound', async () => {
    const [{ readPendingExternalLogoutMarker }, { getActiveEnvKey }] = await Promise.all([
      import('../pendingExternalLogout.js'),
      import('../config.js'),
    ])
    const pendingTokenClear = deferred<void>()
    const tokenClearStarted = deferred<void>()
    const tokenStore = new TokenStoreClass()
    const prepareForQuit = vi.spyOn(tokenStore, 'prepareForQuit')
    const deleteExactSource =
      tokenStore.deleteSessionCredentialSourceIfUnselectedWithProof.bind(tokenStore)
    const deleteSelectedSource = vi
      .spyOn(tokenStore, 'deleteSessionCredentialSourceIfUnselectedWithProof')
      .mockImplementation(async (...args) => {
        tokenClearStarted.resolve()
        await pendingTokenClear.promise
        return deleteExactSource(...args)
      })
    const service = createService(tokenStore)
    await acceptPersistentSession(service, tokenStore)
    vi.useFakeTimers()

    const logout = service.logout()
    await tokenClearStarted.promise
    let preparationSettled = false
    const preparation = service.prepareForQuit().then(() => {
      preparationSettled = true
    })

    try {
      expect(vi.getTimerCount()).toBe(0)
      await expect(service.logout()).resolves.toMatchObject({
        kind: 'not-committed',
        reason: 'deferred',
      })
      const committedLogoutIntent = readPendingExternalLogoutMarker(
        userDataDirectory,
        getActiveEnvKey()
      )
      expect(committedLogoutIntent?.intent).toEqual({ intent: 'logout-pending' })
      expect(committedLogoutIntent?.revision).not.toBeNull()
      await vi.advanceTimersByTimeAsync(120_001)
      expect(preparationSettled).toBe(false)
      expect(prepareForQuit).toHaveBeenCalledOnce()
      expect(deleteSelectedSource).toHaveBeenCalledOnce()

      pendingTokenClear.resolve()
      const [logoutResult] = await Promise.all([logout, preparation])
      expect(logoutResult).toMatchObject({ kind: 'committed' })
      expect(readPendingExternalLogoutMarker(userDataDirectory, getActiveEnvKey())).toEqual(
        committedLogoutIntent
      )
      expect(preparationSettled).toBe(true)
      expect(deleteSelectedSource.mock.invocationCallOrder[0]).toBeLessThan(
        prepareForQuit.mock.invocationCallOrder[0]
      )
    } finally {
      pendingTokenClear.resolve()
      await Promise.allSettled([logout, preparation])
      vi.useRealTimers()
    }
  })

  it('waits for an admitted producer before starting the TokenStore drain', async () => {
    const producer = deferred<void>()
    const producerStarted = deferred<void>()
    const tokenStore = new TokenStoreClass()
    const prepareForQuit = vi.spyOn(tokenStore, 'prepareForQuit')
    const deleteExactSource =
      tokenStore.deleteSessionCredentialSourceIfUnselectedWithProof.bind(tokenStore)
    vi.spyOn(tokenStore, 'deleteSessionCredentialSourceIfUnselectedWithProof').mockImplementation(
      async (...args) => {
        producerStarted.resolve()
        await producer.promise
        return deleteExactSource(...args)
      }
    )
    const service = createService(tokenStore)
    await acceptPersistentSession(service, tokenStore)
    const logout = service.logout()
    await producerStarted.promise
    const preparation = service.prepareForQuit()

    try {
      expect(prepareForQuit).not.toHaveBeenCalled()
      producer.resolve()
      await Promise.all([logout, preparation])
      expect(prepareForQuit).toHaveBeenCalledOnce()
    } finally {
      producer.resolve()
      await Promise.allSettled([logout, preparation])
    }
  })

  it('waits for remaining admitted producers after one producer rejects', async () => {
    const rejectedProducer = deferred<void>()
    const pendingProducer = deferred<void>()
    const firstStarted = deferred<void>()
    const secondStarted = deferred<void>()
    const tokenStore = new TokenStoreClass()
    const prepareForQuit = vi.spyOn(tokenStore, 'prepareForQuit')
    const service = createService(tokenStore)
    const producerService = service as unknown as {
      runCredentialProducer<T>(operation: () => Promise<T>): Promise<T>
    }
    const first = producerService.runCredentialProducer(async () => {
      firstStarted.resolve()
      await rejectedProducer.promise
      throw new SupersededBeforeWrite()
    })
    const second = producerService.runCredentialProducer(async () => {
      secondStarted.resolve()
      await pendingProducer.promise
    })
    let preparation: Promise<void> | undefined
    try {
      await requireProducerEntry(firstStarted.promise)
      await requireProducerEntry(secondStarted.promise)
      expect(
        (service as unknown as { pendingCredentialProducers: Set<unknown> })
          .pendingCredentialProducers.size
      ).toBe(2)
      preparation = service.prepareForQuit()
      expect(prepareForQuit).not.toHaveBeenCalled()

      // A real superseded producer rejects; an ordinary clear failure could
      // instead succeed through a durable LP, which would not prove this case.
      rejectedProducer.reject(new SupersededBeforeWrite())
      await expect(first).rejects.toBeInstanceOf(SupersededBeforeWrite)
      expect(prepareForQuit).not.toHaveBeenCalled()

      pendingProducer.resolve()
      await Promise.all([second, preparation])
      expect(prepareForQuit).toHaveBeenCalledOnce()
    } finally {
      rejectedProducer.resolve()
      pendingProducer.resolve()
      await Promise.allSettled([first, second, ...(preparation ? [preparation] : [])])
    }
  })

  it('does not gate a runWithTeamContext call that has no team credential hop', async () => {
    const service = new AppServiceClass() as unknown as {
      pendingCredentialProducers: Set<Promise<unknown>>
      quitPreparationStarted: boolean
      sessionToken: string | null
      requireSessionToken: () => string
      runWithTeamContext: <T>(
        teamId: string | null | undefined,
        operation: (sessionToken: string) => Promise<T>
      ) => Promise<T>
    }
    service.quitPreparationStarted = true
    service.sessionToken = 'session-token'
    service.requireSessionToken = vi.fn(() => 'session-token')
    const read = vi.fn(async (token: string) => token)

    await expect(service.runWithTeamContext(null, read)).resolves.toBe('session-token')
    expect(read).toHaveBeenCalledOnce()
    expect(service.pendingCredentialProducers.size).toBe(0)
  })

  it('does not hold quit for a same-team operation that does not change credentials', async () => {
    const request = deferred<string>()
    const requestStarted = deferred<void>()
    const tokenStore = new TokenStoreClass()
    const prepareForQuit = vi.spyOn(tokenStore, 'prepareForQuit')
    const service = new AppServiceClass({ tokenStore }) as unknown as {
      pendingCredentialProducers: Set<Promise<unknown>>
      quitPreparationStarted: boolean
      teamContextQueue: Promise<void>
      sessionToken: string | null
      me: { id: string; teamId: string }
      tokenStore: InstanceType<typeof TokenStoreClass>
      requireSessionToken: () => string
      getCurrentSessionTeamId: (token: string) => Promise<string>
      runWithTeamContext: <T>(
        teamId: string | null | undefined,
        operation: (sessionToken: string) => Promise<T>
      ) => Promise<T>
      prepareForQuit: () => Promise<void>
    }
    service.quitPreparationStarted = false
    service.teamContextQueue = Promise.resolve()
    service.sessionToken = 'session-token'
    service.me = { id: 'user-1', teamId: 'team-a' }
    service.requireSessionToken = vi.fn(() => 'session-token')
    service.getCurrentSessionTeamId = vi.fn(async () => 'team-a')

    const operation = service.runWithTeamContext('team-a', async () => {
      requestStarted.resolve()
      return request.promise
    })
    await requestStarted.promise

    const preparation = service.prepareForQuit()
    expect(prepareForQuit).toHaveBeenCalledOnce()
    await expect(preparation).resolves.toBeUndefined()

    request.resolve('request-complete')
    await expect(operation).resolves.toBe('request-complete')
    expect(service.pendingCredentialProducers.size).toBe(0)
  })
})
