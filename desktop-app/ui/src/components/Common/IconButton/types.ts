import type { ButtonHTMLAttributes } from 'react'
import type { ControlColor, ControlSize, ControlVariant } from '../Button/types'

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  color?: ControlColor
  label: string
  loading?: boolean
  size?: ControlSize
  /** Set false when a custom visible tooltip is rendered by the caller. */
  tooltip?: boolean
  variant?: ControlVariant
}
