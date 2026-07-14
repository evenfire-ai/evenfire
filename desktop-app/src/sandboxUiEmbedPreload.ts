import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload script attached to every sandbox-ui `WebContentsView`. Exposes
 * a small surface to recipe JS:
 *
 *   `clerum.requestSessionRefresh()` — recover from a stale session
 *      cookie when an SSE/fetch hits 401 between scheduled refreshes.
 *      The trusted main-process timer runs at ~270 s after each mint, so
 *      most apps will never need this.
 *
 *   `clerum.onOauthCompleted(callback)` — subscribe to the OAuth
 *      completion envelope. Fired after the user clicks an
 *      `<a href="clerum://oauth?clientId=…">Connect</a>` button, the
 *      provider redirects to control-api, the grant is stored, and the
 *      success page bounces to `clerum://oauth-completed`. The recipe
 *      uses this to flip its UI to the authenticated state.
 *
 * Both IPC handlers in main are sender-pinned by `webContents.id` and
 * rate-limited; the preload is exposed to *untrusted* recipe JS, so the
 * abuse surface is bounded by the main-side gating, not by anything on
 * this side of the contextBridge.
 */
type SandboxUiOauthCompletedPayload = {
  oauthClientId: string
  provider: string
}

contextBridge.exposeInMainWorld(
  'clerum',
  Object.freeze({
    requestSessionRefresh: (): Promise<void> =>
      ipcRenderer.invoke('clerum:sandbox-ui:request-refresh'),
    onOauthCompleted: (
      callback: (payload: SandboxUiOauthCompletedPayload) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: SandboxUiOauthCompletedPayload
      ): void => {
        callback(payload)
      }
      ipcRenderer.on('clerum:sandbox-ui:oauth-completed', listener)
      return () => {
        ipcRenderer.off('clerum:sandbox-ui:oauth-completed', listener)
      }
    },
  })
)
