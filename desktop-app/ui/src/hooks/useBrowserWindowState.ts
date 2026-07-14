import { useEffect, useState } from 'react'

/**
 * Tracks whether the Electron window is actually on-screen (not hidden or
 * minimized), driven by main-process events (D.5b §3.4). Used by the T4 nudge to
 * honestly tell the user whether they can close the window vs. rely on an OS
 * notification — `document.visibilityState` can't detect minimize on macOS.
 */
export function useBrowserWindowState(): { isWindowVisible: boolean } {
  const [visible, setVisible] = useState(true) // optimistic until the first IPC reply

  useEffect(() => {
    let cancelled = false
    void window.clerum.window
      .getVisibility()
      .then(state => {
        if (!cancelled) setVisible(state.visible)
      })
      .catch(() => undefined)
    const unsub = window.clerum.window.onVisibilityChange(state => setVisible(state.visible))
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  return { isWindowVisible: visible }
}
