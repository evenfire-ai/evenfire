'use client'

import { IconX } from '@components/icons'
import type { ModalCloseButtonProps } from './types'

export function ModalCloseButton({ onClose, disabled = false }: ModalCloseButtonProps) {
  return (
    <button
      type="button"
      className="cu-btn cu-btn--icon cu-btn--ghost"
      onClick={onClose}
      disabled={disabled}
      aria-label="Close"
      title="Close"
    >
      <IconX />
    </button>
  )
}
