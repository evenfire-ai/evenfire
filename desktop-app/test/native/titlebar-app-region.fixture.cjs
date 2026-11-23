// Real-Electron check of the title bar's `-webkit-app-region` map. jsdom does
// not compute app-region at all, and whether it is inherited depends on the
// Chromium version Electron ships, so the computed value of every element comes
// from a real BrowserWindow. Electron exposes no API to read the resulting
// draggable-region map and synthetic input skips the OS hit-test, so which box
// wins at a point is modelled below rather than measured.
//
// The renderer is the production WindowTitleBar plus the real leading actions
// (bundled by scripts/run-native-titlebar-app-region.mjs), styled by the real
// tokens.css + styles.css. The region at a point is resolved the way Chromium
// unions app-region boxes: every element whose computed value is `drag` or
// `no-drag` and whose border box contains the point, in document order, with
// the last one winning. z-index, position and pointer-events do not take part.
const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const desktopRoot = path.join(__dirname, '../..')
const harnessBundle = path.join(desktopRoot, 'dist/native/titlebar-app-region.harness.js')
const harnessPage = path.join(desktopRoot, 'dist/native/titlebar-app-region.html')

const waitForLayout = () => new Promise(resolve => setTimeout(resolve, 200))

async function regionMap(window) {
  return window.webContents.executeJavaScript(`(() => {
    const computedRegion = element => {
      const style = getComputedStyle(element)
      return (
        style.getPropertyValue('app-region') ||
        style.getPropertyValue('-webkit-app-region') ||
        style.webkitAppRegion ||
        ''
      ).trim()
    }
    const regionAt = (x, y) => {
      let region = 'none'
      for (const element of document.querySelectorAll('*')) {
        const value = computedRegion(element)
        if (value !== 'drag' && value !== 'no-drag') continue
        const box = element.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) continue
        if (x >= box.left && x < box.right && y >= box.top && y < box.bottom) region = value
      }
      return region
    }
    const box = element => {
      const value = element.getBoundingClientRect()
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom }
    }
    const center = element => {
      const value = element.getBoundingClientRect()
      return { x: value.left + value.width / 2, y: value.top + value.height / 2 }
    }
    const probe = element => {
      const point = center(element)
      return { label: element.getAttribute('aria-label'), ...point, region: regionAt(point.x, point.y) }
    }
    const visible = element => getComputedStyle(element).display !== 'none'
    const titlebar = document.querySelector('.window-titlebar')
    const controls = document.querySelector('.window-titlebar__controls')
    const leading = document.querySelector('.window-titlebar__leading')
    const actions = document.querySelector('.window-titlebar__actions')
    const search = document.querySelector('.window-titlebar__actions .search-input')
    const missing = Object.entries({ titlebar, controls, leading, actions, search })
      .filter(([, element]) => !element)
      .map(([name]) => name)
    const leadingButtons = leading ? [...leading.querySelectorAll('button')].filter(visible) : []
    // Return what was found instead of throwing, so assertRegions can say what
    // the harness failed to render.
    if (missing.length > 0 || leadingButtons.length === 0) {
      return { missing, leadingButtons: leadingButtons.map(probe) }
    }
    const lastLeadingButton = leadingButtons[leadingButtons.length - 1]
    const titlebarMidY = titlebar.getBoundingClientRect().top + titlebar.getBoundingClientRect().height / 2
    const gapStart = controls.getBoundingClientRect().right
    const gapEnd = leading.getBoundingClientRect().left
    const afterLeading = lastLeadingButton.getBoundingClientRect().right + 24
    return {
      missing,
      platform: titlebar.dataset.platform,
      actionsComputedRegion: computedRegion(actions),
      boxes: { titlebar: box(titlebar), controls: box(controls), leading: box(leading), actions: box(actions), search: box(search) },
      leadingButtons: leadingButtons.map(probe),
      windowControls: [...controls.querySelectorAll('button')].map(probe),
      search: probe(search),
      emptyBeforeLeading: { x: (gapStart + gapEnd) / 2, region: regionAt((gapStart + gapEnd) / 2, titlebarMidY), gapStart, gapEnd },
      emptyAfterLeading: { x: afterLeading, region: regionAt(afterLeading, titlebarMidY), searchLeft: search.getBoundingClientRect().left },
    }
  })()`)
}

function assertRegions(map, scenario, expectedLeadingLabels) {
  const detail = JSON.stringify(map)
  assert.deepEqual(
    map.missing,
    [],
    `${scenario}: the harness renders the title bar, both slots and the search: ${detail}`
  )
  assert.deepEqual(
    map.leadingButtons.map(button => button.label),
    expectedLeadingLabels,
    `${scenario}: the real leading actions render in the leading slot: ${detail}`
  )
  for (const button of map.leadingButtons) {
    assert.equal(
      button.region,
      'no-drag',
      `${scenario}: leading action "${button.label}" must resolve to no-drag, otherwise the OS swallows its clicks as a window drag: ${detail}`
    )
  }
  for (const button of map.windowControls) {
    assert.equal(
      button.region,
      'no-drag',
      `${scenario}: "${button.label}" stays clickable: ${detail}`
    )
  }
  assert.equal(
    map.search.region,
    'no-drag',
    `${scenario}: the title-bar search stays clickable: ${detail}`
  )
  assert.ok(
    map.emptyBeforeLeading.gapEnd - map.emptyBeforeLeading.gapStart > 4,
    `${scenario}: there is empty title bar between the window controls and the leading slot: ${detail}`
  )
  assert.equal(
    map.emptyBeforeLeading.region,
    'drag',
    `${scenario}: empty title bar before the leading slot still drags the window: ${detail}`
  )
  assert.ok(
    map.emptyAfterLeading.x < map.emptyAfterLeading.searchLeft,
    `${scenario}: the probe after the leading actions lands on empty title bar: ${detail}`
  )
  assert.equal(
    map.emptyAfterLeading.region,
    'drag',
    `${scenario}: empty title bar after the leading actions still drags the window: ${detail}`
  )
}

app.whenReady().then(async () => {
  let window
  try {
    const tokens = readFileSync(path.join(desktopRoot, 'ui/src/styles/tokens.css'), 'utf8')
    const css = readFileSync(path.join(desktopRoot, 'ui/src/styles.css'), 'utf8')
    writeFileSync(
      harnessPage,
      `<!doctype html><html><head><meta charset="utf-8"><style>${tokens}\n${css}</style></head>
      <body><div id="root"></div><script src="${path.basename(harnessBundle)}"></script></body></html>`
    )
    window = new BrowserWindow({ show: true, x: -10000, y: -10000, width: 1200, height: 700 })
    const setSidebarWidth = width =>
      window.webContents.executeJavaScript(
        `document.querySelector('.app-frame').style.setProperty('--sidebar-width', '${width}')`
      )

    // Each route mounts its own leading actions; the GFS pages and the sandbox
    // app page are the two producers that portal buttons into the slot.
    const surfaces = [
      { leading: 'gfs', labels: ['Refresh', 'Copy link', 'Open link'] },
      { leading: 'sandbox', labels: ['Refresh app content', 'Copy current app link'] },
    ]
    for (const { leading, labels } of surfaces) {
      window.setContentSize(1200, 700)
      await window.loadFile(harnessPage, { query: { leading } })
      await waitForLayout()

      await setSidebarWidth('328px')
      await waitForLayout()
      const expanded = await regionMap(window)
      console.log(`${leading}, expanded sidebar:`, JSON.stringify(expanded))
      assertRegions(expanded, `${leading}, expanded sidebar`, labels)

      await setSidebarWidth('74px')
      await waitForLayout()
      const collapsed = await regionMap(window)
      console.log(`${leading}, collapsed sidebar:`, JSON.stringify(collapsed))
      assertRegions(collapsed, `${leading}, collapsed sidebar`, labels)

      // Compact navigation shows the leading navigation toggle as well; App
      // drops the sidebar width to 0 in that mode.
      await setSidebarWidth('0px')
      window.setContentSize(700, 700)
      await waitForLayout()
      const compact = await regionMap(window)
      console.log(`${leading}, compact navigation:`, JSON.stringify(compact))
      assertRegions(compact, `${leading}, compact navigation`, ['Open navigation', ...labels])
    }

    console.log('titlebar app-region BrowserWindow fixture: PASS')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    if (window && !window.isDestroyed()) window.close()
  }
})
