import type { Dispatch, SetStateAction } from 'react'
import type { SortDirection, TableSortHeaderProps } from './tableSort.types'

export type { SortDirection } from './tableSort.types'

export function compareNullsLast(
  left: number | null | undefined,
  right: number | null | undefined
): number | null {
  if (left == null && right == null) return 0
  if (left == null) return 1
  if (right == null) return -1
  return null
}

export function toggleSort<TKey extends string>(
  key: TKey,
  currentKey: TKey | null,
  defaultDirections: Record<TKey, SortDirection>,
  setKey: Dispatch<SetStateAction<TKey | null>>,
  setDirection: Dispatch<SetStateAction<SortDirection>>
) {
  if (currentKey === key) {
    setDirection(current => (current === 'asc' ? 'desc' : 'asc'))
    return
  }
  setKey(key)
  setDirection(defaultDirections[key])
}

export function TableSortHeader<TKey extends string>({
  activeKey,
  defaultDirections,
  direction,
  label,
  onSort,
  sortKey,
}: TableSortHeaderProps<TKey>) {
  const isActive = activeKey === sortKey
  const indicator = isActive ? (direction === 'asc' ? '↑' : '↓') : ''
  const nextDirection = isActive
    ? direction === 'asc'
      ? 'descending'
      : 'ascending'
    : defaultDirections[sortKey] === 'asc'
      ? 'ascending'
      : 'descending'

  return (
    <button
      type="button"
      className={`cu-link cu-link--sm cu-table__sort-link${isActive ? ' is-active' : ''}`}
      onClick={() => onSort(sortKey)}
      aria-label={`Sort by ${label.toLowerCase()} ${nextDirection}`}
      aria-pressed={isActive}
    >
      {label}
      {indicator ? ` ${indicator}` : ''}
    </button>
  )
}
