import type { ReactNode } from 'react'

export type TablePanelHeaderProps = {
  actions?: ReactNode
  actionsClassName?: string
  refreshAction?: ReactNode
  search?: ReactNode
  subtitle?: ReactNode
  title: ReactNode
  titleActions?: ReactNode
}
