import type { ReactNode } from 'react'

export type CreatePageHeaderProps = {
  actions?: ReactNode
  backDisabled?: boolean
  backLabel: string
  eyebrow?: ReactNode
  icon: ReactNode
  onBack: () => void
  subtitle?: ReactNode
  title: string
  titleActions?: ReactNode
}
