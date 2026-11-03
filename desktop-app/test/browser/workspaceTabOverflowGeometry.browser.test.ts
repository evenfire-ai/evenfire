import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { build } from 'vite'

const UI_ROOT = path.resolve(__dirname, '../../ui/src')
let browser: Browser
let page: Page
let bundle: string

async function frame() {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
}

async function settle() {
  let previous = ''
  let stable = 0
  for (let index = 0; index < 12; index += 1) {
    await frame()
    const current = await geometry()
    const serialized = JSON.stringify(current)
    stable = serialized === previous ? stable + 1 : 0
    previous = serialized
    if (stable === 2) return current
  }
  throw new Error('Workspace tab geometry did not settle within 12 animation frames')
}

async function geometry() {
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('.chat-view-tabs')!
    const scroller = strip.querySelector<HTMLElement>('.chat-view-tabs__scroller')!
    const list = scroller.firstElementChild as HTMLElement
    const cloneHost = document.createElement('div')
    const clone = strip.cloneNode(true) as HTMLElement
    Object.assign(cloneHost.style, {
      position: 'absolute',
      visibility: 'hidden',
      left: '0',
      top: '0',
      width: `${strip.clientWidth}px`,
    })
    clone.querySelectorAll('.chat-view-tabs__scroll-button').forEach(button => button.remove())
    cloneHost.append(clone)
    document.body.append(cloneHost)
    let fullWidth: number
    try {
      fullWidth = (clone.querySelector('.chat-view-tabs__list') as HTMLElement).scrollWidth
    } finally {
      cloneHost.remove()
    }
    const active = strip.querySelector<HTMLElement>('.chat-view-tab.is-active')
    const activeStyle = active ? getComputedStyle(active) : null
    return {
      width: strip.clientWidth,
      contentWidth: fullWidth,
      viewportWidth: scroller.clientWidth,
      scrollWidth: scroller.scrollWidth,
      scrollLeft: scroller.scrollLeft,
      arrows: strip.querySelectorAll('.chat-view-tabs__scroll-button').length,
      activeFlexShrink: activeStyle?.flexShrink ?? null,
      active: active?.dataset.workspaceTabId ?? null,
      tabs: Array.from(list.children).map(child => {
        const rect = child.getBoundingClientRect()
        return { left: rect.left, right: rect.right, width: rect.width }
      }),
    }
  })
}

async function open(initialWidth: number, filesCount?: number) {
  page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
  await page.setContent(
    `<html${filesCount === undefined ? '' : ` data-files-count="${filesCount}"`}><body><div id="workspace-fixture" style="width:${initialWidth}px"></div></body></html>`
  )
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles/tokens.css') })
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles.css') })
  await page.addScriptTag({ content: bundle })
  return settle()
}

describe('workspace tab overflow production geometry', () => {
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
          name: 'TabStripGeometryFixture',
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

  afterEach(async () => {
    await page?.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('removes history-dependent arrows when two producer-created Files tabs fit the strip', async () => {
    const fresh = await open(240, 2)
    expect(fresh.contentWidth).toBeLessThanOrEqual(fresh.width + 1)
    expect(fresh.arrows).toBe(0)
    await page.close()

    const initial = await open(240)
    expect(initial.arrows).toBe(2)
    await page.evaluate(() => window.workspaceTabsFixture.setFilesTabCount(2))
    const afterFit = await settle()

    expect(afterFit.width).toBe(240)
    expect(afterFit.contentWidth).toBeLessThanOrEqual(afterFit.width + 1)
    expect(afterFit.arrows, JSON.stringify(afterFit)).toBe(0)
    expect(afterFit.scrollLeft).toBe(0)
  })

  it('uses the dominant wheel axis and preserves ties, delta modes, modifiers, and edge chaining', async () => {
    await open(280)
    const scroller = page.locator('.chat-view-tabs__scroller')
    const sendWheel = async (deltaX: number, deltaY: number, deltaMode = 0, ctrlKey = false) =>
      scroller.evaluate(
        (node, input) => {
          const event = new WheelEvent('wheel', {
            deltaX: input.deltaX,
            deltaY: input.deltaY,
            deltaMode: input.deltaMode,
            ctrlKey: input.ctrlKey,
            bubbles: true,
            cancelable: true,
          })
          node.dispatchEvent(event)
          return event.defaultPrevented
        },
        { deltaX, deltaY, deltaMode, ctrlKey }
      )

    expect(await sendWheel(2, 50)).toBe(true)
    expect((await settle()).scrollLeft).toBe(50)

    await scroller.evaluate(node => {
      node.scrollLeft = 0
    })
    await settle()
    expect(await sendWheel(10, 10)).toBe(true)
    expect((await settle()).scrollLeft).toBe(10)

    await scroller.evaluate(node => {
      node.scrollLeft = 0
    })
    await settle()
    expect(await sendWheel(0, 2, 1)).toBe(true)
    expect((await settle()).scrollLeft).toBe(32)

    await scroller.evaluate(node => {
      node.scrollLeft = 0
    })
    await settle()
    const pageWidth = await scroller.evaluate(node => node.clientWidth)
    const beforePage = await geometry()
    expect(await sendWheel(0, 1, 2)).toBe(true)
    expect((await settle()).scrollLeft).toBe(
      Math.min(pageWidth, beforePage.scrollWidth - beforePage.viewportWidth)
    )

    await scroller.evaluate(node => {
      node.scrollLeft = 0
    })
    await settle()
    expect(await sendWheel(0, 80, 0, true)).toBe(false)
    expect((await settle()).scrollLeft).toBe(0)
    expect(await sendWheel(-40, 0)).toBe(false)
    expect((await settle()).scrollLeft).toBe(0)
  })
})

declare global {
  interface Window {
    workspaceTabsFixture: {
      setFilesTabCount(count: number): void
    }
  }
}
