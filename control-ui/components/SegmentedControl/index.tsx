'use client'

import React from 'react'
import { cn } from '@lib/cn'
import type { SegmentedControlProps } from './types'

export function SegmentedControl<T extends string>({
  ariaLabel,
  className,
  disabled = false,
  onChange,
  options,
  value,
}: SegmentedControlProps<T>) {
  return (
    <div className={cn('cu-segmented-control', className)} role="radiogroup" aria-label={ariaLabel}>
      {options.map(option => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            className="cu-segmented-control__option"
            role="radio"
            aria-checked={selected}
            data-active={selected ? 'true' : 'false'}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
