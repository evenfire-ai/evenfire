'use client'

import React from 'react'
import { cn } from '@lib/cn'
import type { TablePanelHeaderProps } from './types'

export function TablePanelHeader({
  actions,
  actionsClassName,
  subtitle,
  title,
  titleActions,
}: TablePanelHeaderProps) {
  return (
    <div className="cu-table-panel__head">
      <div className="cu-table-panel__heading">
        <div className="cu-table-panel__title-row">
          <span className="cu-panel-title">{title}</span>
          {titleActions}
        </div>
        {subtitle ? <p className="cu-table-panel__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? (
        <div className={cn('cu-table-panel__actions', actionsClassName)}>{actions}</div>
      ) : null}
    </div>
  )
}
