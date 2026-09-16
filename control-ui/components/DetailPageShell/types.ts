import type { ReactNode } from 'react'
import type { TabBarOption } from '@components/TabBar/types'

export type DetailPageShellProps<T extends string> = {
  actions?: ReactNode
  activeTab: T
  backDisabled?: boolean
  backLabel: string
  children: ReactNode
  className?: string
  contentClassName?: string
  contentMode?: 'card' | 'plain'
  error?: string
  eyebrow?: ReactNode
  icon: ReactNode
  notice?: ReactNode
  onBack: () => void
  overlays?: ReactNode
  onTabChange: (value: T) => void
  subtitle: ReactNode
  tabAriaLabel: string
  tabClassName?: string
  tabs?: TabBarOption<T>[]
  // ReactNode (not just string) so detail pages can render a loading
  // skeleton in the title slot while their header data loads.
  title: ReactNode
  titleActions?: ReactNode
}
