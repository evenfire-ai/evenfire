import {
  DataTable,
  DataViewHeader,
  GroupedTableBody,
  RecordList,
  RecordListRow,
  RowActionMenu,
  TableCell,
  TableHeaderCell,
  TableRow,
  TableSearch,
  TableStateRow,
  TableViewport,
  TruncatedText,
  compareSortValues,
  stableSortRows,
  useTableSort,
} from './index'
import type {
  CellKind,
  DataViewHeaderProps,
  GroupedTableBodyProps,
  RowAction,
  SortDirection,
  SortValue,
  TableHeaderCellProps,
  TableStateRowProps,
  TableVariant,
} from './index'

export const publicRuntimeApi = {
  DataTable,
  DataViewHeader,
  GroupedTableBody,
  RecordList,
  RecordListRow,
  RowActionMenu,
  TableCell,
  TableHeaderCell,
  TableRow,
  TableSearch,
  TableStateRow,
  TableViewport,
  TruncatedText,
  compareSortValues,
  stableSortRows,
  useTableSort,
}

export type PublicTypeApi = {
  cellKind: CellKind
  dataViewHeader: DataViewHeaderProps
  groupedTableBody: GroupedTableBodyProps
  rowAction: RowAction
  sortDirection: SortDirection
  sortValue: SortValue
  tableHeaderCell: TableHeaderCellProps
  tableStateRow: TableStateRowProps
  tableVariant: TableVariant
}
