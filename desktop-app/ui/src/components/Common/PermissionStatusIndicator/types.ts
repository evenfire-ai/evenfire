import type { ReactNode } from 'react'

export type PermissionStatusIndicatorProps = {
  label: string
  active: boolean
  className?: string
  children?: ReactNode
  announce?: boolean
}
