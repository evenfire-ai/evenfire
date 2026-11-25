'use client'

import React from 'react'
import { ConfirmationDialog } from '@clerum/frontend-components'
import { IconAlertTriangle } from '@components/icons'
import {
  LOOSENING_CANCEL_LABEL,
  LOOSENING_CONFIRM_LABEL,
  LOOSENING_DIALOG_DESCRIPTION,
  LOOSENING_DIALOG_TITLE,
  looseningItemLabel,
  looseningItemText,
} from './constants'
import type { LooseningDialogProps } from './types'

/**
 * Spec §6.6: lists every loosening item of a save; the save is not sent until
 * the admin confirms. The save protocol computes the items again at the write
 * and asks again when a new one appears (spec §6.4 step 6).
 */
export function LooseningDialog({ open, items, draft, onCancel, onConfirm }: LooseningDialogProps) {
  return (
    <ConfirmationDialog
      open={open}
      tone="warning"
      icon={<IconAlertTriangle />}
      title={LOOSENING_DIALOG_TITLE}
      description={LOOSENING_DIALOG_DESCRIPTION}
      confirmLabel={LOOSENING_CONFIRM_LABEL}
      cancelLabel={LOOSENING_CANCEL_LABEL}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <ul className="cu-host-approval-dialog__items">
        {items.map(item => {
          const label = looseningItemLabel(item)
          return (
            <li
              className="cu-host-approval-dialog__item"
              data-loosening-item={label}
              key={`${item.path} ${item.rule}`}
            >
              <span className="cu-host-approval-dialog__item-name">{label}</span>
              <span data-loosening-text="">{looseningItemText(item, draft)}</span>
            </li>
          )
        })}
      </ul>
    </ConfirmationDialog>
  )
}
