import { useState } from 'react'
import type { GfsActionOverlay } from './types'

/**
 * Whether the sidebar's resource actions cover the window, so the native app
 * view must hide. The menu and the host report separately: choosing an action
 * closes the menu and opens the action in the same batch, so the union never
 * drops to false between them.
 */
export function useGfsActionOverlay(): GfsActionOverlay {
  const [menuOpen, setMenuOpen] = useState(false)
  const [actionOpen, setActionOpen] = useState(false)
  return {
    overlayOpen: menuOpen || actionOpen,
    onGfsMenuOpenChange: setMenuOpen,
    onActionOpenChange: setActionOpen,
  }
}
