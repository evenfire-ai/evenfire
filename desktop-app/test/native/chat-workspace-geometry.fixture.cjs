const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

function tab(title, active = false) {
  return `<div class="chat-view-tab${active ? ' is-active' : ''}">
    <button class="ui-button ui-button--ghost ui-button--neutral ui-button--sm ui-button--align-start chat-view-tab__select"><span class="chat-view-tab__label">${title}</span></button>
    <button class="ui-button ui-button--ghost ui-button--neutral ui-button--xs ui-button--align-center chat-view-tab__close" aria-label="Close ${title}">×</button>
  </div>`
}

async function geometry(window) {
  return window.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.content-panel')
    const panelStyle = getComputedStyle(panel)
    const workspace = document.querySelector('.chat-view-workspace').getBoundingClientRect()
    const tabs = document.querySelector('.chat-view-tabs').getBoundingClientRect()
    const active = document.querySelector('.chat-view-tab.is-active').getBoundingClientRect()
    const inactive = document.querySelector('.chat-view-tab:not(.is-active)').getBoundingClientRect()
    const scroller = document.querySelector('.chat-view-tabs__scroller')
    const surface = document.querySelector('.chat-view-surface').getBoundingClientRect()
    const surfaceStyle = getComputedStyle(document.querySelector('.chat-view-surface'))
    const activeTab = document.querySelector('.chat-view-tab.is-active')
    const activeStyle = getComputedStyle(activeTab)
    // The bottom shelf now lives on the non-scrolling .chat-view-tabs container
    // (::after) so it stays under the whole visible strip when the tabs
    // overflow and scroll — it used to live on the scrolling list.
    const seamStyle = getComputedStyle(document.querySelector('.chat-view-tabs'), '::after')
    const inactiveStyle = getComputedStyle(document.querySelector('.chat-view-tab:not(.is-active)'))
    const inactiveBorderReferenceStyle = getComputedStyle(
      document.querySelector('[data-inactive-tab-border-reference]')
    )
    const activeSelectStyle = getComputedStyle(
      document.querySelector('.chat-view-tab.is-active .chat-view-tab__select')
    )
    const activeCloseStyle = getComputedStyle(
      document.querySelector('.chat-view-tab.is-active .chat-view-tab__close')
    )
    return {
      activeBottom: active.bottom,
      activeWidth: active.width,
      activeBackground: activeStyle.backgroundColor,
      activeBackgroundImage: activeStyle.backgroundImage,
      activeBorderBottom: activeStyle.borderBottomColor,
      activeBorderBottomStyle: activeStyle.borderBottomStyle,
      activeBorderBottomWidth: activeStyle.borderBottomWidth,
      activeBorderTop: activeStyle.borderTopColor,
      activeBorderTopStyle: activeStyle.borderTopStyle,
      activeFlexShrink: activeStyle.flexShrink,
      activeCloseBackground: activeCloseStyle.backgroundColor,
      activeSelectBackground: activeSelectStyle.backgroundColor,
      inactiveBackground: inactiveStyle.backgroundColor,
      inactiveWidth: inactive.width,
      inactiveBorderBottom: inactiveStyle.borderBottomColor,
      inactiveBorderBottomStyle: inactiveStyle.borderBottomStyle,
      inactiveBorderBottomWidth: inactiveStyle.borderBottomWidth,
      inactiveBorderTop: inactiveStyle.borderTopColor,
      inactiveBorderReferenceTop: inactiveBorderReferenceStyle.borderTopColor,
      inactiveFlexShrink: inactiveStyle.flexShrink,
      inactiveMinWidth: inactiveStyle.minWidth,
      inactiveMaxWidth: inactiveStyle.maxWidth,
      listClientWidth: scroller.clientWidth,
      listOverflowX: getComputedStyle(scroller).overflowX,
      seamBackground: seamStyle.backgroundColor,
      seamBottom: seamStyle.bottom,
      seamHeight: seamStyle.height,
      seamPosition: seamStyle.position,
      seamZIndex: seamStyle.zIndex,
      listScrollWidth: scroller.scrollWidth,
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
      theme: document.documentElement.dataset.theme,
      workspaceWidth: workspace.width,
    }
  })()`)
}

async function paintedSeam(window) {
  const targets = await window.webContents.executeJavaScript(`(() => {
    const active = document.querySelector('.chat-view-tab.is-active').getBoundingClientRect()
    const surface = document.querySelector('.chat-view-surface').getBoundingClientRect()
    return {
      activeCenterX: active.left + active.width / 2,
      outsideX: Math.min(surface.right - 4, active.right + 8),
      seamRows: [surface.top - 1, surface.top],
      selectedFillY: active.bottom - 3,
      surfaceFillY: surface.top + 3,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    }
  })()`)
  const image = await window.webContents.capturePage()
  const bitmap = image.toBitmap()
  const size = image.getSize()
  const scaleX = size.width / targets.viewportWidth
  const scaleY = size.height / targets.viewportHeight

  function pixel(cssX, cssY) {
    const x = Math.min(size.width - 1, Math.max(0, Math.floor(cssX * scaleX)))
    const y = Math.min(size.height - 1, Math.max(0, Math.floor(cssY * scaleY)))
    const offset = (y * size.width + x) * 4
    return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset], bitmap[offset + 3]]
  }

  const outsideFill = pixel(targets.outsideX, targets.surfaceFillY)
  const seamRow = targets.seamRows
    .map(cssY => ({
      cssY,
      outsideBorder: pixel(targets.outsideX, cssY),
    }))
    .sort(
      (left, right) =>
        colorDistance(right.outsideBorder, outsideFill) -
        colorDistance(left.outsideBorder, outsideFill)
    )[0]

  return {
    outsideBorder: seamRow.outsideBorder,
    outsideFill,
    selectedSeam: pixel(targets.activeCenterX, seamRow.cssY),
    selectedFill: pixel(targets.activeCenterX, targets.selectedFillY),
  }
}

function colorDistance(left, right) {
  return Math.max(...left.map((channel, index) => Math.abs(channel - right[index])))
}

function assertTabTreatment(state, theme) {
  assert.equal(state.theme, theme, `${theme} theme is applied`)
  assert.notEqual(
    state.activeBackground,
    state.inactiveBackground,
    `${theme} active tab remains visually distinct`
  )
  assert.notEqual(
    state.activeBorderTop,
    state.inactiveBorderTop,
    `${theme} active tab keeps its selected border treatment`
  )
  assert.equal(
    state.inactiveBorderBottomStyle,
    'solid',
    `${theme} inactive tabs draw a bottom border to complete the shared seam`
  )
  assert.equal(
    state.inactiveBorderBottomWidth,
    '1px',
    `${theme} inactive tabs draw a one-pixel bottom border`
  )
  assert.equal(
    state.inactiveBorderBottom,
    state.surfaceBorderTop,
    `${theme} inactive bottom border uses the selected surface border treatment`
  )
  assert.equal(
    state.inactiveBorderTop,
    state.inactiveBorderReferenceTop,
    `${theme} inactive tabs use 25% of the normal border color`
  )
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
    const html = `<!doctype html><html data-theme="dark"><style>${tokens}\n${css}</style>
      <div
        data-inactive-tab-border-reference
        style="border-top: 1px solid color-mix(in srgb, var(--border-soft) 25%, transparent); position: fixed; visibility: hidden"
      ></div>
      <main class="content-panel content-panel--agent-chat" style="width:100%;height:600px">
        <section class="chat-view-workspace">
          <div class="chat-view-tabs" role="toolbar"><div class="chat-view-tabs__scroller">
            <div class="chat-view-tabs__list">
              ${tab('First chat', true)}
              ${tab('A long second conversation title')}
              ${tab('A long third conversation title')}
              ${tab('A long fourth conversation title')}
            </div>
          </div></div>
          <section class="chat-view-surface">
            <div class="current-content-search">Current chat find</div>
            <div class="chat-view-surface__content">Active chat</div>
          </section>
        </section>
      </main>`
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

    const wide = await geometry(window)
    const darkPaint = await paintedSeam(window)
    assertTabTreatment(wide, 'dark')
    assert.ok(
      Math.abs(wide.surfaceWidth - wide.workspaceWidth) <= 1,
      'wide surface stays full width'
    )
    assert.ok(
      Math.abs(wide.surfaceTop - wide.activeBottom) <= 1,
      'active tab and selected surface share one border row'
    )
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
    assert.equal(wide.activeBorderTopStyle, 'solid', 'active tab keeps its top border')
    assert.equal(wide.activeBorderBottomStyle, 'none', 'active tab has no bottom border')
    assert.equal(wide.activeBorderBottomWidth, '0px', 'active tab bottom edge has no width')
    assert.ok(
      colorDistance(darkPaint.selectedSeam, darkPaint.selectedFill) <
        colorDistance(darkPaint.outsideBorder, darkPaint.outsideFill) / 2,
      'selected tab visibly masks the surface border beneath its own span'
    )
    assert.ok(
      colorDistance(darkPaint.outsideBorder, darkPaint.outsideFill) >= 5,
      'surface border remains visibly painted outside the selected tab'
    )
    assert.equal(
      wide.seamPosition,
      'absolute',
      'the non-scrolling tab strip owns the shared surface seam'
    )
    assert.equal(wide.seamBottom, '0px', 'shared seam occupies the tab strip lower edge')
    assert.equal(wide.seamHeight, '1px', 'shared seam paints exactly one border row')
    assert.equal(
      wide.seamZIndex,
      '-1',
      'shared seam sits behind the opaque tabs so it only shows through their gaps'
    )
    assert.equal(
      wide.seamBackground,
      wide.surfaceBorderTop,
      'shared seam uses the selected surface border treatment'
    )
    // Elastic tab sizing: tokens anchor a 220px ceiling and a 96px floor, and
    // with only four tabs in a wide window each tab measures at the ceiling.
    assert.equal(wide.inactiveMaxWidth, '220px', 'tabs cap at the --chat-tab-max ceiling')
    assert.equal(wide.inactiveMinWidth, '96px', 'tabs never shrink below the --chat-tab-min floor')
    assert.ok(
      Math.abs(wide.inactiveWidth - 220) <= 1,
      'a wide window with few tabs holds each tab at the 220px ceiling'
    )
    assert.ok(
      Math.abs(wide.activeWidth - 220) <= 1,
      'the active tab also sits at the 220px ceiling when there is room'
    )
    assert.equal(wide.inactiveFlexShrink, '1', 'inactive tabs shrink at the default rate')
    assert.ok(
      Number(wide.activeFlexShrink) < Number(wide.inactiveFlexShrink),
      'the active tab is configured to shrink slower than inactive tabs'
    )
    await window.webContents.executeJavaScript(
      "document.documentElement.setAttribute('data-theme', 'light')"
    )
    const light = await geometry(window)
    const lightPaint = await paintedSeam(window)
    assertTabTreatment(light, 'light')
    assert.equal(
      light.activeBorderTop,
      light.surfaceBorderTop,
      'light active tab shares the surface border'
    )
    assert.equal(
      light.seamBackground,
      light.surfaceBorderTop,
      'light shared seam uses the selected surface border treatment'
    )
    assert.ok(
      colorDistance(lightPaint.selectedSeam, lightPaint.selectedFill) <
        colorDistance(lightPaint.outsideBorder, lightPaint.outsideFill) / 2,
      'light selected tab visibly masks the surface border beneath its own span'
    )
    assert.ok(
      colorDistance(lightPaint.outsideBorder, lightPaint.outsideFill) >= 5,
      'light surface border remains visibly painted outside the selected tab'
    )

    await hover(window, '.chat-view-tab.is-active .chat-view-tab__close')
    const closeHover = await geometry(window)
    assert.notEqual(
      closeHover.activeBackgroundImage,
      wide.activeBackgroundImage,
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
    await hover(window, '.chat-view-tab.is-active .chat-view-tab__select')
    const labelHover = await geometry(window)
    assert.equal(
      labelHover.activeBackgroundImage,
      closeHover.activeBackgroundImage,
      'label and close hover fill the same complete tab surface'
    )
    assert.equal(
      labelHover.activeSelectBackground,
      'rgba(0, 0, 0, 0)',
      'the label remains transparent over the complete tab hover fill'
    )

    // Intermediate width: tabs have shrunk below the ceiling but the strip has
    // not overflowed yet — proving the tabs give up width before the scroller
    // ever scrolls.
    window.setSize(700, 700)
    await new Promise(resolve => setTimeout(resolve, 50))
    const mid = await geometry(window)
    assert.ok(
      mid.listScrollWidth <= mid.listClientWidth + 1,
      'at an intermediate width the tab strip shrinks instead of overflowing'
    )
    assert.ok(
      mid.inactiveWidth > 96 && mid.inactiveWidth < 220,
      'at an intermediate width inactive tabs sit between the 96px floor and 220px ceiling'
    )
    assert.ok(
      mid.activeWidth > 96 && mid.activeWidth < 220,
      'at an intermediate width the active tab is also between floor and ceiling'
    )
    assert.ok(
      mid.activeWidth > mid.inactiveWidth,
      'while shrinking, the active tab stays wider than an inactive one'
    )

    window.setSize(420, 700)
    await new Promise(resolve => setTimeout(resolve, 50))
    const narrow = await geometry(window)
    const narrowPaint = await paintedSeam(window)
    assert.equal(narrow.listOverflowX, 'auto', 'only the tab list owns horizontal overflow')
    assert.ok(narrow.listScrollWidth > narrow.listClientWidth, 'long narrow tabs remain scrollable')
    // Overflow only begins once even the slowest-shrinking (active) tab has
    // bottomed out at the 96px floor — the scroller does not appear before then.
    assert.ok(
      Math.abs(narrow.inactiveWidth - 96) <= 1,
      'once the strip overflows, inactive tabs rest at the 96px floor'
    )
    assert.ok(
      Math.abs(narrow.activeWidth - 96) <= 1,
      'once the strip overflows, the active tab has also reached the 96px floor'
    )
    assert.ok(
      Math.abs(narrow.surfaceWidth - narrow.workspaceWidth) <= 1,
      'narrow surface stays full width'
    )
    assert.ok(
      Math.abs(narrow.surfaceTop - narrow.activeBottom) <= 1,
      'narrow active tab and selected surface share one border row'
    )
    assert.ok(
      colorDistance(narrowPaint.selectedSeam, narrowPaint.selectedFill) <
        colorDistance(narrowPaint.outsideBorder, narrowPaint.outsideFill) / 2,
      'narrow selected tab visibly masks the surface border beneath its own span'
    )
    assert.ok(
      colorDistance(narrowPaint.outsideBorder, narrowPaint.outsideFill) >= 5,
      'narrow surface border remains visibly painted outside the selected tab'
    )
    assert.equal(narrow.surfaceBorderLeftStyle, 'solid', 'narrow surface keeps its left border')
    assert.equal(narrow.surfaceBorderRightStyle, 'solid', 'narrow surface keeps its right border')

    // With the strip actually scrolled, the shelf must stay put and the active
    // tab's notch must still mask the surface border beneath it. This is the
    // reason the shelf was moved onto the non-scrolling container: a shelf on
    // the scrolling list would slide out from under the visible tabs here.
    window.setSize(360, 700)
    await new Promise(resolve => setTimeout(resolve, 50))
    const appliedScroll = await window.webContents.executeJavaScript(`(() => {
      const scroller = document.querySelector('.chat-view-tabs__scroller')
      scroller.scrollLeft = Math.floor((scroller.scrollWidth - scroller.clientWidth) / 2)
      return scroller.scrollLeft
    })()`)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(appliedScroll > 0, 'the overflowing strip actually scrolls horizontally')
    const scrolled = await geometry(window)
    const scrolledPaint = await paintedSeam(window)
    assert.equal(
      scrolled.seamPosition,
      'absolute',
      'the shelf stays anchored to the non-scrolling container after scrolling'
    )
    assert.equal(scrolled.seamBottom, '0px', 'the scrolled shelf still hugs the strip lower edge')
    assert.equal(scrolled.seamHeight, '1px', 'the scrolled shelf still paints exactly one row')
    assert.equal(
      scrolled.seamBackground,
      scrolled.surfaceBorderTop,
      'the scrolled shelf keeps the selected surface border treatment'
    )
    assert.ok(
      Math.abs(scrolled.surfaceTop - scrolled.activeBottom) <= 1,
      'the scrolled active tab and surface still share one border row'
    )
    assert.ok(
      colorDistance(scrolledPaint.selectedSeam, scrolledPaint.selectedFill) <
        colorDistance(scrolledPaint.outsideBorder, scrolledPaint.outsideFill) / 2,
      'the scrolled active tab still masks the surface border beneath its own span'
    )
    assert.ok(
      colorDistance(scrolledPaint.outsideBorder, scrolledPaint.outsideFill) >= 5,
      'the shelf remains visibly painted outside the scrolled active tab'
    )

    console.log('chat workspace native geometry fixture: PASS')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
