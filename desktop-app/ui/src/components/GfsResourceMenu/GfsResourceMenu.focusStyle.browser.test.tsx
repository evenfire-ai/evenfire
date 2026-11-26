// @vitest-environment jsdom
/**
 * Keyboard focus on a greyed-out item must not paint it like the live action.
 * jsdom neither matches :focus-visible nor resolves var(--), so the real menu
 * markup (rendered here by the real menu from the real action model) is
 * handed to Chromium together with the real stylesheets, in the order the app
 * loads them, and the computed styles are read there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { buildGfsResourceActions } from '@lib/gfsResourceActions'
import { GfsResourceMenu } from './index'

const URI = 'gfs://main/0123456789abcdef0123456789abcdef'
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function menuMarkup(name: string, allowed: boolean) {
  const actions = buildGfsResourceActions({
    kind: 'file',
    uri: URI,
    moveApplicable: false,
    previewable: false,
    handlers: { rename: vi.fn(), delete: vi.fn() },
    canRename: allowed,
    canDelete: allowed,
  })
  render(
    <GfsResourceMenu
      actions={actions}
      anchor={{ x: 10, y: 10 }}
      permissionStatus="ok"
      resourceName={name}
    />
  )
  const html = screen.getByRole('menu', { name: `Actions for ${name}` }).outerHTML
  cleanup()
  return html
}

type ItemStyle = { focusVisible: boolean; background: string; color: string }

describe('GfsResourceMenu: focus styling of unavailable items in Chromium', () => {
  afterEach(() => vi.restoreAllMocks())

  it('gives a focused greyed-out Delete the neutral focus look, not the live danger tint', async () => {
    const refused = menuMarkup('refused.txt', false)
    const allowed = menuMarkup('allowed.txt', true)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(`<!doctype html><body>${refused}${allowed}</body>`, {
        waitUntil: 'domcontentloaded',
      })
      await page.addStyleTag({ content: readFileSync(path.join(SRC, 'styles.css'), 'utf8') })
      await page.addStyleTag({
        content: readFileSync(path.join(SRC, 'styles/tokens.css'), 'utf8'),
      })
      // Transitions would leave the computed background mid-fade.
      await page.addStyleTag({ content: '* { transition: none !important; }' })

      const styleOf = (menu: string, action: string, focus: boolean) =>
        page.evaluate(
          ([menuName, key, shouldFocus]) => {
            const item = document.querySelector<HTMLElement>(
              `[aria-label="${menuName}"] [data-gfs-action="${key}"]`
            )
            if (!item) throw new Error(`${menuName}: no ${key} item`)
            if (shouldFocus) item.focus()
            else (document.activeElement as HTMLElement | null)?.blur()
            const computed = getComputedStyle(item)
            return {
              focusVisible: item.matches(':focus-visible'),
              background: computed.backgroundColor,
              color: computed.color,
            } satisfies ItemStyle
          },
          [menu, action, focus] as const
        )

      const greyDeleteAtRest = await styleOf('Actions for refused.txt', 'delete', false)
      const greyDelete = await styleOf('Actions for refused.txt', 'delete', true)
      const greyRename = await styleOf('Actions for refused.txt', 'rename', true)
      const liveDelete = await styleOf('Actions for allowed.txt', 'delete', true)

      for (const focused of [greyDelete, greyRename, liveDelete]) {
        expect(focused.focusVisible).toBe(true)
      }
      const liveAtRest = await styleOf('Actions for allowed.txt', 'delete', false)
      expect(liveAtRest.background).not.toBe(liveDelete.background)
      // The live Delete keeps its danger focus tint, so the two differ only
      // because one of them cannot run.
      expect(liveDelete.background).not.toBe(greyRename.background)
      expect(greyDelete.background).toBe(greyRename.background)
      // Its label keeps the danger hue it has at rest.
      expect(greyDelete.color).toBe(greyDeleteAtRest.color)
    } finally {
      await browser.close()
    }
  })
})
