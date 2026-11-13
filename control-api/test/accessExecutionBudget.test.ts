import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AccessBudgetConfigurationError,
  AccessBudgetExceededError,
  AccessExecutionBudget,
  AccessExecutionCancelledError,
  resolveAccessExecutionLimits,
} from '../src/services/access/accessExecutionBudget.js'

describe('AccessExecutionBudget', () => {
  it('applies the accepted local clamps and rejects attempts to raise them', () => {
    expect(resolveAccessExecutionLimits({ producerCalls: 2 }).producerCalls).toBe(2)
    expect(resolveAccessExecutionLimits({ databaseStatements: 2 }).databaseStatements).toBe(2)
    expect(() => resolveAccessExecutionLimits({ producerCalls: 33 })).toThrow(
      AccessBudgetConfigurationError
    )
    expect(() => resolveAccessExecutionLimits({ producerCalls: 0 })).toThrow(
      AccessBudgetConfigurationError
    )
    expect(() => resolveAccessExecutionLimits({ databaseStatements: 129 })).toThrow(
      AccessBudgetConfigurationError
    )
  })

  it('keeps the action class within its authorized producer and SQL ceiling', () => {
    expect(() => AccessExecutionBudget.create('action', { limits: { producerCalls: 33 } })).toThrow(
      AccessBudgetConfigurationError
    )
    expect(() =>
      AccessExecutionBudget.create('action', { limits: { databaseStatements: 129 } })
    ).toThrow(AccessBudgetConfigurationError)
  })

  it('charges action requests against the action producer and SQL ceiling', () => {
    const action = AccessExecutionBudget.create('action')
    expect(action.remaining('producerCalls')).toBe(32)
    expect(action.remaining('databaseStatements')).toBe(128)
    expect(() => action.charge({ kind: 'producerCalls', amount: 33 })).toThrow(
      AccessBudgetExceededError
    )
    expect(() => action.charge({ kind: 'databaseStatements', amount: 129 })).toThrow(
      AccessBudgetExceededError
    )
    action.close()
  })

  it('charges objects, bytes, paths, relationships and rows', () => {
    const budget = AccessExecutionBudget.create('action', {
      limits: {
        objects: 1,
        decodedBytes: 10,
        objectBytes: 8,
        accessPaths: 1,
        relationships: 1,
        dbRowsReturned: 1,
        databaseStatements: 1,
      },
    })
    budget.chargeOperationalObject(8)
    budget.charge({ kind: 'accessPaths' })
    budget.charge({ kind: 'relationships' })
    budget.charge({ kind: 'dbRowsReturned' })
    budget.charge({ kind: 'databaseStatements' })
    expect(() => budget.chargeOperationalObject(1)).toThrow(AccessBudgetExceededError)
    budget.close()
  })

  it('bounds producer concurrency and releases slots after completion', async () => {
    const budget = AccessExecutionBudget.create('action', {
      limits: { producerCalls: 3, producerConcurrency: 1 },
    })
    let releaseFirst: (() => void) | undefined
    const first = budget.runProducer(() => new Promise<void>(resolve => (releaseFirst = resolve)))
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'))
    const secondWork = vi.fn(async () => 'second')
    const second = budget.runProducer(secondWork)
    await Promise.resolve()
    expect(secondWork).not.toHaveBeenCalled()
    releaseFirst!()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBe('second')
    budget.close()
  })

  it('cancels queued and late producer completion without returning a result', async () => {
    const budget = AccessExecutionBudget.create('action', {
      limits: { producerCalls: 2, producerConcurrency: 1 },
    })
    let finish: (() => void) | undefined
    const running = budget.runProducer(() => new Promise<void>(resolve => (finish = resolve)))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const queued = budget.runProducer(async () => 'late')
    budget.cancel()
    finish!()
    await expect(running).rejects.toBeInstanceOf(AccessExecutionCancelledError)
    await expect(queued).rejects.toBeInstanceOf(AccessExecutionCancelledError)
    budget.close()
  })

  it('derives the statement timeout from the same absolute deadline', () => {
    const now = Date.now()
    const budget = AccessExecutionBudget.create('action', { now })
    expect(budget.statementTimeoutMs(now)).toBe(1_750)
    expect(() => budget.statementTimeoutMs(now + 1_751)).toThrow(AccessBudgetExceededError)
    budget.close()
  })
})

describe('AccessExecutionBudget.untilDeadline (C12 P4)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  async function drainRejections(): Promise<void> {
    // Node reports an unhandled rejection after the microtask queue drains.
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
  }

  it('settles with work that finishes before the deadline', async () => {
    const budget = AccessExecutionBudget.create('action')
    await expect(budget.untilDeadline(Promise.resolve('admitted'))).resolves.toBe('admitted')
    const failure = new Error('admission failed')
    await expect(budget.untilDeadline(Promise.reject(failure))).rejects.toBe(failure)
    expect(budget.signal.aborted).toBe(false)
    budget.close()
  })

  it('rejects with deadline when the deadline passes first and observes the late rejection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const budget = AccessExecutionBudget.create('action')
      let rejectWork!: (error: Error) => void
      const work = new Promise<string>((_resolve, reject) => {
        rejectWork = reject
      })
      let outcome: unknown = 'pending'
      const bounded = budget.untilDeadline(work).then(
        value => (outcome = value),
        error => (outcome = error)
      )

      await vi.advanceTimersByTimeAsync(1_999)
      expect(outcome).toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      await bounded
      expect(outcome).toBeInstanceOf(AccessExecutionCancelledError)
      expect((outcome as AccessExecutionCancelledError).reason).toBe('deadline')

      rejectWork(new Error('late admission failure'))
      await drainRejections()
      expect(unhandled).toEqual([])
      // Witness: the late rejection did happen.
      await expect(work).rejects.toThrow('late admission failure')
      budget.close()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('rejects at once on a budget that is already cancelled and observes the late rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const budget = AccessExecutionBudget.create('action')
      budget.cancel()
      let rejectWork!: (error: Error) => void
      const work = new Promise<string>((_resolve, reject) => {
        rejectWork = reject
      })

      const error = await budget.untilDeadline(work).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(AccessExecutionCancelledError)
      expect((error as AccessExecutionCancelledError).reason).toBe('cancelled')
      rejectWork(new Error('late admission failure'))
      await drainRejections()
      expect(unhandled).toEqual([])
      await expect(work).rejects.toThrow('late admission failure')
      budget.close()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
