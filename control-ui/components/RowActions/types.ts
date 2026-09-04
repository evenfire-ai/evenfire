import type { ReactNode } from 'react'

/**
 * Row actions are ordered by kind, never by array position, so every route
 * table presents the same vocabulary in the same place:
 *
 * - `utility`     non-mutating helpers (copy, download)
 * - `edit`        opens an editor for the row
 * - `destructive` removes the row
 * - `inspect`     opens the row's detail view; always the right-edge chevron
 */
export type RowActionKind = 'utility' | 'edit' | 'destructive' | 'inspect'

export type RowAction = {
  key: string
  kind: RowActionKind
  /** Required. Becomes the button's `aria-label`, and its text once overflowed. */
  label: string
  /** Omit for `inspect`: the chevron is supplied so every table opens details alike. */
  icon?: ReactNode
  onSelect: () => void
  disabled?: boolean
  /** Lets a row drop an affordance it cannot support in its current state. */
  hidden?: boolean
}

export type RowActionsProps = {
  actions: RowAction[]
  /** Beyond this many buttons, non-destructive/non-inspect actions collapse into a kebab. */
  overflowAfter?: number
  className?: string
}
