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
    expect(resolveAccessExecutionLimits().publicPageSize).toBe(100)
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

  it('rejects invalid public limits and cursor sizes before producer work', () => {
    const budget = AccessExecutionBudget.create('catalog')
    expect(() => budget.assertPageSize(101)).toThrow(AccessBudgetConfigurationError)
    expect(() => budget.assertCursorBytes(16 * 1024 + 1)).toThrow(AccessBudgetConfigurationError)
    expect(budget.remaining('producerCalls')).toBe(32)
    expect(budget.remaining('databaseStatements')).toBe(128)
    budget.close()
  })

  it('charges objects, bytes, paths, relationships, rows, memo, and response limits', () => {
    const budget = AccessExecutionBudget.create('catalog', {
      limits: {
        objects: 1,
        decodedBytes: 10,
        objectBytes: 8,
        accessPaths: 1,
        relationships: 1,
        dbRowsReturned: 1,
        databaseStatements: 1,
        memoEntries: 1,
        memoBytes: 8,
        responseBytes: 8,
      },
    })
    budget.chargeOperationalObject(8)
    budget.charge({ kind: 'accessPaths' })
    budget.charge({ kind: 'relationships' })
    budget.charge({ kind: 'dbRowsReturned' })
    budget.charge({ kind: 'databaseStatements' })
    budget.charge({ kind: 'memoEntries' })
    budget.charge({ kind: 'memoBytes', amount: 8 })
    budget.charge({ kind: 'responseBytes', amount: 8 })
    expect(() => budget.chargeOperationalObject(1)).toThrow(AccessBudgetExceededError)
    expect(() => budget.assertRelationshipDepth(2)).toThrow(AccessBudgetExceededError)
    budget.close()
  })

  it('reserves child capacity and returns only unused capacity on close', () => {
    const parent = AccessExecutionBudget.create('catalog', {
      limits: { producerCalls: 4, objects: 4 },
    })
    const child = parent.child({ producerCalls: 2, objects: 3 })
    expect(parent.remaining('producerCalls')).toBe(2)
    expect(parent.remaining('objects')).toBe(1)
    child.charge({ kind: 'producerCalls' })
    child.charge({ kind: 'objects', amount: 2 })
    child.close()
    expect(parent.remaining('producerCalls')).toBe(3)
    expect(parent.remaining('objects')).toBe(2)
    parent.close()
  })

  it('bounds producer concurrency and releases slots after completion', async () => {
    const budget = AccessExecutionBudget.create('catalog', {
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
    const budget = AccessExecutionBudget.create('catalog', {
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

  it('releases a long-lived parent abort listener when a root budget closes', () => {
    const parent = new AbortController()
    const add = vi.spyOn(parent.signal, 'addEventListener')
    const remove = vi.spyOn(parent.signal, 'removeEventListener')
    const budget = AccessExecutionBudget.create('action', { parentSignal: parent.signal })

    const listener = add.mock.calls.find(([event]) => event === 'abort')?.[1]
    expect(listener).toBeTypeOf('function')

    budget.close()

    expect(remove).toHaveBeenCalledWith('abort', listener)
  })
})
