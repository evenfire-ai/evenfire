import { createContext, useContext } from 'react'
import type { GfsActionHostContextValue } from './types'

export const GfsActionHostContext = createContext<GfsActionHostContextValue | null>(null)

/** The host's actions, or null outside a host (a surface rendered on its own). */
export function useGfsActionHost(): GfsActionHostContextValue | null {
  return useContext(GfsActionHostContext)
}
