// desktop-app/test/e2e-playwright/chromium-focus-boundary.spec.ts
//
// Browser boundary probe for the renderer's jsdom tests. jsdom accepts focus on
// hidden elements and never synthesizes hover events after a layout change, so
// the renderer tests install `ui/src/__tests__/__fixtures__/chromiumFocusShim.ts`
// and drive the pointer with `ui/src/__tests__/__fixtures__/pointerDriver.ts`.
// This probe records what headless Chromium really does, so those helpers copy
// observed behaviour instead of a belief about it. No app build or cluster is
// needed: every case is a static page.
import { type Page, expect, test } from '@playwright/test'
import { chromiumFocusRejection } from '../../ui/src/__tests__/__fixtures__/chromiumFocusShim'

type Recorded = { target: string; type: string }

const POINTER_EVENTS = [
  'pointerover',
  'pointerenter',
  'pointerout',
  'pointerleave',
  'pointermove',
  'pointerdown',
  'pointerup',
  'mouseover',
  'mouseenter',
  'mouseout',
  'mouseleave',
  'mousemove',
  'mousedown',
  'mouseup',
  'click',
] as const

async function installRecorder(page: Page, ids: string[]) {
  await page.evaluate(
    ({ ids, types }) => {
      const log: { target: string; type: string }[] = []
      ;(window as unknown as { __events: typeof log }).__events = log
      for (const id of ids) {
        const element = document.getElementById(id)!
        for (const type of types) {
          // Listen on the element itself so enter/leave (which do not bubble)
          // are seen, and keep only events targeted at it or entering/leaving it.
          element.addEventListener(type, event => {
            if (event.target === element || type.endsWith('enter') || type.endsWith('leave')) {
              log.push({ target: id, type })
            }
          })
        }
      }
    },
    { ids, types: [...POINTER_EVENTS] }
  )
}

async function takeEvents(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => {
    const log = (window as unknown as { __events: Recorded[] }).__events
    return log.splice(0)
  })
}

/** Chromium updates hover after a layout change on a later frame; let it run. */
async function settleHover(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))
      )
  )
}

const types = (events: Recorded[], target?: string) =>
  events.filter(event => target === undefined || event.target === target).map(event => event.type)

test.describe('Chromium focus rejection (backs chromiumFocusShim)', () => {
  const CASES = [
    {
      name: 'visible control',
      html: '<button id="target">target</button>',
      expected: null,
    },
    {
      name: 'visibility: hidden on an ancestor',
      html: '<div style="visibility: hidden"><button id="target">target</button></div>',
      expected: 'visibility-hidden',
    },
    {
      name: 'visibility: hidden on the element',
      html: '<button id="target" style="visibility: hidden">target</button>',
      expected: 'visibility-hidden',
    },
    {
      name: 'display: none on an ancestor',
      html: '<div style="display: none"><button id="target">target</button></div>',
      expected: 'display-none',
    },
    {
      name: 'inert ancestor',
      html: '<div inert><button id="target">target</button></div>',
      expected: 'inert',
    },
  ] as const

  for (const { name, html, expected } of CASES) {
    test(name, async ({ page }) => {
      await page.setContent(`<button id="before">before</button>${html}`)
      await page.locator('#before').focus()
      const outcome = await page.evaluate(
        ({ source }) => {
          const reject = new Function(`return (${source})`)() as (el: HTMLElement) => string | null
          const target = document.getElementById('target') as HTMLElement
          const shimSays = reject(target)
          target.focus()
          return { shimSays, active: document.activeElement?.id ?? document.activeElement?.tagName }
        },
        { source: chromiumFocusRejection.toString() }
      )
      expect(outcome.active).toBe(expected === null ? 'target' : 'before')
      // The shim's own predicate, run in Chromium, reaches the same verdict.
      expect(outcome.shimSays).toBe(expected)
    })
  }

  test('detached element', async ({ page }) => {
    await page.setContent('<button id="before">before</button>')
    await page.locator('#before').focus()
    const outcome = await page.evaluate(
      ({ source }) => {
        const reject = new Function(`return (${source})`)() as (el: HTMLElement) => string | null
        const target = document.createElement('button')
        const shimSays = reject(target)
        target.focus()
        return { shimSays, active: document.activeElement?.id }
      },
      { source: chromiumFocusRejection.toString() }
    )
    expect(outcome.active).toBe('before')
    expect(outcome.shimSays).toBe('disconnected')
  })

  test('mousedown on a button focuses it before click', async ({ page }) => {
    await page.setContent(
      '<button id="before">before</button><button id="target" style="position:absolute;left:100px;top:100px;width:80px;height:30px">t</button>'
    )
    await page.locator('#before').focus()
    await page.evaluate(() => {
      const target = document.getElementById('target')!
      const log: string[] = []
      ;(window as unknown as { __focusAt: string[] }).__focusAt = log
      for (const type of ['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']) {
        target.addEventListener(type, () => log.push(type))
      }
    })
    await page.mouse.move(140, 115)
    await page.mouse.down()
    const afterDown = await page.evaluate(() => document.activeElement?.id)
    await page.mouse.up()
    const order = await page.evaluate(
      () => (window as unknown as { __focusAt: string[] }).__focusAt
    )
    test.info().annotations.push({ type: 'click order', description: order.join(' → ') })
    expect(afterDown).toBe('target')
    expect(order).toEqual(['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click'])
  })

  test('a right-click focuses the pressed control before contextmenu', async ({ page }) => {
    await page.setContent(
      '<button id="before">before</button><button id="target" style="position:absolute;left:100px;top:100px;width:80px;height:30px">t</button>'
    )
    await page.locator('#before').focus()
    await page.evaluate(() => {
      const target = document.getElementById('target')!
      const log: string[] = []
      ;(window as unknown as { __order: string[] }).__order = log
      for (const type of [
        'pointerdown',
        'mousedown',
        'focus',
        'contextmenu',
        'pointerup',
        'mouseup',
        'auxclick',
        'click',
      ]) {
        target.addEventListener(type, event => {
          log.push(type === 'contextmenu' ? `contextmenu@${document.activeElement?.id}` : type)
          if (type === 'contextmenu') event.preventDefault()
        })
      }
    })
    await page.mouse.move(140, 115)
    await page.mouse.down({ button: 'right' })
    await page.mouse.up({ button: 'right' })
    const order = await page.evaluate(() => (window as unknown as { __order: string[] }).__order)
    test.info().annotations.push({ type: 'right-click order', description: order.join(' → ') })
    expect(order).toEqual([
      'pointerdown',
      'mousedown',
      'focus',
      'contextmenu@target',
      'pointerup',
      'mouseup',
      'auxclick',
    ])
  })
})

test.describe('Chromium pointer events under a still pointer (backs pointerDriver)', () => {
  const BOX = 'position:absolute;width:120px;height:40px'

  // GfsResourceMenu mounts its panel hidden at 0,0 and shows it at its anchor
  // in the next commit: a layout change under the pointer.
  for (const appear of [
    {
      name: 'a panel shown at its anchor after a hidden first paint',
      setup: `${BOX};left:0;top:0;visibility:hidden`,
      change: "t.style.left = '100px'; t.style.top = '100px'; t.style.visibility = 'visible'",
    },
    {
      name: 'an element inserted under the pointer',
      setup: `${BOX};left:100px;top:100px;display:none`,
      change: "t.style.display = 'block'",
    },
  ]) {
    test(`${appear.name} gets boundary events without pointermove`, async ({ page }) => {
      await page.setContent(
        `<div id="bg" style="position:absolute;inset:0"></div>
         <button id="target" style="${appear.setup}">t</button>`
      )
      await installRecorder(page, ['target'])
      // Without a known pointer position Chromium does not update hover at all.
      await page.mouse.move(150, 120)
      await settleHover(page)
      await takeEvents(page)

      await page.evaluate(change => {
        new Function('t', change)(document.getElementById('target'))
      }, appear.change)
      await settleHover(page)
      const appeared = types(await takeEvents(page), 'target')
      test.info().annotations.push({ type: 'appear', description: appeared.join(' → ') })
      expect(appeared).toEqual(['pointerover', 'pointerenter', 'mouseover', 'mouseenter'])

      await page.mouse.move(151, 120)
      const micro = types(await takeEvents(page), 'target')
      test.info().annotations.push({ type: 'micro-move', description: micro.join(' → ') })
      expect(micro).toEqual(['pointermove', 'mousemove'])
    })
  }

  test('a paint-only visibility flip in place updates hover only on the next move', async ({
    page,
  }) => {
    await page.setContent(
      `<div id="bg" style="position:absolute;inset:0"></div>
       <button id="target" style="${BOX};left:100px;top:100px;visibility:hidden">t</button>`
    )
    await installRecorder(page, ['target'])
    await page.mouse.move(150, 120)
    await settleHover(page)
    await takeEvents(page)

    await page.evaluate(() => {
      document.getElementById('target')!.style.visibility = 'visible'
    })
    await settleHover(page)
    expect(types(await takeEvents(page), 'target')).toEqual([])

    await page.mouse.move(151, 120)
    expect(types(await takeEvents(page), 'target')).toEqual([
      'pointerover',
      'pointerenter',
      'mouseover',
      'mouseenter',
      'pointermove',
      'mousemove',
    ])
  })

  test('an element that moves under a still pointer gets boundary events without pointermove', async ({
    page,
  }) => {
    await page.setContent(
      `<div id="bg" style="position:absolute;inset:0"></div>
       <button id="target" style="${BOX};left:400px;top:100px">t</button>`
    )
    await installRecorder(page, ['target'])
    await page.mouse.move(150, 120)
    await settleHover(page)
    await takeEvents(page)

    await page.evaluate(() => {
      document.getElementById('target')!.style.left = '100px'
    })
    await settleHover(page)
    const moved = types(await takeEvents(page), 'target')
    test.info().annotations.push({ type: 'move under pointer', description: moved.join(' → ') })
    expect(moved).toEqual(['pointerover', 'pointerenter', 'mouseover', 'mouseenter'])
  })

  test('a scroll under a still pointer swaps hover without pointermove', async ({ page }) => {
    await page.setContent(
      `<div id="scroller" style="position:absolute;left:100px;top:100px;width:200px;height:40px;overflow:auto">
         <button id="first" style="display:block;width:180px;height:40px">first</button>
         <button id="second" style="display:block;width:180px;height:40px">second</button>
       </div>`
    )
    await installRecorder(page, ['first', 'second'])
    await page.mouse.move(150, 120)
    await settleHover(page)
    await takeEvents(page)

    await page.evaluate(() => {
      document.getElementById('scroller')!.scrollTop = 40
    })
    await settleHover(page)
    const scrolled = await takeEvents(page)
    test.info().annotations.push({
      type: 'still scroll',
      description: scrolled.map(event => `${event.target}:${event.type}`).join(' → '),
    })
    expect(scrolled.map(event => `${event.target}:${event.type}`)).toEqual([
      'first:pointerout',
      'first:pointerleave',
      'second:pointerover',
      'second:pointerenter',
      'first:mouseout',
      'first:mouseleave',
      'second:mouseover',
      'second:mouseenter',
    ])
  })

  test('a real move from A to B starts with a move inside A', async ({ page }) => {
    await page.setContent(
      `<button id="a" style="${BOX};left:100px;top:100px">a</button>
       <button id="b" style="${BOX};left:220px;top:100px">b</button>`
    )
    await installRecorder(page, ['a', 'b'])
    await page.mouse.move(150, 120)
    await settleHover(page)
    await takeEvents(page)

    await page.mouse.move(160, 120)
    await page.mouse.move(260, 120)
    const path = (await takeEvents(page)).map(event => `${event.target}:${event.type}`)
    test.info().annotations.push({ type: 'move A to B', description: path.join(' → ') })
    expect(path).toEqual([
      'a:pointermove',
      'a:mousemove',
      'a:pointerout',
      'a:pointerleave',
      'b:pointerover',
      'b:pointerenter',
      'a:mouseout',
      'a:mouseleave',
      'b:mouseover',
      'b:mouseenter',
      'b:pointermove',
      'b:mousemove',
    ])
  })

  test('removing the element under a still pointer enters the one below without leaving the removed one', async ({
    page,
  }) => {
    await page.setContent(
      `<div id="bg" style="position:absolute;inset:0"></div>
       <button id="share" style="${BOX};left:100px;top:100px">share</button>
       <div id="cover" style="${BOX};left:100px;top:100px"><button id="item" style="width:100%;height:100%">item</button></div>`
    )
    await installRecorder(page, ['share', 'item'])
    await page.mouse.move(150, 120)
    await settleHover(page)
    await takeEvents(page)
    const relatedOf = () =>
      page.evaluate(() => (window as unknown as { __related: string[] }).__related.splice(0))
    await page.evaluate(() => {
      const related: string[] = []
      ;(window as unknown as { __related: string[] }).__related = related
      document.getElementById('share')!.addEventListener('mouseover', event => {
        related.push((event.relatedTarget as Element | null)?.id ?? 'null')
      })
    })

    await page.evaluate(() => document.getElementById('cover')!.remove())
    await settleHover(page)
    const revealed = (await takeEvents(page)).map(event => `${event.target}:${event.type}`)
    test.info().annotations.push({ type: 'cover removed', description: revealed.join(' → ') })
    expect(revealed).toEqual([
      'share:pointerover',
      'share:pointerenter',
      'share:mouseover',
      'share:mouseenter',
    ])
    expect(await relatedOf()).toEqual(['item'])

    await page.mouse.move(151, 120)
    expect(types(await takeEvents(page), 'share')).toEqual(['pointermove', 'mousemove'])
  })
})
