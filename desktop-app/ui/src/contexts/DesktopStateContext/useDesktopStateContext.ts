import { useContext } from 'react'
import { DesktopStateContext } from './context'
import type { DesktopStateContextValue } from './types'

export function useDesktopStateContext(): DesktopStateContextValue {
  const ctx = useContext(DesktopStateContext)
  if (!ctx) throw new Error('useDesktopStateContext must be used within DesktopStateProvider')
  return ctx
}
