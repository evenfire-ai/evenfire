import { describe, expect, it, vi } from 'vitest'
import {
  CONTROL_API_SHUTDOWN_STEP_NAMES,
  createControlApiShutdownSteps,
  createShutdownHandler,
  runShutdownSteps,
} from '../src/shutdown.js'

describe('Control API shutdown', () => {
  it('stops the OAuth proactive refresh cron before database pools close', () => {
    const names = [...CONTROL_API_SHUTDOWN_STEP_NAMES] as string[]
    const cronIndex = names.indexOf('oauth-proactive-refresh-cron')
    const poolIndex = names.indexOf('core-database-pool')

    expect(names).toContain('oauth-proactive-refresh-cron')
    expect(cronIndex).toBeGreaterThanOrEqual(0)
    expect(poolIndex).toBeGreaterThan(cronIndex)
  })

  it('stops both database-backed dispatchers and the access indexer before pools close', () => {
    const names = [...CONTROL_API_SHUTDOWN_STEP_NAMES] as string[]
    const corePoolIndex = names.indexOf('core-database-pool')

    expect(corePoolIndex).toBeGreaterThan(names.indexOf('entity-change-dispatcher'))
    expect(corePoolIndex).toBeGreaterThan(names.indexOf('operational-access-indexer'))
  })

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
    expect(completed.indexOf('oauth-proactive-refresh-cron')).toBeLessThan(
      completed.indexOf('core-database-pool')
    )
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
