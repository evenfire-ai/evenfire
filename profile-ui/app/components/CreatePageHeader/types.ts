import type { ReactNode } from 'react'

export type CreatePageHeaderProps = {
  actions?: ReactNode
  backDisabled?: boolean
  backLabel: string
  icon: ReactNode
  onBack: () => void
  subtitle: ReactNode
  title: string
  titleActions?: ReactNode
}
