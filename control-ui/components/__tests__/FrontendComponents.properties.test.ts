import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type SortDirection,
  type SortValue,
  compareSortValues,
  stableSortRows,
} from '@clerum/frontend-components'

const sortValue = fc.oneof(
  fc.string(),
  fc.double({ noDefaultInfinity: true, noNaN: true }),
  fc.boolean(),
  fc.date({ noInvalidDate: true }),
  fc.constant(null),
  fc.constant(undefined)
)

const rows = fc.uniqueArray(
  fc.record({
    id: fc.uuid(),
    value: sortValue,
  }),
  { maxLength: 60, selector: row => row.id }
)

function rowOrder(
  left: { id: string; value: SortValue },
  right: { id: string; value: SortValue },
  direction: SortDirection
): number {
  const primary =
    left.value == null || right.value == null
      ? compareSortValues(left.value, right.value)
      : compareSortValues(left.value, right.value) * (direction === 'asc' ? 1 : -1)
  return primary || compareSortValues(left.id, right.id)
}

describe('stableSortRows properties', () => {
  it('forms a deterministic total order without losing or duplicating rows', () => {
    fc.assert(
      fc.property(rows, fc.constantFrom<SortDirection>('asc', 'desc'), (input, direction) => {
        const first = stableSortRows(
          input,
          row => row.value,
          direction,
          row => row.id
        )
        const second = stableSortRows(
          input,
          row => row.value,
          direction,
          row => row.id
        )

        expect(first.map(row => row.id).sort()).toEqual(input.map(row => row.id).sort())
        expect(new Set(first.map(row => row.id)).size).toBe(input.length)
        expect(second.map(row => row.id)).toEqual(first.map(row => row.id))
        for (let index = 1; index < first.length; index += 1) {
          expect(rowOrder(first[index - 1], first[index], direction)).toBeLessThanOrEqual(0)
        }
      }),
      { numRuns: 250 }
    )
  })

  it('uses identity ordering for nullish primary ties regardless of input order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            id: fc.uuid(),
            value: fc.constantFrom<null | undefined>(null, undefined),
          }),
          { maxLength: 60, selector: row => row.id }
        ),
        fc.constantFrom<SortDirection>('asc', 'desc'),
        (input, direction) => {
          const sortedIds = stableSortRows(
            input,
            row => row.value,
            direction,
            row => row.id
          ).map(row => row.id)
          const reversedSortedIds = stableSortRows(
            [...input].reverse(),
            row => row.value,
            direction,
            row => row.id
          ).map(row => row.id)

          expect(sortedIds).toEqual(
            [...input].map(row => row.id).sort((left, right) => compareSortValues(left, right))
          )
          expect(reversedSortedIds).toEqual(sortedIds)
        }
      ),
      { numRuns: 250 }
    )
  })

  it('is idempotent and preserves input order for exact ties', () => {
    fc.assert(
      fc.property(rows, fc.constantFrom<SortDirection>('asc', 'desc'), (input, direction) => {
        const once = stableSortRows(
          input,
          row => row.value,
          direction,
          row => row.id
        )
        const twice = stableSortRows(
          once,
          row => row.value,
          direction,
          row => row.id
        )
        expect(twice.map(row => row.id)).toEqual(once.map(row => row.id))
      }),
      { numRuns: 250 }
    )

    fc.assert(
      fc.property(sortValue, fc.array(fc.uuid(), { maxLength: 60 }), (value, ids) => {
        const tiedRows = ids.map((id, index) => ({ id, index, value }))
        const sorted = stableSortRows(
          tiedRows,
          row => row.value,
          'asc',
          () => 'same-identity'
        )
        expect(sorted.map(row => row.index)).toEqual(tiedRows.map(row => row.index))
      }),
      { numRuns: 250 }
    )
  })
})
