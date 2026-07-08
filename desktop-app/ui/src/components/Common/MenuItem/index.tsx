import { forwardRef } from 'react'
import { joinClasses } from '@lib/classNames'
import type { MenuItemProps } from './types'

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  {
    active = false,
    children,
    className,
    color = 'neutral',
    leadingIcon,
    trailingIcon,
    type = 'button',
    ...props
  },
  ref
) {
  return (
    <button
      {...props}
      className={joinClasses(
        'ui-menu-item',
        `ui-menu-item--${color}`,
        active && 'active',
        className
      )}
      ref={ref}
      type={type}
    >
      {leadingIcon ? <span className="ui-menu-item__icon">{leadingIcon}</span> : null}
      <span className="ui-menu-item__label">{children}</span>
      {trailingIcon ? <span className="ui-menu-item__trailing">{trailingIcon}</span> : null}
    </button>
  )
})

export type { MenuItemProps } from './types'
