import type { ReactNode } from 'react'

export type TabBarOption<T extends string> = {
  disabled?: boolean
  href?: string
  label: ReactNode
  value: T
}

export type TabBarProps<T extends string> = {
  activeValue: T
  ariaLabel: string
  className?: string
  onChange?: (value: T) => void
  options: TabBarOption<T>[]
}
