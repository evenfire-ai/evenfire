const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const waitForLayout = () => new Promise(resolve => setTimeout(resolve, 200))

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
      sidebarWidth: getComputedStyle(document.querySelector('.app-frame')).getPropertyValue(
        '--sidebar-width'
      ),
      backdrop: rect('.sidebar-mobile-backdrop'),
      viewport: { width: innerWidth, height: innerHeight },
      workspace: rect('.workspace-layout'),
      slot: rect('.sandbox-ui-embed-slot'),
    }
  })()`)
}

app.whenReady().then(async () => {
  let window
  try {
    window = new BrowserWindow({ show: true, x: -10000, y: -10000, width: 700, height: 700 })
    const tokens = readFileSync(path.join(__dirname, '../../ui/src/styles/tokens.css'), 'utf8')
    const css = readFileSync(path.join(__dirname, '../../ui/src/styles.css'), 'utf8')
    const html = `<!doctype html><html><head><style>${tokens}\n${css}</style></head>
      <body><div class="app-frame">
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
      document.querySelector('.window-titlebar__leading').innerHTML =
        '<button class="ui-icon-button compact-navigation-toggle" type="button">Menu</button>'
    })()`)
    const closed = await layout(window)
    assert.equal(closed.compact, true, '700px window uses the compact navigation breakpoint')
    assert.equal(
      closed.sidebarWidth,
      '0px',
      'compact titlebar leading slot uses the App width state'
    )
    assert.equal(closed.overlayOpen, false, 'compact navigation starts closed')
    assert.notEqual(closed.compactToggleDisplay, 'none', 'compact navigation trigger is visible')
    assert.equal(
      closed.compactTogglePointerEvents,
      'auto',
      'compact navigation trigger can receive pointer input'
    )
    const contentBefore = closed.workspace
    await window.webContents.executeJavaScript(
      "document.querySelector('#desktop-sidebar-navigation').classList.add('compact-open')"
    )
    await waitForLayout()
    const overlay = await layout(window)
    assert.equal(overlay.overlayOpen, true, 'the trigger opens compact navigation')
    assert.ok(Math.abs(overlay.sidebar.x) <= 1, 'compact navigation starts at the left edge')
    assert.ok(
      Math.abs(overlay.sidebar.y - overlay.titlebar.height) <= 1,
      `compact navigation starts below the real window titlebar: ${JSON.stringify({ sidebarY: overlay.sidebar.y, titlebarHeight: overlay.titlebar.height })}`
    )
    assert.ok(Math.abs(overlay.sidebar.width - 700) <= 2, 'compact navigation spans the window')
    assert.ok(Math.abs(overlay.backdrop.width - 700) <= 2, 'backdrop covers the compact sidebar')
    assert.ok(
      Math.abs(overlay.backdrop.y - overlay.titlebar.height) <= 1,
      'backdrop starts below the native titlebar'
    )
    assert.ok(
      Math.abs(overlay.sidebar.y + overlay.sidebar.height - overlay.viewport.height) <= 1,
      'compact navigation extends to the bottom of the content viewport'
    )
    const backdropTarget = await window.webContents.executeJavaScript(`(() => {
      const target = document.elementFromPoint(window.innerWidth - 16, window.innerHeight / 2)
      return {
        className: target?.className,
        backdrop: target?.classList.contains('sidebar-mobile-backdrop') ?? false,
      }
    })()`)
    assert.equal(
      backdropTarget.backdrop,
      true,
      `right edge remains a reachable backdrop target: ${backdropTarget.className}`
    )
    await window.webContents.executeJavaScript(
      "document.querySelector('#desktop-sidebar-navigation').classList.remove('compact-open')"
    )
    await waitForLayout()
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
      document.querySelector('.app-frame').style.setProperty('--sidebar-width', '460px')
    })()`)
    window.setContentSize(1200, 700)
    await waitForLayout()
    const desktop = await layout(window)
    assert.equal(desktop.compact, false, '1200px window uses desktop navigation')
    assert.equal(desktop.compactToggleDisplay, 'none', 'desktop hides the compact trigger')
    assert.ok(Math.abs(desktop.sidebar.width - 460) <= 1, 'desktop sidebar honors its live width')

    console.log('sidebar navigation CSS/BrowserWindow geometry fixture: PASS')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    if (window && !window.isDestroyed()) window.close()
  }
})
