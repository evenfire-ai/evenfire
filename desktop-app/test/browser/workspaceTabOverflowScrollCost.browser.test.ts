import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'
import { build } from 'vite'

const UI_ROOT = path.resolve(__dirname, '../../ui/src')
let browser: Browser
let page: Page
let bundle: string
let errors: string[]

const frames = async (count = 4) => {
  for (let index = 0; index < count; index += 1) {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  }
}

// This instrumentation delegates every geometry read, native observer callback and
// listener to the browser. It never supplies geometry, changes delivery or feeds
// an observation back into the component's decisions.
function instrument() {
  const records = {
    fullReads: 0,
    styles: 0,
    scrolls: 0,
    resizeCallbacks: 0,
    trace: [] as Array<Record<string, any>>,
    wheels: [] as Array<{ trusted: boolean; prevented: boolean; dx: number; dy: number }>,
  }
  window.tabOverflowRecords = records
  window.tabOverflowObserve = (kind, data = {}) => {
    const strip = document.querySelector<HTMLElement>('.chat-view-tabs')
    const scroller = strip?.querySelector<HTMLElement>('.chat-view-tabs__scroller')
    records.trace.push({
      kind,
      ...data,
      controls: strip?.querySelectorAll('.chat-view-tabs__scroll-button').length ?? 0,
      W: strip?.clientWidth,
      V: scroller?.clientWidth,
      R: scroller?.scrollWidth,
      S: scroller?.scrollLeft,
    })
  }
  const width = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth')!
  Object.defineProperty(Element.prototype, 'scrollWidth', {
    ...width,
    get() {
      if (this.classList.contains('chat-view-tabs__list')) records.fullReads += 1
      return width.get!.call(this)
    },
  })
  new MutationObserver(changes => {
    for (const change of changes) {
      if ((change.target as Element).classList?.contains('chat-view-tabs__list')) {
        records.styles += 1
      }
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['style'] })
  const observers = new Map<ResizeObserver, Set<Element>>()
  const NativeResizeObserver = window.ResizeObserver
  window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        records.resizeCallbacks += 1
        window.tabOverflowObserve?.('RO-enter')
        callback(entries, observer)
        window.tabOverflowObserve?.('RO-exit')
      })
      observers.set(this, new Set())
    }
    observe(target: Element, options?: ResizeObserverOptions) {
      observers.get(this)!.add(target)
      super.observe(target, options)
    }
    disconnect() {
      observers.get(this)!.clear()
      super.disconnect()
    }
  }
  const listeners = new Map<EventTarget, Map<string, Set<EventListenerOrEventListenerObject>>>()
  const nativeAdd = EventTarget.prototype.addEventListener
  const nativeRemove = EventTarget.prototype.removeEventListener
  const owned = (target: EventTarget, type: string) =>
    (target === window && type === 'resize') ||
    (target instanceof Element &&
      target.classList.contains('chat-view-tabs__scroller') &&
      ['scroll', 'wheel'].includes(type))
  EventTarget.prototype.addEventListener = function (type, callback, options) {
    if (callback && owned(this, type)) {
      if (!listeners.has(this)) listeners.set(this, new Map())
      const target = listeners.get(this)!
      if (!target.has(type)) target.set(type, new Set())
      target.get(type)!.add(callback)
    }
    nativeAdd.call(this, type, callback, options)
  }
  EventTarget.prototype.removeEventListener = function (type, callback, options) {
    if (callback) listeners.get(this)?.get(type)?.delete(callback)
    nativeRemove.call(this, type, callback, options)
  }
  window.tabOverflowOwnership = () => ({
    observations: Array.from(observers.values())
      .filter(targets => targets.size > 0)
      .map(targets =>
        Array.from(targets)
          .map(target => target.className)
          .sort()
      ),
    listeners: Array.from(listeners.values())
      .flatMap(target =>
        Array.from(target).flatMap(([type, callbacks]) => Array(callbacks.size).fill(type))
      )
      .sort(),
  })
  document.addEventListener(
    'scroll',
    event => {
      if ((event.target as Element).classList?.contains('chat-view-tabs__scroller')) {
        records.scrolls += 1
        window.tabOverflowObserve?.('native-scroll')
      }
    },
    true
  )
  document.addEventListener('wheel', event =>
    records.wheels.push({
      trusted: event.isTrusted,
      prevented: event.defaultPrevented,
      dx: event.deltaX,
      dy: event.deltaY,
    })
  )
}

async function open(width: number, count = 40) {
  page = await browser.newPage({ viewport: { width: 1200, height: 600 } })
  errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent(
    `<html data-files-count="${count}"><body><div id="outer" style="width:500px;height:120px;overflow:auto"><div style="width:1800px"><div id="workspace-fixture" style="width:${width}px;margin-left:600px"></div></div></div></body></html>`
  )
  await page.locator('#outer').evaluate(node => {
    node.scrollLeft = 500
  })
  await page.evaluate(instrument)
  for (const file of ['styles/tokens.css', 'styles.css']) {
    await page.addStyleTag({ path: path.join(UI_ROOT, file) })
  }
  await page.addScriptTag({ content: bundle })
  await frames(8)
}

async function snapshot() {
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('.chat-view-tabs')!
    const scroller = strip.querySelector<HTMLElement>('.chat-view-tabs__scroller')!
    const left = scroller.getBoundingClientRect().left + scroller.clientLeft
    return {
      W: strip.clientWidth,
      V: scroller.clientWidth,
      R: scroller.scrollWidth,
      S: scroller.scrollLeft,
      left,
      right: left + scroller.clientWidth,
      controls: Array.from(strip.querySelectorAll('.chat-view-tabs__scroll-button')).map(node =>
        node.getAttribute('aria-disabled')
      ),
      tabs: Array.from(scroller.firstElementChild!.children).map(node => {
        const rect = node.getBoundingClientRect()
        return {
          id: (node as HTMLElement).dataset.workspaceTabId!,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
        }
      }),
      selected: window.workspaceTabLifecycle.selectionCount(),
      outer: document.getElementById('outer')!.scrollLeft,
    }
  })
}

function overflowInvariants(value: Awaited<ReturnType<typeof snapshot>>) {
  const maximum = value.R - value.V
  expect(value.S).toBeGreaterThanOrEqual(0)
  expect(value.S).toBeLessThanOrEqual(maximum)
  expect(value.controls).toEqual([String(!(value.S > 1)), String(!(value.S < maximum - 1))])
  expect(value.selected).toBe(0)
}

async function resetCounters() {
  await page.evaluate(() => {
    Object.assign(window.tabOverflowRecords, {
      fullReads: 0,
      styles: 0,
      scrolls: 0,
      resizeCallbacks: 0,
      trace: [],
      wheels: [],
    })
  })
}

async function expectZeroCost() {
  const counts = await page.evaluate(() => window.tabOverflowRecords)
  expect(counts.resizeCallbacks, 'fixed geometry has no full measurement exception').toBe(0)
  expect(counts.fullReads, 'pure scrolling never reads full list extent').toBe(0)
  expect(counts.styles, 'pure scrolling never temporarily resizes list').toBe(0)
  expect(counts.scrolls).toBeGreaterThan(0)
}

// Independent interval oracle: among fitting tabs beyond the requested edge,
// choose the nearest protruding interval and its closest feasible exposure.
function nearest(value: Awaited<ReturnType<typeof snapshot>>, direction: 'left' | 'right') {
  const intervals = value.tabs.map(tab => ({
    id: tab.id,
    L: tab.left - value.left + value.S,
    U: tab.right - value.left + value.S,
  }))
  const boundary = value.S + (direction === 'right' ? value.V : 0)
  const candidates = intervals.filter(tab =>
    direction === 'right' ? tab.U > boundary + 1 : tab.L < boundary - 1
  )
  candidates.sort((a, b) =>
    direction === 'right'
      ? Math.max(0, a.L - boundary) - Math.max(0, b.L - boundary) || a.L - b.L
      : Math.max(0, boundary - a.U) - Math.max(0, boundary - b.U) || b.U - a.U
  )
  const target = candidates[0]!
  expect(target.U - target.L).toBeLessThanOrEqual(value.V)
  return {
    target: target.id,
    S:
      direction === 'right'
        ? Math.max(value.S, Math.min(value.R - value.V, target.U - value.V))
        : Math.min(value.S, Math.max(0, target.L)),
  }
}

async function manual(position: number) {
  await page.locator('.chat-view-tabs__scroller').evaluate((node, value) => {
    node.scrollLeft = value
  }, position)
  await frames()
}

async function resize(width: number) {
  await page.locator('#workspace-fixture').evaluate((node, value) => {
    node.style.width = `${value}px`
  }, width)
}

async function trace() {
  return page.evaluate(() => window.tabOverflowRecords.trace)
}

// Observation-only transform: logs the real queued setter's argument and real
// render boundaries. It adds no state, event, scheduling, branch or return-value
// change. All tests still run the repository hook, component, producers and CSS.
function observeHook(source: string) {
  return source
    .replace(
      '  const updateScrollState = useCallback(() => {',
      "  window.tabOverflowObserve?.('render-state', { ...scrollState });\n  const updateScrollState = useCallback(() => {"
    )
    .replace(
      '    setScrollState(current =>\n      current.hasOverflow',
      "    window.tabOverflowObserve?.('full-request', { ...next });\n    setScrollState(current =>\n      current.hasOverflow"
    )
    .replace(
      '    setScrollState(current =>\n      current.canScrollLeft',
      "    window.tabOverflowObserve?.('light-request', { canScrollLeft, canScrollRight });\n    setScrollState(current => { window.tabOverflowObserve?.('light-updater', { ...current }); return current.canScrollLeft"
    )
    .replace(
      '\n    )\n  }, [stripRef])\n\n  const getTabNodes',
      '\n    })\n  }, [stripRef])\n\n  const getTabNodes'
    )
}

describe('workspace tab overflow scroll cost and lifecycle', () => {
  beforeAll(async () => {
    const output = await build({
      configFile: path.resolve(__dirname, '../../ui/vite.config.ts'),
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': JSON.stringify('development') },
      plugins: [
        {
          name: 'observe-real-tab-hook',
          enforce: 'pre',
          transform(source, id) {
            if (id.endsWith('/WorkspaceTabStrip/useWorkspaceTabOverflow.ts'))
              return observeHook(source)
          },
        },
      ],
      build: {
        write: false,
        minify: false,
        lib: {
          entry: path.join(__dirname, '__fixtures__/workspaceTabStripLifecycle.tsx'),
          name: 'TabOverflowLifecycle',
          formats: ['iife'],
        },
      },
    })
    const result = Array.isArray(output) ? output[0] : output
    if (!result || !('output' in result)) throw new Error('Expected browser fixture output')
    const chunk = result.output.find(item => item.type === 'chunk')
    if (!chunk || chunk.type !== 'chunk') throw new Error('Missing browser fixture')
    bundle = chunk.code
    browser = await chromium.launch({ headless: true })
  }, 30_000)

  afterEach(async () => {
    await page?.close()
    expect(errors).toEqual([])
  })
  afterAll(async () => {
    await browser?.close()
  })

  for (const kind of ['wheel', 'programmatic', 'arrow'] as const) {
    it(`${kind} preserves motion, bounds and direction with zero full-list work`, async () => {
      await open(280)
      const initial = await snapshot()
      overflowInvariants(initial)
      expect(initial.S).toBe(0)
      await resetCounters()
      for (let step = 0; step < 20; step += 1) {
        const before = await snapshot()
        const target = kind === 'arrow' ? nearest(before, 'right') : null
        const expected = target?.S ?? Math.min(before.R - before.V, before.S + 12)
        if (kind === 'wheel') {
          const box = (await page.locator('.chat-view-tabs__scroller').boundingBox())!
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          await page.mouse.wheel(12, 0)
        } else if (kind === 'programmatic') {
          await page.locator('.chat-view-tabs__scroller').evaluate(node => {
            node.scrollLeft += 12
          })
        } else await page.getByRole('button', { name: 'Scroll tabs right', exact: true }).click()
        await frames(2)
        const after = await snapshot()
        overflowInvariants(after)
        expect(Math.abs(after.S - expected)).toBeLessThanOrEqual(1)
        expect(after.S).toBeGreaterThanOrEqual(before.S)
        expect(after.outer).toBe(before.outer)
        expect([after.W, after.V, after.R, after.tabs.map(tab => [tab.width, tab.height])]).toEqual(
          [initial.W, initial.V, initial.R, initial.tabs.map(tab => [tab.width, tab.height])]
        )
        if (target) {
          const visible = after.tabs.find(tab => tab.id === target.target)!
          expect(visible.left).toBeGreaterThanOrEqual(after.left - 1)
          expect(visible.right).toBeLessThanOrEqual(after.right + 1)
        }
        if (kind === 'wheel') {
          expect(await page.evaluate(() => window.tabOverflowRecords.wheels.at(-1))).toEqual({
            trusted: true,
            prevented: true,
            dx: 12,
            dy: 0,
          })
        }
      }
      await expectZeroCost()
      await manual(111)
      expect((await snapshot()).S).toBe(111)
      const beforeLeft = await snapshot()
      const expectedLeft = nearest(beforeLeft, 'left')
      await page.getByRole('button', { name: 'Scroll tabs left', exact: true }).click()
      await frames()
      const afterLeft = await snapshot()
      overflowInvariants(afterLeft)
      expect(afterLeft.S).toBe(expectedLeft.S)
      expect(afterLeft.S).toBeLessThanOrEqual(beforeLeft.S)
      await expectZeroCost()
    })
  }

  it('settles a full-fit measure and subsequent light publication without control churn', async () => {
    await open(280, 4)
    for (const selected of [3, 0, 3]) {
      await resize(280)
      await frames()
      await page.locator('#workspace-fixture').evaluate(node => {
        node.style.display = 'none'
      })
      await frames()
      await page.evaluate(index => window.workspaceTabLifecycle.select(index), selected)
      await frames()
      await resetCounters()
      await page.locator('#workspace-fixture').evaluate(node => {
        node.style.width = '560px'
        node.style.display = 'block'
      })
      await frames(12)
      const observations = await trace()
      const full = observations.findIndex(row => row.kind === 'full-request' && !row.hasOverflow)
      const light = observations.findIndex(
        (row, index) => index > full && row.kind === 'light-request'
      )
      expect(full).toBeGreaterThanOrEqual(0)
      expect(light).toBeGreaterThan(full)
      expect(observations[full]!.controls).toBe(2)
      // AntD's custom controls are committed from the full fit result before the next
      // native light callback. The source-entry probe is not a React commit boundary.
      expect(observations[light]!.controls).toBe(0)
      expect(observations[light]!.V).toBe(observations[light]!.W)
      expect(observations[light]!.R).toBe(observations[light]!.V)
      expect(
        observations.some(
          (row, index) => index > light && row.kind === 'light-updater' && row.hasOverflow === false
        )
      ).toBe(true)
      const firstROEnd = observations.findIndex(
        (row, index) => index > full && row.kind === 'RO-exit'
      )
      expect(
        observations.slice(full, firstROEnd).filter(row => row.kind === 'full-request')
      ).toHaveLength(1)
      const final = await snapshot()
      expect(final.controls, JSON.stringify(observations)).toEqual([])
      expect(final.S).toBe(0)
      const settledTraceLength = observations.length
      const trailing = []
      for (let index = 0; index < 6; index += 1) {
        await frames(1)
        trailing.push((await snapshot()).controls.length)
      }
      expect(trailing).toEqual([0, 0, 0, 0, 0, 0])
      expect((await trace()).length).toBe(settledTraceLength)
    }
  })

  it('keeps manual scroll before native RO when the prior rendered state fitted', async () => {
    await open(900, 4)
    expect((await snapshot()).controls).toEqual([])
    await resetCounters()
    await page.evaluate(() => {
      document.getElementById('workspace-fixture')!.style.width = '280px'
      document.querySelector<HTMLElement>('.chat-view-tabs__scroller')!.scrollLeft = 25
    })
    await frames(12)
    const observations = await trace()
    const scroll = observations.findIndex(row => row.kind === 'native-scroll')
    const ro = observations.findIndex(row => row.kind === 'RO-enter')
    expect(scroll).toBeGreaterThanOrEqual(0)
    expect(ro).toBeGreaterThan(scroll)
    expect(observations[scroll]!.controls).toBe(0)
    expect(observations[scroll]!.S).toBe(25)
    const final = await snapshot()
    overflowInvariants(final)
    expect(final.S).toBe(25)
  })

  it('resets a real one-pixel fit range through the native light path without full work', async () => {
    await open(401, 3)
    // A one-pixel descendant overflow is real browser geometry. It is not a
    // mocked range or a replacement flex solver; no tab/node is omitted.
    await page.locator('.chat-view-tabs__list').evaluate(node => {
      node.style.setProperty('min-width', 'calc(100% + 1px)')
    })
    await frames(8)
    const before = await snapshot()
    expect([before.W, before.V, before.R, before.controls.length]).toEqual([401, 401, 402, 0])
    await resetCounters()
    await manual(1)
    const final = await snapshot()
    expect(final.S).toBe(0)
    expect(final.controls).toEqual([])
    await expectZeroCost()
  })

  it('retains pending identities across native restoration and cleans exact listener ownership', async () => {
    await open(900, 4)
    const ownership = () => page.evaluate(() => window.tabOverflowOwnership())
    const activeOwnership = {
      observations: [['chat-view-tabs__list', 'chat-view-tabs__scroller']],
      listeners: ['resize', 'scroll', 'wheel'],
    }
    expect(await ownership()).toEqual(activeOwnership)
    await page.locator('#workspace-fixture').evaluate(node => {
      node.style.display = 'none'
    })
    await frames()
    await page.evaluate(() => window.workspaceTabLifecycle.select(1))
    await page.evaluate(() => window.workspaceTabLifecycle.select(3))
    await page.locator('#workspace-fixture').evaluate(node => {
      node.style.width = '100px'
      node.style.display = 'block'
    })
    await frames(12)
    const revealed = await snapshot()
    const target = revealed.tabs[3]!
    const intersection = Math.max(
      0,
      Math.min(target.right, revealed.right) - Math.max(target.left, revealed.left)
    )
    expect(intersection).toBeGreaterThanOrEqual(Math.min(target.width, revealed.V) - 1)
    expect(await ownership()).toEqual(activeOwnership)
    await resize(280)
    await frames()
    await manual(31)
    await page.evaluate(() => {
      window.workspaceTabLifecycle.rerender()
      window.workspaceTabLifecycle.reorder()
    })
    await frames()
    expect((await snapshot()).S).toBe(31)
    expect(await ownership()).toEqual(activeOwnership)
    await page.evaluate(() => window.workspaceTabLifecycle.unmount())
    await frames()
    expect(await ownership()).toEqual({ observations: [], listeners: [] })
    await resetCounters()
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await frames()
    expect((await trace()).filter(row => row.kind === 'full-request')).toHaveLength(0)
    await page.evaluate(() => window.workspaceTabLifecycle.remount())
    await frames(8)
    expect(await ownership()).toEqual(activeOwnership)
    await page.evaluate(() => window.workspaceTabLifecycle.unmount())
    expect(await ownership()).toEqual({ observations: [], listeners: [] })
  })
})

declare global {
  interface Window {
    tabOverflowRecords: {
      fullReads: number
      styles: number
      scrolls: number
      resizeCallbacks: number
      trace: Array<Record<string, any>>
      wheels: Array<{ trusted: boolean; prevented: boolean; dx: number; dy: number }>
    }
    tabOverflowOwnership(): { observations: string[][]; listeners: string[] }
  }
}
