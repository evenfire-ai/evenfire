import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
let isolatedConfigPath = ''
let AppServiceClass: typeof import('../appService.js').AppService
let TokenStoreClass: typeof import('../tokenStore.js').TokenStore
let getDesktopRuntimeConfigState: typeof import('../config.js').getDesktopRuntimeConfigState

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function createService(tokenStore = new TokenStoreClass()) {
  return new AppServiceClass({
    tokenStore,
    getUserDataDirectory: () => path.dirname(isolatedConfigPath),
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
    const service = createService(tokenStore)

    await service.prepareForQuit()
    await expect(service.logout()).rejects.toThrow('Application is shutting down')

    service.cancelQuitPreparation()
    await expect(service.logout()).resolves.toBeUndefined()
    expect(clearSessionToken).toHaveBeenCalledOnce()
    expect(reopenAdmission).toHaveBeenCalledOnce()
    expect(prepareForQuit).toHaveBeenCalledOnce()
  })

  it('keeps an admitted logout pending beyond a two-minute producer bound', async () => {
    vi.useFakeTimers()
    const pendingTokenClear = deferred<void>()
    const tokenClearStarted = deferred<void>()
    const tokenStore = new TokenStoreClass()
    const prepareForQuit = vi.spyOn(tokenStore, 'prepareForQuit')
    const clearSessionToken = vi
      .spyOn(tokenStore, 'clearSessionToken')
      .mockImplementation(async () => {
        tokenClearStarted.resolve()
        await pendingTokenClear.promise
      })
    const service = createService(tokenStore)

    const logout = service.logout()
    await tokenClearStarted.promise
    let preparationSettled = false
    const preparation = service.prepareForQuit().then(() => {
      preparationSettled = true
    })

    try {
      expect(vi.getTimerCount()).toBe(0)
      await expect(service.logout()).rejects.toThrow('Application is shutting down')
      await vi.advanceTimersByTimeAsync(120_001)
      expect(preparationSettled).toBe(false)
      expect(prepareForQuit).not.toHaveBeenCalled()
      expect(clearSessionToken).toHaveBeenCalledOnce()

      pendingTokenClear.resolve()
      await Promise.all([logout, preparation])
      expect(preparationSettled).toBe(true)
      expect(clearSessionToken.mock.invocationCallOrder[0]).toBeLessThan(
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
    vi.spyOn(tokenStore, 'clearSessionToken').mockImplementation(async () => {
      producerStarted.resolve()
      await producer.promise
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
    const producersStarted = deferred<void>()
    let startedCount = 0
    const tokenStore = new TokenStoreClass()
    const prepareForQuit = vi.spyOn(tokenStore, 'prepareForQuit')
    vi.spyOn(tokenStore, 'clearSessionToken')
      .mockImplementationOnce(async () => {
        startedCount += 1
        if (startedCount === 2) producersStarted.resolve()
        await rejectedProducer.promise
      })
      .mockImplementationOnce(async () => {
        startedCount += 1
        if (startedCount === 2) producersStarted.resolve()
        await pendingProducer.promise
      })
    const service = createService(tokenStore)

    const first = service.logout().catch(error => error)
    const second = service.logout()
    await producersStarted.promise
    const preparation = service.prepareForQuit()

    rejectedProducer.reject(new Error('first producer failed'))
    await first
    expect(prepareForQuit).not.toHaveBeenCalled()

    pendingProducer.resolve()
    await Promise.all([second, preparation])
    expect(prepareForQuit).toHaveBeenCalledOnce()
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
