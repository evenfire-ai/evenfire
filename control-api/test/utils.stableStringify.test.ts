import { describe, expect, it } from 'vitest'
import { stableStringify } from '../src/utils/stableStringify.js'

describe('stableStringify', () => {
  it('produces identical output regardless of key insertion order', () => {
    const a = { b: 1, a: 2, c: { y: 9, x: 8 } }
    const b = { c: { x: 8, y: 9 }, a: 2, b: 1 }
    expect(stableStringify(a)).toBe(stableStringify(b))
  })

  it('differs when values differ', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }))
  })

  it('handles arrays without sorting element order', () => {
    // Array order is meaningful — it MUST be preserved.
    expect(stableStringify([1, 2, 3])).toBe('[1,2,3]')
    expect(stableStringify([3, 2, 1])).toBe('[3,2,1]')
  })

  it('serialises null, booleans, numbers, and strings JSON-compatibly', () => {
    expect(stableStringify(null)).toBe('null')
    expect(stableStringify(true)).toBe('true')
    expect(stableStringify(42)).toBe('42')
    expect(stableStringify('hi')).toBe('"hi"')
  })

  it('drops undefined object values like JSON.stringify does', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('replaces non-finite numbers with null', () => {
    expect(stableStringify(Number.NaN)).toBe('null')
    expect(stableStringify(Number.POSITIVE_INFINITY)).toBe('null')
  })
})
