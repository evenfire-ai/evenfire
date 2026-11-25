'use client'

import React, { useId, useState } from 'react'
import { SimpleEditDialog } from '@clerum/frontend-components'
import { Field, SelectInput } from '@components/ui'
import {
  FIRST_SAVE_DIALOG_DESCRIPTION,
  FIRST_SAVE_DIALOG_TITLE,
  FIRST_SAVE_NOTES,
  FIRST_SAVE_POLICY_LABEL,
  FIRST_SAVE_POLICY_OPTIONS,
} from './constants'
import type { FirstSaveDialogProps, FirstSavePolicy } from './types'

function isFirstSavePolicy(value: string): value is FirstSavePolicy {
  return FIRST_SAVE_POLICY_OPTIONS.some(option => option.value === value)
}

/**
 * The first per-tool save on an agent with no approval settings of its own
 * (spec §6.6, decision 4): a required policy, with Save disabled until the
 * admin chooses one. Nothing is chosen for them. The section mounts it for
 * each first save, so no earlier choice carries over.
 */
export function FirstSaveDialog({ open, onCancel, onSave }: FirstSaveDialogProps) {
  const selectId = useId()
  const [policy, setPolicy] = useState<FirstSavePolicy | ''>('')

  return (
    <SimpleEditDialog
      open={open}
      title={FIRST_SAVE_DIALOG_TITLE}
      description={FIRST_SAVE_DIALOG_DESCRIPTION}
      isDirty={policy !== ''}
      isValid={policy !== ''}
      onCancel={onCancel}
      onSave={() => {
        if (policy !== '') onSave(policy)
      }}
    >
      {FIRST_SAVE_NOTES.map(note => (
        <p className="cu-host-approval-dialog__note" key={note}>
          {note}
        </p>
      ))}
      <Field htmlFor={selectId} label={FIRST_SAVE_POLICY_LABEL}>
        <SelectInput
          id={selectId}
          required
          value={policy}
          onChange={event => {
            const { value } = event.target
            setPolicy(isFirstSavePolicy(value) ? value : '')
          }}
        >
          <option value="" disabled>
            Choose a policy
          </option>
          {FIRST_SAVE_POLICY_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectInput>
      </Field>
    </SimpleEditDialog>
  )
}
