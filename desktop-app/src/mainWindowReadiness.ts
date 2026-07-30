import type { WebContents } from 'electron'

export function wireMainWindowRendererReadiness(input: {
  webContents: Pick<WebContents, 'isDestroyed' | 'on' | 'reload'>
  isCurrentWindow: () => boolean
  markNotReady: () => void
}): void {
  const { webContents, isCurrentWindow, markNotReady } = input

  // did-navigate only fires after a main-frame, cross-document navigation
  // commits. did-start-navigation also fires for attempts later cancelled by
  // will-navigate, which would leave readiness false with no replacement
  // renderer available to perform the ready handshake.
  webContents.on('did-navigate', () => {
    if (isCurrentWindow()) markNotReady()
  })

  webContents.on('render-process-gone', (_event, details) => {
    if (!isCurrentWindow()) return
    markNotReady()
    if (details.reason !== 'clean-exit' && !webContents.isDestroyed()) {
      webContents.reload()
    }
  })
}
