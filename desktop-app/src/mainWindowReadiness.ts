import type { WebContents } from 'electron'

export function wireMainWindowRendererReadiness(input: {
  webContents: Pick<WebContents, 'isDestroyed' | 'on' | 'reload'>
  isCurrentWindow: () => boolean
  markNotReady: () => void
  // The service itself rather than a closure, so the release reason chosen here
  // cannot be dropped on the way.
  sandboxUi: { closeSandboxUi(options: { reason: 'renderer_replaced' }): Promise<void> }
}): void {
  const { webContents, isCurrentWindow, markNotReady, sandboxUi } = input

  // The sandbox-ui embed is a native view painted over this renderer and owned
  // by renderer state. A replacement renderer starts with no owner for it, so
  // main drops the embed itself. Its release is still sent to this window's
  // webContents, which may by then belong to the replacement renderer: that
  // renderer did not open the launch and ignores it.
  const discardSandboxUi = () => {
    void sandboxUi.closeSandboxUi({ reason: 'renderer_replaced' }).catch(error => {
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
