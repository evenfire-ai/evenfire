import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
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

const nullableInteger = fc.oneof(fc.integer(), fc.constant(null), fc.constant(undefined))

function multiset(values: Array<number | null | undefined>) {
  const counts = new Map<string, number>()
  for (const value of values) {
    const key = value === null ? 'null' : value === undefined ? 'undefined' : `number:${value}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
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

  it('keeps arbitrary nullish values last while preserving and idempotently sorting the multiset', () => {
    fc.assert(
      fc.property(fc.array(nullableInteger, { maxLength: 100 }), values => {
        for (const direction of ['asc', 'desc'] as const) {
          const sorted = sortNumbersNullLast(values, direction)
          const firstNullish = sorted.findIndex(value => value == null)

          expect(firstNullish < 0 || sorted.slice(firstNullish).every(value => value == null)).toBe(
            true
          )
          expect(multiset(sorted)).toEqual(multiset(values))
          expect(sortNumbersNullLast(sorted, direction)).toEqual(sorted)
          expect(sortNumbersNullLast(values, direction)).toEqual(sorted)
        }
      })
    )
  })

  it('has a permutation-stable non-null projection for arbitrary arrays', () => {
    fc.assert(
      fc.property(
        fc
          .array(nullableInteger, { maxLength: 50 })
          .chain(values =>
            fc
              .shuffledSubarray(values, { minLength: values.length, maxLength: values.length })
              .map(shuffled => ({ values, shuffled }))
          ),
        ({ values, shuffled }) => {
          for (const direction of ['asc', 'desc'] as const) {
            const project = (input: Array<number | null | undefined>) =>
              sortNumbersNullLast(input, direction).filter(
                (value): value is number => value != null
              )
            expect(project(shuffled)).toEqual(project(values))
          }
        }
      )
    )
  })

  it('obeys the null-delegation and antisymmetry contract for arbitrary pairs', () => {
    fc.assert(
      fc.property(nullableInteger, nullableInteger, (left, right) => {
        const comparison = compareNullsLast(left, right)
        const reverse = compareNullsLast(right, left)
        if (left == null && right == null) {
          expect(comparison).toBe(0)
        } else if (left != null && right != null) {
          expect(comparison).toBeNull()
          expect(reverse).toBeNull()
        } else {
          expect(comparison).toBe(-reverse!)
        }
      })
    )
  })
})
