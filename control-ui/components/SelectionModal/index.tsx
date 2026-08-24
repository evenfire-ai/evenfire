'use client'

import React from 'react'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconX } from '@components/icons'
import type { SelectionModalProps } from './types'

/**
 * "Pick some things from a list, then confirm" overlay — the Add member / Add
 * team / Add hook flow on the agent detail tabs. Extracted from HostAccessTab
 * so every one of those surfaces is literally the same control rather than a
 * near-copy that drifts.
 */
export function SelectionModal({
  busy,
  emptyLabel,
  id,
  label,
  onChange,
  onClose,
  onConfirm,
  options,
  placeholder,
  searchPlaceholder,
  selectionLabel,
  submitLabel,
  title,
  titleId,
  value,
}: SelectionModalProps) {
  return (
    <div
      className="cu-modal-overlay"
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        className="cu-modal-panel cu-modal-panel--selection"
        role="dialog"
        aria-labelledby={titleId}
        onClick={e => e.stopPropagation()}
      >
        <div className="cu-modal-panel__head">
          <strong id={titleId} style={{ fontSize: '1rem', lineHeight: 1.35 }}>
            {title}
          </strong>
          <button
            type="button"
            className="cu-btn cu-btn--icon cu-btn--ghost"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <IconX width={18} height={18} />
          </button>
        </div>

        <div className="cu-field">
          <label htmlFor={id}>{label}</label>
          <SelectionDropdown
            emptyLabel={emptyLabel}
            id={id}
            inline
            disabled={busy}
            onChange={onChange}
            options={options}
            placeholder={placeholder}
            searchPlaceholder={searchPlaceholder}
            selectionLabel={selectionLabel}
            value={value}
          />
        </div>

        <div className="cu-modal-panel__foot">
          <button
            type="button"
            className="cu-btn cu-btn--ghost cu-btn--sm"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cu-btn cu-btn--primary"
            onClick={() => void onConfirm()}
            disabled={busy || value.length === 0}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
