import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
  userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-quit-preparation-data-'))
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

describe('AppService quit preparation', () => {
  it('loads runtime config from this suite’s isolated path', () => {
    expect(getDesktopRuntimeConfigState().storagePath).toBe(isolatedConfigPath)
  })

  it('reopens credential admission when Electron cancels a quit attempt', async () => {
    const tokenStore = new TokenStoreClass()
    const prepareForQuit = vi.spyOn(tokenStore, 'prepareForQuit')
    const reopenAdmission = vi.spyOn(tokenStore, 'reopenAdmission')
    const clearSessionToken = vi.spyOn(tokenStore, 'clearSessionToken').mockResolvedValue()
    const clearSessionTokenStrictly = vi
      .spyOn(tokenStore, 'clearSessionTokenStrictly')
      .mockResolvedValue({ keytarAvailable: true, keytarDisabled: false })
    const service = createService(tokenStore)

    await service.prepareForQuit()
    await expect(service.logout()).rejects.toThrow('Application is shutting down')

    service.cancelQuitPreparation()
    await expect(service.logout()).resolves.toBeUndefined()
    expect(clearSessionToken).not.toHaveBeenCalled()
    expect(clearSessionTokenStrictly).toHaveBeenCalledOnce()
    expect(reopenAdmission).toHaveBeenCalledOnce()
    expect(prepareForQuit).toHaveBeenCalledOnce()
  })

  it('keeps an admitted logout pending beyond a two-minute producer bound', async () => {
    const [{ readPendingExternalLogoutMarker }, { getActiveEnvKey }] = await Promise.all([
      import('../pendingExternalLogout.js'),
      import('../config.js'),
    ])
    vi.useFakeTimers()
    const pendingTokenClear = deferred<void>()
    const tokenClearStarted = deferred<void>()
    const tokenStore = new TokenStoreClass()
    const prepareForQuit = vi.spyOn(tokenStore, 'prepareForQuit')
    const clearSessionTokenStrictly = vi
      .spyOn(tokenStore, 'clearSessionTokenStrictly')
      .mockImplementation(async () => {
        tokenClearStarted.resolve()
        await pendingTokenClear.promise
        return { keytarAvailable: true, keytarDisabled: false }
      })
    const service = createService(tokenStore)

    const logout = service.logout().catch(error => error)
    await tokenClearStarted.promise
    let preparationSettled = false
    const preparation = service.prepareForQuit().then(() => {
      preparationSettled = true
    })

    try {
      expect(vi.getTimerCount()).toBe(0)
      await expect(service.logout()).rejects.toThrow('Application is shutting down')
      const newerLogoutIntent = readPendingExternalLogoutMarker(
        userDataDirectory,
        getActiveEnvKey()
      )
      expect(newerLogoutIntent?.intent).toEqual({ intent: 'logout-pending' })
      expect(newerLogoutIntent?.revision).not.toBeNull()
      await vi.advanceTimersByTimeAsync(120_001)
      expect(preparationSettled).toBe(false)
      expect(prepareForQuit).not.toHaveBeenCalled()
      expect(clearSessionTokenStrictly).toHaveBeenCalledOnce()

      pendingTokenClear.resolve()
      const [logoutResult] = await Promise.all([logout, preparation])
      expect(logoutResult).toBeInstanceOf(SupersededBeforeWrite)
      expect(readPendingExternalLogoutMarker(userDataDirectory, getActiveEnvKey())).toEqual(
        newerLogoutIntent
      )
      expect(preparationSettled).toBe(true)
      expect(clearSessionTokenStrictly.mock.invocationCallOrder[0]).toBeLessThan(
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
    vi.spyOn(tokenStore, 'clearSessionTokenStrictly').mockImplementation(async () => {
      producerStarted.resolve()
      await producer.promise
      return { keytarAvailable: true, keytarDisabled: false }
    })
    const service = createService(tokenStore)
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
    vi.spyOn(tokenStore, 'clearSessionTokenStrictly')
      .mockImplementationOnce(async () => {
        firstStarted.resolve()
        await rejectedProducer.promise
        return { keytarAvailable: true, keytarDisabled: false }
      })
      .mockImplementationOnce(async () => {
        secondStarted.resolve()
        await pendingProducer.promise
        return { keytarAvailable: true, keytarDisabled: false }
      })
    const service = createService(tokenStore)

    const first = service.logout().catch(error => error)
    let second: Promise<void> | undefined
    let preparation: Promise<void> | undefined
    try {
      await requireProducerEntry(firstStarted.promise)
      second = service.logout()
      expect(
        (service as unknown as { pendingCredentialProducers: Set<unknown> })
          .pendingCredentialProducers.size
      ).toBe(2)
      preparation = service.prepareForQuit()
      expect(prepareForQuit).not.toHaveBeenCalled()

      // A real superseded producer rejects; an ordinary clear failure could
      // instead succeed through a durable LP, which would not prove this case.
      rejectedProducer.reject(new SupersededBeforeWrite())
      expect(await first).toBeInstanceOf(SupersededBeforeWrite)
      await requireProducerEntry(secondStarted.promise)
      expect(prepareForQuit).not.toHaveBeenCalled()

      pendingProducer.resolve()
      await Promise.all([second, preparation])
      expect(prepareForQuit).toHaveBeenCalledOnce()
    } finally {
      rejectedProducer.resolve()
      pendingProducer.resolve()
      await Promise.allSettled([
        first,
        ...(second ? [second] : []),
        ...(preparation ? [preparation] : []),
      ])
    }
  })

  it('does not gate a runWithTeamContext call that has no team credential hop', async () => {
    const service = new AppServiceClass() as unknown as {
      pendingCredentialProducers: Set<Promise<unknown>>
      quitPreparationStarted: boolean
      requireSessionToken: () => string
      runWithTeamContext: <T>(
        teamId: string | null | undefined,
        operation: (sessionToken: string) => Promise<T>
      ) => Promise<T>
    }
    service.quitPreparationStarted = true
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
