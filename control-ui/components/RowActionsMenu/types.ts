export type RowAction = {
  key: string
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}

export type RowActionsMenuProps = {
  ariaLabel: string
  actions: RowAction[]
  horizontalTrigger?: boolean
}
