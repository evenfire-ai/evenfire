// desktop-app/test/e2e-playwright/chat-drawer-narrow-flyouts.test.ts
//
// Real-layout guard for the narrow chat DRAWER (min width 340px): the composer
// reference submenu (.composer-reference-submenu) and the agent selector menu
// (.agent-title-selector-menu, incl. its nested submenu) must render fully and be
// operable, not cropped by the drawer's overflow-clipping ancestors or occluded
// by the native embed that paints to the drawer's left. The unit suite runs under
// jsdom (no layout), so this is the only lane that can assert actual on-screen
// rects. It needs the live external-rest-api + a docked chat drawer, so it runs
// only via `npm run test:e2e:playwright` against a cluster port-forward — it is
// NOT part of the vitest unit suite.
//
// NOTE (unrun): the "dock a chat into the drawer" step below depends on the
// packaged app's docked-drawer entry flow, which cannot be validated here without
// a live cluster. Confirm the dock affordance (the `dock-chat-drawer` testid used
// below) against the real harness before relying on this spec; the assertions
// themselves are harness-independent.
import { expect, test } from './fixtures.js'
import { enterChatllmChat as enterAgentChat } from './workflowAgentChatTools.js'

const DRAWER = '.chat-drawer'
const DRAWER_SURFACE = '.chat-drawer__surface'
const RESIZE_HANDLE = '.chat-drawer__resize-handle'

type Rect = { left: number; right: number; top: number; bottom: number; width: number }

async function rectOf(page: import('@playwright/test').Page, selector: string): Promise<Rect> {
  return page
    .locator(selector)
    .first()
    .evaluate(el => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }
    })
}

/**
 * Shrink the drawer to its 340px minimum via the keyboard-operable resize handle
 * (ARIA separator pattern, aria-valuemin=340). Left-arrow widens a right-docked
 * drawer, Right-arrow narrows it; hold Right until it stops moving (pinned to min).
 */
async function shrinkDrawerToMinimum(page: import('@playwright/test').Page): Promise<void> {
  const handle = page.locator(RESIZE_HANDLE)
  await expect(handle).toBeVisible()
  await handle.focus()
  let previous = -1
  for (let i = 0; i < 60; i += 1) {
    const width = (await rectOf(page, DRAWER)).width
    if (width === previous) break
    previous = width
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(16)
  }
}

test.describe('narrow chat drawer flyouts', () => {
  test('composer submenu and agent menu render fully inside the 340px drawer', async ({
    appPage,
  }) => {
    await enterAgentChat(appPage)
    // Dock the active conversation into the right-side chat drawer. Replace with
    // the harness's real dock affordance if this id differs.
    const dockButton = appPage.locator('[data-testid="dock-chat-drawer"]')
    if (await dockButton.count()) {
      await dockButton.first().click()
    }
    await expect(appPage.locator(DRAWER)).toBeVisible()

    await shrinkDrawerToMinimum(appPage)
    const drawerRect = await rectOf(appPage, DRAWER)
    expect(Math.round(drawerRect.width)).toBeLessThanOrEqual(360) // ~340 + rounding

    const viewport = appPage.viewportSize()
    const viewportWidth = viewport?.width ?? (await appPage.evaluate(() => window.innerWidth))

    // The drawer surface never overflows horizontally (the scroll-fix contract).
    const surfaceOverflow = await appPage.locator(DRAWER_SURFACE).evaluate(el => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }))
    expect(surfaceOverflow.scrollWidth).toBeLessThanOrEqual(surfaceOverflow.clientWidth)

    // --- Composer reference submenu ---
    await appPage.locator('.chat-drawer [aria-label="Add context"]').click()
    await appPage.getByRole('menuitem', { name: /Plugins/ }).hover()
    const submenu = appPage.locator('.composer-reference-submenu')
    await expect(submenu).toBeVisible()
    const submenuRect = await rectOf(appPage, '.composer-reference-submenu')
    // Fully on screen: within the viewport and to the right of the drawer's left
    // edge (so it is off the embed that sits to the drawer's left).
    expect(submenuRect.left).toBeGreaterThanOrEqual(0)
    expect(submenuRect.right).toBeLessThanOrEqual(viewportWidth)
    expect(submenuRect.left).toBeGreaterThanOrEqual(drawerRect.left - 1)
    await appPage.keyboard.press('Escape')

    // --- Agent selector menu + nested sections submenu ---
    await appPage.locator('.chat-drawer .agent-title-selector-trigger').first().click()
    const menu = appPage.locator('.agent-title-selector-menu')
    await expect(menu).toBeVisible()
    const menuRect = await rectOf(appPage, '.agent-title-selector-menu')
    expect(menuRect.left).toBeGreaterThanOrEqual(0)
    expect(menuRect.right).toBeLessThanOrEqual(viewportWidth)

    // Expand a row's sections submenu; confined, it must stay within the menu.
    await appPage.locator('.agent-title-selector-row-dots').first().click()
    const nested = appPage.locator('.agent-title-selector-submenu')
    await expect(nested).toBeVisible()
    const nestedRect = await rectOf(appPage, '.agent-title-selector-submenu')
    expect(nestedRect.left).toBeGreaterThanOrEqual(0)
    expect(nestedRect.right).toBeLessThanOrEqual(viewportWidth)
  })
})
