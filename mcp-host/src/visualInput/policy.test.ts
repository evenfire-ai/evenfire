import { describe, expect, it } from 'vitest'
import { VisualInputBudget } from './policy'

describe('turn-owned visual input budget', () => {
  it('admits concurrent reservations atomically and releases each only once', async () => {
    const budget = new VisualInputBudget(100, 100)
    const first = budget.reserve(60)
    await expect(Promise.resolve().then(() => budget.reserve(60))).rejects.toThrow('limit_exceeded')
    expect(budget.residentBytes).toBe(60)
    first.release()
    first.release()
    const second = budget.reserve(100)
    expect(budget.residentBytes).toBe(100)
    second.release()
    expect(budget.residentBytes).toBe(0)
  })

  it('does not refund cumulative read work when memory is released', () => {
    const budget = new VisualInputBudget(100, 80)
    const allocation = budget.reserve(60)
    budget.consumeRead(60)
    allocation.release()
    expect(() => budget.consumeRead(21)).toThrow('limit_exceeded')
    expect(budget.readBytes).toBe(80)
    expect(() => budget.consumeRead(1)).toThrow('limit_exceeded')
  })

  it('restores read work across suspension without restoring image payloads', () => {
    const original = new VisualInputBudget(100, 80)
    original.consumeRead(60)
    const resumed = new VisualInputBudget(100, 80, original.readBytes)
    expect(resumed.residentBytes).toBe(0)
    expect(() => resumed.consumeRead(21)).toThrow('limit_exceeded')
  })

  it('reserves encoded memory before conversion and shares actual encoded data on reread', () => {
    const budget = new VisualInputBudget(16, 100)
    const bytes = Buffer.from('abc')
    expect(budget.encodeImage(bytes)).toBe('YWJj')
    expect(budget.residentBytes).toBe(8)
    expect(budget.encodeImage(Buffer.from(bytes))).toBe('YWJj')
    expect(budget.residentBytes).toBe(8)
    expect(() => budget.encodeImage(Buffer.from('a longer image'))).toThrow('limit_exceeded')
    expect(budget.residentBytes).toBe(8)
  })

  it('closes admission while outstanding reads retain their own reservations', () => {
    const budget = new VisualInputBudget(100, 100)
    const read = budget.reserve(10)
    budget.encodeImage(Buffer.from('abc'))
    budget.close()
    budget.close()
    expect(budget.residentBytes).toBe(10)
    expect(() => budget.reserve(1)).toThrow('limit_exceeded')
    expect(() => budget.consumeRead(1)).toThrow('limit_exceeded')
    expect(() => budget.encodeImage(Buffer.from('abc'))).toThrow('limit_exceeded')
    read.release()
    expect(budget.residentBytes).toBe(0)
  })

  it('rejects invalid policy and persisted accounting values', () => {
    for (const value of [NaN, Infinity, -1, 0, 1.5]) {
      expect(() => new VisualInputBudget(value, 100)).toThrow('Invalid visual input limit')
    }
    expect(() => new VisualInputBudget(100, 100, 101)).toThrow(
      'Invalid visual input budget snapshot'
    )
    const budget = new VisualInputBudget()
    expect(() => budget.reserve(-1)).toThrow('Invalid visual input size')
    expect(() => budget.consumeRead(Infinity)).toThrow('Invalid visual input size')
  })

  it('counts pending cleanup reservations when the same turn resumes', () => {
    const budget = new VisualInputBudget(100, 100)
    const pending = budget.reserve(80)
    budget.consumeRead(20)
    budget.close()
    const resumed = budget.resume()
    expect(resumed.readBytes).toBe(20)
    expect(resumed.residentBytes).toBe(80)
    expect(() => resumed.reserve(21)).toThrow('limit_exceeded')
    const current = resumed.reserve(20)
    pending.release()
    expect(resumed.residentBytes).toBe(20)
    current.release()
    expect(resumed.residentBytes).toBe(0)
  })

  it('counts pre-existing image payloads without dropping or recounting them after resume', () => {
    const budget = new VisualInputBudget(100, 100)
    budget.observeExternalImage('x'.repeat(40))
    budget.observeExternalImage('x'.repeat(40))
    expect(budget.residentBytes).toBe(80)
    expect(() => budget.reserve(21)).toThrow('limit_exceeded')
    budget.close()
    const resumed = budget.resume()
    resumed.observeExternalImage('x'.repeat(40))
    expect(resumed.residentBytes).toBe(80)
    resumed.observeExternalImage('another image exceeds the balance')
    expect(() => resumed.reserve(1)).toThrow('limit_exceeded')
  })
})
