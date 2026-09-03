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
  searchWidth: number
}

let browser: Browser | undefined

function launchOptions() {
  if (process.platform === 'darwin' && fs.existsSync(SYSTEM_CHROME)) {
    return { executablePath: SYSTEM_CHROME, headless: true }
  }
  return { headless: true }
}

async function headerGeometry(
  width: number,
  drawerOpen = false,
  searchOpen = false
): Promise<HeaderGeometry> {
  if (!browser) throw new Error('Browser must launch before measuring responsive utility geometry')
  const page = await browser.newPage({ viewport: { width, height: 800 } })
  await page.setContent(`
    <div class="content-panel${drawerOpen ? ' content-panel--app-notification-drawer-open' : ''}">
      <div class="top-bar"><div class="header-left"><div class="global-search${searchOpen ? ' is-open' : ''}"></div></div></div>
      <section class="page">
        <header class="apps-page-header">Apps</header>
        <header class="sandbox-ui-mounted-header"><button>Back</button></header>
      </section>
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
      searchWidth: number('.global-search', 'width'),
    }
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

  it('uses the compact closed-header reservation at tablet widths and retains drawer-open space', async () => {
    const closed = await headerGeometry(1100)
    const open = await headerGeometry(1100, true)
    const searchExpanded = await headerGeometry(1100, false, true)

    // Idle, the global-search collapses to the 40px magnifier; it grows to its
    // tablet expanded width (clamp(160px, 32vw, …) = 352px at 1100) only on
    // focus/open. The utility gutter still reserves for the *expanded* search
    // (352 + space-2 + 36 = 398) so expansion never collides with page content.
    expect(closed.searchWidth).toBe(40)
    expect(searchExpanded.searchWidth).toBe(352)
    expect(closed.mountedPaddingRight).toBe(398)
    expect(closed.mountedPaddingRight).toBeLessThan(open.pagePaddingRight)
    expect(open.mountedPaddingRight).toBe(0)
    expect(open.pagePaddingRight).toBe(466)
  })

  it('retains mobile zero-reservation and the wide desktop utility budget', async () => {
    const mobile = await headerGeometry(900)
    const desktop = await headerGeometry(1221)

    expect(mobile.appsPaddingRight).toBe(0)
    expect(mobile.mountedPaddingRight).toBe(0)
    expect(desktop.appsPaddingRight).toBe(466)
    expect(desktop.mountedPaddingRight).toBe(466)
  })
})
