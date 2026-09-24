import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { type Browser, chromium } from 'playwright'

const UI_ROOT = path.resolve(__dirname, '../../ui/src')
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

type HeaderGeometry = {
  appsPaddingRight: number
  embedPaddingRight: number
  pagePaddingRight: number
}

let browser: Browser | undefined

function launchOptions() {
  if (process.platform === 'darwin' && fs.existsSync(SYSTEM_CHROME)) {
    return { executablePath: SYSTEM_CHROME, headless: true }
  }
  return { headless: true }
}

// The command-center (global-search) now lives in the window title bar on every
// route, so the content panel and its headers reserve NO base gutter for it —
// that fixture is deliberately absent here. The mounted-app actions also moved to
// the title bar, so the mounted view's layout now anchors on the embed slot
// (`.sandbox-ui-embed-slot`) rather than a header row. The only horizontal
// reservation left in the panel is the apps notification drawer's rail, applied
// to the page while the drawer is open, which is what this geometry measures.
async function headerGeometry(width: number, drawerOpen = false): Promise<HeaderGeometry> {
  if (!browser) throw new Error('Browser must launch before measuring responsive utility geometry')
  const page = await browser.newPage({ viewport: { width, height: 800 } })
  await page.setContent(`
    <div class="content-panel${drawerOpen ? ' content-panel--app-notification-drawer-open' : ''}">
      <section class="page">
        <header class="apps-page-header">Apps</header>
        <div class="sandbox-ui-embed-slot"></div>
      </section>
    </div>
  `)
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles/tokens.css') })
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles.css') })
  const geometry = await page.evaluate(() => {
    const number = (selector: string) =>
      Number.parseFloat(getComputedStyle(document.querySelector(selector)!).paddingRight)
    return {
      appsPaddingRight: number('.apps-page-header'),
      embedPaddingRight: number('.sandbox-ui-embed-slot'),
      pagePaddingRight: number('.page'),
    }
  })
  await page.close()
  return geometry
}

async function notificationDrawerGeometry() {
  if (!browser) throw new Error('Browser must launch before measuring notification drawer geometry')
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.setContent(`
    <div class="app-frame">
      <div class="content-panel">
        <div class="sandbox-ui-embed-slot" style="position: fixed; left: 16px; top: 80px; width: 650px; height: 600px"></div>
      </div>
      <div
        class="notification-menu notification-menu--app-drawer notification-menu--embed-aligned"
        style="--notification-drawer-left: 666px"
      ></div>
    </div>
  `)
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles/tokens.css') })
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles.css') })
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
    const embed = rect('.sandbox-ui-embed-slot')
    const drawer = rect('.notification-menu--app-drawer')
    return { drawerLeft: drawer.left, drawerRight: drawer.right, embedRight: embed.right }
  })
  await page.close()
  return geometry
}

describe('responsive utility gutter', () => {
  beforeAll(async () => {
    browser = await chromium.launch(launchOptions())
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('reserves the apps notification-drawer rail only while open, never a base gutter', async () => {
    const closed = await headerGeometry(1100)
    const open = await headerGeometry(1100, true)

    // Closed: no base gutter on the mounted embed (search is in the title bar).
    // Open: the page reserves the drawer rail and the embed sits flush against it
    // (the embed slot's own padding stays 0 — the page pads, not the slot). The
    // rail is `--app-notification-drawer-width` (420px) + `--space-4` (18px) = 438px;
    // the window-controls term was dropped once those controls moved to the titlebar.
    expect(closed.embedPaddingRight).toBe(0)
    expect(open.embedPaddingRight).toBe(0)
    expect(open.pagePaddingRight).toBe(438)
  })

  it('reserves no base utility gutter at any width, mobile or wide desktop', async () => {
    const mobile = await headerGeometry(900)
    const desktop = await headerGeometry(1221)

    // With search in the title bar, neither the apps picker header nor the
    // mounted embed pads a base gutter at any width — the responsive "utility
    // budget" that reserved space for the floating in-panel search is retired.
    // Regression guard: re-introducing a floating in-panel search would make one
    // of these non-zero again.
    expect(mobile.appsPaddingRight).toBe(0)
    expect(mobile.embedPaddingRight).toBe(0)
    expect(desktop.appsPaddingRight).toBe(0)
    expect(desktop.embedPaddingRight).toBe(0)
  })

  it('fills the measured embedded-app rail when the chat drawer is closed', async () => {
    const geometry = await notificationDrawerGeometry()

    expect(geometry.drawerLeft).toBe(geometry.embedRight)
    expect(geometry.drawerRight).toBe(1182)
  })
})
