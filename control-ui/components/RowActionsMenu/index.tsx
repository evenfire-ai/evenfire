'use client'

import { RowActionMenu } from '@clerum/frontend-components'
import type { RowActionsMenuProps } from './types'

export type { RowActionMenuItem } from './types'

/** Control UI compatibility adapter for the shared cross-application action menu. */
export function RowActionsMenu({ ariaLabel, actions }: RowActionsMenuProps) {
  return (
    <RowActionMenu
      actions={actions.map(action => ({
        key: action.key,
        label: action.label,
        onSelect: action.onClick,
        danger: action.danger,
        disabled: action.disabled,
      }))}
      ariaLabel={ariaLabel}
      menuClassName="cu-kebab__menu--portal"
    />
  )
}
