const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

function tab(title, active = false) {
  return `<div class="chat-view-tab${active ? ' is-active' : ''}">
    <button class="ui-button chat-view-tab__select"><span class="chat-view-tab__label">${title}</span></button>
    <button class="ui-button chat-view-tab__close" aria-label="Close ${title}">×</button>
  </div>`
}

async function geometry(window) {
  return window.webContents.executeJavaScript(`(() => {
    const workspace = document.querySelector('.chat-view-workspace').getBoundingClientRect()
    const tabs = document.querySelector('.chat-view-tabs').getBoundingClientRect()
    const active = document.querySelector('.chat-view-tab.is-active').getBoundingClientRect()
    const list = document.querySelector('.chat-view-tabs__list')
    const surface = document.querySelector('.chat-view-surface').getBoundingClientRect()
    const surfaceStyle = getComputedStyle(document.querySelector('.chat-view-surface'))
    const activeStyle = getComputedStyle(document.querySelector('.chat-view-tab.is-active'))
    return {
      activeBottom: active.bottom,
      activeBorderTop: activeStyle.borderTopColor,
      listClientWidth: list.clientWidth,
      listOverflowX: getComputedStyle(list).overflowX,
      listScrollWidth: list.scrollWidth,
      surfaceBorderTop: surfaceStyle.borderTopColor,
      surfaceTop: surface.top,
      surfaceWidth: surface.width,
      tabsBottom: tabs.bottom,
      workspaceWidth: workspace.width,
    }
  })()`)
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: true, x: -10000, y: -10000, width: 1000, height: 700 })
  try {
    const css = readFileSync(path.join(__dirname, '../../ui/src/styles.css'), 'utf8')
    const html = `<!doctype html><style>${css}</style>
      <main style="width:100%;height:600px">
        <section class="chat-view-workspace">
          <div class="chat-view-tabs" role="toolbar"><div class="chat-view-tabs__list">
            ${tab('First chat', true)}
            ${tab('A long second conversation title')}
            ${tab('A long third conversation title')}
            ${tab('A long fourth conversation title')}
          </div></div>
          <section class="chat-view-surface">
            <div class="current-content-search">Current chat find</div>
            <div class="chat-view-surface__content">Active chat</div>
          </section>
        </section>
      </main>`
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

    const wide = await geometry(window)
    assert.ok(
      Math.abs(wide.surfaceWidth - wide.workspaceWidth) <= 1,
      'wide surface stays full width'
    )
    assert.ok(wide.surfaceTop <= wide.activeBottom + 1, 'active tab meets the selected surface')
    assert.equal(
      wide.activeBorderTop,
      wide.surfaceBorderTop,
      'tab and surface share accent treatment'
    )

    window.setSize(420, 700)
    await new Promise(resolve => setTimeout(resolve, 50))
    const narrow = await geometry(window)
    assert.equal(narrow.listOverflowX, 'auto', 'only the tab list owns horizontal overflow')
    assert.ok(narrow.listScrollWidth > narrow.listClientWidth, 'long narrow tabs remain scrollable')
    assert.ok(
      Math.abs(narrow.surfaceWidth - narrow.workspaceWidth) <= 1,
      'narrow surface stays full width'
    )
    assert.ok(narrow.surfaceTop <= narrow.activeBottom + 1, 'narrow active tab keeps its seam')

    console.log('chat workspace native geometry fixture: PASS')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
