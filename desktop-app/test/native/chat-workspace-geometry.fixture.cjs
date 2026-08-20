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
    const panel = document.querySelector('.content-panel')
    const panelStyle = getComputedStyle(panel)
    const workspace = document.querySelector('.chat-view-workspace').getBoundingClientRect()
    const tabs = document.querySelector('.chat-view-tabs').getBoundingClientRect()
    const active = document.querySelector('.chat-view-tab.is-active').getBoundingClientRect()
    const list = document.querySelector('.chat-view-tabs__list')
    const surface = document.querySelector('.chat-view-surface').getBoundingClientRect()
    const surfaceStyle = getComputedStyle(document.querySelector('.chat-view-surface'))
    const activeTab = document.querySelector('.chat-view-tab.is-active')
    const activeStyle = getComputedStyle(activeTab)
    const activeSeamStyle = getComputedStyle(activeTab, '::after')
    const activeSelectStyle = getComputedStyle(
      document.querySelector('.chat-view-tab.is-active .chat-view-tab__select')
    )
    const activeCloseStyle = getComputedStyle(
      document.querySelector('.chat-view-tab.is-active .chat-view-tab__close')
    )
    return {
      activeBottom: active.bottom,
      activeBackground: activeStyle.backgroundColor,
      activeBorderBottom: activeStyle.borderBottomColor,
      activeBorderBottomStyle: activeStyle.borderBottomStyle,
      activeBorderBottomWidth: activeStyle.borderBottomWidth,
      activeBorderTop: activeStyle.borderTopColor,
      activeCloseBackground: activeCloseStyle.backgroundColor,
      activeSeamBackground: activeSeamStyle.backgroundColor,
      activeSeamBottom: activeSeamStyle.bottom,
      activeSeamHeight: activeSeamStyle.height,
      activeSeamPosition: activeSeamStyle.position,
      activeSelectBackground: activeSelectStyle.backgroundColor,
      listClientWidth: list.clientWidth,
      listOverflowX: getComputedStyle(list).overflowX,
      listScrollWidth: list.scrollWidth,
      panelPaddingLeft: panelStyle.paddingLeft,
      surfaceBackground: surfaceStyle.backgroundColor,
      surfaceBorderBottom: surfaceStyle.borderBottomColor,
      surfaceBorderBottomStyle: surfaceStyle.borderBottomStyle,
      surfaceBorderTop: surfaceStyle.borderTopColor,
      surfaceBorderLeft: surfaceStyle.borderLeftColor,
      surfaceBorderLeftStyle: surfaceStyle.borderLeftStyle,
      surfaceBorderRight: surfaceStyle.borderRightColor,
      surfaceBorderRightStyle: surfaceStyle.borderRightStyle,
      surfacePaddingLeft: surfaceStyle.paddingLeft,
      surfaceTop: surface.top,
      surfaceWidth: surface.width,
      tabsBottom: tabs.bottom,
      workspaceWidth: workspace.width,
    }
  })()`)
}

async function hover(window, selector) {
  const point = await window.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  await new Promise(resolve => setTimeout(resolve, 200))
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: true, x: -10000, y: -10000, width: 1000, height: 700 })
  try {
    const tokens = readFileSync(path.join(__dirname, '../../ui/src/styles/tokens.css'), 'utf8')
    const css = readFileSync(path.join(__dirname, '../../ui/src/styles.css'), 'utf8')
    const html = `<!doctype html><style>${tokens}\n${css}</style>
      <main class="content-panel content-panel--agent-chat" style="width:100%;height:600px">
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
    assert.equal(wide.panelPaddingLeft, '9px', 'outer left spacing is half of the prior margin')
    assert.equal(wide.surfacePaddingLeft, '14px', 'surface adds one more content padding unit')
    assert.equal(wide.surfaceBorderTop, 'rgba(67, 119, 250, 0.25)', 'accent is 25% opaque')
    assert.equal(wide.surfaceBorderLeftStyle, 'solid', 'surface owns its left border')
    assert.equal(wide.surfaceBorderRightStyle, 'solid', 'surface owns its right border')
    assert.equal(wide.surfaceBorderLeft, wide.surfaceBorderTop, 'left border shares the accent')
    assert.equal(wide.surfaceBorderRight, wide.surfaceBorderTop, 'right border shares the accent')
    assert.equal(wide.surfaceBorderBottomStyle, 'solid', 'surface owns its bottom border')
    assert.equal(wide.surfaceBorderBottom, wide.surfaceBorderTop, 'bottom border shares the accent')
    assert.equal(wide.activeBorderBottomStyle, 'none', 'active tab has no bottom border')
    assert.equal(wide.activeBorderBottomWidth, '0px', 'active tab bottom edge has no width')
    assert.equal(wide.activeSeamPosition, 'absolute', 'active tab owns the shared seam cover')
    assert.equal(wide.activeSeamBottom, '-1px', 'seam cover overlaps the conversation top border')
    assert.equal(wide.activeSeamHeight, '1px', 'seam cover masks only the shared border row')
    assert.equal(
      wide.activeSeamBackground,
      wide.activeBackground,
      'conversation top border is hidden beneath the active tab'
    )

    await hover(window, '.chat-view-tab.is-active .chat-view-tab__close')
    const closeHover = await geometry(window)
    assert.notEqual(
      closeHover.activeBackground,
      wide.activeBackground,
      'hovering the close area fills the whole tab'
    )
    assert.equal(
      closeHover.activeSelectBackground,
      'rgba(0, 0, 0, 0)',
      'the label button does not own a partial hover fill'
    )
    assert.equal(
      closeHover.activeCloseBackground,
      'rgba(0, 0, 0, 0)',
      'the close button does not own a partial hover fill'
    )
    assert.equal(
      closeHover.activeSeamBackground,
      closeHover.activeBackground,
      'the seam cover follows the complete tab hover fill'
    )

    await hover(window, '.chat-view-tab.is-active .chat-view-tab__select')
    const labelHover = await geometry(window)
    assert.equal(
      labelHover.activeBackground,
      closeHover.activeBackground,
      'label and close hover fill the same complete tab surface'
    )
    assert.equal(
      labelHover.activeSelectBackground,
      'rgba(0, 0, 0, 0)',
      'the label remains transparent over the complete tab hover fill'
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
    assert.equal(narrow.surfaceBorderLeftStyle, 'solid', 'narrow surface keeps its left border')
    assert.equal(narrow.surfaceBorderRightStyle, 'solid', 'narrow surface keeps its right border')

    console.log('chat workspace native geometry fixture: PASS')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
