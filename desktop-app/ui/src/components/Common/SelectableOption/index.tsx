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
        // A toggle button must announce BOTH states: an explicit aria-pressed
        // override wins, otherwise reflect `selected` as a real boolean so an
        // unselected option is "false", never an absent attribute.
        aria-pressed={props['aria-pressed'] ?? selected}
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
