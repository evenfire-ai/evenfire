import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { ControlColor } from '../Button/types'

export type MenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean
  color?: Extract<ControlColor, 'neutral' | 'primary' | 'danger'>
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
}
