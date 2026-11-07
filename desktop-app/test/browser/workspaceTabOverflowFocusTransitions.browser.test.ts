import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { build } from 'vite'

const UI_ROOT = path.resolve(__dirname, '../../ui/src')
let browser: Browser
let page: Page
let bundle: string
let pageErrors: string[]
let expectedPageErrors: string[]

const frames = (count = 6) =>
  page.evaluate(async count => {
    for (let index = 0; index < count; index += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    }
  }, count)
const focused = () =>
  page.evaluate(
    () =>
      document.activeElement?.getAttribute('aria-label') ||
      document.activeElement?.id ||
      document.activeElement?.tagName
  )
const leftArrow = () => page.getByRole('button', { name: 'Scroll tabs left', exact: true })

async function keyboardArrow() {
  await page.locator('#outside').click()
  await page.keyboard.press('Tab')
  expect(await focused(), 'genuine Tab reaches unavailable left arrow').toBe('Scroll tabs left')
  expect(await leftArrow().evaluate(node => node.matches(':focus-visible'))).toBe(true)
  expect(await leftArrow().getAttribute('aria-disabled')).toBe('true')
}
async function fit() {
  await page.locator('#workspace-fixture').evaluate(node => {
    ;(node as HTMLElement).style.width = '1100px'
  })
  await frames()
  expect(await page.locator('.chat-view-tabs__scroll-button').count()).toBe(0)
}

describe('workspace overflow genuine focus transitions (R4-L3)', () => {
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
          name: 'TabStripFocusTransitionsFixture',
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

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1200, height: 600 } })
    pageErrors = []
    expectedPageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.setContent(
      '<html data-files-count="4"><body><button id="outside">Outside</button>' +
        '<div id="workspace-fixture" style="width:280px"></div>' +
        '<button id="after">After</button></body></html>'
    )
    for (const file of ['styles/tokens.css', 'styles.css']) {
      await page.addStyleTag({ path: path.join(UI_ROOT, file) })
    }
    // Native observer delivery remains intact. Interpose an intentional focus move after
    // the real hook callback and before React removes its controls, as another native owner can.
    await page.evaluate(() => {
      const state = { outsideAfterMeasure: false, events: [] as string[] }
      Object.assign(window, { focusTransitions: state })
      const Native = ResizeObserver
      window.ResizeObserver = class extends Native {
        constructor(callback: ResizeObserverCallback) {
          super((entries, observer) => {
            callback(entries, observer)
            if (state.outsideAfterMeasure) {
              state.outsideAfterMeasure = false
              state.events.push(
                `measured:${document.querySelectorAll('.chat-view-tabs__scroll-button').length}`
              )
              document.getElementById('outside')!.focus()
              state.events.push(`outside:${document.activeElement?.id}`)
            }
          })
        }
      }
      new MutationObserver(records => {
        if (
          records.some(record =>
            [...record.removedNodes].some(
              node => node instanceof Element && node.matches('.chat-view-tabs__scroll-button')
            )
          )
        )
          state.events.push(`removed:${document.activeElement?.id}`)
      }).observe(document.getElementById('workspace-fixture')!, { subtree: true, childList: true })
    })
    await page.addScriptTag({ content: bundle })
    await frames()
    expect(await page.locator('.chat-view-tabs__scroll-button').count()).toBe(2)
  })
  afterEach(async () => {
    await page?.close()
    expect(pageErrors).toEqual(expectedPageErrors)
  })
  afterAll(async () => {
    await browser?.close()
  })

  it('F0 hands genuine keyboard focus to Files when overflow disappears', async () => {
    await keyboardArrow()
    await fit()
    expect(await focused(), 'keyboard-origin removal hands off').toBe('Files')
  })

  it('preserves an independently scrollable ancestor during keyboard focus handoff', async () => {
    await page.locator('#workspace-fixture').evaluate(node => {
      const ancestor = document.createElement('div')
      ancestor.id = 'scroll-ancestor'
      ancestor.style.width = '180px'
      ancestor.style.overflowX = 'auto'
      node.parentElement!.insertBefore(ancestor, node)
      ancestor.append(node)
      ancestor.after(document.getElementById('outside')!)
      ;(node as HTMLElement).style.width = '500px'
    })
    await page.evaluate(() => {
      ;(
        window as unknown as Window & {
          workspaceTabsFixture: { setFilesTabCount: (count: number) => void }
        }
      ).workspaceTabsFixture.setFilesTabCount(8)
    })
    await frames()

    const rightArrow = page.getByRole('button', { name: 'Scroll tabs right', exact: true })
    await page.locator('#outside').click()
    await page.keyboard.press('Shift+Tab')
    expect(await focused()).toBe('Scroll tabs right')
    expect(await rightArrow.evaluate(node => node.matches(':focus-visible'))).toBe(true)
    expect(await page.locator('.chat-view-tabs__scroll-button').count()).toBe(2)
    const ancestorBefore = await page
      .locator('#scroll-ancestor')
      .evaluate(node => (node as HTMLElement).scrollLeft)

    const before = await page.evaluate(() => ({ scrollX, scrollY, innerWidth, innerHeight }))
    const innerScrollBefore = await page
      .locator('.chat-view-tabs__scroller')
      .evaluate(node => node.scrollLeft)

    await page.locator('#workspace-fixture').evaluate(node => {
      ;(node as HTMLElement).style.width = '1600px'
    })
    await page.waitForFunction(
      () => document.querySelectorAll('.chat-view-tabs__scroll-button').length === 0
    )
    await frames(12)

    expect(await focused(), 'keyboard-origin removal hands off to Files').toBe('Files')
    expect(await page.locator('.chat-view-tabs__scroll-button').count()).toBe(0)
    expect(await page.locator('.chat-view-tabs__scroller').evaluate(node => node.scrollLeft)).toBe(
      0
    )
    expect(innerScrollBefore).toBe(0)
    expect(
      await page.locator('#scroll-ancestor').evaluate(node => (node as HTMLElement).scrollLeft)
    ).toBe(ancestorBefore)
    expect(await page.evaluate(() => ({ scrollX, scrollY, innerWidth, innerHeight }))).toEqual(
      before
    )
  })

  it('F1 cancels keyboard handoff on pointerdown on the SAME focused arrow', async () => {
    await keyboardArrow()
    // Force bypasses aria-disabled actionability only; real pointer input still fires.
    await leftArrow().click({ force: true })
    expect(await focused()).toBe('Scroll tabs left')
    await fit()
    expect(await focused(), 'pointer same-arrow transition cancels keyboard handoff').toBe('BODY')
  })

  it('F2 enables keyboard handoff on Enter after pointer focus without a new focus event', async () => {
    await leftArrow().click({ force: true })
    expect(await focused()).toBe('Scroll tabs left')
    await page.keyboard.press('Enter')
    await fit()
    expect(await focused(), 'keyboard Enter after pointer focus enables handoff').toBe('Files')
  })

  it('F3 preserves genuine Shift+Tab blur to an outside control', async () => {
    await keyboardArrow()
    await page.keyboard.press('Shift+Tab')
    expect(await focused()).toBe('outside')
    await fit()
    expect(await focused(), 'external blur stays external').toBe('outside')
  })

  it('F4 leaves an unavailable arrow focusable and inert under Enter, Space and pointer', async () => {
    await keyboardArrow()
    expect(await leftArrow().getAttribute('disabled')).toBeNull()
    const before = await page.locator('.chat-view-tabs__scroller').evaluate(node => node.scrollLeft)
    for (const key of ['Enter', 'Space']) await page.keyboard.press(key)
    await leftArrow().click({ force: true })
    await frames()
    expect(await page.locator('.chat-view-tabs__scroller').evaluate(node => node.scrollLeft)).toBe(
      before
    )
    expect(await focused()).toBe('Scroll tabs left')
    expect(await page.evaluate('window.workspaceTabsFixture.selectionCount()')).toBe(0)
    expect(
      await page.locator('.chat-view-tab.is-active button').first().getAttribute('aria-label')
    ).toBe('Files')
  })

  it('uses natural Tab order and keeps null-selection focus separate from activation', async () => {
    await page.evaluate(() => {
      ;(
        window as unknown as Window & {
          workspaceTabsFixture: { setAppsPickerProjection: (active: boolean) => void }
        }
      ).workspaceTabsFixture.setAppsPickerProjection(true)
    })
    await frames()

    const tabs = page.locator('.chat-view-tabs__list [role="tab"]')
    const tabIds = await tabs.evaluateAll(nodes =>
      nodes.map(node => (node as HTMLElement).dataset.workspaceTabId)
    )
    expect(tabIds.length).toBeGreaterThan(1)
    expect(
      await tabs.evaluateAll(nodes =>
        nodes.filter(node => node.getAttribute('aria-selected') === 'true')
      )
    ).toHaveLength(0)

    await page.locator('#outside').click()
    await page.keyboard.press('Tab')
    expect(await focused()).toBe('Scroll tabs left')
    await page.keyboard.press('Tab')
    expect(await focused()).toBe(await tabs.nth(0).getAttribute('aria-label'))
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-workspace-tab-id'))
    ).toBe(tabIds[0])
    expect(
      await tabs.evaluateAll(nodes => nodes.filter(node => (node as HTMLElement).tabIndex === 0))
    ).toHaveLength(1)

    await page.keyboard.press('Shift+Tab')
    expect(await focused()).toBe('Scroll tabs left')
    await page.keyboard.press('Shift+Tab')
    expect(await focused()).toBe('outside')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')

    await page.keyboard.press('ArrowRight')
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-workspace-tab-id'))
    ).toBe(tabIds[1])
    await page.keyboard.press('Home')
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-workspace-tab-id'))
    ).toBe(tabIds[0])
    await page.keyboard.press('End')
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-workspace-tab-id'))
    ).toBe(tabIds.at(-1))
    expect(await page.evaluate('window.workspaceTabsFixture.storeActiveTabId()')).toBe('files-0')
    expect(await page.evaluate('window.workspaceTabsFixture.selectionCount()')).toBe(0)
    expect(
      await tabs.evaluateAll(nodes =>
        nodes.filter(node => node.getAttribute('aria-selected') === 'true')
      )
    ).toHaveLength(0)

    await page.keyboard.press('Space')
    expect(await page.evaluate('window.workspaceTabsFixture.selectionCount()')).toBe(1)
    expect(await page.evaluate('window.workspaceTabsFixture.storeActiveTabId()')).toBe(
      tabIds.at(-1)
    )
    expect(await tabs.nth(tabIds.length - 1).getAttribute('aria-selected')).toBe('true')

    await page.keyboard.press('Enter')
    expect(await page.evaluate('window.workspaceTabsFixture.selectionCount()')).toBe(2)
    expect(await page.evaluate('window.workspaceTabsFixture.storeActiveTabId()')).toBe(
      tabIds.at(-1)
    )

    await page.keyboard.press('Tab')
    expect(await focused()).toBe('Close Files')
    await page.keyboard.press('Tab')
    expect(await focused()).toBe('Scroll tabs right')
    await page.keyboard.press('Tab')
    expect(await focused()).toBe('after')
    expect(pageErrors).toEqual([])
  })

  it('F5 preserves outside focus between native RO measurement and React control removal', async () => {
    await keyboardArrow()
    await page.evaluate(() => {
      ;(
        window as unknown as Window & { focusTransitions: { outsideAfterMeasure: boolean } }
      ).focusTransitions.outsideAfterMeasure = true
    })
    await fit()
    expect(await focused(), 'external focus during RO retained').toBe('outside')
    expect(
      await page.evaluate(
        () =>
          (window as unknown as Window & { focusTransitions: { events: string[] } })
            .focusTransitions.events
      )
    ).toEqual(['measured:2', 'outside:outside', 'removed:outside'])
  })

  it('captures an injected known asynchronous page error', async () => {
    const message = 'focus transitions collector known error'
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
