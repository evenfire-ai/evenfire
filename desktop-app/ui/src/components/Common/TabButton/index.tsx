import { forwardRef } from 'react'
import { joinClasses } from '@lib/classNames'
import type { TabButtonProps } from './types'

export const TabButton = forwardRef<HTMLButtonElement, TabButtonProps>(function TabButton(
  { active = false, className, size = 'md', type = 'button', ...props },
  ref
) {
  return (
    <button
      {...props}
      aria-selected={active || props['aria-selected']}
      className={joinClasses(
        'ui-tab-button',
        `ui-tab-button--${size}`,
        active && 'active',
        className
      )}
      ref={ref}
      type={type}
    />
  )
})

export type { TabButtonProps } from './types'
