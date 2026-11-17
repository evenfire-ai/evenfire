// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Browser, type Page, chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const desktopRoot = fileURLToPath(new URL('../', import.meta.url))
const appStyles = readFileSync(`${desktopRoot}/ui/src/styles.css`, 'utf8')

let browser: Browser
let page: Page

async function renderHeader(viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport)
  await page.setContent(`
    <div class="layout-test-shell">
      <div class="layout-test-tab-strip">Workspace tabs</div>
      <section class="da-gfs-preview-page">
        <div class="da-gfs-preview-content">
          <header class="da-gfs-markdown-preview-dialog__header">
            <div class="da-gfs-preview-title-row da-gfs-preview-title-row--editing">
              <h2 class="da-gfs-preview-title">a-very-long-markdown-filename-for-layout-check.md</h2>
              <div class="da-gfs-markdown-edit-actions">
                <button type="button">Discard</button>
                <button type="button">Save</button>
              </div>
            </div>
            <div class="da-gfs-markdown-preview-dialog__header-actions"></div>
          </header>
          <div class="da-gfs-markdown-preview-dialog__body"></div>
        </div>
      </section>
    </div>
  `)
  await page.addStyleTag({ content: appStyles })
  await page.addStyleTag({
    content: `
      .layout-test-shell { height: calc(100vh - 32px); display: flex; flex-direction: column; }
      .layout-test-tab-strip { flex: 0 0 32px; }
      .da-gfs-markdown-edit-actions button { min-height: 32px; padding: 0 12px; }
    `,
  })
}

async function box(selector: string) {
  return page.locator(selector).evaluate(element => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      x: rect.x,
      width: rect.width,
      right: rect.right,
      textOverflow: style.textOverflow,
    }
  })
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
})

afterAll(async () => {
  await browser?.close()
})

describe('EvenDrive Markdown preview header in Chromium', () => {
  it('aligns Save/Discard with the far right edge of the header row', async () => {
    await renderHeader({ width: 900, height: 640 })

    const row = await box('.da-gfs-preview-title-row')
    const title = await box('.da-gfs-preview-title')
    const actions = await box('.da-gfs-markdown-edit-actions')

    expect(actions.right).toBeCloseTo(row.right, 0)
    expect(title.x + title.width).toBeLessThanOrEqual(actions.x)
  })

  it('keeps both actions visible and avoids title overlap at narrow widths', async () => {
    await renderHeader({ width: 320, height: 640 })

    const row = await box('.da-gfs-preview-title-row')
    const title = await box('.da-gfs-preview-title')
    const actions = await box('.da-gfs-markdown-edit-actions')

    expect(row.right).toBeLessThanOrEqual(320)
    expect(actions.right).toBeLessThanOrEqual(320)
    expect(title.x + title.width).toBeLessThanOrEqual(actions.x)
    expect(actions.x).toBeGreaterThanOrEqual(row.x)
    expect(actions.right).toBeLessThanOrEqual(row.right)
    expect(title.textOverflow).toBe('ellipsis')
    expect(await page.getByRole('button', { name: 'Discard' }).isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: 'Save' }).isVisible()).toBe(true)
  })
})
