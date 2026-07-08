import type { ButtonHTMLAttributes } from 'react'
import type { ControlSize } from '../Button/types'

export type SelectableOptionProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  selected?: boolean
  size?: Extract<ControlSize, 'sm' | 'md' | 'lg'>
}
