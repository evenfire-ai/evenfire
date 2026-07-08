import { joinClasses } from '@lib/classNames'
import type { BadgeProps } from './types'

export function Badge({ children, className, tone = 'neutral', variant, label }: BadgeProps) {
  return (
    <span
      className={joinClasses('badge', `tone-${tone}`, variant && `badge--${variant}`, className)}
      {...(label ? { role: 'status', 'aria-label': label } : {})}
    >
      {children}
    </span>
  )
}

export type { BadgeProps, BadgeStateVariant, PrimitiveTone } from './types'
