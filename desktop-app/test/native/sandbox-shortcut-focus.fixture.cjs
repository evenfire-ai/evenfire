const assert = require('node:assert/strict')
const { app, BrowserWindow, WebContentsView } = require('electron')

async function waitFor(check, message) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: true,
    x: -10000,
    y: -10000,
    width: 600,
    height: 400,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  })
  let view = null
  try {
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`
        <input id="find" hidden aria-label="Find in current app" />
        <script>
          const { ipcRenderer } = require('electron')
          ipcRenderer.on('shortcuts:command', (_event, command) => {
            if (command.commandId !== 'search.current') return
            const input = document.getElementById('find')
            input.hidden = false
            input.focus()
          })
        </script>
      `)}`
    )

    view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    window.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 500, height: 300 })
    await view.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent('<input value="sandbox owns focus" />')}`
    )

    const { wireDesktopShortcutRouting } = await import('../../dist/shortcutRouter.js')
    const dispose = wireDesktopShortcutRouting({
      platform: 'darwin',
      source: 'sandbox',
      sourceWebContents: view.webContents,
      trustedRenderer: window.webContents,
    })

    view.webContents.focus()
    assert.equal(view.webContents.isFocused(), true, 'sandbox starts with native focus')
    view.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'F',
      modifiers: ['meta', 'shift'],
    })

    await waitFor(
      () => window.webContents.executeJavaScript("document.activeElement?.id === 'find'"),
      'trusted current-content input did not receive focus after one shortcut'
    )
    window.webContents.sendInputEvent({ type: 'char', keyCode: 'i' })
    await waitFor(
      () => window.webContents.executeJavaScript("document.getElementById('find').value === 'i'"),
      'trusted current-content input was not ready for immediate typing'
    )

    view.webContents.focus()
    assert.equal(view.webContents.isFocused(), true, 'close path restores native sandbox focus')
    dispose()
    window.contentView.removeChildView(view)
    view.webContents.close()
    view = null
    console.log('sandbox shortcut focus native fixture: PASS')
    app.exit(0)
  } catch (error) {
    console.error(error)
    if (view && !view.webContents.isDestroyed()) {
      window.contentView.removeChildView(view)
      view.webContents.close()
    }
    app.exit(1)
  }
})
