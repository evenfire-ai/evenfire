export type SortDirection = 'asc' | 'desc'

export type TableSortHeaderProps<TKey extends string> = {
  activeKey: TKey | null
  defaultDirections: Record<TKey, SortDirection>
  direction: SortDirection
  label: string
  onSort: (key: TKey) => void
  sortKey: TKey
}
