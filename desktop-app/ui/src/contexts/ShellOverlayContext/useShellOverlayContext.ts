import { useContext } from 'react'
import { ShellOverlayContext } from './context'
import type { ShellOverlayContextValue } from './types'

export function useShellOverlayContext(): ShellOverlayContextValue {
  return useContext(ShellOverlayContext)
}
