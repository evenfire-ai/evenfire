import { describe, expect, it, vi } from 'vitest'
import { createWriterCleanupRunner } from './cleanup'

describe('writer cleanup runner', () => {
  it('runs upload reconciliation only after the service is available at invocation time', async () => {
    let uploadService: { reconcile: () => Promise<void> } | undefined
    const reconcileBlobs = vi.fn(async () => undefined)
    const run = createWriterCleanupRunner({
      reconcileUploads: async () => uploadService?.reconcile(),
      reconcileBlobs,
    })

    uploadService = { reconcile: vi.fn(async () => undefined) }
    await run()

    expect(uploadService.reconcile).toHaveBeenCalledTimes(1)
    expect(reconcileBlobs).toHaveBeenCalledTimes(1)
  })

  it('does not overlap a running pass and releases the gate after failures', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const reconcileUploads = vi.fn(async () => blocked)
    const reconcileBlobs = vi.fn(async () => undefined)
    const run = createWriterCleanupRunner({ reconcileUploads, reconcileBlobs })

    const first = run()
    const second = run()
    expect(reconcileUploads).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    await run()

    expect(reconcileUploads).toHaveBeenCalledTimes(2)
    expect(reconcileBlobs).toHaveBeenCalledTimes(2)
  })
})
