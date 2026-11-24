import type { ReactNode } from 'react'

export interface GfsNameDialogProps {
  title: string
  description: ReactNode
  /** Accessible name of the form. */
  formLabel: string
  fieldLabel: string
  submitLabel: string
  placeholder?: string
  /** Starting draft; Save stays disabled until the trimmed draft differs from it. */
  initialValue?: string
  /** The owner's in-flight state: blocks dismissal and edits while true. */
  busy: boolean
  error?: string | null
  onSubmit: (value: string) => void
  onCancel: () => void
}
