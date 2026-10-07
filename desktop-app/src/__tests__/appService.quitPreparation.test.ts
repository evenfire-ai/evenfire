import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
let isolatedConfigPath = ''
let AppServiceClass: typeof import('../appService.js').AppService
let getDesktopRuntimeConfigState: typeof import('../config.js').getDesktopRuntimeConfigState

beforeAll(async () => {
  const isolatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-quit-preparation-'))
  isolatedConfigPath = path.join(isolatedDirectory, 'runtime-config.json')
  process.env.CLERUM_DESKTOP_CONFIG_PATH = isolatedConfigPath
  vi.resetModules()

  const [{ AppService }, configModule] = await Promise.all([
    import('../appService.js'),
    import('../config.js'),
  ])
  AppServiceClass = AppService
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

function createService(tokenStore: {
  prepareForQuit: ReturnType<typeof vi.fn>
  reopenAdmission: ReturnType<typeof vi.fn>
}) {
  const service = Object.create(AppServiceClass.prototype) as {
    pendingCredentialProducers: Set<Promise<unknown>>
    quitPreparationStarted: boolean
    tokenStore: typeof tokenStore
    logoutOnce: ReturnType<typeof vi.fn>
    prepareForQuit: () => Promise<void>
    cancelQuitPreparation: () => void
    logout: () => Promise<void>
  }
  service.pendingCredentialProducers = new Set()
  service.quitPreparationStarted = false
  service.tokenStore = tokenStore
  service.logoutOnce = vi.fn().mockResolvedValue(undefined)
  return service
}

describe('AppService quit preparation', () => {
  it('loads runtime config from this suite’s isolated path', () => {
    expect(getDesktopRuntimeConfigState().storagePath).toBe(isolatedConfigPath)
  })

  it('reopens credential admission when Electron cancels a quit attempt', async () => {
    const tokenStore = {
      prepareForQuit: vi.fn().mockResolvedValue(undefined),
      reopenAdmission: vi.fn(),
    }
    const service = createService(tokenStore)

    await service.prepareForQuit()
    await expect(service.logout()).rejects.toThrow('Application is shutting down')

    service.cancelQuitPreparation()
    await expect(service.logout()).resolves.toBeUndefined()
    expect(service.logoutOnce).toHaveBeenCalledOnce()
    expect(tokenStore.reopenAdmission).toHaveBeenCalledOnce()
  })

  it('keeps an admitted logout pending beyond a two-minute producer bound', async () => {
    vi.useFakeTimers()
    const pendingAuthFence = deferred<void>()
    let storeAdmissionClosed = false
    let persistedSession = true
    const prepareForQuit = vi.fn(async () => {
      storeAdmissionClosed = true
    })
    const clearSessionToken = vi.fn(async () => {
      if (storeAdmissionClosed) throw new Error('Application is shutting down')
      persistedSession = false
    })
    const tokenStore = {
      prepareForQuit,
      clearSessionToken,
    }
    const service = Object.create(AppServiceClass.prototype) as {
      pendingCredentialProducers: Set<Promise<unknown>>
      quitPreparationStarted: boolean
      logoutInProgress: boolean
      sessionToken: string | null
      me: object | null
      tokenStore: typeof tokenStore
      logout: () => Promise<void>
      prepareForQuit: () => Promise<void>
      beginPrewarmAuthTransition: () => () => void
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
      clearAuthenticatedSessionState: () => void
    }
    service.pendingCredentialProducers = new Set()
    service.quitPreparationStarted = false
    service.logoutInProgress = false
    service.sessionToken = 'active-session-token'
    service.me = { id: 'synthetic-user' }
    service.tokenStore = tokenStore
    service.beginPrewarmAuthTransition = vi.fn(() => () => {})
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn(() => pendingAuthFence.promise)
    service.clearAuthenticatedSessionState = vi.fn(() => {
      service.sessionToken = null
      service.me = null
    })

    const logout = service.logout()
    let preparationSettled = false
    const preparation = service.prepareForQuit().then(() => {
      preparationSettled = true
    })

    try {
      expect(service.quitPreparationStarted).toBe(true)
      await expect(service.logout()).rejects.toThrow('Application is shutting down')
      await vi.advanceTimersByTimeAsync(120_001)
      expect(preparationSettled).toBe(false)
      expect(prepareForQuit).not.toHaveBeenCalled()
      expect(service.sessionToken).toBe('active-session-token')
      expect(persistedSession).toBe(true)

      pendingAuthFence.resolve()
      await Promise.all([logout, preparation])
      expect(preparationSettled).toBe(true)
      expect(service.sessionToken).toBeNull()
      expect(persistedSession).toBe(false)
      expect(clearSessionToken.mock.invocationCallOrder[0]).toBeLessThan(
        prepareForQuit.mock.invocationCallOrder[0]
      )
    } finally {
      pendingAuthFence.resolve()
      await Promise.allSettled([logout, preparation])
      vi.useRealTimers()
    }
  })

  it('waits for an admitted producer before starting the TokenStore drain', async () => {
    const producer = deferred<void>()
    const tokenStore = {
      prepareForQuit: vi.fn().mockResolvedValue(undefined),
      reopenAdmission: vi.fn(),
    }
    const service = createService(tokenStore)
    service.logoutOnce.mockReturnValue(producer.promise)
    const logout = service.logout()
    const preparation = service.prepareForQuit()

    try {
      expect(tokenStore.prepareForQuit).not.toHaveBeenCalled()
      producer.resolve()
      await Promise.all([logout, preparation])
      expect(tokenStore.prepareForQuit).toHaveBeenCalledOnce()
    } finally {
      producer.resolve()
      await Promise.allSettled([logout, preparation])
    }
  })

  it('waits for remaining admitted producers after one producer rejects', async () => {
    const rejectedProducer = deferred<void>()
    const pendingProducer = deferred<void>()
    const tokenStore = {
      prepareForQuit: vi.fn().mockResolvedValue(undefined),
      reopenAdmission: vi.fn(),
    }
    const service = createService(tokenStore)
    service.logoutOnce
      .mockImplementationOnce(() => rejectedProducer.promise)
      .mockImplementationOnce(() => pendingProducer.promise)

    const first = service.logout().catch(error => error)
    const second = service.logout()
    const preparation = service.prepareForQuit()

    rejectedProducer.reject(new Error('first producer failed'))
    await first
    expect(tokenStore.prepareForQuit).not.toHaveBeenCalled()

    pendingProducer.resolve()
    await Promise.all([second, preparation])
    expect(tokenStore.prepareForQuit).toHaveBeenCalledOnce()
  })

  it('does not gate a runWithTeamContext call that has no team credential hop', async () => {
    const service = Object.create(AppServiceClass.prototype) as {
      pendingCredentialProducers: Set<Promise<unknown>>
      quitPreparationStarted: boolean
      teamContextQueue: Promise<void>
      requireSessionToken: () => string
      runWithTeamContext: <T>(
        teamId: string | null | undefined,
        operation: (sessionToken: string) => Promise<T>
      ) => Promise<T>
    }
    service.pendingCredentialProducers = new Set()
    service.quitPreparationStarted = true
    service.teamContextQueue = Promise.resolve()
    service.requireSessionToken = vi.fn(() => 'session-token')
    const read = vi.fn(async (token: string) => token)

    await expect(service.runWithTeamContext(null, read)).resolves.toBe('session-token')
    expect(read).toHaveBeenCalledOnce()
    expect(service.pendingCredentialProducers.size).toBe(0)
  })

  it('does not hold quit for a same-team operation that does not change credentials', async () => {
    const request = deferred<string>()
    const requestStarted = deferred<void>()
    const tokenStore = {
      prepareForQuit: vi.fn().mockResolvedValue(undefined),
      reopenAdmission: vi.fn(),
    }
    const service = Object.create(AppServiceClass.prototype) as {
      pendingCredentialProducers: Set<Promise<unknown>>
      quitPreparationStarted: boolean
      teamContextQueue: Promise<void>
      sessionToken: string | null
      me: { id: string; teamId: string }
      tokenStore: typeof tokenStore
      requireSessionToken: () => string
      getCurrentSessionTeamId: (token: string) => Promise<string>
      runWithTeamContext: <T>(
        teamId: string | null | undefined,
        operation: (sessionToken: string) => Promise<T>
      ) => Promise<T>
      prepareForQuit: () => Promise<void>
    }
    service.pendingCredentialProducers = new Set()
    service.quitPreparationStarted = false
    service.teamContextQueue = Promise.resolve()
    service.sessionToken = 'session-token'
    service.me = { id: 'user-1', teamId: 'team-a' }
    service.tokenStore = tokenStore
    service.requireSessionToken = vi.fn(() => 'session-token')
    service.getCurrentSessionTeamId = vi.fn(async () => 'team-a')

    const operation = service.runWithTeamContext('team-a', async () => {
      requestStarted.resolve()
      return request.promise
    })
    await requestStarted.promise

    const preparation = service.prepareForQuit()
    expect(tokenStore.prepareForQuit).toHaveBeenCalledOnce()
    await expect(preparation).resolves.toBeUndefined()

    request.resolve('request-complete')
    await expect(operation).resolves.toBe('request-complete')
    expect(service.pendingCredentialProducers.size).toBe(0)
  })
})
