import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCoalescedRevalidation } from '../coalescedRevalidation'

describe('coalesced GFS revalidation', () => {
  afterEach(() => vi.useRealTimers())

  it('reports an unexpected failure and still runs the coalesced latest-state pass', async () => {
    vi.useFakeTimers()
    const failure = new Error('unexpected background revalidation failure')
    const run = vi.fn<(_latest: string | undefined) => Promise<void>>()
    run.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
    const onError = vi.fn()
    const revalidation = createCoalescedRevalidation(run, onError, 100)

    revalidation.request('first')
    await vi.advanceTimersByTimeAsync(100)
    revalidation.request('latest')
    await vi.advanceTimersByTimeAsync(100)

    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(failure)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenLastCalledWith('latest')
    revalidation.dispose()
  })

  it('runs a latest-state pass within the maximum wait during a continuous burst', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async (_latest: string | undefined) => undefined)
    const revalidation = createCoalescedRevalidation(run, vi.fn(), 100)

    for (let index = 0; index < 20; index += 1) {
      revalidation.request(`cursor-${index}`)
      await vi.advanceTimersByTimeAsync(50)
    }

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('cursor-19')
    revalidation.dispose()
  })
})
