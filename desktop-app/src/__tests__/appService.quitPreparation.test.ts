import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'

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
  const service = Object.create(AppService.prototype) as {
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
    const service = Object.create(AppService.prototype) as {
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
