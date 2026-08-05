'use client'

import { cn } from '@lib/cn'
import type { SectionLoadingSkeletonProps } from './types'

export function SectionLoadingSkeleton({
  label,
  rows = 4,
  className,
}: SectionLoadingSkeletonProps) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className={cn('cu-section-loading-skeleton', className)}
      role="status"
    >
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <div className="cu-section-loading-skeleton__row" key={rowIdx}>
          <span
            aria-hidden="true"
            className="cu-skeleton cu-section-loading-skeleton__cell cu-section-loading-skeleton__cell--primary"
          />
          <span aria-hidden="true" className="cu-skeleton cu-section-loading-skeleton__cell" />
          <span
            aria-hidden="true"
            className="cu-skeleton cu-section-loading-skeleton__cell cu-section-loading-skeleton__cell--short"
          />
        </div>
      ))}
    </div>
  )
}
