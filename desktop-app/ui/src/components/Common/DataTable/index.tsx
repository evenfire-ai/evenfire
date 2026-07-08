import { joinClasses } from '@lib/classNames'
import type { DataTableFilterProps, DataTableProps } from './types'

export function DataTable({
  children,
  className,
  compact = false,
  fullBleed = false,
  frameless = false,
  scrollClassName,
  ...props
}: DataTableProps) {
  return (
    <div
      className={joinClasses(
        'da-table__scroll',
        frameless && 'da-table__scroll--frameless',
        fullBleed && 'da-table__scroll--full-bleed',
        scrollClassName
      )}
    >
      <table
        className={joinClasses('da-table', compact && 'da-table--compact', className)}
        {...props}
      >
        {children}
      </table>
    </div>
  )
}

export function DataTableFilter<TValue extends string = string>({
  active = false,
  ariaLabel,
  className,
  label,
  onChange,
  options,
  value,
  variant = 'select',
}: DataTableFilterProps<TValue>) {
  if (variant === 'icon') {
    return (
      <span
        className={joinClasses(
          'da-table-filter',
          'da-table-filter--icon',
          active && 'da-table-filter--active',
          className
        )}
      >
        <span className="da-table-filter__label">{label}</span>
        <span className="da-table-filter__icon-control">
          <select
            aria-label={ariaLabel}
            className="da-table-filter__icon-select"
            value={value}
            onChange={event => onChange(event.target.value as TValue)}
          >
            {options.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="da-table-filter__icon" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <path d="M2.75 3.75h10.5L9.25 8.1v3.55l-2.5 1V8.1L2.75 3.75Z" />
            </svg>
          </span>
        </span>
      </span>
    )
  }

  return (
    <span className={joinClasses('da-table-filter', className)}>
      <span className="da-table-filter__label">{label}</span>
      <select
        aria-label={ariaLabel}
        className="da-table-filter__select"
        value={value}
        onChange={event => onChange(event.target.value as TValue)}
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  )
}

export type { DataTableFilterOption, DataTableFilterProps, DataTableProps } from './types'
