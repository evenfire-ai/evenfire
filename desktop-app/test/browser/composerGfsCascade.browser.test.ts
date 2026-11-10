import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { build } from 'vite'

const UI_ROOT = path.resolve(__dirname, '../../ui/src')
let browser: Browser
let page: Page
let bundle: string

async function open(width = 900) {
  page = await browser.newPage({ viewport: { width, height: 720 } })
  page.setDefaultTimeout(3_000)
  page.on('pageerror', error =>
    console.error(`EvenDrive browser fixture: ${error.stack ?? error.message}`)
  )
  await page.setContent('<html><body><div id="composer-cascade-fixture"></div></body></html>')
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles/tokens.css') })
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles.css') })
  await page.addScriptTag({ content: bundle })
  try {
    await page.waitForSelector('[role="menu"]', { timeout: 2_000 })
  } catch {
    throw new Error(`Fixture did not render menu: ${await page.locator('body').innerHTML()}`)
  }
}

describe('EvenDrive cascade browser geometry and long-name motion', () => {
  beforeAll(async () => {
    const output = await build({
      configFile: path.resolve(__dirname, '../../ui/vite.config.ts'),
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': JSON.stringify('development') },
      build: {
        write: false,
        minify: false,
        lib: {
          entry: path.join(__dirname, '__fixtures__/composerGfsCascade.tsx'),
          name: 'ComposerGfsCascadeFixture',
          formats: ['iife'],
        },
      },
    })
    const result = Array.isArray(output) ? output[0] : output
    if (!('output' in result)) throw new Error('Expected a bundled EvenDrive browser fixture')
    const chunk = result.output.find(item => item.type === 'chunk')
    if (!chunk || chunk.type !== 'chunk') throw new Error('EvenDrive fixture bundle missing')
    bundle = chunk.code
    browser = await chromium.launch({ headless: true })
  }, 30_000)

  afterEach(async () => {
    await page?.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('renders real wide menu rows, inserts folders/files, and opens nested folders on hover', async () => {
    await open()
    const panel = page.getByRole('menu', { name: 'EvenDrive files' })
    expect(await panel.evaluate(node => getComputedStyle(node).width)).toBe('320px')
    expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    const folder = page.locator('.composer-gfs-picker-insert[aria-label="Insert folder Folder A"]')
    expect(await page.getByRole('menuitem', { name: 'Insert link to Folder A' }).count()).toBe(0)
    const nested = page.getByRole('menu', { name: 'Folder A contents' })
    expect(await page.evaluate(() => window.composerCascadeFixture.childRequests)).toEqual([])
    expect(await nested.count()).toBe(0)
    await page.getByRole('menuitem', { name: 'Expand folder Folder A' }).click()
    await nested.waitFor({ state: 'visible' })
    expect(await page.evaluate(() => window.composerCascadeFixture.childRequests)).toEqual([
      'folder-a',
    ])
    await folder.hover()
    await nested.waitFor({ state: 'visible' })
    await nested.locator('[aria-label="Insert link to child.txt"]').waitFor({ state: 'visible' })
    expect(await page.evaluate(() => window.composerCascadeFixture.inserted)).toEqual([])

    await page.locator('.composer-gfs-picker-insert[aria-label="Insert folder Folder A"]').click()
    expect(await page.evaluate(() => window.composerCascadeFixture.inserted)).toEqual([
      'gfs://main/folder-a',
    ])
    await page
      .locator('.composer-gfs-picker-insert[aria-label^="Insert link to Quarterly"]')
      .click()
    expect(await page.evaluate(() => window.composerCascadeFixture.inserted)).toEqual([
      'gfs://main/folder-a',
      'gfs://main/long-file',
    ])
  })

  it('animates only overflowing text, returns on leave, and disables motion for reduced motion', async () => {
    await open()
    const longRow = page.locator(
      '.composer-gfs-picker-insert[aria-label^="Insert link to Quarterly"]'
    )
    await longRow.hover()
    const longLabel = longRow.locator('.ui-menu-item__label')
    expect(await longLabel.evaluate(node => node.classList.contains('is-overflowing'))).toBe(true)
    expect(
      await longLabel
        .locator('.composer-gfs-picker-name')
        .evaluate(node => getComputedStyle(node).animationName)
    ).toBe('composer-gfs-name-pan')
    const start = await longLabel
      .locator('.composer-gfs-picker-name')
      .evaluate(node => getComputedStyle(node).transform)
    await page.waitForTimeout(1850)
    const middle = await longLabel
      .locator('.composer-gfs-picker-name')
      .evaluate(node => getComputedStyle(node).transform)
    expect(middle).not.toBe(start)
    await page.mouse.move(5, 5)
    expect(await longLabel.evaluate(node => node.classList.contains('is-overflowing'))).toBe(false)
    expect(
      await longLabel
        .locator('.composer-gfs-picker-name')
        .evaluate(node => getComputedStyle(node).transform)
    ).toBe('none')

    const shortRow = page.locator(
      '.composer-gfs-picker-insert[aria-label="Insert link to short.txt"]'
    )
    await shortRow.hover()
    expect(
      await shortRow
        .locator('.ui-menu-item__label')
        .evaluate(node => node.classList.contains('is-overflowing'))
    ).toBe(false)

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await longRow.hover()
    expect(await longLabel.evaluate(node => node.classList.contains('is-overflowing'))).toBe(true)
    expect(
      await longLabel
        .locator('.composer-gfs-picker-name')
        .evaluate(node => getComputedStyle(node).animationName)
    ).toBe('none')
    expect(await longLabel.locator('.composer-gfs-picker-name').getAttribute('title')).toBe(
      'Quarterly consolidated operating results and 2026 review.pdf'
    )
  })

  it('keeps the cascading panel inside a narrow viewport without horizontal overflow', async () => {
    await open(720)
    const panel = page.getByRole('menu', { name: 'EvenDrive files' })
    const rootBox = await panel.boundingBox()
    expect(rootBox).not.toBeNull()
    expect(rootBox!.x).toBeGreaterThanOrEqual(0)
    expect(rootBox!.x + rootBox!.width).toBeLessThanOrEqual(720)
    await page.locator('.composer-gfs-picker-insert[aria-label="Insert folder Folder A"]').hover()
    const nested = page.getByRole('menu', { name: 'Folder A contents' })
    await nested.waitFor({ state: 'visible' })
    const nestedBox = await nested.boundingBox()
    expect(nestedBox).not.toBeNull()
    expect(nestedBox!.x).toBeGreaterThanOrEqual(0)
    expect(nestedBox!.x + nestedBox!.width).toBeLessThanOrEqual(720)
    expect(await nested.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  })
})

declare global {
  interface Window {
    composerCascadeFixture: { inserted: string[]; path: string[]; reset(): void }
  }
}
