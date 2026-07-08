import type { ButtonHTMLAttributes } from 'react'
import type { ControlSize } from '../Button/types'

export type TabButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean
  size?: Exclude<ControlSize, 'xs' | 'xl'>
}
