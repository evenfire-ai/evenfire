import { forwardRef } from 'react'
import { joinClasses } from '@lib/classNames'
import type { ButtonProps } from './types'

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    align = 'center',
    block = false,
    className,
    color = 'primary',
    loading = false,
    size = 'md',
    type = 'button',
    variant = 'solid',
    ...props
  },
  ref
) {
  return (
    <button
      {...props}
      aria-busy={loading || props['aria-busy']}
      className={joinClasses(
        'ui-button',
        `ui-button--${variant}`,
        `ui-button--${color}`,
        `ui-button--${size}`,
        `ui-button--align-${align}`,
        block && 'ui-button--block',
        loading && 'ui-button--loading',
        className
      )}
      disabled={loading || props.disabled}
      ref={ref}
      type={type}
    />
  )
})

export type {
  ButtonAlign,
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  ControlColor,
  ControlSize,
  ControlVariant,
} from './types'
