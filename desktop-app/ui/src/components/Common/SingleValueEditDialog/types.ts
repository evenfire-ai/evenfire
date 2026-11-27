import type { ReactNode } from 'react'

export type SingleValueEditDialogProps = {
  /** Modal heading, rendered as the dialog's `h3`. */
  title: string
  /** Explanatory copy under the heading. */
  description?: ReactNode
  /** Visible field label; also the input's accessible name. */
  label: string
  /** The value as the record holds it. The draft starts from it. */
  initialValue: string
  submitLabel?: string
  cancelLabel?: string
  /** Returns why the trimmed draft cannot be saved, or `null` when it can. */
  validate?: (value: string) => string | null
  /** Receives the trimmed draft. A rejection stays in the dialog; a resolution closes it. */
  onSubmit: (value: string) => void | Promise<unknown>
  /** Called for every dismissal — cancel, Escape, backdrop — and after a saved submit. */
  onClose: () => void
}
