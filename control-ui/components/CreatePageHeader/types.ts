import type { ReactNode } from 'react'

export type CreatePageHeaderProps = {
  actions?: ReactNode
  backDisabled?: boolean
  backLabel?: string
  eyebrow?: ReactNode
  icon: ReactNode
  onBack?: () => void
  subtitle?: ReactNode
  // ReactNode (not just string) so detail pages can render a loading
  // skeleton in the title slot while their header data loads.
  title: ReactNode
  titleActions?: ReactNode
}
