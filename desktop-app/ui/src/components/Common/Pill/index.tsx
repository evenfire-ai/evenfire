import type { KeyboardEvent } from 'react'
import { joinClasses } from '@lib/classNames'
import type { PillProps } from './types'

export function Pill({
  children,
  className,
  interactive = false,
  size = 'sm',
  tone = 'neutral',
  ...props
}: PillProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    props.onKeyDown?.(event)
    if (!interactive || event.defaultPrevented) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.currentTarget.click()
    }
  }

  return (
    <span
      {...props}
      className={joinClasses(
        'ui-pill',
        `ui-pill--${tone}`,
        `ui-pill--${size}`,
        interactive && 'ui-pill--interactive',
        className
      )}
      onKeyDown={handleKeyDown}
      role={interactive ? (props.role ?? 'button') : props.role}
      tabIndex={interactive ? (props.tabIndex ?? 0) : props.tabIndex}
    >
      {children}
    </span>
  )
}

export type { PillProps } from './types'
