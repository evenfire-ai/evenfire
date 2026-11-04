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
const frames = (count = 6) =>
  page.evaluate(async count => {
    for (let index = 0; index < count; index += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    }
  }, count)

async function open(width: number, count = 4, kind = 'files') {
  page = await browser.newPage({ viewport: { width: 1200, height: 600 } })
  pageErrors = []
  expectedPageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.setContent(
    `<html data-tab-count="${count}" data-tab-kind="${kind}"><body>` +
      `<div id="workspace-fixture" style="width:${width}px"></div></body></html>`
  )
  for (const file of ['styles/tokens.css', 'styles.css']) {
    await page.addStyleTag({ path: path.join(UI_ROOT, file) })
  }
  await page.evaluate(() => {
    const commands: number[] = []
    Object.assign(window, { operationsScrollCommands: commands })
    const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')!
    Object.defineProperty(Element.prototype, 'scrollLeft', {
      ...native,
      set(value: number) {
        if (this.classList.contains('chat-view-tabs__scroller')) commands.push(value)
        native.set!.call(this, value)
      },
    })
  })
  await page.addScriptTag({ content: bundle })
  await frames()
}

const geometry = () =>
  page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('.chat-view-tabs')!
    const scroller = strip.querySelector<HTMLElement>('.chat-view-tabs__scroller')!
    return {
      W: strip.clientWidth,
      V: scroller.clientWidth,
      R: scroller.scrollWidth,
      S: scroller.scrollLeft,
      arrows: strip.querySelectorAll('.chat-view-tabs__scroll-button').length,
      directions: [...strip.querySelectorAll('.chat-view-tabs__scroll-button')].map(node =>
        node.getAttribute('aria-disabled')
      ),
    }
  })

describe('separate retained overflow operations (R6-L2)', () => {
  beforeAll(async () => {
    const output = await build({
      configFile: path.resolve(__dirname, '../../ui/vite.config.ts'),
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': JSON.stringify('development') },
      build: {
        write: false,
        minify: false,
        lib: {
          entry: path.join(__dirname, '__fixtures__/workspaceTabStripOperations.tsx'),
          name: 'TabStripOperationsFixture',
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

  for (const style of [null, 'outline: 0px solid transparent', 'outline: 0px solid transparent;']) {
    for (const throwRead of [false, true]) {
      it(`parses full temporary width and restores exact style ${JSON.stringify(style)}; throw=${throwRead}`, async () => {
        await open(200, 1, 'app')
        const message = 'intended operations measurement read failure'
        if (throwRead) expectedPageErrors.push(message)
        const result = await page.evaluate(
          ({ style, throwRead, message }) => {
            const strip = document.querySelector<HTMLElement>('.chat-view-tabs')!
            const scroller = strip.querySelector<HTMLElement>('.chat-view-tabs__scroller')!
            const list = scroller.firstElementChild as HTMLElement
            if (style === null) list.removeAttribute('style')
            else list.setAttribute('style', style)
            const snapshot = () => ({
              style: list.getAttribute('style'),
              width: list.getBoundingClientRect().width,
              viewport: scroller.clientWidth,
              position: scroller.scrollLeft,
            })
            const before = snapshot()
            const observed: { width: string; style: string | null }[] = []
            const flushes: (string | null)[] = []
            const nativeWidth = Object.getOwnPropertyDescriptor(
              Element.prototype,
              'scrollWidth'
            )!.get!
            const nativeRect = scroller.getBoundingClientRect
            let thrown = false
            Object.defineProperty(list, 'scrollWidth', {
              configurable: true,
              get() {
                observed.push({
                  width: getComputedStyle(list).width,
                  style: list.getAttribute('style'),
                })
                if (throwRead && !thrown) {
                  thrown = true
                  throw new Error(message)
                }
                return nativeWidth.call(list)
              },
            })
            scroller.getBoundingClientRect = function () {
              flushes.push(list.getAttribute('style'))
              return nativeRect.call(this)
            }
            try {
              // Native EventTarget reports a listener throw as pageerror; it does not reject evaluate.
              window.dispatchEvent(new Event('resize'))
              // Record the finally boundary BEFORE our own geometry reads can force layout.
              const boundaryFlushes = [...flushes]
              return {
                before,
                after: snapshot(),
                observed,
                thrown,
                boundaryFlushes,
                W: strip.clientWidth,
              }
            } finally {
              Reflect.deleteProperty(list, 'scrollWidth')
              Reflect.deleteProperty(scroller, 'getBoundingClientRect')
            }
          },
          { style, throwRead, message }
        )
        expect(result.observed.length).toBe(1)
        expect(
          parseFloat(result.observed[0]!.width),
          'temporary CSS width parsed as full strip'
        ).toBe(result.W)
        expect(result.after, 'exact style and live geometry restored on every exit').toEqual(
          result.before
        )
        expect(result.thrown).toBe(throwRead)
        // Retained eager-finally boundary only. This trace is NOT a claim that removing the
        // flush alone changes visible behavior; later geometry reads can force layout too.
        expect(result.boundaryFlushes, 'finally flush sees the exact restored style').toEqual([
          style,
        ])
        await frames()
      })
    }
  }

  it('uses restored live geometry for effective right extent after measurement', async () => {
    await open(208, 2)
    await page.locator('.chat-view-tabs__scroller').evaluate(node => {
      node.scrollLeft = node.scrollWidth
    })
    await frames()
    const result = await geometry()
    expect(result.R - result.V).toBe(48)
    expect(result.S).toBe(48)
    expect(result.arrows).toBe(2)
    expect(result.directions).toEqual(['false', 'true'])
    // This observable acceptance passes without the isolated flush line too. Do not relabel
    // it as a flush-only discriminator or as the older restored-order mutation proof.
  })

  it('resets native one-pixel fit range exactly to zero in the full owner and native scroll path', async () => {
    await open(900)
    await page.locator('#workspace-fixture').evaluate(node => {
      ;(node as HTMLElement).style.width = '401px'
    })
    await frames()
    expect(await geometry()).toMatchObject({ W: 401, V: 401, R: 402, S: 0, arrows: 0 })
    const immediate = await page.locator('.chat-view-tabs__scroller').evaluate(node => {
      node.scrollLeft = 1
      const nativePosition = node.scrollLeft
      // Full geometry owner must reset synchronously. A delayed light scroll callback cannot
      // mask removal of the retained full reset in this assertion.
      window.dispatchEvent(new Event('resize'))
      return { nativePosition, afterFullMeasurement: node.scrollLeft }
    })
    expect(immediate.nativePosition, 'browser permits one pixel despite no controls').toBe(1)
    expect(
      immediate.afterFullMeasurement,
      'full fit reset is exact, independently of native clamp'
    ).toBe(0)
    await page.locator('.chat-view-tabs__scroller').evaluate(node => {
      node.scrollLeft = 1
    })
    await frames()
    expect(await geometry()).toMatchObject({ W: 401, V: 401, R: 402, S: 0, arrows: 0 })
  })

  it('issues one identity reveal DOM command across a fitting StrictMode mount replay', async () => {
    await open(900)
    expect(await geometry()).toMatchObject({ W: 900, V: 900, R: 900, S: 0, arrows: 0 })
    const commands = await page.evaluate(
      () =>
        (window as unknown as Window & { operationsScrollCommands: number[] })
          .operationsScrollCommands
    )
    expect(commands, 'one identity reveal DOM scroll command across StrictMode replay').toEqual([0])
    // This distinguishes duplicate DOM commands, not visible displacement or fictional user
    // input between StrictMode effect replays. Removing only previous-ID equality yields [0,0].
  })

  it('collects a known asynchronous page error in addition to expected read exceptions', async () => {
    await open(900)
    const message = 'operations collector known error'
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
