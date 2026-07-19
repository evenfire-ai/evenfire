import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TraceMaintenanceShutdownCoordinator,
  waitForAbortableDelay,
} from '../src/services/tracing/maintenance/workerLifecycle.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('trace maintenance worker lifecycle', () => {
  it('interrupts the idle delay immediately when shutdown is requested', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const delay = waitForAbortableDelay(60_000, controller.signal)

    controller.abort()

    await expect(delay).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the idle delay referenced so the standalone worker remains alive', async () => {
    const controller = new AbortController()
    const unref = vi.fn()
    const timer = { unref }
    vi.spyOn(globalThis, 'setTimeout').mockReturnValue(
      timer as unknown as ReturnType<typeof setTimeout>
    )
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})

    const delay = waitForAbortableDelay(60_000, controller.signal)

    expect(unref).not.toHaveBeenCalled()
    controller.abort()
    await expect(delay).resolves.toBeUndefined()
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer)
  })

  it('waits for in-flight work to finish and records one graceful shutdown', async () => {
    vi.useFakeTimers()
    const onRequested = vi.fn()
    const onCompleted = vi.fn()
    const onTimedOut = vi.fn()
    const exit = vi.fn()
    const shutdown = new TraceMaintenanceShutdownCoordinator({
      timeoutMs: 25_000,
      onRequested,
      onCompleted,
      onTimedOut,
      exit,
    })

    expect(shutdown.request('SIGTERM')).toBe(true)
    expect(shutdown.request('SIGINT')).toBe(false)
    expect(shutdown.signal.aborted).toBe(true)
    expect(onRequested).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(24_999)
    expect(exit).not.toHaveBeenCalled()
    expect(shutdown.finish()).toBe(true)
    expect(shutdown.finish()).toBe(false)
    expect(onCompleted).toHaveBeenCalledWith('SIGTERM')

    await vi.advanceTimersByTimeAsync(1)
    expect(onTimedOut).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('records an aborted cycle before forcing exit at the bounded timeout', async () => {
    vi.useFakeTimers()
    const onTimedOut = vi.fn()
    const exit = vi.fn()
    const shutdown = new TraceMaintenanceShutdownCoordinator({
      timeoutMs: 25_000,
      onRequested: vi.fn(),
      onCompleted: vi.fn(),
      onTimedOut,
      exit,
    })

    shutdown.request('SIGTERM')
    await vi.advanceTimersByTimeAsync(25_000)

    expect(onTimedOut).toHaveBeenCalledWith('SIGTERM', 25_000)
    expect(exit).toHaveBeenCalledWith(1)
  })
})
