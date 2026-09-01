'use client'

import { DataViewHeader } from '@clerum/frontend-table-system'
import { cn } from '@lib/cn'
import type { TablePanelHeaderProps } from './types'

/** Control UI compatibility adapter for the shared list header. */
export function TablePanelHeader({
  actionsClassName,
  primaryAction,
  refreshAction,
  search,
  secondaryActions,
  subtitle,
  title,
  titleActions,
}: TablePanelHeaderProps) {
  return (
    <DataViewHeader
      actions={
        secondaryActions || search || refreshAction || primaryAction ? (
          <div className={cn('cu-table-panel__actions', actionsClassName)}>
            {secondaryActions}
            {search}
            {refreshAction}
            {primaryAction}
          </div>
        ) : undefined
      }
      className="cu-table-panel__head"
      description={subtitle}
      title={
        <span className="cu-panel-title cu-table-panel__title-row">
          {title}
          {titleActions}
        </span>
      }
    />
  )
}
