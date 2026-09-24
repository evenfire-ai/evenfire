import type { ReactNode } from 'react'

/**
 * One entry inside the kebab menu. This is the menu's own item shape, distinct
 * from `RowActions`' `RowAction` descriptor: the menu renders text entries and
 * knows nothing about kind ordering or inline affordances.
 */
export type RowActionMenuItem = {
  key: string
  label: string
  onClick: () => void
  disabled?: boolean
  disabledReason?: ReactNode
  danger?: boolean
}

export type RowActionsMenuProps = {
  ariaLabel: string
  actions: RowActionMenuItem[]
  horizontalTrigger?: boolean
}
