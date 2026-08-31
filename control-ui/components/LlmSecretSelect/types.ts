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
  onChange: (value: string) => void
  options: LlmSecretSelectOption[]
  placeholder: string
  value: string
}
