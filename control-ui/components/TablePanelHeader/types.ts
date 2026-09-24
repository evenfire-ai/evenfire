import type { DataViewHeaderProps } from '@clerum/frontend-components'

export type TablePanelHeaderProps = {
  actionsClassName?: string
  primaryAction?: DataViewHeaderProps['actions']
  refreshAction?: DataViewHeaderProps['actions']
  search?: DataViewHeaderProps['actions']
  secondaryActions?: DataViewHeaderProps['actions']
  subtitle?: DataViewHeaderProps['description']
  title: DataViewHeaderProps['title']
  titleActions?: DataViewHeaderProps['actions']
}
