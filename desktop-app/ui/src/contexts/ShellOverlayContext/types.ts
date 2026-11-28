import type { ReactNode } from 'react'

export interface ShellOverlayContextValue {
  /**
   * Declares that `source` shows a DOM overlay, or no longer does. The shell
   * counts open sources among the flags that hide the native embedded-app view.
   */
  setShellOverlay: (source: string, open: boolean) => void
}

export interface ShellOverlayProviderProps {
  value: ShellOverlayContextValue
  children: ReactNode
}
