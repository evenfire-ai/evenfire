import { forwardRef } from 'react'
import { joinClasses } from '@lib/classNames'
import type { IconButtonProps } from './types'

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    children,
    className,
    color = 'neutral',
    label,
    loading = false,
    size = 'md',
    type = 'button',
    variant = 'ghost',
    ...props
  },
  ref
) {
  return (
    <button
      {...props}
      aria-busy={loading || props['aria-busy']}
      aria-label={props['aria-label'] || label}
      className={joinClasses(
        'ui-icon-button',
        `ui-icon-button--${variant}`,
        `ui-icon-button--${color}`,
        `ui-icon-button--${size}`,
        loading && 'ui-icon-button--loading',
        className
      )}
      disabled={loading || props.disabled}
      ref={ref}
      title={props.title || label}
      type={type}
    >
      {children}
    </button>
  )
})

export type { IconButtonProps } from './types'
