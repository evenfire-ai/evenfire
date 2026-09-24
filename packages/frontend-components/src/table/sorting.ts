'use client'

import { useMemo, useState } from 'react'
import type { SortDirection, SortValue } from './types'

export function compareSortValues(left: SortValue, right: SortValue): number {
  if (left == null) return right == null ? 0 : 1
  if (right == null) return -1
  const a = left instanceof Date ? left.getTime() : typeof left === 'boolean' ? Number(left) : left
  const b =
    right instanceof Date ? right.getTime() : typeof right === 'boolean' ? Number(right) : right
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

export function stableSortRows<TRow>(
  rows: readonly TRow[],
  value: (row: TRow) => SortValue,
  direction: SortDirection,
  identity: (row: TRow) => SortValue
): TRow[] {
  const multiplier = direction === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ index, row }))
    .sort((left, right) => {
      const leftValue = value(left.row)
      const rightValue = value(right.row)
      const primary =
        leftValue == null || rightValue == null
          ? compareSortValues(leftValue, rightValue)
          : compareSortValues(leftValue, rightValue) * multiplier
      if (primary !== 0) return primary
      const secondary = compareSortValues(identity(left.row), identity(right.row))
      return secondary || left.index - right.index
    })
    .map(entry => entry.row)
}

export function useTableSort<TRow, TKey extends string>({
  accessors,
  defaultDirection = 'asc',
  defaultDirections,
  defaultKey,
  identity,
  rows,
}: {
  accessors: Record<TKey, (row: TRow) => SortValue>
  defaultDirection?: SortDirection
  defaultDirections?: Partial<Record<TKey, SortDirection>>
  defaultKey: TKey
  identity: (row: TRow) => SortValue
  rows: readonly TRow[]
}) {
  const [key, setKey] = useState<TKey>(defaultKey)
  const [direction, setDirection] = useState<SortDirection>(
    defaultDirections?.[defaultKey] ?? defaultDirection
  )
  const sortedRows = useMemo(
    () => stableSortRows(rows, accessors[key], direction, identity),
    [accessors, direction, identity, key, rows]
  )
  const sortBy = (nextKey: TKey) => {
    if (nextKey === key) setDirection(current => (current === 'asc' ? 'desc' : 'asc'))
    else {
      setKey(nextKey)
      setDirection(defaultDirections?.[nextKey] ?? 'asc')
    }
  }
  return { direction, key, setDirection, setKey, sortBy, sortedRows }
}
