import { createContext } from 'react'
import type { DesktopStateContextValue, DesktopStateProviderProps } from './types'

export const DesktopStateContext = createContext<DesktopStateContextValue | null>(null)

export function DesktopStateProvider({ value, children }: DesktopStateProviderProps) {
  return <DesktopStateContext.Provider value={value}>{children}</DesktopStateContext.Provider>
}
