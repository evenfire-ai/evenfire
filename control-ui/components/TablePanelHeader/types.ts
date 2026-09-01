import type { ReactNode } from 'react'

export type TablePanelHeaderProps = {
  actionsClassName?: string
  primaryAction?: ReactNode
  refreshAction?: ReactNode
  search?: ReactNode
  secondaryActions?: ReactNode
  subtitle?: ReactNode
  title: ReactNode
  titleActions?: ReactNode
}
