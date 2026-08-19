import { useEffect, useState } from 'react'

type BrowserWindowState = { visible: boolean; focused: boolean }

/**
 * Tracks native Electron window state (visibility and application focus),
 * driven by main-process events (D.5b §3.4). The focus bit deliberately comes
 * from Electron: a native WebContentsView can own Chromium document focus
 * while the Evenfire application remains focused.
 */
export function useBrowserWindowState(): {
  isWindowVisible: boolean
  isAppFocused: boolean
} {
  const [visible, setVisible] = useState(true) // optimistic until the first IPC reply
  const [focused, setFocused] = useState(true)

  useEffect(() => {
    let cancelled = false
    const bridge = window.clerum?.window
    if (!bridge) return undefined
    void bridge
      .getVisibility()
      .then(state => {
        if (!cancelled) {
          setVisible(state.visible)
          setFocused(state.focused ?? true)
        }
      })
      .catch(() => undefined)
    const unsub = bridge.onVisibilityChange((state: BrowserWindowState) => {
      setVisible(state.visible)
      setFocused(state.focused ?? true)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  return { isWindowVisible: visible, isAppFocused: focused }
}
