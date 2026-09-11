import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { type Browser, chromium } from 'playwright'

const UI_ROOT = path.resolve(__dirname, '../../ui/src')
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

type HeaderGeometry = {
  appsPaddingRight: number
  mountedPaddingRight: number
  pagePaddingRight: number
  searchInsideContentPanel: boolean
}

let browser: Browser | undefined

function launchOptions() {
  if (process.platform === 'darwin' && fs.existsSync(SYSTEM_CHROME)) {
    return { executablePath: SYSTEM_CHROME, headless: true }
  }
  return { headless: true }
}

async function headerGeometry(width: number, drawerOpen = false): Promise<HeaderGeometry> {
  if (!browser) throw new Error('Browser must launch before measuring responsive utility geometry')
  const page = await browser.newPage({ viewport: { width, height: 800 } })
  await page.setContent(`
    <div class="app-frame">
      <header class="window-titlebar">
        <div class="window-titlebar__actions">
          <div class="top-bar top-bar--titlebar">
            <div class="header-left"><div class="global-search global-search--titlebar is-open"></div></div>
          </div>
        </div>
      </header>
      <div class="app-root">
        <div class="content-panel${drawerOpen ? ' content-panel--app-notification-drawer-open' : ''}">
          <section class="page">
            <header class="apps-page-header">Apps</header>
            <header class="sandbox-ui-mounted-header"><button>Back</button></header>
          </section>
        </div>
      </div>
    </div>
  `)
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles/tokens.css') })
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles.css') })
  const geometry = await page.evaluate(() => {
    const number = (selector: string, property: 'paddingRight' | 'width') =>
      Number.parseFloat(getComputedStyle(document.querySelector(selector)!)[property])
    return {
      appsPaddingRight: number('.apps-page-header', 'paddingRight'),
      mountedPaddingRight: number('.sandbox-ui-mounted-header', 'paddingRight'),
      pagePaddingRight: number('.page', 'paddingRight'),
      searchInsideContentPanel: Boolean(document.querySelector('.content-panel .global-search')),
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

  it('keeps the mounted-app notification rail stable at tablet widths', async () => {
    const closed = await headerGeometry(1100)
    const open = await headerGeometry(1100, true)

    // Search is now portalled into the titlebar. The embedded app therefore
    // reserves the notification drawer rail, not the removed in-panel search.
    expect(closed.searchInsideContentPanel).toBe(false)
    expect(closed.mountedPaddingRight).toBe(438)
    expect(open.mountedPaddingRight).toBe(0)
    expect(open.pagePaddingRight).toBe(438)
  })

  it('retains mobile zero-reservation and the wide desktop utility budget', async () => {
    const mobile = await headerGeometry(900)
    const desktop = await headerGeometry(1221)

    expect(mobile.appsPaddingRight).toBe(0)
    expect(mobile.mountedPaddingRight).toBe(0)
    // The titlebar owns the window controls, so the mounted app only reserves
    // the 420px notification rail plus its 18px outer inset.
    expect(desktop.appsPaddingRight).toBe(438)
    expect(desktop.mountedPaddingRight).toBe(438)
  })

  it('fills the measured embedded-app rail when the chat drawer is closed', async () => {
    const geometry = await notificationDrawerGeometry()

    expect(geometry.drawerLeft).toBe(geometry.embedRight)
    expect(geometry.drawerRight).toBe(1182)
  })
})
