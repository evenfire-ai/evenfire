import { forwardRef } from 'react'
import { joinClasses } from '@lib/classNames'
import type { SelectableOptionProps } from './types'

export const SelectableOption = forwardRef<HTMLButtonElement, SelectableOptionProps>(
  function SelectableOption(
    { className, selected = false, size = 'md', type = 'button', ...props },
    ref
  ) {
    return (
      <button
        {...props}
        aria-pressed={selected || props['aria-pressed']}
        className={joinClasses(
          'ui-selectable-option',
          `ui-selectable-option--${size}`,
          selected && 'is-selected',
          className
        )}
        ref={ref}
        type={type}
      />
    )
  }
)

export type { SelectableOptionProps } from './types'
