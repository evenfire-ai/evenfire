const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, WebContentsView, screen } = require('electron')

const waitForLayout = () => new Promise(resolve => setTimeout(resolve, 80))

async function layout(window) {
  return window.webContents.executeJavaScript(`(() => {
    const rect = selector => {
      const value = document.querySelector(selector).getBoundingClientRect()
      return { x: value.x, y: value.y, width: value.width, height: value.height }
    }
    return {
      compact: matchMedia('(max-width: 759px)').matches,
      overlayOpen: document
        .querySelector('#desktop-sidebar-navigation')
        .classList.contains('compact-open'),
      titlebar: rect('.window-titlebar'),
      compactToggleDisplay: getComputedStyle(
        document.querySelector('.compact-navigation-toggle')
      ).display,
      compactTogglePointerEvents: getComputedStyle(
        document.querySelector('.compact-navigation-toggle')
      ).pointerEvents,
      sidebar: rect('.left-nav'),
      workspace: rect('.workspace-layout'),
      slot: rect('.sandbox-ui-embed-slot'),
    }
  })()`)
}

function nativeBounds(rect, dpr, scaleFactor) {
  const factor = dpr / scaleFactor
  return {
    x: Math.round(rect.x * factor),
    y: Math.round(rect.y * factor),
    width: Math.round(rect.width * factor),
    height: Math.round(rect.height * factor),
  }
}

app.whenReady().then(async () => {
  let window
  let view
  try {
    window = new BrowserWindow({ show: true, x: -10000, y: -10000, width: 700, height: 700 })
    const tokens = readFileSync(path.join(__dirname, '../../ui/src/styles/tokens.css'), 'utf8')
    const css = readFileSync(path.join(__dirname, '../../ui/src/styles.css'), 'utf8')
    const html = `<!doctype html><html><head><style>${tokens}\n${css}</style></head>
      <body><div class="app-frame" style="--sidebar-width:328px">
        <header class="window-titlebar">
          <div class="window-titlebar__controls"><span>Window controls</span></div>
          <div class="window-titlebar__leading"></div>
          <div class="window-titlebar__actions"></div>
        </header>
        <div class="app-root"><main class="app-shell">
          <aside id="desktop-sidebar-navigation" class="left-nav glass-card">
            <button class="sidebar-mobile-backdrop" aria-label="Close navigation"></button>
            <div class="sidebar-logo"><span>Navigation</span></div>
            <div class="sidebar-menu-surface"><nav>Chat · Files · Settings</nav></div>
          </aside>
          <section class="workspace-layout"><section class="content-panel">
            <div class="sandbox-ui-embed-slot"></div>
          </section></section>
        </main></div>
      </div></body></html>`
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await window.webContents.executeJavaScript(`(() => {
      const sidebar = document.querySelector('#desktop-sidebar-navigation')
      const toggle = () => sidebar.classList.toggle('compact-open')
      document.querySelector('.window-titlebar__leading').innerHTML =
        '<button class="ui-icon-button compact-navigation-toggle" type="button">Menu</button>'
      document.querySelector('.compact-navigation-toggle').addEventListener('click', toggle)
    })()`)
    view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
    await view.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><body>Native sandbox view</body>')}`
    )
    window.contentView.addChildView(view)

    const closed = await layout(window)
    assert.equal(closed.compact, true, '700px window uses the compact navigation breakpoint')
    assert.equal(closed.overlayOpen, false, 'compact navigation starts closed')
    assert.notEqual(closed.compactToggleDisplay, 'none', 'compact navigation trigger is visible')
    assert.equal(
      closed.compactTogglePointerEvents,
      'auto',
      'compact navigation trigger can receive pointer input'
    )
    assert.equal(view.getVisible(), true, 'native WebContentsView starts visible')

    const contentBefore = closed.workspace
    await window.webContents.executeJavaScript(
      "document.querySelector('.compact-navigation-toggle').click()"
    )
    await waitForLayout()
    const overlay = await layout(window)
    assert.equal(overlay.overlayOpen, true, 'the trigger opens compact navigation')
    assert.ok(Math.abs(overlay.sidebar.x) <= 1, 'compact navigation starts at the left edge')
    assert.ok(
      Math.abs(overlay.sidebar.y - overlay.titlebar.height) <= 1,
      'compact navigation starts below the real window titlebar'
    )
    assert.ok(Math.abs(overlay.sidebar.width - 700) <= 2, 'compact navigation spans the window')
    view.setVisible(false)
    assert.equal(view.getVisible(), false, 'native WebContentsView is hidden for the overlay')
    assert.deepEqual(
      overlay.workspace,
      contentBefore,
      'fixed overlay does not move workspace content'
    )

    await window.webContents.executeJavaScript(`(() => {
      const workspace = document.querySelector('.workspace-layout')
      workspace.style.transform = 'translateX(1px)'
    })()`)
    const movedWorkspace = await layout(window)
    assert.notDeepEqual(
      movedWorkspace.workspace,
      contentBefore,
      'negative control detects a workspace movement'
    )
    await window.webContents.executeJavaScript(
      "document.querySelector('.workspace-layout').style.removeProperty('transform')"
    )

    await window.webContents.executeJavaScript(`(() => {
      document.querySelector('#desktop-sidebar-navigation').classList.remove('compact-open')
      document.querySelector('.app-frame').style.setProperty('--sidebar-width', '460px')
    })()`)
    window.setContentSize(1200, 700)
    await waitForLayout()
    const desktop = await layout(window)
    assert.equal(desktop.compact, false, '1200px window uses desktop navigation')
    assert.equal(desktop.compactToggleDisplay, 'none', 'desktop hides the compact trigger')
    assert.ok(Math.abs(desktop.sidebar.width - 460) <= 1, 'desktop sidebar honors its live width')

    const scaleFactor = screen.getDisplayMatching(window.getBounds()).scaleFactor
    const dpr = await window.webContents.executeJavaScript('window.devicePixelRatio')
    view.setBounds(nativeBounds(desktop.slot, dpr, scaleFactor))
    view.setVisible(true)
    assert.equal(view.getVisible(), true, 'native WebContentsView is restored after the overlay')
    assert.deepEqual(
      view.getBounds(),
      nativeBounds(desktop.slot, dpr, scaleFactor),
      'native view bounds match the live renderer slot after the viewport changes'
    )

    console.log('sidebar navigation native geometry fixture: PASS')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    if (window && !window.isDestroyed() && view) window.contentView.removeChildView(view)
    if (window && !window.isDestroyed()) window.close()
  }
})
