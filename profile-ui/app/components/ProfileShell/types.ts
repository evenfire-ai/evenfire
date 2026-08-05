import type { ReactNode } from 'react'
import type { ProfileRouteKey } from '@lib/profileAppFrame'

export type ProfileShellProps = {
  currentRoute?: ProfileRouteKey
  children: ReactNode
}
