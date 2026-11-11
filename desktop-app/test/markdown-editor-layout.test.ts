// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Browser, type Page, chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const desktopRoot = fileURLToPath(new URL('../', import.meta.url))
const appStyles = readFileSync(`${desktopRoot}/ui/src/styles.css`, 'utf8')
const editorStyles = readFileSync(
  `${desktopRoot}/node_modules/@uiw/react-md-editor/markdown-editor.css`,
  'utf8'
)
const longMarkdown = Array.from({ length: 120 }, (_, line) => `Markdown line ${line}`).join('\n')

let browser: Browser
let page: Page

async function renderEditor(viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport)
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
            <div class="da-gfs-markdown-preview-dialog__header-actions"></div>
          </header>
          <div class="da-gfs-markdown-preview-dialog__body da-gfs-markdown-preview-dialog__body--editing">
            <div class="da-gfs-markdown-editor">
              <div data-color-mode="dark">
                <div class="w-md-editor" style="height: 100%">
                  <div class="w-md-editor-toolbar" role="toolbar">Markdown toolbar</div>
                  <div class="w-md-editor-content">
                    <div class="w-md-editor-input">
                      <div class="w-md-editor-area">
                        <div class="w-md-editor-text">
                          <textarea class="w-md-editor-text-input" aria-label="Markdown source" style="height: 100%; overflow: auto">${longMarkdown}</textarea>
                        </div>
                      </div>
                    </div>
                    <div class="w-md-editor-preview"><div class="layout-test-long-preview">Long rendered Markdown</div></div>
                  </div>
                  <div class="w-md-editor-bar" aria-hidden="true"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  `)
  await page.addStyleTag({ content: appStyles })
  await page.addStyleTag({ content: editorStyles })
  await page.addStyleTag({
    content: `
      .layout-test-shell { height: calc(100vh - 32px); display: flex; flex-direction: column; }
      .layout-test-tab-strip { flex: 0 0 32px; }
      .da-gfs-markdown-edit-actions button { min-height: 32px; padding: 0 12px; }
      .layout-test-long-preview { height: 1000px !important; min-height: 1000px; }
    `,
  })
}

async function box(selector: string) {
  return page.locator(selector).evaluate(element => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      height: rect.height,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: style.overflowY,
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

describe('EvenDrive Markdown editor layout in Chromium', () => {
  it('fills and resizes with the available preview area while preserving inner scrolling', async () => {
    await renderEditor({ width: 900, height: 720 })

    const body = await box('.da-gfs-markdown-preview-dialog__body')
    const editor = await box('.w-md-editor')
    expect(editor.height).toBeCloseTo(body.height, 0)
    expect(await page.getByText('Markdown toolbar').isVisible()).toBe(true)

    const tallEditorHeight = editor.height
    await page.setViewportSize({ width: 900, height: 520 })
    const resizedEditor = await box('.w-md-editor')
    expect(resizedEditor.height).toBeLessThan(tallEditorHeight)
    expect(resizedEditor.height).toBeGreaterThan(300)

    const input = await box('.w-md-editor-text-input')
    const preview = await box('.w-md-editor-preview')
    expect(body.overflowY).toBe('hidden')
    expect(input.overflowY).toBe('auto')
    expect(preview.overflowY).toBe('auto')
    expect(input.scrollHeight).toBeGreaterThan(input.clientHeight)
    expect(preview.scrollHeight).toBeGreaterThan(preview.clientHeight)
  })
})
