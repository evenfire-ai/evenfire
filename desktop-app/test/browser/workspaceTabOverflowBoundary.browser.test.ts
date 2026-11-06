import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { build } from 'vite'

const UI_ROOT = path.resolve(__dirname, '../../ui/src')
let browser: Browser
let page: Page
let bundle: string
let pageErrors: string[]
let expectedPageErrors: string[]

async function frames(count: number) {
  return page.evaluate(async count => {
    const counts: number[] = []
    for (let index = 0; index < count; index += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      counts.push(
        document.querySelectorAll('#workspace-fixture .chat-view-tabs__scroll-button').length
      )
    }
    return counts
  }, count)
}

async function open(width: number) {
  page = await browser.newPage({ viewport: { width: 1200, height: 600 } })
  pageErrors = []
  expectedPageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.setContent(`<div id="workspace-fixture" style="width:${width}px"></div>`)
  for (const file of ['styles/tokens.css', 'styles.css']) {
    await page.addStyleTag({ path: path.join(UI_ROOT, file) })
  }
  await page.addScriptTag({ content: bundle })
  // The existing fixture uses openAppTab and selectWorkspaceTab. No synthetic sizes or RO.
  await page.evaluate('window.workspaceTabsFixture.setTabCount(1)')
  // Fixed preparation, deliberately no settle()/wait-for-stability that could hide oscillation.
  await frames(5)
  await page.evaluate(() => {
    const host = document.getElementById('workspace-fixture')!
    const changes: number[] = []
    Object.assign(window, { boundaryControlChanges: changes })
    new MutationObserver(records => {
      for (const record of records) {
        const controls = [...record.addedNodes, ...record.removedNodes].filter(
          node => node instanceof Element && node.matches('.chat-view-tabs__scroll-button')
        )
        if (controls.length) changes.push(controls.length)
      }
    }).observe(host, { childList: true, subtree: true })
  })
}

describe('workspace tab full-width boundary liveness (R4-M1)', () => {
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
          name: 'TabStripBoundaryFixture',
          formats: ['iife'],
        },
      },
    })
    const result = Array.isArray(output) ? output[0] : output
    if (!result || !('output' in result)) throw new Error('Expected browser bundle')
    const chunk = result.output.find(item => item.type === 'chunk')
    if (!chunk || chunk.type !== 'chunk') throw new Error('Missing browser fixture')
    bundle = chunk.code
    browser = await chromium.launch({ headless: true })
  }, 30_000)

  afterEach(async () => {
    await page?.close()
    expect(pageErrors).toEqual(expectedPageErrors)
  })
  afterAll(async () => {
    await browser?.close()
  })

  it.each([186, 198, 200, 208, 218, 220, 221, 222, 224, 236])(
    'settles one active producer-created app tab at width %i without control churn',
    async width => {
      await open(width)
      const counts = await frames(18)
      const geometry = await page.evaluate(() => {
        const strip = document.querySelector<HTMLElement>('.chat-view-tabs')!
        const active = strip.querySelector<HTMLElement>('.chat-view-tab.is-active')!
        // Independent no-control browser layout, outside the observed live subtree.
        const host = document.createElement('div')
        const clone = strip.cloneNode(true) as HTMLElement
        Object.assign(host.style, {
          position: 'absolute',
          visibility: 'hidden',
          width: `${strip.clientWidth}px`,
        })
        clone.querySelectorAll('.chat-view-tabs__scroll-button').forEach(node => node.remove())
        const antTabs = document.createElement('div')
        antTabs.className = 'ant-tabs'
        antTabs.append(clone)
        host.append(antTabs)
        document.body.append(host)
        try {
          return {
            W: strip.clientWidth,
            Cfull: clone.querySelector<HTMLElement>('.chat-view-tabs__list')!.scrollWidth,
            arrows: strip.querySelectorAll('.chat-view-tabs__scroll-button').length,
            shrink: getComputedStyle(active).flexShrink,
            activeLabel: active.querySelector('button')?.getAttribute('aria-label'),
            tabs: strip.querySelectorAll('.chat-view-tab').length,
            changes: (window as unknown as Window & { boundaryControlChanges: number[] })
              .boundaryControlChanges,
          }
        } finally {
          host.remove()
        }
      })
      expect(geometry.tabs).toBe(1)
      expect(geometry.activeLabel).toBe('Focus 0')
      expect(geometry.shrink).toBe('0')
      expect(
        counts.slice(-6).every(count => count === geometry.arrows),
        `control quiescence: last six frames must agree; samples=${counts.join(',')}`
      ).toBe(true)
      expect(
        geometry.changes,
        'control quiescence: no control-count oscillation at fixed width'
      ).toEqual([])
      expect(geometry.arrows, 'full-width arrow presence').toBe(
        geometry.Cfull - geometry.W > 1 ? 2 : 0
      )
    }
  )

  it('restores selected A focus and visibility after keyboard-closing focused inactive E', async () => {
    await open(200)
    await page.evaluate(() =>
      (
        window as Window & { workspaceTabsFixture: { setTabCount(count: number): void } }
      ).workspaceTabsFixture.setTabCount(6)
    )
    await frames(5)

    const rightArrow = page.getByRole('button', { name: 'Scroll tabs right' })
    for (let index = 0; index < 12; index += 1) {
      if ((await rightArrow.getAttribute('aria-disabled')) === 'true') break
      await rightArrow.click()
    }
    await page.evaluate(() => {
      document
        .querySelector<HTMLElement>('[data-workspace-tab-id="focus-0"] [role="tab"]')!
        .focus({ preventScroll: true })
    })
    for (let index = 0; index < 5; index += 1) await page.keyboard.press('ArrowRight')
    expect(
      await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('aria-label'))
    ).toBe('Focus 5')

    const selectedA = page.getByRole('tab', { name: 'Focus 0' })
    expect(await selectedA.getAttribute('aria-selected')).toBe('true')

    await page.keyboard.press('Tab')
    expect(
      await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('aria-label'))
    ).toBe('Close Focus 5')
    const beforeClose = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.chat-view-tabs__scroller')!
      const viewport = scroller.getBoundingClientRect()
      const boundsFor = (id: string) =>
        document
          .querySelector<HTMLElement>(`[data-workspace-tab-id="${id}"].chat-view-tab`)
          ?.getBoundingClientRect()
      const selectedA = boundsFor('focus-0')
      const focusedB = boundsFor('focus-5')
      return {
        viewportLeft: viewport.left + scroller.clientLeft,
        viewportRight: viewport.left + scroller.clientLeft + scroller.clientWidth,
        selectedARect: selectedA && [selectedA.left, selectedA.right],
        focusedBRect: focusedB && [focusedB.left, focusedB.right],
        selectedAFits: Boolean(
          selectedA &&
          selectedA.left >= viewport.left + scroller.clientLeft - 1 &&
          selectedA.right <= viewport.left + scroller.clientLeft + scroller.clientWidth + 1
        ),
        focusedBFits: Boolean(
          focusedB &&
          focusedB.left >= viewport.left + scroller.clientLeft - 1 &&
          focusedB.right <= viewport.left + scroller.clientLeft + scroller.clientWidth + 1
        ),
      }
    })
    expect(beforeClose.selectedAFits).toBe(false)
    expect(beforeClose.focusedBFits, JSON.stringify(beforeClose)).toBe(true)
    await page.keyboard.press('Enter')
    await frames(5)

    const afterClose = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.chat-view-tabs__scroller')!
      const viewport = scroller.getBoundingClientRect()
      const selected = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      const selectedBounds = selected
        ?.closest<HTMLElement>('.chat-view-tab')
        ?.getBoundingClientRect()
      return {
        tabIds: Array.from(
          document.querySelectorAll<HTMLElement>('.chat-view-tabs__list > [data-workspace-tab-id]')
        ).map(node => node.dataset.workspaceTabId),
        selected: selected?.getAttribute('aria-label'),
        focused:
          (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ??
          (document.activeElement === document.body ? 'BODY' : document.activeElement?.tagName),
        selectedFits: Boolean(
          selectedBounds &&
          selectedBounds.left >= viewport.left + scroller.clientLeft - 1 &&
          selectedBounds.right <= viewport.left + scroller.clientLeft + scroller.clientWidth + 1
        ),
        selectionCount: (
          window as Window & { workspaceTabsFixture: { selectionCount(): number } }
        ).workspaceTabsFixture.selectionCount(),
      }
    })
    expect(afterClose.tabIds).toEqual(['focus-0', 'focus-1', 'focus-2', 'focus-3', 'focus-4'])
    expect(afterClose.selected).toBe('Focus 0')
    expect(afterClose.focused).toBe('Focus 0')
    expect(afterClose.selectedFits).toBe(true)
    expect(afterClose.selectionCount).toBe(0)
  })

  it('collects a known asynchronous page error while retaining the ordinary zero-error contract', async () => {
    await open(200)
    const message = 'boundary collector known error'
    expectedPageErrors.push(message)
    const observed = page.waitForEvent('pageerror')
    await page.evaluate(message => {
      setTimeout(() => {
        throw new Error(message)
      }, 0)
    }, message)
    expect((await observed).message).toBe(message)
  })
})
