import { createContext } from 'react'
import type { ShellOverlayContextValue, ShellOverlayProviderProps } from './types'

// A tree without the app shell (component tests) has nothing to hide. The app
// mounts its provider beside the NavigationContext every chat surface requires.
export const ShellOverlayContext = createContext<ShellOverlayContextValue>({
  setShellOverlay: () => undefined,
})

export function ShellOverlayProvider({ value, children }: ShellOverlayProviderProps) {
  return <ShellOverlayContext.Provider value={value}>{children}</ShellOverlayContext.Provider>
}
