'use client'

import React from 'react'
import Link from 'next/link'
import { cn } from '@lib/cn'
import type { TabBarProps } from './types'

export function TabBar<T extends string>({
  activeValue,
  ariaLabel,
  className,
  onChange,
  options,
}: TabBarProps<T>) {
  return (
    <nav className={cn('cu-tabs', className)} aria-label={ariaLabel} role="tablist">
      {options.map(option => {
        const isActive = activeValue === option.value
        if (option.href && !option.disabled) {
          return (
            <Link
              key={option.value}
              href={option.href}
              className="cu-tab"
              role="tab"
              data-active={isActive ? 'true' : 'false'}
              aria-selected={isActive}
              aria-current={isActive ? 'page' : undefined}
            >
              {option.label}
            </Link>
          )
        }
        return (
          <button
            key={option.value}
            type="button"
            className="cu-tab"
            role="tab"
            data-active={isActive ? 'true' : 'false'}
            aria-selected={isActive}
            disabled={option.disabled}
            onClick={() => onChange?.(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </nav>
  )
}
