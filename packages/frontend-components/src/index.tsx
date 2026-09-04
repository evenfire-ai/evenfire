'use client'

import {
  type CSSProperties,
  Children,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

export type SortDirection = 'asc' | 'desc'
export type SortValue = string | number | boolean | Date | null | undefined
export type TableVariant = 'standard' | 'selection' | 'hierarchy' | 'embedded'
export type CellKind = 'text' | 'numeric' | 'fixed' | 'selection' | 'actions'

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

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
      return cloneElement(child, {
        style: tableHeaderStyle(child.props.style, enabled),
      })
    }

    if (child.props.children === undefined) return child
    return cloneElement(
      child as ReactElement<HeaderPaintElementProps>,
      undefined,
      withHeaderCellSeam(child.props.children, enabled)
    )
  })
}

export type DataViewHeaderProps = {
  actions?: ReactNode
  className?: string
  description?: ReactNode
  icon?: ReactNode
  tabs?: ReactNode
  title: ReactNode
}

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
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type'> & {
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

export type TableHeaderCellProps = Omit<ThHTMLAttributes<HTMLTableCellElement>, 'children'> & {
  activeDirection?: SortDirection | null
  defaultDirection?: SortDirection
  kind?: CellKind
  label: ReactNode
  onSort?: () => void
  sortLabel?: ReactNode
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

export type TableStateRowProps = {
  action?: ReactNode
  colSpan: number
  kind?: 'loading' | 'empty' | 'error'
  message?: ReactNode
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

export function TruncatedText({
  className,
  maxLength = 80,
  value,
}: {
  className?: string
  maxLength?: number
  value: string | null | undefined
}) {
  const text = String(value || '').trim()
  const display = text || '-'
  const isTruncated = text.length > maxLength
  const visible = isTruncated ? `${text.slice(0, maxLength).trimEnd()}...` : display
  const tooltipId = useId()

  return (
    <span
      aria-describedby={isTruncated ? tooltipId : undefined}
      className={classNames('eft-truncated-text', className)}
      tabIndex={isTruncated ? 0 : undefined}
    >
      <span className="eft-truncated-text__value">{visible}</span>
      {isTruncated ? (
        <span className="eft-truncated-text__tooltip" id={tooltipId} role="tooltip">
          {text}
        </span>
      ) : null}
    </span>
  )
}

export type RowAction = {
  key: string
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

function enabledItems(menu: HTMLDivElement | null) {
  return menu
    ? Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    : []
}

export function RowActionMenu({
  actions,
  ariaLabel,
  className,
  menuClassName,
}: {
  actions: RowAction[]
  ariaLabel: string
  className?: string
  menuClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const initialFocusRef = useRef<'first' | 'last'>('first')
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const triggerDisabled = actions.every(action => action.disabled)

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (triggerDisabled && open) close()
  }, [close, open, triggerDisabled])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close()
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close(true)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [close, open])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const trigger = triggerRef.current
      const menu = menuRef.current
      if (!trigger || !menu) return
      const anchor = trigger.getBoundingClientRect()
      const bounds = menu.getBoundingClientRect()
      const inset = 8
      const left = Math.max(
        inset,
        Math.min(anchor.right - bounds.width, innerWidth - bounds.width - inset)
      )
      const above =
        anchor.bottom + bounds.height + inset > innerHeight && anchor.top > bounds.height
      setPosition({ left, top: above ? anchor.top - bounds.height - inset : anchor.bottom + inset })
    }
    place()
    const items = enabledItems(menuRef.current)
    ;(initialFocusRef.current === 'last' ? items.at(-1) : items[0])?.focus()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  if (actions.length === 0) return null
  return (
    <span className={classNames('eft-row-actions', className)}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={ariaLabel}
        className="eft-row-actions__trigger"
        disabled={triggerDisabled}
        onClick={event => {
          event.stopPropagation()
          initialFocusRef.current = 'first'
          setOpen(value => !value)
        }}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          initialFocusRef.current = event.key === 'ArrowUp' ? 'last' : 'first'
          setOpen(true)
        }}
        ref={triggerRef}
        type="button"
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open
        ? createPortal(
            <div
              className={classNames('eft-row-actions__menu', menuClassName)}
              onClick={event => event.stopPropagation()}
              onKeyDown={event => {
                const items = enabledItems(menuRef.current)
                const current = items.indexOf(document.activeElement as HTMLButtonElement)
                if (event.key === 'Escape') {
                  event.preventDefault()
                  close(true)
                  return
                }
                const next =
                  event.key === 'ArrowDown'
                    ? (current + 1) % items.length
                    : event.key === 'ArrowUp'
                      ? (current - 1 + items.length) % items.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? items.length - 1
                          : null
                if (next == null || items.length === 0) return
                event.preventDefault()
                items[next]?.focus()
              }}
              ref={menuRef}
              role="menu"
              style={position ? position : { left: 0, top: 0, visibility: 'hidden' }}
            >
              {actions.map(action => (
                <button
                  className={classNames(
                    'eft-row-actions__item',
                    action.danger && 'eft-row-actions__item--danger'
                  )}
                  disabled={action.disabled}
                  key={action.key}
                  onClick={() => {
                    close(true)
                    action.onSelect()
                  }}
                  role="menuitem"
                  type="button"
                >
                  {action.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </span>
  )
}

export function compareSortValues(left: SortValue, right: SortValue): number {
  if (left == null) return right == null ? 0 : 1
  if (right == null) return -1
  const a = left instanceof Date ? left.getTime() : typeof left === 'boolean' ? Number(left) : left
  const b =
    right instanceof Date ? right.getTime() : typeof right === 'boolean' ? Number(right) : right
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

export function stableSortRows<TRow>(
  rows: readonly TRow[],
  value: (row: TRow) => SortValue,
  direction: SortDirection,
  identity: (row: TRow) => SortValue
): TRow[] {
  const multiplier = direction === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ index, row }))
    .sort((left, right) => {
      const leftValue = value(left.row)
      const rightValue = value(right.row)
      if (leftValue == null) return rightValue == null ? 0 : 1
      if (rightValue == null) return -1
      const primary = compareSortValues(leftValue, rightValue) * multiplier
      if (primary !== 0) return primary
      const secondary = compareSortValues(identity(left.row), identity(right.row))
      return secondary || left.index - right.index
    })
    .map(entry => entry.row)
}

export function useTableSort<TRow, TKey extends string>({
  accessors,
  defaultDirection = 'asc',
  defaultDirections,
  defaultKey,
  identity,
  rows,
}: {
  accessors: Record<TKey, (row: TRow) => SortValue>
  defaultDirection?: SortDirection
  defaultDirections?: Partial<Record<TKey, SortDirection>>
  defaultKey: TKey
  identity: (row: TRow) => SortValue
  rows: readonly TRow[]
}) {
  const [key, setKey] = useState<TKey>(defaultKey)
  const [direction, setDirection] = useState<SortDirection>(
    defaultDirections?.[defaultKey] ?? defaultDirection
  )
  const sortedRows = useMemo(
    () => stableSortRows(rows, accessors[key], direction, identity),
    [accessors, direction, identity, key, rows]
  )
  const sortBy = (nextKey: TKey) => {
    if (nextKey === key) setDirection(current => (current === 'asc' ? 'desc' : 'asc'))
    else {
      setKey(nextKey)
      setDirection(defaultDirections?.[nextKey] ?? 'asc')
    }
  }
  return { direction, key, setDirection, setKey, sortBy, sortedRows }
}
