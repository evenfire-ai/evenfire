'use client'

import { TableSearch } from '@clerum/frontend-components'

export function SectionSearchInput({
  disabled = false,
  value,
  onChange,
  placeholder = 'Search',
  ariaLabel = 'Search',
}: {
  disabled?: boolean
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
}) {
  return (
    <TableSearch
      className="cu-input cu-input--compact cu-section-search"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
    />
  )
}
