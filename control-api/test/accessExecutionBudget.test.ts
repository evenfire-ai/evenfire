import { describe, expect, it, vi } from 'vitest'
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
