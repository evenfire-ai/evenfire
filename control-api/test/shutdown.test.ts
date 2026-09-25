import { describe, expect, it, vi } from 'vitest'
import {
  CONTROL_API_SHUTDOWN_STEP_NAMES,
  createControlApiShutdownSteps,
  createShutdownHandler,
  runShutdownSteps,
} from '../src/shutdown.js'

describe('Control API shutdown', () => {
  it('closes every registered resource in order and continues after failures', async () => {
    const completed: string[] = []
    const actions = Object.fromEntries(
      CONTROL_API_SHUTDOWN_STEP_NAMES.map(name => [
        name,
        vi.fn(async () => {
          completed.push(name)
          if (name === 'rate-limit-cleanup') throw new Error('fixture failure')
        }),
      ])
    ) as Record<(typeof CONTROL_API_SHUTDOWN_STEP_NAMES)[number], () => Promise<void>>

    const result = await runShutdownSteps(createControlApiShutdownSteps(actions), 1000)

    expect(completed).toEqual(CONTROL_API_SHUTDOWN_STEP_NAMES)
    expect(Object.keys(actions).sort()).toEqual([...CONTROL_API_SHUTDOWN_STEP_NAMES].sort())
    expect(result.errors.map(error => error.name)).toEqual(['rate-limit-cleanup'])
    expect(result.timedOut).toBe(false)
  })

  it('shares one in-flight cleanup operation across repeated shutdown signals', async () => {
    let finish!: () => void
    const run = vi.fn(() => new Promise<void>(resolve => (finish = resolve)))
    const shutdown = createShutdownHandler(run)

    const first = shutdown()
    const second = shutdown()

    expect(second).toBe(first)
    expect(run).toHaveBeenCalledOnce()
    finish()
    await first
  })

  it('reports a shared-deadline timeout without skipping later cleanup continuation', async () => {
    vi.useFakeTimers()
    let finishSlowStep!: () => void
    const steps = [
      { name: 'slow', run: () => new Promise<void>(resolve => (finishSlowStep = resolve)) },
      { name: 'later', run: vi.fn() },
    ]
    const pending = runShutdownSteps(steps, 25)
    await vi.advanceTimersByTimeAsync(25)
    await expect(pending).resolves.toMatchObject({ timedOut: true, errors: [] })
    finishSlowStep()
    await vi.advanceTimersByTimeAsync(0)
    expect(steps[1]?.run).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
