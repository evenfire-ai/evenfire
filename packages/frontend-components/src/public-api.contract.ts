import {
  ConfirmationDialog,
  DataTable,
  DataViewHeader,
  DialogShell,
  GroupedTableBody,
  MultiSelectActionDialog,
  RecordList,
  RecordListRow,
  RowActionMenu,
  SecretEditField,
  SimpleEditDialog,
  SingleValueEditDialog,
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
  ConfirmationDialogProps,
  DataViewHeaderProps,
  DialogShellProps,
  GroupedTableBodyProps,
  GroupedTableSummaryCell,
  MultiSelectActionDialogProps,
  RowAction,
  SecretEditFieldProps,
  SimpleEditDialogProps,
  SingleValueEditDialogProps,
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
  ConfirmationDialog,
  DialogShell,
  MultiSelectActionDialog,
  SecretEditField,
  SimpleEditDialog,
  SingleValueEditDialog,
}

export type PublicTypeApi = {
  cellKind: CellKind
  dataViewHeader: DataViewHeaderProps
  groupedTableBody: GroupedTableBodyProps
  groupedTableSummaryCell: GroupedTableSummaryCell
  rowAction: RowAction
  sortDirection: SortDirection
  sortValue: SortValue
  tableHeaderCell: TableHeaderCellProps
  tableStateRow: TableStateRowProps
  tableVariant: TableVariant
  confirmationDialog: ConfirmationDialogProps
  dialogShell: DialogShellProps
  multiSelectActionDialog: MultiSelectActionDialogProps
  secretEditField: SecretEditFieldProps
  simpleEditDialog: SimpleEditDialogProps
  singleValueEditDialog: SingleValueEditDialogProps<string>
}
