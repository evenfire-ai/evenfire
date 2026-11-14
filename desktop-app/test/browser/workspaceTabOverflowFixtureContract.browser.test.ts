import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { build } from 'vite'
import { SYNTHETIC_TAB_STRIP_METRICS } from '../../ui/src/components/WorkspaceTabStrip/__fixtures__/tabStripLayout'

const UI_ROOT = path.resolve(__dirname, '../../ui/src')
let browser: Browser
let page: Page
let bundle: string
const pageErrors: string[] = []

async function geometry() {
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('.chat-view-tabs')!
    const scroller = strip.querySelector<HTMLElement>('.chat-view-tabs__scroller')!
    const list = scroller.firstElementChild as HTMLElement
    // Independent browser layout at full width; no synthetic rectangles or flex solver.
    const host = document.createElement('div')
    Object.assign(host.style, {
      position: 'absolute',
      visibility: 'hidden',
      width: `${strip.clientWidth}px`,
    })
    const clone = strip.cloneNode(true) as HTMLElement
    clone.querySelectorAll('.chat-view-tabs__scroll-button').forEach(node => node.remove())
    host.append(clone)
    document.body.append(host)
    let fullContentWidth: number
    try {
      fullContentWidth = clone.querySelector<HTMLElement>('.chat-view-tabs__list')!.scrollWidth
    } finally {
      host.remove()
    }
    const viewportLeft = scroller.getBoundingClientRect().left + scroller.clientLeft
    return {
      width: strip.clientWidth,
      viewportWidth: scroller.clientWidth,
      viewportLeft,
      viewportRight: viewportLeft + scroller.clientWidth,
      fullContentWidth,
      scrollLeft: scroller.scrollLeft,
      maximum: Math.max(0, scroller.scrollWidth - scroller.clientWidth),
      gap: Number.parseFloat(getComputedStyle(list).columnGap),
      tokenGap: getComputedStyle(list).getPropertyValue('--space-1').trim(),
      controls: Array.from(
        strip.querySelectorAll<HTMLElement>('.chat-view-tabs__scroll-button')
      ).map(node => ({
        width: node.getBoundingClientRect().width,
        flexShrink: getComputedStyle(node).flexShrink,
        unavailable: node.getAttribute('aria-disabled') === 'true',
      })),
      tabs: Array.from(list.children).map(node => {
        const element = node as HTMLElement
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return {
          id: element.dataset.workspaceTabId,
          active: element.classList.contains('is-active'),
          left: rect.left,
          right: rect.right,
          width: rect.width,
          minWidth: style.minWidth,
          maxWidth: style.maxWidth,
          flexShrink: style.flexShrink,
        }
      }),
    }
  })
}

async function settle() {
  let previous = ''
  let stable = 0
  for (let frame = 0; frame < 18; frame += 1) {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    const current = await geometry()
    const serialized = JSON.stringify(current)
    stable = serialized === previous ? stable + 1 : 0
    previous = serialized
    if (stable === 5) return current
  }
  throw new Error(`Real CSS fixture geometry failed to settle: ${previous}`)
}

async function open(width: number, count: number) {
  page = await browser.newPage({ viewport: { width: 1200, height: 600 } })
  pageErrors.length = 0
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.setContent(
    `<html><body><div id="workspace-fixture" style="width:${width}px"></div></body></html>`
  )
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles/tokens.css') })
  await page.addStyleTag({ path: path.join(UI_ROOT, 'styles.css') })
  await page.addScriptTag({ content: bundle })
  await page.evaluate(
    value =>
      (
        window as unknown as Window & {
          workspaceTabsFixture: {
            setTabCount(count: number): void
            selectTab(index: number): void
            selectionCount(): number
          }
        }
      ).workspaceTabsFixture.setTabCount(value),
    count
  )
  return settle()
}

function assertLiveContract(observed: Awaited<ReturnType<typeof geometry>>) {
  const overflowing = observed.fullContentWidth - observed.width > 1
  expect(observed.controls).toHaveLength(overflowing ? 2 : 0)
  expect(observed.gap).toBe(SYNTHETIC_TAB_STRIP_METRICS.gap)
  expect(observed.gap).toBe(6)
  expect(observed.tokenGap).toBe('6px')
  for (const control of observed.controls) {
    expect(control.width).toBe(SYNTHETIC_TAB_STRIP_METRICS.controlWidth)
    expect(control.width).toBe(24)
    expect(control.flexShrink).toBe('0')
  }
  expect(observed.viewportWidth).toBe(observed.width - observed.controls.length * 24)
  expect(observed.scrollLeft).toBeGreaterThanOrEqual(0)
  expect(observed.scrollLeft).toBeLessThanOrEqual(observed.maximum)
  if (!overflowing) expect(observed.scrollLeft).toBe(0)
  else {
    expect(observed.controls[0]!.unavailable).toBe(observed.scrollLeft <= 1)
    expect(observed.controls[1]!.unavailable).toBe(observed.scrollLeft >= observed.maximum - 1)
  }
  for (const [index, tab] of observed.tabs.entries()) {
    expect(tab.minWidth).toBe('96px')
    expect(tab.maxWidth).toBe('220px')
    expect(tab.width).toBeGreaterThanOrEqual(96)
    expect(tab.width).toBeLessThanOrEqual(220)
    expect(tab.flexShrink).toBe(tab.active ? '0.4' : '1')
    if (index > 0) expect(tab.left - observed.tabs[index - 1]!.right).toBeCloseTo(6, 5)
  }
}

function assertTargetVisible(
  observed: Awaited<ReturnType<typeof geometry>>,
  id: string | undefined
) {
  const target = observed.tabs.find(tab => tab.id === id)!
  const intersection = Math.max(
    0,
    Math.min(target.right, observed.viewportRight) - Math.max(target.left, observed.viewportLeft)
  )
  expect(intersection).toBeGreaterThanOrEqual(Math.min(target.width, observed.viewportWidth) - 1)
}

describe('synthetic fixture token agreement and separate real CSS acceptance', () => {
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
          name: 'TabStripFixtureContract',
          formats: ['iife'],
        },
      },
    })
    const result = Array.isArray(output) ? output[0] : output
    if (!result || !('output' in result)) throw new Error('Expected a bundled real-store fixture')
    const chunk = result.output.find(item => item.type === 'chunk')
    if (!chunk || chunk.type !== 'chunk') throw new Error('Browser fixture bundle missing')
    bundle = chunk.code
    browser = await chromium.launch({ headless: true })
  }, 30_000)
  afterEach(async () => {
    await page?.close()
    expect(pageErrors).toEqual([])
  })
  afterAll(async () => {
    await browser?.close()
  })

  it.each([
    { count: 1, width: 240 },
    { count: 2, width: 100 },
    { count: 2, width: 240 },
    { count: 3, width: 430 },
    { count: 3, width: 900 },
    { count: 4, width: 280 },
    { count: 5, width: 900 },
    { count: 8, width: 430 },
  ])(
    'uses real flex geometry for $count producer tabs at width $width',
    async ({ count, width }) => {
      const initial = await open(width, count)
      expect(initial.tabs).toHaveLength(count)
      assertLiveContract(initial)
      // Actual unequal shrink is observed, never assigned as a fixture width.
      if ((count === 3 && width === 430) || (count === 5 && width === 900)) {
        expect(initial.tabs[0]!.width).toBeGreaterThan(initial.tabs[1]!.width)
      }
      if (count === 3 && width === 900) {
        expect(initial.tabs.every(tab => tab.width === 220)).toBe(true)
      }
      if (initial.controls.length) {
        const nearestRight = initial.tabs.find(tab => tab.right > initial.viewportRight + 1)!
        await page.getByRole('button', { name: 'Scroll tabs right' }).click()
        const right = await settle()
        assertLiveContract(right)
        expect(right.scrollLeft).toBeGreaterThan(initial.scrollLeft)
        assertTargetVisible(right, nearestRight.id)
        const nearestLeft = right.tabs
          .slice()
          .reverse()
          .find(tab => tab.left < right.viewportLeft - 1)!
        await page.getByRole('button', { name: 'Scroll tabs left' }).click()
        const left = await settle()
        assertLiveContract(left)
        expect(left.scrollLeft).toBeLessThan(right.scrollLeft)
        assertTargetVisible(left, nearestLeft.id)
        expect(
          await page.evaluate(() =>
            (
              window as unknown as Window & {
                workspaceTabsFixture: {
                  setTabCount(count: number): void
                  selectTab(index: number): void
                  selectionCount(): number
                }
              }
            ).workspaceTabsFixture.selectionCount()
          )
        ).toBe(0)
      }
      await page.evaluate(
        index =>
          (
            window as unknown as Window & {
              workspaceTabsFixture: {
                setTabCount(count: number): void
                selectTab(index: number): void
                selectionCount(): number
              }
            }
          ).workspaceTabsFixture.selectTab(index),
        count - 1
      )
      const selected = await settle()
      assertLiveContract(selected)
      expect(selected.tabs.at(-1)!.active).toBe(true)
      assertTargetVisible(selected, selected.tabs.at(-1)!.id)
    }
  )

  it('converges to the same real fitting geometry after reducing an overflowing producer list', async () => {
    const fresh = await open(240, 2)
    assertLiveContract(fresh)
    await page.close()
    expect(pageErrors).toEqual([])
    const overflowing = await open(240, 8)
    expect(overflowing.controls).toHaveLength(2)
    await page.evaluate(() =>
      (
        window as unknown as Window & {
          workspaceTabsFixture: {
            setTabCount(count: number): void
            selectTab(index: number): void
            selectionCount(): number
          }
        }
      ).workspaceTabsFixture.setTabCount(2)
    )
    const reduced = await settle()
    assertLiveContract(reduced)
    expect(reduced.controls).toHaveLength(0)
    expect(reduced.scrollLeft).toBe(0)
    expect(reduced.tabs.map(tab => tab.width)).toEqual(fresh.tabs.map(tab => tab.width))
    expect(reduced.fullContentWidth).toBe(fresh.fullContentWidth)
  })
})
