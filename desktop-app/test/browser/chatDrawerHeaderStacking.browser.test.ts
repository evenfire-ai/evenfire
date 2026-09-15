import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'

const UI_ROOT = path.resolve(__dirname, '../../ui/src')
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

let browser: Browser | undefined

function launchOptions() {
  if (process.platform === 'darwin' && fs.existsSync(SYSTEM_CHROME)) {
    return { executablePath: SYSTEM_CHROME, headless: true }
  }
  return { headless: true }
}

async function mountPortalEraShell(page: Page, drawerOpen: boolean): Promise<void> {
  await page.setContent(`
    <div class="app-frame">
      <header class="window-titlebar">
        <div class="window-titlebar__actions">
          <div class="top-bar top-bar--titlebar">
            <div class="header-left">
              <div class="global-search global-search--titlebar is-open">
                <input class="search-input" aria-label="Search" />
                <div class="global-search-results">
                  <div class="search-results-card"><button id="search-result">Search result</button></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>
      <div class="app-root">
        <section class="content-panel${drawerOpen ? ' content-panel--chat-drawer-open' : ''}">
          ${drawerOpen ? '<aside class="chat-drawer is-ready">Chat drawer</aside>' : ''}
        </section>
      </div>
    </div>
  `)
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles/tokens.css') })
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles.css') })
}

async function topmostAtOverlap(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const result = document.querySelector('.global-search-results')
    const drawer = document.querySelector('.chat-drawer')
    if (!result || !drawer) return null

    const resultRect = result.getBoundingClientRect()
    const drawerRect = drawer.getBoundingClientRect()
    const left = Math.max(resultRect.left, drawerRect.left)
    const right = Math.min(resultRect.right, drawerRect.right)
    const top = Math.max(resultRect.top, drawerRect.top)
    const bottom = Math.min(resultRect.bottom, drawerRect.bottom)
    if (left >= right || top >= bottom) return null

    const topmost = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
    if (topmost?.closest('.global-search-results')) return 'search-result'
    if (topmost?.closest('.chat-drawer')) return 'chat-drawer'
    return null
  })
}

describe('chat drawer titlebar overlay paint order', () => {
  beforeAll(async () => {
    browser = await chromium.launch(launchOptions())
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('keeps portalled search results above an open chat drawer', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
    await mountPortalEraShell(page, true)

    expect(await topmostAtOverlap(page)).toBe('search-result')
    await page.close()
  })

  it('detects a broken root stacking context instead of comparing local z-index tokens', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
    await mountPortalEraShell(page, true)

    await page.locator('.content-panel').evaluate(element => {
      ;(element as HTMLElement).style.zIndex = '200'
    })

    expect(await topmostAtOverlap(page)).toBe('chat-drawer')
    await page.close()
  })

  it('keeps titlebar search interactive without a chat drawer', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
    await mountPortalEraShell(page, false)

    await page.getByRole('button', { name: 'Search result' }).click()
    expect(await page.locator('#search-result').count()).toBe(1)
    await page.close()
  })
})
