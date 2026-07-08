import type { ReactNode } from 'react'

export interface DesktopStateContextValue {
  desktopStatus: 'inactive' | 'starting' | 'running' | 'error'
  desktopError: string | null
  desktopAvailable: boolean
  handleOpenDesktop: () => Promise<void>
}

export interface DesktopStateProviderProps {
  value: DesktopStateContextValue
  children: ReactNode
}
