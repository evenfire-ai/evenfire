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
      const main = document.querySelector('[aria-label="Actions for native-menu-file.md"]')
      const share = document.querySelector('[aria-label="Share options for native-menu-file.md"]')
      return {
        sidebar: rect('.left-nav'),
        slot: rect('.sandbox-ui-embed-slot'),
        main: main ? { ...rect('[aria-label="Actions for native-menu-file.md"]'), identity: window.__mainPanelIdentity === main || window.__keyboardMainPanelIdentity === main } : null,
        share: share ? { ...rect('[aria-label="Share options for native-menu-file.md"]'), identity: window.__sharePanelIdentity === share } : null,
        separatePanels: Boolean(main && share && main !== share),
        visibleMenus: document.querySelectorAll('[role="menu"]').length
      }
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
    const sendKey = keyCode => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
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
    assert.equal(main.main.left, main.sidebar.left + 8, 'main menu anchors to the sidebar edge')
    assert.ok(
      main.main.left >= main.sidebar.left && main.main.right <= main.sidebar.right,
      'main menu is fully inside the sidebar'
    )
    assert.ok(
      main.main.right <= nativeBounds.x,
      'main menu does not intersect the native app surface'
    )
    await window.webContents.executeJavaScript(`(() => {
      window.__mainPanelIdentity = document.querySelector('[aria-label="Actions for native-menu-file.md"]')
      const share = document.querySelector('[data-gfs-action="share"]')
      const rect = share.getBoundingClientRect()
      window.__shareTriggerPoint = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)
    const triggerPoint = await window.webContents.executeJavaScript('window.__shareTriggerPoint')
    window.webContents.sendInputEvent({ type: 'mouseMove', x: triggerPoint.x, y: triggerPoint.y })
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          'Boolean(document.querySelector(\'[aria-label="Share options for native-menu-file.md"]\'))'
        ),
      'hovered Share flyout'
    )
    const share = await measure()
    assert.equal(share.visibleMenus, 2, 'Main and Share are simultaneously mounted')
    assert.equal(share.main.identity, true, 'Main retains its exact DOM panel')
    assert.equal(share.separatePanels, true, 'Share is a separate panel identity')
    assert.ok(share.share.left - share.main.left >= 44 && share.share.left - share.main.left <= 56)
    assert.ok(share.share.left < share.main.right, 'Share overlaps the Main panel')
    assert.ok(share.share.left > share.main.left, 'the leading Main icon strip stays visible')
    assert.ok(share.share.right <= share.sidebar.right, 'Share remains in the sidebar')
    assert.ok(
      share.share.right <= nativeBounds.x,
      'Share panel remains outside the native app surface'
    )
    assert.equal(share.visibleMenus, 2)
    assertNativeUnchanged()
    const flyoutPoint = await window.webContents.executeJavaScript(`(() => {
      window.__sharePanelIdentity = document.querySelector('[aria-label="Share options for native-menu-file.md"]')
      const rect = window.__sharePanelIdentity.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)
    window.webContents.sendInputEvent({ type: 'mouseMove', x: flyoutPoint.x, y: flyoutPoint.y })
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          'Boolean(document.querySelector(\'[aria-label="Share options for native-menu-file.md"]\'))'
        ),
      'Share remains open while pointer enters its overlapping panel'
    )
    assert.equal((await measure()).visibleMenus, 2, 'pointer transit does not flicker-close Share')
    sendKey('ESC')
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          '!document.querySelector(\'[aria-label="Share options for native-menu-file.md"]\')'
        ),
      'Share overlay dismissal'
    )
    assert.equal((await measure()).visibleMenus, 1, 'Escape leaves the Main menu open')
    assertNativeUnchanged()
    sendKey('ESC')
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
      const panel = document.querySelector('[aria-label="Actions for native-menu-file.md"]')
      window.__keyboardMainPanelIdentity = panel
      panel.querySelector('[data-gfs-action="share"]').focus()
    })()`)
    sendKey('RIGHT')
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          'Boolean(document.querySelector(\'[aria-label="Share options for native-menu-file.md"]\'))'
        ),
      'keyboard Share navigation'
    )
    const keyboardShare = await measure()
    assert.equal(keyboardShare.visibleMenus, 2, 'keyboard Share adds one flyout beside Main')
    assert.equal(keyboardShare.main.identity, true, 'keyboard Share keeps the Main node mounted')
    assert.equal(keyboardShare.separatePanels, true)
    assert.ok(
      keyboardShare.share.left - keyboardShare.main.left >= 44 &&
        keyboardShare.share.left - keyboardShare.main.left <= 56
    )
    assert.ok(
      keyboardShare.share.right <= nativeBounds.x,
      'keyboard Share stays outside the native app surface'
    )
    assertNativeUnchanged()
    sendKey('ESC')
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          '!document.querySelector(\'[aria-label="Share options for native-menu-file.md"]\')'
        ),
      'Share Escape leaves Main mounted'
    )
    assert.equal((await measure()).visibleMenus, 1)
    sendKey('ESC')
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
        mainMenu: share.main,
        shareMenu: share.share,
        keyboardShare: keyboardShare.share,
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
