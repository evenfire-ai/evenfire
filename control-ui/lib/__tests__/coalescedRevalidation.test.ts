import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCoalescedRevalidation } from '../coalescedRevalidation'

describe('coalesced GFS revalidation', () => {
  afterEach(() => vi.useRealTimers())

  it('runs a latest-state pass within the maximum wait during a continuous burst', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async (_latest: string | undefined) => undefined)
    const revalidation = createCoalescedRevalidation(run, 100)

    for (let index = 0; index < 20; index += 1) {
      revalidation.request(`cursor-${index}`)
      await vi.advanceTimersByTimeAsync(50)
    }

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('cursor-19')
    revalidation.dispose()
  })
})
