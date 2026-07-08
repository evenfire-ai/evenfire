import type { ReactNode } from 'react'
import type { ProfileRouteKey } from '@components/Sidebar/types'

export type ProfileShellProps = {
  currentRoute: ProfileRouteKey
  children: ReactNode
}
