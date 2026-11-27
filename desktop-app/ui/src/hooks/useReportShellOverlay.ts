import { useEffect } from 'react'
import { useShellOverlayContext } from '@contexts/ShellOverlayContext'

/**
 * Tells the app shell that this component shows a DOM overlay while `open`.
 *
 * The embedded app is a native view that always paints above renderer DOM. An
 * overlay opened from the chat drawer — a delete confirmation, a dialog — is
 * therefore invisible until the shell hides that view, which it does while any
 * source reports an overlay.
 */
export function useReportShellOverlay(source: string, open: boolean) {
  const { setShellOverlay } = useShellOverlayContext()
  useEffect(() => {
    if (!open) return
    setShellOverlay(source, true)
    return () => setShellOverlay(source, false)
  }, [open, setShellOverlay, source])
}
