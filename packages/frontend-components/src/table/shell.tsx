'use client'

import type { HTMLAttributes, InputHTMLAttributes } from 'react'
import { classNames } from './utils'
import type { DataViewHeaderProps } from './types'

export function DataViewHeader({
  actions,
  className,
  description,
  icon,
  tabs,
  title,
}: DataViewHeaderProps) {
  return (
    <header className={classNames('eft-data-view-header', className)}>
      <div className="eft-data-view-header__main">
        <div className="eft-data-view-header__identity">
          {icon ? <span className="eft-data-view-header__icon">{icon}</span> : null}
          <div>
            <h2 className="eft-data-view-header__title">{title}</h2>
            {description ? (
              <p className="eft-data-view-header__description">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="eft-data-view-header__actions">{actions}</div> : null}
      </div>
      {tabs ? <div className="eft-data-view-header__tabs">{tabs}</div> : null}
    </header>
  )
}

export function TableSearch({
  'aria-label': ariaLabel = 'Search',
  className,
  onChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type'> & {
  onChange: (value: string) => void
}) {
  return (
    <input
      {...props}
      aria-label={ariaLabel}
      className={classNames('eft-search', className)}
      onChange={event => onChange(event.currentTarget.value)}
      type="search"
    />
  )
}

export function TableViewport({
  children,
  className,
  embedded = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { embedded?: boolean }) {
  return (
    <div
      {...props}
      className={classNames(
        'eft-table-viewport',
        embedded && 'eft-table-viewport--embedded',
        className
      )}
    >
      {children}
    </div>
  )
}

export function RecordList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={classNames('eft-record-list', className)} role="list" />
}

export function RecordListRow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={classNames('eft-record-list__row', className)} role="listitem" />
  )
}
