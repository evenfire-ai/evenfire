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
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
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

  it('moves on to TokenStore draining after the five-second producer deadline', async () => {
    vi.useFakeTimers()
    const producer = deferred<void>()
    const tokenStore = {
      prepareForQuit: vi.fn().mockResolvedValue(undefined),
      reopenAdmission: vi.fn(),
    }
    const service = createService(tokenStore)
    service.logoutOnce.mockReturnValue(producer.promise)
    const logout = service.logout()
    let preparationSettled = false
    const preparation = service.prepareForQuit().then(() => {
      preparationSettled = true
    })

    try {
      expect(service.quitPreparationStarted).toBe(true)
      await expect(service.logout()).rejects.toThrow('Application is shutting down')
      expect(tokenStore.prepareForQuit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(4_999)
      expect(preparationSettled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(preparationSettled).toBe(true)
      expect(tokenStore.prepareForQuit).toHaveBeenCalledOnce()
    } finally {
      producer.resolve()
      await Promise.all([logout, preparation])
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
})
