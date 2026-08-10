import { describe, expect, it } from 'vitest'
import { compareNullsLast } from '../tableSort'

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest])
  )
}

function sortNumbersNullLast(values: Array<number | null | undefined>, direction: 'asc' | 'desc') {
  const multiplier = direction === 'asc' ? 1 : -1
  return [...values].sort((left, right) => {
    const nullOrder = compareNullsLast(left, right)
    return nullOrder ?? ((left as number) - (right as number)) * multiplier
  })
}

describe('compareNullsLast invariants', () => {
  const values = [7, null, 2, undefined, 5]

  it('keeps nullish values last in both directions without losing values', () => {
    expect(sortNumbersNullLast(values, 'asc')).toEqual([2, 5, 7, null, undefined])
    expect(sortNumbersNullLast(values, 'desc')).toEqual([7, 5, 2, null, undefined])
  })

  it('produces the same ordered non-null projection for every input permutation', () => {
    for (const order of permutations([7, null, 2, 5])) {
      expect(sortNumbersNullLast(order, 'asc')).toEqual([2, 5, 7, null])
      expect(sortNumbersNullLast(order, 'desc')).toEqual([7, 5, 2, null])
    }
  })

  it('is antisymmetric for null ordering and neutral for two nullish values', () => {
    expect(compareNullsLast(null, 1)).toBe(-compareNullsLast(1, null)!)
    expect(compareNullsLast(null, undefined)).toBe(0)
    expect(compareNullsLast(1, 2)).toBeNull()
  })
})
