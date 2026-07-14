import { describe, expect, it } from 'vitest'
import { ComputedValueError, evaluateComputedValues } from './computedValuesEvaluator.js'

describe('evaluateComputedValues', () => {
  it('multiplies an input by a literal', () => {
    const result = evaluateComputedValues(
      [{ name: 'doubled', expression: 'inputs.memoryRequest * 2' }],
      { memoryRequest: 256 }
    )
    expect(result.doubled).toBe(512)
  })

  it('adds a literal to an input', () => {
    const result = evaluateComputedValues([{ name: 'total', expression: 'inputs.replicas + 1' }], {
      replicas: 3,
    })
    expect(result.total).toBe(4)
  })

  it('divides an input by a literal', () => {
    const result = evaluateComputedValues(
      [{ name: 'half', expression: 'inputs.memoryRequest / 2' }],
      { memoryRequest: 256 }
    )
    expect(result.half).toBe(128)
  })

  it('adds two input references', () => {
    const result = evaluateComputedValues([{ name: 'sum', expression: 'inputs.a + inputs.b' }], {
      a: 10,
      b: 20,
    })
    expect(result.sum).toBe(30)
  })

  it('handles parenthesized grouping', () => {
    const result = evaluateComputedValues([{ name: 'grouped', expression: '(inputs.x + 1) * 2' }], {
      x: 5,
    })
    expect(result.grouped).toBe(12)
  })

  it('concatenates strings with +', () => {
    const result = evaluateComputedValues(
      [{ name: 'label', expression: "inputs.name + '-suffix'" }],
      { name: 'redis' }
    )
    expect(result.label).toBe('redis-suffix')
  })

  it('evaluates ternary with true condition', () => {
    const result = evaluateComputedValues(
      [{ name: 'tier', expression: "inputs.x > 5 ? 'high' : 'low'" }],
      { x: 10 }
    )
    expect(result.tier).toBe('high')
  })

  it('evaluates ternary with false condition', () => {
    const result = evaluateComputedValues(
      [{ name: 'tier', expression: "inputs.x > 5 ? 'high' : 'low'" }],
      { x: 3 }
    )
    expect(result.tier).toBe('low')
  })

  it('throws ComputedValueError on division by zero', () => {
    expect(() =>
      evaluateComputedValues([{ name: 'bad', expression: 'inputs.x / 0' }], { x: 10 })
    ).toThrow(ComputedValueError)
    expect(() =>
      evaluateComputedValues([{ name: 'bad', expression: 'inputs.x / 0' }], { x: 10 })
    ).toThrow(/Division by zero/)
  })

  it('throws ComputedValueError on unresolved reference', () => {
    expect(() =>
      evaluateComputedValues([{ name: 'bad', expression: 'inputs.missing + 1' }], { x: 10 })
    ).toThrow(ComputedValueError)
    expect(() =>
      evaluateComputedValues([{ name: 'bad', expression: 'inputs.missing + 1' }], { x: 10 })
    ).toThrow(/Unresolved reference/)
  })

  it('allows computed values to reference earlier computed results', () => {
    const result = evaluateComputedValues(
      [
        { name: 'base', expression: 'inputs.x * 2' },
        { name: 'final', expression: 'inputs.base + 10' },
      ],
      { x: 5 }
    )
    expect(result.base).toBe(10)
    expect(result.final).toBe(20)
  })

  it('supports subtraction', () => {
    const result = evaluateComputedValues([{ name: 'diff', expression: 'inputs.a - inputs.b' }], {
      a: 30,
      b: 12,
    })
    expect(result.diff).toBe(18)
  })

  it('supports comparison operators ==, !=, <, <=, >=', () => {
    const eq = evaluateComputedValues([{ name: 'r', expression: "inputs.a == 5 ? 'yes' : 'no'" }], {
      a: 5,
    })
    expect(eq.r).toBe('yes')

    const neq = evaluateComputedValues(
      [{ name: 'r', expression: "inputs.a != 5 ? 'yes' : 'no'" }],
      { a: 3 }
    )
    expect(neq.r).toBe('yes')

    const lte = evaluateComputedValues(
      [{ name: 'r', expression: "inputs.a <= 5 ? 'yes' : 'no'" }],
      { a: 5 }
    )
    expect(lte.r).toBe('yes')

    const gte = evaluateComputedValues(
      [{ name: 'r', expression: "inputs.a >= 10 ? 'yes' : 'no'" }],
      { a: 10 }
    )
    expect(gte.r).toBe('yes')

    const lt = evaluateComputedValues([{ name: 'r', expression: "inputs.a < 5 ? 'yes' : 'no'" }], {
      a: 3,
    })
    expect(lt.r).toBe('yes')
  })

  it('supports unary negation', () => {
    const result = evaluateComputedValues([{ name: 'neg', expression: '-inputs.x' }], { x: 42 })
    expect(result.neg).toBe(-42)
  })

  it('supports double-quoted strings', () => {
    const result = evaluateComputedValues(
      [{ name: 'label', expression: 'inputs.name + "-prod"' }],
      { name: 'api' }
    )
    expect(result.label).toBe('api-prod')
  })

  it('throws ComputedValueError on syntax error', () => {
    expect(() =>
      evaluateComputedValues([{ name: 'bad', expression: 'inputs.x +' }], { x: 1 })
    ).toThrow(ComputedValueError)
  })

  it('returns empty object for empty computed array', () => {
    const result = evaluateComputedValues([], { x: 1 })
    expect(result).toEqual({})
  })
})
