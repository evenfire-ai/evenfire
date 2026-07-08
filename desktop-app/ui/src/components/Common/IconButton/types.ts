import type { ButtonHTMLAttributes } from 'react'
import type { ControlColor, ControlSize, ControlVariant } from '../Button/types'

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  color?: ControlColor
  label: string
  loading?: boolean
  size?: ControlSize
  variant?: ControlVariant
}
