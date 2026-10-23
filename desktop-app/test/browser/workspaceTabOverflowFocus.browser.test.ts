import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { build } from 'vite'

const UI_ROOT = path.resolve(__dirname, '../../ui/src')
let browser: Browser
let page: Page
let bundle: string

const frame = () =>
  page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
const scrollPosition = () =>
  page.locator('.chat-view-tabs__scroller').evaluate(node => node.scrollLeft)
const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))

async function resize(width: number) {
  await page.locator('#workspace-fixture').evaluate((node, value) => {
    ;(node as HTMLElement).style.width = `${value}px`
  }, width)
  await page.waitForFunction(
    () => document.querySelectorAll('.chat-view-tabs__scroll-button').length === 0
  )
}

async function keyboardFocus(direction: 'left' | 'right') {
  await page.getByRole('button', { name: `Scroll tabs ${direction}` }).focus()
  await page.keyboard.press('Shift')
  expect(
    await page
      .getByRole('button', { name: `Scroll tabs ${direction}` })
      .evaluate(node => node.matches(':focus-visible'))
  ).toBe(true)
}

describe('workspace tab overflow browser focus', () => {
  beforeAll(async () => {
    const output = await build({
      configFile: path.resolve(__dirname, '../../ui/vite.config.ts'),
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': JSON.stringify('development') },
      build: {
        write: false,
        minify: false,
        lib: {
          entry: path.join(__dirname, '__fixtures__/workspaceTabStrip.tsx'),
          name: 'TabStripFixture',
          formats: ['iife'],
        },
      },
    })
    const result = Array.isArray(output) ? output[0] : output
    if (!('output' in result)) throw new Error('Expected a bundled browser fixture')
    const chunk = result.output.find(item => item.type === 'chunk')
    if (!chunk || chunk.type !== 'chunk') throw new Error('Browser fixture bundle missing')
    bundle = chunk.code
    browser = await chromium.launch({ headless: true })
  }, 30_000)

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
    await page.setContent(
      '<button id="outside">Outside</button><div id="workspace-fixture" style="width:280px"></div>'
    )
    await page.addStyleTag({ path: path.join(UI_ROOT, 'styles/tokens.css') })
    await page.addStyleTag({ path: path.join(UI_ROOT, 'styles.css') })
    const pageErrors: Error[] = []
    page.on('pageerror', error => pageErrors.push(error))
    await page.addScriptTag({ content: bundle })
    expect(pageErrors).toEqual([])
    await page.waitForSelector('.chat-view-tabs__scroll-button')
    await frame()
  })

  afterEach(async () => {
    await page?.close()
  })
  afterAll(async () => {
    await browser?.close()
  })

  it.each(['left', 'right'] as const)(
    'keeps the final %s arrow focused and inert at its extent',
    async direction => {
      if (direction === 'left') {
        await page.locator('.chat-view-tabs__scroller').evaluate(node => {
          node.scrollLeft = node.scrollWidth
        })
        await frame()
      }
      await keyboardFocus(direction)
      for (let step = 0; step < 12; step += 1) {
        const unavailable = await page
          .getByRole('button', { name: `Scroll tabs ${direction}` })
          .evaluate(
            node => node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true'
          )
        if (unavailable) break
        await page.keyboard.press('Enter')
        await frame()
      }
      expect(await focusedLabel()).toBe(`Scroll tabs ${direction}`)
      const arrow = page.getByRole('button', { name: `Scroll tabs ${direction}` })
      expect(await arrow.getAttribute('aria-disabled')).toBe('true')
      expect(await arrow.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid')
      const position = await scrollPosition()
      await page.keyboard.press('Enter')
      await page.keyboard.press('Space')
      await arrow.click({ force: true })
      await frame()
      expect(await scrollPosition()).toBe(position)
      expect(await page.evaluate('window.workspaceTabsFixture.selectionCount()')).toBe(0)
      expect(
        await page
          .locator('.chat-view-tab.is-active .chat-view-tab__select')
          .getAttribute('aria-label')
      ).toBe('Focus 0')
    }
  )

  it('moves keyboard focus to the active tab on element resize and leaves it there on restoration', async () => {
    await keyboardFocus('right')
    await resize(900)
    expect(await focusedLabel()).toBe('Focus 0')
    await page.locator('#workspace-fixture').evaluate(node => {
      ;(node as HTMLElement).style.width = '280px'
    })
    await page.waitForSelector('.chat-view-tabs__scroll-button')
    expect(await focusedLabel()).toBe('Focus 0')
  })

  it('moves keyboard focus to the active tab when tab removal removes overflow', async () => {
    await keyboardFocus('right')
    await page.evaluate('window.workspaceTabsFixture.setTabCount(1)')
    await page.waitForFunction(
      () => document.querySelectorAll('.chat-view-tabs__scroll-button').length === 0
    )
    expect(await focusedLabel()).toBe('Focus 0')
  })

  it('does not transfer pointer-origin focus when overflow disappears', async () => {
    await page.getByRole('button', { name: 'Scroll tabs right' }).click()
    await resize(900)
    expect(await focusedLabel()).not.toBe('Focus 0')
  })

  it('does not steal focus from a control outside the toolbar during element resize', async () => {
    await page.locator('#outside').focus()
    await resize(900)
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('outside')
  })
})
