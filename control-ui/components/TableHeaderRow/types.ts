import type { ReactNode } from 'react'

export type TableHeaderColumn = {
  align?: 'left' | 'right' | 'center'
  ariaLabel?: string
  key: string
  label?: ReactNode
  minWidth?: string
  title?: string
  width?: string
}
