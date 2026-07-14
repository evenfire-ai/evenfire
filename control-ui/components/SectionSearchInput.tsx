'use client'

import React from 'react'

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
    <input
      className="cu-input cu-input--compact cu-section-search"
      type="search"
      value={value}
      onChange={event => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
    />
  )
}
