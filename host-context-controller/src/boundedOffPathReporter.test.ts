import { describe, expect, it, vi } from 'vitest'
import {
  BoundedOffPathReporter,
  type BoundedOffPathReporterOptions,
} from './boundedOffPathReporter'

function createReporter(overrides: Partial<BoundedOffPathReporterOptions<string>> = {}) {
  return new BoundedOffPathReporter<string>({
    capacity: 2,
    retryLimit: 1,
    stopTimeoutMs: 100,
    random: () => 0,
    submit: vi.fn().mockResolvedValue(undefined),
    onAccepted: vi.fn(),
    onDrop: vi.fn(),
    ...overrides,
  })
}

describe('BoundedOffPathReporter', () => {
  it('keeps enqueue synchronous and submits on the microtask queue', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const onAccepted = vi.fn()
    const reporter = createReporter({ submit, onAccepted })

    reporter.enqueue('event-1')

    expect(submit).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(submit).toHaveBeenCalledOnce()
    expect(onAccepted).toHaveBeenCalledWith('event-1')
  })

  it('drops entries that exceed bounded capacity', () => {
    const onDrop = vi.fn()
    const reporter = createReporter({ capacity: 1, onDrop })

    reporter.enqueue('event-1')
    reporter.enqueue('event-2')

    expect(onDrop).toHaveBeenCalledWith('event-2', 'buffer_full')
  })

  it('retries a failed submission and preserves the entry value', async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const onRetry = vi.fn()
    const onAccepted = vi.fn()
    const reporter = createReporter({ submit, onRetry, onAccepted })

    reporter.enqueue('event-1')
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(submit).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith('event-1')
    expect(onAccepted).toHaveBeenCalledWith('event-1')
  })

  it('reports retry exhaustion without rejecting enqueue', async () => {
    const onDrop = vi.fn()
    const reporter = createReporter({
      retryLimit: 0,
      submit: vi.fn().mockRejectedValue(new Error('offline')),
      onDrop,
    })

    expect(() => reporter.enqueue('event-1')).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(onDrop).toHaveBeenCalledWith('event-1', 'retry_exhausted')
  })

  it('drains queued entries during stop and rejects later enqueue', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const onDrop = vi.fn()
    const reporter = createReporter({ submit, onDrop })

    reporter.enqueue('event-1')
    await reporter.stop()
    reporter.enqueue('event-2')

    expect(submit).toHaveBeenCalledWith('event-1')
    expect(onDrop).toHaveBeenCalledWith('event-2', 'stopped')
  })

  it('validates queue capacity and retry limit', () => {
    expect(() => createReporter({ capacity: 0 })).toThrow('capacity must be a positive integer')
    expect(() => createReporter({ retryLimit: -1 })).toThrow(
      'retryLimit must be a non-negative integer'
    )
  })
})
