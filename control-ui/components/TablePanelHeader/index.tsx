'use client'

import { Children, Fragment, isValidElement } from 'react'
import type { ReactNode } from 'react'
import { DataViewHeader } from '@clerum/frontend-components'
import { cn } from '@lib/cn'
import { ClampedDescription } from './ClampedDescription'
import type { TablePanelHeaderProps } from './types'

function flattenTitleNodes(title: ReactNode): ReactNode[] {
  return Children.toArray(title).flatMap(node =>
    isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment
      ? flattenTitleNodes(node.props.children)
      : node
  )
}

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
  const titleNodes = flattenTitleNodes(title)
  const [firstTitleNode, ...remainingTitleNodes] = titleNodes
  const titleIcon = isValidElement(firstTitleNode) ? firstTitleNode : undefined
  const titleText = titleIcon ? remainingTitleNodes : titleNodes

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
      description={subtitle ? <ClampedDescription>{subtitle}</ClampedDescription> : undefined}
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
