import { useEffect } from 'react'
import { focusManager } from '@tanstack/react-query'

/**
 * Bridge OS-window focus into TanStack Query's focusManager.
 *
 * query-core's focusManager listens only for `visibilitychange`. Browsers
 * fire that when the tab is hidden, but an Electron renderer stays
 * `visibilityState: 'visible'` while its window merely loses or gains OS
 * focus — so switching between the desktop app and another window (control-ui,
 * a browser) never notified the manager, and `refetchOnWindowFocus` policies
 * never ran. The renderer DOES receive DOM `focus`/`blur` on window
 * activation; forwarding them keeps every focus-aware query (GFS listings,
 * accessible resources) revalidating exactly when the user looks at the app
 * again after changing something elsewhere.
 */
export function useWindowFocusBridge(): void {
  useEffect(() => {
    const onFocus = (): void => focusManager.setFocused(true)
    const onBlur = (): void => focusManager.setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
}
