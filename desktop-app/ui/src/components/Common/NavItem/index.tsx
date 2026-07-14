import { forwardRef } from 'react'
import { joinClasses } from '@lib/classNames'
import type { NavItemProps } from './types'

export const NavItem = forwardRef<HTMLButtonElement, NavItemProps>(function NavItem(
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
      className={joinClasses('ui-nav-item', `ui-nav-item--${color}`, active && 'active', className)}
      ref={ref}
      type={type}
    >
      {leadingIcon ? <span className="ui-nav-item__icon">{leadingIcon}</span> : null}
      <span className="ui-nav-item__label">{children}</span>
      {trailingIcon ? <span className="ui-nav-item__trailing">{trailingIcon}</span> : null}
    </button>
  )
})

export type { NavItemProps } from './types'
