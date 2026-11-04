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
    const viewportLeft = scroller.getBoundingClientRect().left + scroller.clientLeft
    return {
      width: strip.clientWidth,
      contentWidth: fullWidth,
      viewportWidth: scroller.clientWidth,
      viewportLeft,
      viewportRight: viewportLeft + scroller.clientWidth,
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

  it('uses producer geometry for first and last Files tabs across narrow viewport classes', async () => {
    for (const width of [100, 144, 160]) {
      await open(width, 2)
      const scroller = page.locator('.chat-view-tabs__scroller')
      const initial = await geometry()
      const activeWidth = initial.tabs[0]?.width
      expect(activeWidth).toBe(96)
      expect(initial.arrows).toBe(2)
      expect(initial.viewportWidth).toBeLessThanOrEqual(width)
      if (width === 100) expect(initial.viewportWidth).toBeLessThan(activeWidth!)
      if (width === 144) expect(initial.viewportWidth).toBe(activeWidth)
      if (width === 160) expect(initial.viewportWidth).toBeGreaterThan(activeWidth!)

      await page.evaluate(() => window.workspaceTabsFixture.selectTab(1))
      await settle()
      await scroller.evaluate(node => {
        node.scrollLeft = 0
      })
      const beforeFirst = await settle()
      const first = beforeFirst.tabs[0]!
      const firstId = await page
        .locator('.chat-view-tab')
        .first()
        .getAttribute('data-workspace-tab-id')
      expect(first.right).toBeGreaterThan(beforeFirst.viewportLeft)
      await page.evaluate(() => window.workspaceTabsFixture.selectTab(0))
      const firstActive = await settle()
      expect(firstActive.active).toBe(firstId)
      const firstActiveTab = firstActive.tabs[0]!
      const firstIntersection = Math.max(
        0,
        Math.min(firstActiveTab.right, firstActive.viewportRight) -
          Math.max(firstActiveTab.left, firstActive.viewportLeft)
      )
      expect(firstIntersection).toBe(Math.min(firstActiveTab.width, firstActive.viewportWidth))

      await scroller.evaluate(node => {
        node.scrollLeft = 0
      })
      const beforeLast = await settle()
      const last = beforeLast.tabs.at(-1)!
      const lastId = await page
        .locator('.chat-view-tab')
        .last()
        .getAttribute('data-workspace-tab-id')
      const initialIntersection = Math.max(
        0,
        Math.min(last.right, beforeLast.viewportRight) -
          Math.max(last.left, beforeLast.viewportLeft)
      )
      expect(initialIntersection).toBeLessThan(last.width)
      await page.evaluate(() => window.workspaceTabsFixture.selectTab(1))
      const lastActive = await settle()
      const lastTab = lastActive.tabs.at(-1)!
      expect(lastActive.active).toBe(lastId)
      const lastIntersection = Math.max(
        0,
        Math.min(lastTab.right, lastActive.viewportRight) -
          Math.max(lastTab.left, lastActive.viewportLeft)
      )
      expect(lastIntersection).toBe(Math.min(lastTab.width, lastActive.viewportWidth))
      expect(lastActive.scrollLeft).toBeGreaterThanOrEqual(0)
      expect(lastActive.scrollLeft).toBeLessThanOrEqual(
        lastActive.scrollWidth - lastActive.viewportWidth
      )
      await page.close()
    }
  })

  it('reads active-tab flex shrink from the computed production style', async () => {
    await open(100, 2)
    const observed = await geometry()
    expect(observed.activeFlexShrink).toBe('0.4')
  })

  it('keeps active tabs above the shelf and overflow controls hit-testable', async () => {
    await open(280)
    const hits = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('.chat-view-tabs')!
      const active = strip.querySelector<HTMLElement>('.chat-view-tab.is-active')!
      const arrow = strip.querySelector<HTMLElement>('.chat-view-tabs__scroll-button')!
      const activeRect = active.getBoundingClientRect()
      const arrowRect = arrow.getBoundingClientRect()
      const hit = (x: number, y: number) => document.elementFromPoint(x, y)
      return {
        activeZIndex: getComputedStyle(active).zIndex,
        shelfZIndex: getComputedStyle(strip, '::after').zIndex,
        shelfPointerEvents: getComputedStyle(strip, '::after').pointerEvents,
        activeCenter:
          hit(
            activeRect.left + activeRect.width / 2,
            activeRect.top + activeRect.height / 2
          )?.closest('.chat-view-tab.is-active') === active,
        activeBottom:
          hit(activeRect.left + activeRect.width / 2, activeRect.bottom - 0.5)?.closest(
            '.chat-view-tab.is-active'
          ) === active,
        arrowCenter:
          hit(arrowRect.left + arrowRect.width / 2, arrowRect.top + arrowRect.height / 2)?.closest(
            '.chat-view-tabs__scroll-button'
          ) === arrow,
      }
    })
    expect(hits).toEqual({
      activeZIndex: '1',
      shelfZIndex: '-1',
      shelfPointerEvents: 'none',
      activeCenter: true,
      activeBottom: true,
      arrowCenter: true,
    })
  })

  it('restores a pre-existing list style attribute after full-width measurement', async () => {
    await open(280)
    const expected = 'color: rgb(12, 34, 56); --r4-measurement-style: preserved;'
    await page.evaluate(value => {
      const list = document.querySelector('.chat-view-tabs__list')!
      list.setAttribute('style', value)
      window.dispatchEvent(new Event('resize'))
    }, expected)
    await settle()
    expect(await page.locator('.chat-view-tabs__list').getAttribute('style')).toBe(expected)
  })

  it('keeps an absent list style attribute absent after full-width measurement', async () => {
    await open(280)
    await page.evaluate(() => {
      const list = document.querySelector('.chat-view-tabs__list')!
      list.removeAttribute('style')
      window.dispatchEvent(new Event('resize'))
    })
    await settle()
    expect(await page.locator('.chat-view-tabs__list').getAttribute('style')).toBeNull()
  })

  it('restores the original list style when the full-width read throws', async () => {
    await open(280)
    const pageError = page.waitForEvent('pageerror')
    const result = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>('.chat-view-tabs__list')!
      const before = list.getAttribute('style')
      let prototype: object | null = Object.getPrototypeOf(list)
      let nativeGetter: (() => number) | undefined
      while (prototype && !nativeGetter) {
        nativeGetter = Object.getOwnPropertyDescriptor(prototype, 'scrollWidth')?.get
        prototype = Object.getPrototypeOf(prototype)
      }
      if (!nativeGetter) throw new Error('native scrollWidth getter unavailable')
      let throwNext = true
      Object.defineProperty(list, 'scrollWidth', {
        configurable: true,
        get() {
          if (throwNext) {
            throwNext = false
            throw new Error('forced full-width read failure')
          }
          return nativeGetter!.call(this)
        },
      })
      window.dispatchEvent(new Event('resize'))
      const after = list.getAttribute('style')
      delete (list as HTMLElement & { scrollWidth: number }).scrollWidth
      return { before, after }
    })
    expect(result.after).toBe(result.before)
    expect((await pageError).message).toBe('forced full-width read failure')
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

  it('uses horizontal dominance and the horizontal tie rule while chaining at both bounds', async () => {
    await open(280)
    const scroller = page.locator('.chat-view-tabs__scroller')
    const sendWheel = async (deltaX: number, deltaY: number) =>
      scroller.evaluate(
        (node, input) => {
          const event = new WheelEvent('wheel', {
            deltaX: input.deltaX,
            deltaY: input.deltaY,
            bubbles: true,
            cancelable: true,
          })
          node.dispatchEvent(event)
          return event.defaultPrevented
        },
        { deltaX, deltaY }
      )

    const initial = await geometry()
    const maximum = initial.scrollWidth - initial.viewportWidth
    expect(maximum).toBeGreaterThan(40)

    expect(await sendWheel(20, -10)).toBe(true)
    expect((await settle()).scrollLeft).toBe(20)

    await scroller.evaluate(node => {
      node.scrollLeft = 20
    })
    await settle()
    expect(await sendWheel(-10, 10)).toBe(true)
    expect((await settle()).scrollLeft).toBe(10)

    await scroller.evaluate(node => {
      node.scrollLeft = 0
    })
    await settle()
    expect(await sendWheel(-40, 0)).toBe(false)
    expect((await settle()).scrollLeft).toBe(0)

    await scroller.evaluate((node, max) => {
      node.scrollLeft = max
    }, maximum)
    await settle()
    expect(await sendWheel(40, 10)).toBe(false)
    expect((await settle()).scrollLeft).toBe(maximum)
  })
})

declare global {
  interface Window {
    workspaceTabsFixture: {
      setFilesTabCount(count: number): void
    }
  }
}
