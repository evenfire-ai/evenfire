import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpilloverStorage } from '../storage'

// A failed periodic sweep is reported through the service logger (repository
// logging standard), which keeps the error's name and code but not its message.
const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
vi.mock('../../../logger', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../logger')>()),
  logger,
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('SpilloverStorage GC failure logging', () => {
  it('logs a failed sweep through the service logger', async () => {
    vi.useFakeTimers()
    const storage = new SpilloverStorage({
      workspacePath: '/nonexistent-spillover-workspace',
      thresholdBytes: 8,
      ttlMs: 60_000,
      gcIntervalMs: 1_000,
    })
    const failure = Object.assign(new Error('EACCES: /private/path'), { code: 'EACCES' })
    const sweep = vi.spyOn(storage, 'sweep').mockRejectedValue(failure)

    storage.startGc()
    try {
      await vi.advanceTimersByTimeAsync(1_000)
    } finally {
      storage.stopGc()
    }

    // Witness: the timer fired the sweep.
    expect(sweep).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      { component: 'SpilloverStorage', err: failure },
      'GC sweep failed'
    )
  })
})
