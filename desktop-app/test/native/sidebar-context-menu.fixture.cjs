const assert = require('node:assert/strict')
const { app, BrowserWindow, WebContentsView } = require('electron')

const waitFor = async (read, description) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

app.whenReady().then(async () => {
  let window
  let view
  try {
    const rendererUrl = process.env.SIDEBAR_MENU_RENDERER_URL
    assert.ok(rendererUrl, 'the test runner must provide the Vite renderer URL')
    window = new BrowserWindow({ show: true, width: 900, height: 600, autoHideMenuBar: true })
    const [contentWidth, contentHeight] = window.getContentSize()
    view = new WebContentsView({
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    window.contentView.addChildView(view)
    view.setBounds({ x: 280, y: 0, width: contentWidth - 280, height: contentHeight })
    view.setVisible(true)
    await view.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>Native embedded app</title><body style="margin:0;background:#dce8f4"><main>Embedded native app</main></body>')}`
    )
    await window.loadURL(rendererUrl)
    await waitFor(
      () => window.webContents.executeJavaScript('window.__nativeSidebarReady === true'),
      'the real sidebar renderer'
    )
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          "Boolean(document.querySelector('.da-file-explorer__label'))"
        ),
      'the GFS row'
    )

    const nativeId = view.webContents.id
    const nativeBounds = view.getBounds()
    const nativeVisible = view.getVisible()
    const measure = () =>
      window.webContents.executeJavaScript(`(() => {
      const rect = selector => {
        const element = document.querySelector(selector)
        if (!element) return null
        const value = element.getBoundingClientRect()
        return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height }
      }
      const panel = document.querySelector('[role="menu"]')
      return { sidebar: rect('.left-nav'), slot: rect('.sandbox-ui-embed-slot'), panel: panel ? { ...rect('[role="menu"]'), identity: window.__panelIdentity === panel || window.__keyboardPanelIdentity === panel } : null }
    })()`)
    const assertNativeUnchanged = () => {
      assert.equal(
        view.webContents.id,
        nativeId,
        'menu operations preserve native WebContentsView identity'
      )
      assert.deepEqual(
        view.getBounds(),
        nativeBounds,
        'menu operations do not move or resize the native view'
      )
      assert.equal(
        view.getVisible(),
        nativeVisible,
        'menu operations preserve native view visibility'
      )
      assert.equal(nativeVisible, true, 'the embedded WebContentsView is visible during the test')
    }
    const openPointer = async () => {
      await window.webContents.executeJavaScript(`(() => {
        const row = document.querySelector('.da-file-explorer__row')
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 270, clientY: 140 }))
      })()`)
      await waitFor(
        () =>
          window.webContents.executeJavaScript("Boolean(document.querySelector('[role=menu]'))"),
        'pointer context menu'
      )
    }
    const snapshot = await measure()
    assert.ok(snapshot.sidebar && snapshot.slot, 'actual sidebar and native view slot are present')
    assert.deepEqual(
      snapshot.slot,
      {
        left: nativeBounds.x,
        top: nativeBounds.y,
        right: nativeBounds.x + nativeBounds.width,
        bottom: nativeBounds.y + nativeBounds.height,
        width: nativeBounds.width,
        height: nativeBounds.height,
      },
      'renderer slot and native view bounds align'
    )

    await openPointer()
    const main = await measure()
    assert.equal(main.panel.left, main.sidebar.left + 8, 'main menu anchors to the sidebar edge')
    assert.ok(
      main.panel.left >= main.sidebar.left && main.panel.right <= main.sidebar.right,
      'main menu is fully inside the sidebar'
    )
    assert.ok(
      main.panel.right <= nativeBounds.x,
      'main menu does not intersect the native app surface'
    )
    await window.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[role="menu"]')
      window.__panelIdentity = panel
      panel.querySelector('[data-gfs-action="share"]').click()
    })()`)
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          "document.querySelector('[role=menu]')?.getAttribute('aria-label') === 'Share options for native-menu-file.md'"
        ),
      'in-place Share view'
    )
    const share = await measure()
    assert.equal(share.panel.identity, true, 'Share reuses the exact same popup DOM panel')
    assert.deepEqual(
      { left: share.panel.left, top: share.panel.top, width: share.panel.width },
      { left: main.panel.left, top: main.panel.top, width: main.panel.width },
      'Share retains the same menu anchor and width'
    )
    assert.ok(
      share.panel.right <= nativeBounds.x,
      'Share panel remains outside the native app surface'
    )
    assertNativeUnchanged()

    await window.webContents.executeJavaScript(
      "document.querySelector('[data-gfs-action=share-back]').click()"
    )
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          "document.querySelector('[role=menu]')?.getAttribute('aria-label') === 'Actions for native-menu-file.md'"
        ),
      'Share Back'
    )
    await window.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
    )
    await waitFor(
      () => window.webContents.executeJavaScript("!document.querySelector('[role=menu]')"),
      'main menu dismissal'
    )

    await window.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('.da-file-explorer__label')
      row.focus()
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }))
    })()`)
    await waitFor(
      () => window.webContents.executeJavaScript("Boolean(document.querySelector('[role=menu]'))"),
      'keyboard context menu'
    )
    await window.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[role="menu"]')
      window.__keyboardPanelIdentity = panel
      panel.querySelector('[data-gfs-action="share"]').focus()
      panel.querySelector('[data-gfs-action="share"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })()`)
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          "document.querySelector('[role=menu]')?.getAttribute('aria-label') === 'Share options for native-menu-file.md'"
        ),
      'keyboard Share navigation'
    )
    const keyboardShare = await measure()
    assert.equal(keyboardShare.panel.identity, true, 'keyboard Share keeps the same panel')
    assert.ok(
      keyboardShare.panel.right <= nativeBounds.x,
      'keyboard Share stays outside the native app surface'
    )
    assertNativeUnchanged()
    await window.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
    )
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          "document.querySelector('[role=menu]')?.getAttribute('aria-label') === 'Actions for native-menu-file.md'"
        ),
      'Share Escape returns to main actions'
    )
    await window.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
    )
    await waitFor(
      () => window.webContents.executeJavaScript("!document.querySelector('[role=menu]')"),
      'keyboard main menu dismissal'
    )
    assertNativeUnchanged()

    console.log(
      JSON.stringify({
        acceptance: 'sidebar context menu with live native WebContentsView',
        sidebar: snapshot.sidebar,
        nativeView: { id: nativeId, bounds: nativeBounds, visible: nativeVisible },
        mainMenu: main.panel,
        shareMenu: share.panel,
        keyboardShare: keyboardShare.panel,
        result: 'PASS',
      })
    )
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    if (window && !window.isDestroyed()) window.close()
  }
})
