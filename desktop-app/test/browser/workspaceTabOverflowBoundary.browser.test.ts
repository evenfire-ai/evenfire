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
        host.append(clone)
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
      expect(geometry.shrink).toBe('0.4')
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
      if (width === 200) {
        expect(geometry.Cfull).toBe(212)
        expect(geometry.arrows).toBe(2)
      }
    }
  )

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
