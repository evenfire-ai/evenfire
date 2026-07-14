import type { ButtonHTMLAttributes } from 'react'

export type ControlColor =
  | 'primary'
  | 'secondary'
  | 'neutral'
  | 'transparent'
  | 'danger'
  | 'success'
  | 'warning'
export type ControlVariant = 'solid' | 'soft' | 'outline' | 'ghost' | 'text'
export type ControlSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'
export type ButtonAlign = 'start' | 'center' | 'between'
export type ButtonVariant = ControlVariant
export type ButtonSize = ControlSize

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  align?: ButtonAlign
  block?: boolean
  color?: ControlColor
  loading?: boolean
  size?: ButtonSize
  variant?: ButtonVariant
}
