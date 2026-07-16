import type { ReactNode } from 'react'

export type SegmentedControlOption<T extends string> = {
  disabled?: boolean
  label: ReactNode
  value: T
}

export type SegmentedControlOptions<T extends string> = readonly [
  SegmentedControlOption<T>,
  SegmentedControlOption<T>,
  ...SegmentedControlOption<T>[],
]

export type SegmentedControlProps<T extends string> = {
  ariaLabel: string
  className?: string
  disabled?: boolean
  onChange: (value: T) => void
  options: SegmentedControlOptions<T>
  value: T
}
