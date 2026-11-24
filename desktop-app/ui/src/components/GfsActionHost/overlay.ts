import { useState } from 'react'
import type { GfsActionOverlay } from './types'

/**
 * Whether the sidebar's resource actions cover the window, so the native app
 * view must hide. The menu and the host report separately: choosing an action
 * closes the menu and opens the action in the same batch, so the union never
 * drops to false between them.
 *
 * `reportersMounted` is false while the menu and the host are not mounted
 * (signed out). The host reports only when its action changes, not when it
 * unmounts, so without this reset a session that ends with an action open would
 * keep the native view hidden after the next sign-in.
 */
export function useGfsActionOverlay(reportersMounted: boolean): GfsActionOverlay {
  const [menuOpen, setMenuOpen] = useState(false)
  const [actionOpen, setActionOpen] = useState(false)
  if (!reportersMounted && (menuOpen || actionOpen)) {
    setMenuOpen(false)
    setActionOpen(false)
  }
  return {
    overlayOpen: menuOpen || actionOpen,
    onGfsMenuOpenChange: setMenuOpen,
    onActionOpenChange: setActionOpen,
  }
}
