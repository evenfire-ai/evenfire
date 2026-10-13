import type { ReactNode } from 'react'

export type LlmSecretSelectProvider = {
  id: string
  label: string
}

export type LlmSecretSelectOption = {
  group?: string
  value: string
  label: string
  meta?: ReactNode
  providers?: LlmSecretSelectProvider[]
}

export type LlmSecretSelectProps = {
  ariaLabel?: string
  className?: string
  disabled?: boolean
  id?: string
  /** Only used by the interactive variant; ignored when `readOnly` is set. */
  onChange?: (value: string) => void
  options: LlmSecretSelectOption[]
  placeholder: string
  /**
   * Static presentation for read-only surfaces: renders the selected option
   * (label + provider icons or meta) as a plain value display — no button,
   * chevron, hover, or menu. Interactive behavior is unchanged when unset.
   */
  readOnly?: boolean
  value: string
}
