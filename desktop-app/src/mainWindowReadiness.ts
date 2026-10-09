import type { WebContents } from 'electron'

export function wireMainWindowRendererReadiness(input: {
  webContents: Pick<WebContents, 'isDestroyed' | 'on' | 'reload'>
  isCurrentWindow: () => boolean
  markNotReady: () => void
  closeSandboxUi: () => Promise<void>
}): void {
  const { webContents, isCurrentWindow, markNotReady, closeSandboxUi } = input

  // The sandbox-ui embed is a native view painted over this renderer and owned
  // by renderer state. A replacement renderer starts with no owner for it, so
  // main drops the embed itself; the new renderer needs no notice.
  const discardSandboxUi = () => {
    void closeSandboxUi().catch(error => {
      console.error('[Desktop] Could not close the sandbox-ui embed of a replaced renderer:', error)
    })
  }

  // did-navigate only fires after a main-frame, cross-document navigation
  // commits. did-start-navigation also fires for attempts later cancelled by
  // will-navigate, which would leave readiness false with no replacement
  // renderer available to perform the ready handshake, and would close the
  // embed under a renderer that is still alive and still owns it.
  webContents.on('did-navigate', () => {
    if (!isCurrentWindow()) return
    markNotReady()
    discardSandboxUi()
  })

  webContents.on('render-process-gone', (_event, details) => {
    if (!isCurrentWindow()) return
    markNotReady()
    discardSandboxUi()
    if (details.reason !== 'clean-exit' && !webContents.isDestroyed()) {
      webContents.reload()
    }
  })
}
