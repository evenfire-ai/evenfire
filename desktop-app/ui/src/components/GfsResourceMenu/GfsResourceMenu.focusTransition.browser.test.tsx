// @vitest-environment node
/**
 * A focused menu item that becomes inert while the menu is open must keep
 * focus. jsdom does not apply Chromium's rule that a focused control blurs
 * when it becomes natively disabled, so the real sidebar row menu (see
 * `src/test/GfsResourceMenuFocusHarness.tsx`) is mounted in Chromium through
 * the app's own Vite config and moved between states there.
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Page, chromium } from 'playwright'
import { type Plugin, createServer } from 'vite'

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const HARNESS_PATH = '/gfs-resource-menu-focus.html'
const HARNESS_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>GfsResourceMenu focus</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/test/GfsResourceMenuFocusHarness.tsx"></script>
  </body>
</html>`

// Served from memory so the harness page never becomes a build input.
const serveHarness: Plugin = {
  name: 'gfs-resource-menu-focus-harness',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== HARNESS_PATH) return next()
      const html = await server.transformIndexHtml(req.url, HARNESS_HTML)
      res.setHeader('Content-Type', 'text/html')
      res.end(html)
    })
  },
}

type MenuState = {
  writable: boolean
  permissionStatus: 'ok' | 'pending' | 'error'
  mutating: boolean
}

async function withMenu(initial: MenuState, run: (page: Page) => Promise<void>) {
  const vite = await createServer({
    configFile: path.join(UI_ROOT, 'vite.config.ts'),
    plugins: [serveHarness],
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Vite test server did not bind')
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    page.setDefaultTimeout(15_000)
    const params = new URLSearchParams({
      writable: String(initial.writable),
      status: initial.permissionStatus,
      mutating: String(initial.mutating),
    })
    await page.goto(`http://127.0.0.1:${address.port}${HARNESS_PATH}?${params}`)
    await page.getByRole('menu', { name: 'Actions for notes.md' }).waitFor()
    await page.waitForFunction(() => window.__gfsMenuFocus !== undefined)
    await run(page)
  } finally {
    await browser?.close()
    await vite.close()
  }
}

const focusRename = (page: Page) =>
  page.evaluate(() => {
    const rename = document.querySelector<HTMLElement>('[data-gfs-action="rename"]')
    if (!rename) throw new Error('no Rename item')
    rename.focus()
    return document.activeElement === rename
  })

/** Moves the menu to `next`, then reads focus after two animation frames. */
const settleInto = (page: Page, next: MenuState) =>
  page.evaluate(async state => {
    const before = document.querySelector('[data-gfs-action="rename"]')
    await window.__gfsMenuFocus!.setState(state)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const rename = document.querySelector<HTMLButtonElement>('[data-gfs-action="rename"]')
    const active = document.activeElement
    return {
      sameNode: rename === before,
      focusedOnRename: active === rename,
      activeTag: active?.tagName ?? null,
      ariaDisabled: rename?.getAttribute('aria-disabled') ?? null,
      nativeDisabled: rename?.disabled ?? null,
      title: rename?.getAttribute('title') ?? null,
    }
  }, next)

const nextAfterRename = (page: Page) =>
  page.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[aria-label="Actions for notes.md"] [role="menuitem"]'
      )
    )
    const index = items.findIndex(item => item.getAttribute('data-gfs-action') === 'rename')
    return items[index + 1]?.getAttribute('data-gfs-action') ?? null
  })

const activeAction = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute('data-gfs-action') ?? null)

describe('GfsResourceMenu: focus across an inert transition in Chromium', () => {
  it.each([
    { from: 'refused bits', initial: { writable: false, permissionStatus: 'ok' } as const },
    { from: 'pending bits', initial: { writable: true, permissionStatus: 'pending' } as const },
  ])(
    'keeps focus on Rename when it leaves $from while a change is in flight',
    async ({ initial }) => {
      await withMenu({ ...initial, mutating: true }, async page => {
        expect(await focusRename(page)).toBe(true)

        const settled = await settleInto(page, {
          writable: true,
          permissionStatus: 'ok',
          mutating: true,
        })

        expect(settled).toEqual({
          sameNode: true,
          focusedOnRename: true,
          activeTag: 'BUTTON',
          ariaDisabled: 'true',
          nativeDisabled: false,
          title: null,
        })
        const expectedNext = await nextAfterRename(page)
        expect(expectedNext).not.toBeNull()
        await page.keyboard.press('ArrowDown')
        expect(await activeAction(page)).toBe(expectedNext)
        await page.keyboard.press('ArrowUp')
        expect(await activeAction(page)).toBe('rename')
        await page.keyboard.press('Enter')
        await page.keyboard.press('Space')
        expect(await page.evaluate(() => window.__gfsMenuFocus!.calls)).toEqual([])
        await page.getByRole('menu', { name: 'Actions for notes.md' }).waitFor()
        // The same keys run Rename once the change has finished.
        await settleInto(page, { writable: true, permissionStatus: 'ok', mutating: false })
        await page.keyboard.press('Enter')
        expect(await page.evaluate(() => window.__gfsMenuFocus!.calls)).toEqual(['rename'])
      })
    }
  )

  it('keeps focus on an enabled Rename when a change starts', async () => {
    await withMenu({ writable: true, permissionStatus: 'ok', mutating: false }, async page => {
      expect(await focusRename(page)).toBe(true)

      const settled = await settleInto(page, {
        writable: true,
        permissionStatus: 'ok',
        mutating: true,
      })

      expect(settled).toEqual({
        sameNode: true,
        focusedOnRename: true,
        activeTag: 'BUTTON',
        ariaDisabled: 'true',
        nativeDisabled: false,
        title: null,
      })
      const expectedNext = await nextAfterRename(page)
      await page.keyboard.press('ArrowDown')
      expect(await activeAction(page)).toBe(expectedNext)
    })
  })
})
