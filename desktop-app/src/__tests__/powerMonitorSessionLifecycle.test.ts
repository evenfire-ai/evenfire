import { describe, expect, it, vi } from 'vitest'
import type { PowerMonitor } from 'electron'
import { EventEmitter } from 'node:events'
import { wireMemoryOnlySessionPowerLifecycle } from '../powerMonitorSessionLifecycle.js'

describe('memory-only session power lifecycle', () => {
  it('ends M on suspend and checks expiry before resume and unlock notifications', () => {
    const monitor = new EventEmitter()
    const service = {
      endMemoryOnlySessionForSystemSuspend: vi.fn(),
      checkTemporarySessionExpiry: vi.fn(),
    }
    const emitSystemResume = vi.fn()

    wireMemoryOnlySessionPowerLifecycle(
      monitor as unknown as Pick<PowerMonitor, 'on'>,
      service,
      emitSystemResume
    )

    monitor.emit('suspend')
    expect(service.endMemoryOnlySessionForSystemSuspend).toHaveBeenCalledOnce()

    monitor.emit('resume')
    monitor.emit('unlock-screen')
    expect(service.checkTemporarySessionExpiry).toHaveBeenCalledTimes(2)
    expect(emitSystemResume).toHaveBeenCalledTimes(2)
    expect(service.checkTemporarySessionExpiry.mock.invocationCallOrder[0]).toBeLessThan(
      emitSystemResume.mock.invocationCallOrder[0]
    )
    expect(service.checkTemporarySessionExpiry.mock.invocationCallOrder[1]).toBeLessThan(
      emitSystemResume.mock.invocationCallOrder[1]
    )
  })
})
