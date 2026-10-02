import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'

describe('AppService quit preparation', () => {
  it('reopens credential admission when Electron cancels a quit attempt', async () => {
    const service = Object.create(AppService.prototype) as {
      pendingCredentialProducers: Set<Promise<unknown>>
      quitPreparationStarted: boolean
      tokenStore: { prepareForQuit: ReturnType<typeof vi.fn> }
      logoutOnce: ReturnType<typeof vi.fn>
      prepareForQuit: () => Promise<void>
      cancelQuitPreparation?: () => void
      logout: () => Promise<void>
    }
    service.pendingCredentialProducers = new Set()
    service.quitPreparationStarted = false
    service.tokenStore = { prepareForQuit: vi.fn().mockResolvedValue(undefined) }
    service.logoutOnce = vi.fn().mockResolvedValue(undefined)

    await service.prepareForQuit()
    await expect(service.logout()).rejects.toThrow('Application is shutting down')

    expect(service.cancelQuitPreparation).toBeTypeOf('function')
    service.cancelQuitPreparation?.()
    await expect(service.logout()).resolves.toBeUndefined()
    expect(service.logoutOnce).toHaveBeenCalledOnce()
  })
})
