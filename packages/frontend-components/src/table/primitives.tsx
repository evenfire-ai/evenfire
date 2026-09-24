'use client'

import {
  type CSSProperties,
  Children,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { CellKind, TableHeaderCellProps, TableStateRowProps, TableVariant } from './types'
import { classNames } from './utils'

const tableHeaderSeamStyle: CSSProperties = {
  boxShadow: '0 -0.375rem 0 var(--eft-surface-muted), inset 0 -1px 0 var(--eft-border)',
}

const TableHeaderSeamContext = createContext(false)

type HeaderPaintElementProps = {
  children?: ReactNode
  style?: CSSProperties
}

function tableHeaderStyle(style: CSSProperties | undefined, enabled: boolean) {
  return enabled ? { ...tableHeaderSeamStyle, ...style } : style
}

function withTableHeaderSeam(children: ReactNode, enabled: boolean): ReactNode {
  if (!enabled) return children
  return Children.map(children, child => {
    if (!isValidElement<HeaderPaintElementProps>(child) || child.type !== 'thead') return child
    return cloneElement(child, undefined, withHeaderCellSeam(child.props.children, enabled))
  })
}

function withHeaderCellSeam(children: ReactNode, enabled: boolean): ReactNode {
  return Children.map(children, child => {
    if (!isValidElement<HeaderPaintElementProps>(child)) return child
    if (child.type === 'th') {
      return cloneElement(child, { style: tableHeaderStyle(child.props.style, enabled) })
    }
    if (child.props.children === undefined) return child
    return cloneElement(
      child as ReactElement<HeaderPaintElementProps>,
      undefined,
      withHeaderCellSeam(child.props.children, enabled)
    )
  })
}

export function DataTable({
  children,
  className,
  variant = 'standard',
  ...props
}: TableHTMLAttributes<HTMLTableElement> & { variant?: TableVariant }) {
  const tableRef = useRef<HTMLTableElement | null>(null)
  const [paintHeaderSeam, setPaintHeaderSeam] = useState(false)

  useLayoutEffect(() => {
    setPaintHeaderSeam(Boolean(tableRef.current?.closest('.eft-table-viewport')))
  }, [])

  return (
    <table
      {...props}
      className={classNames('eft-table', `eft-table--${variant}`, className)}
      ref={tableRef}
    >
      <TableHeaderSeamContext.Provider value={paintHeaderSeam}>
        {withTableHeaderSeam(children, paintHeaderSeam)}
      </TableHeaderSeamContext.Provider>
    </table>
  )
}

export function TableRow({
  className,
  onNavigate,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { onNavigate?: () => void }) {
  const activate = (event: KeyboardEvent<HTMLTableRowElement>) => {
    props.onKeyDown?.(event)
    if (
      event.defaultPrevented ||
      event.target !== event.currentTarget ||
      !onNavigate ||
      (event.key !== 'Enter' && event.key !== ' ')
    )
      return
    event.preventDefault()
    onNavigate()
  }
  return (
    <tr
      {...props}
      className={classNames(onNavigate && 'eft-table__row--navigable', className)}
      onClick={event => {
        props.onClick?.(event)
        if (event.defaultPrevented || !onNavigate) return
        const target = event.target as HTMLElement
        if (target.closest('a,button,input,select,textarea,[role="button"],[role="menuitem"]'))
          return
        onNavigate()
      }}
      onKeyDown={activate}
      tabIndex={onNavigate ? 0 : props.tabIndex}
    />
  )
}

export function TableCell({
  className,
  kind = 'text',
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { kind?: CellKind }) {
  return <td {...props} className={classNames(`eft-table__cell--${kind}`, className)} />
}

export function TableHeaderCell({
  activeDirection,
  className,
  defaultDirection = 'asc',
  kind = 'text',
  label,
  onSort,
  sortLabel,
  ...props
}: TableHeaderCellProps) {
  const paintHeaderSeam = useContext(TableHeaderSeamContext)
  const ariaSort = activeDirection
    ? activeDirection === 'asc'
      ? 'ascending'
      : 'descending'
    : onSort
      ? 'none'
      : undefined
  const nextDirection = activeDirection
    ? activeDirection === 'asc'
      ? 'descending'
      : 'ascending'
    : defaultDirection === 'asc'
      ? 'ascending'
      : 'descending'
  const accessibleSortLabel = String(sortLabel ?? label)
  return (
    <th
      {...props}
      aria-sort={ariaSort}
      className={classNames(`eft-table__header--${kind}`, className)}
      scope={props.scope ?? 'col'}
      style={tableHeaderStyle(props.style, paintHeaderSeam)}
    >
      {onSort && sortLabel ? (
        <span className="eft-table__sort-group">
          {label}
          <button
            aria-label={`Sort by ${accessibleSortLabel} ${nextDirection}`}
            className="eft-table__sort eft-table__sort--icon"
            onClick={onSort}
            type="button"
          >
            <span aria-hidden="true" className="eft-table__sort-indicator">
              {activeDirection === 'asc' ? '↑' : activeDirection === 'desc' ? '↓' : '↕'}
            </span>
          </button>
        </span>
      ) : onSort ? (
        <button
          aria-label={`Sort by ${accessibleSortLabel} ${nextDirection}`}
          className="eft-table__sort"
          onClick={onSort}
          type="button"
        >
          <span>{label}</span>
          <span aria-hidden="true" className="eft-table__sort-indicator">
            {activeDirection === 'asc' ? '↑' : activeDirection === 'desc' ? '↓' : '↕'}
          </span>
        </button>
      ) : (
        label
      )}
    </th>
  )
}

export function TableStateRow({
  action,
  colSpan,
  kind = 'empty',
  message = 'No data',
}: TableStateRowProps) {
  return (
    <tr>
      <td className={classNames('eft-table__state', `eft-table__state--${kind}`)} colSpan={colSpan}>
        <div
          aria-label={kind !== 'empty' && typeof message === 'string' ? message : undefined}
          role={kind === 'loading' ? 'status' : kind === 'error' ? 'alert' : undefined}
        >
          {message}
        </div>
        {action ? <span className="eft-table__state-action">{action}</span> : null}
      </td>
    </tr>
  )
}
