// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Browser, chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const desktopRoot = fileURLToPath(new URL('../', import.meta.url))
const uiRoot = path.join(desktopRoot, 'ui/src')
const appStyles = readFileSync(path.join(uiRoot, 'styles.css'), 'utf8')
const tokens = readFileSync(path.join(uiRoot, 'styles/tokens.css'), 'utf8')
const editorStyles = readFileSync(
  path.join(desktopRoot, 'node_modules/@uiw/react-md-editor/markdown-editor.css'),
  'utf8'
)
const longMarkdown = [
  Array.from({ length: 180 }, (_, line) => `Markdown line ${line}`).join('\n'),
  '',
  '```text',
  ...Array.from({ length: 180 }, (_, line) => `Code line ${line}`),
  '```',
].join('\n')

let browser: Browser
let bundle: string

async function openEditor(viewport: { width: number; height: number }) {
  if (!browser) throw new Error('Chromium must launch before mounting the Markdown editor')
  const page = await browser.newPage({ viewport })
  await page.setContent(`
    <div class="layout-test-shell">
      <div class="layout-test-tab-strip">Workspace tabs</div>
      <section class="da-gfs-preview-page">
        <div class="da-gfs-preview-content">
          <header class="da-gfs-markdown-preview-dialog__header">
            <div class="da-gfs-preview-title-row da-gfs-preview-title-row--editing">
              <h2 class="da-gfs-preview-title">about-me.md</h2>
              <div class="da-gfs-markdown-edit-actions">
                <button type="button">Discard</button>
                <button type="button">Save</button>
              </div>
            </div>
          </header>
          <div
            id="markdown-editor-host"
            class="da-gfs-markdown-preview-dialog__body da-gfs-markdown-preview-dialog__body--editing"
          >
          </div>
        </div>
      </section>
    </div>
  `)
  await page.addStyleTag({ content: tokens })
  await page.addStyleTag({ content: editorStyles })
  await page.addStyleTag({ content: appStyles })
  await page.addStyleTag({
    content: `
      .layout-test-shell { height: calc(100vh - 32px); display: flex; flex-direction: column; }
      .layout-test-tab-strip { flex: 0 0 32px; }
      .da-gfs-markdown-edit-actions button { min-height: 32px; padding: 0 12px; }
    `,
  })
  await page.addScriptTag({ content: 'window.process = { env: { NODE_ENV: "development" } }' })
  await page.addScriptTag({ content: bundle })
  expect(await page.evaluate(() => typeof window.mountGfsMarkdownEditor)).toBe('function')
  await page.evaluate(value => window.mountGfsMarkdownEditor?.(value), longMarkdown)
  await page.waitForSelector('.w-md-editor-text-input', { timeout: 5000 })
  await page.waitForSelector('.w-md-editor-preview', { timeout: 5000 })
  return page
}

beforeAll(async () => {
  const output = await build({
    configFile: path.join(desktopRoot, 'ui/vite.config.ts'),
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.join(desktopRoot, 'test/browser/fixtures/gfsMarkdownEditor.tsx'),
        name: 'GfsMarkdownEditorFixture',
        formats: ['iife'],
      },
    },
  })
  const result = Array.isArray(output) ? output[0] : output
  if (!result || !('output' in result)) throw new Error('Expected the real editor fixture bundle')
  const chunk = result.output.find(item => item.type === 'chunk')
  if (!chunk || chunk.type !== 'chunk') throw new Error('Markdown editor bundle is missing')
  bundle = chunk.code
  browser = await chromium.launch({ headless: true })
}, 30_000)

afterAll(async () => {
  await browser?.close()
})

describe('EvenDrive Markdown editor layout in Chromium', () => {
  it('uses real UIW markup for long-document scroll, caret, overlay, and resize', async () => {
    const page = await openEditor({ width: 900, height: 720 })
    const input = page.getByRole('textbox', { name: 'Markdown source' })
    const area = page.locator('.w-md-editor-area')
    const preview = page.locator('.w-md-editor-preview')
    const overlay = page.locator('.w-md-editor-text-pre > code')

    expect(await page.locator('.w-md-editor').count()).toBe(1)
    expect(await input.inputValue()).toBe(longMarkdown)
    expect((await overlay.textContent())?.trimEnd()).toBe(longMarkdown)
    const editingBodyHeight = (await page
      .locator('.da-gfs-markdown-preview-dialog__body--editing')
      .boundingBox())!.height
    const editorHeight = (await page.locator('.w-md-editor').boundingBox())!.height
    expect(editorHeight).toBeGreaterThan(editingBodyHeight * 0.8)
    expect(await area.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    expect(
      await page
        .locator('.w-md-editor-text-pre')
        .evaluate(element => getComputedStyle(element).maxHeight)
    ).toBe('none')
    expect(
      await preview.locator('pre').evaluate(element => getComputedStyle(element).maxHeight)
    ).toBe('none')

    await area.hover()
    await page.mouse.wheel(0, 1200)
    await page.waitForFunction(
      () => document.querySelector('.w-md-editor-preview')?.scrollTop ?? 0 > 0
    )
    expect(await area.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(await preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect((await overlay.textContent())?.trimEnd()).toBe(await input.inputValue())

    await input.evaluate(element => {
      element.focus()
      element.setSelectionRange(element.value.length, element.value.length)
    })
    await page.keyboard.press('ArrowLeft')
    expect(await input.evaluate(element => element.selectionStart)).toBe(longMarkdown.length - 1)
    expect(await area.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await page.keyboard.type('!')
    expect(await input.inputValue()).toBe(`${longMarkdown.slice(0, -1)}!${longMarkdown.slice(-1)}`)
    expect((await overlay.textContent())?.trimEnd()).toBe(await input.inputValue())

    const editorHeightBeforeResize = (await page.locator('.w-md-editor').boundingBox())!.height
    await page.setViewportSize({ width: 900, height: 520 })
    const editorHeightAfterResize = (await page.locator('.w-md-editor').boundingBox())!.height
    const bodyHeightAfterResize = (await page
      .locator('.da-gfs-markdown-preview-dialog__body--editing')
      .boundingBox())!.height
    expect(editorHeightAfterResize).toBeLessThan(editorHeightBeforeResize)
    expect(editorHeightAfterResize).toBeGreaterThan(300)
    expect(editorHeightAfterResize).toBeGreaterThan(bodyHeightAfterResize * 0.8)
    await page.close()
  })
})
