'use client'

import { DataViewHeader } from '@clerum/frontend-components'
import { cn } from '@lib/cn'
import { ClampedDescription } from './ClampedDescription'
import { hasInteractiveDescendant, splitTitleContent } from './contentSemantics'
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
  const { icon: titleIcon, text: titleText } = splitTitleContent(title)

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
      description={
        subtitle ? (
          hasInteractiveDescendant(subtitle) ? (
            subtitle
          ) : (
            <ClampedDescription>{subtitle}</ClampedDescription>
          )
        ) : undefined
      }
      title={
        <span className="cu-panel-title cu-table-panel__title-row">
          {titleIcon ? <span className="cu-table-panel__title-icon">{titleIcon}</span> : null}
          <span className="cu-table-panel__title-text">{titleText}</span>
          {titleActions}
        </span>
      }
    />
  )
}
