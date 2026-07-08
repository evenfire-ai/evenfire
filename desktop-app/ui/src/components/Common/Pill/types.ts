import type { HTMLAttributes, ReactNode } from 'react'
import type { PrimitiveTone } from '../Badge/types'
import type { ControlSize } from '../Button/types'

export type PillProps = HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode
  interactive?: boolean
  size?: Extract<ControlSize, 'xs' | 'sm' | 'md'>
  tone?: PrimitiveTone | 'danger' | 'warning' | 'info'
}
