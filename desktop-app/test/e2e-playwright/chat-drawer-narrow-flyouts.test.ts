// desktop-app/test/e2e-playwright/chat-drawer-narrow-flyouts.test.ts
//
// Real-layout guard for the narrow chat DRAWER (min width 340px): the composer
// reference submenu (.composer-reference-submenu) and the agent selector menu
// (.agent-title-selector-menu, incl. its nested submenu) must render fully and
// stay CONFINED to the drawer — not cropped by the drawer's overflow-clipping
// ancestors, and not spilling past the drawer's right edge over the tab content
// to its left (on the apps route that content is the native embed). The unit
// suite runs under jsdom (no layout), so this is the only lane that can assert
// actual on-screen rects. It needs the live external-rest-api + a docked chat
// drawer, so it runs only via `npm run test:e2e:playwright` against a cluster
// port-forward — it is NOT part of the vitest unit suite.
//
// Dock flow: the chat drawer is only available over a NON-chat tab (App.tsx
// `drawerAvailable`; on a chat tab the chat IS the content and the toggle is an
// inert placeholder). So we open a chat with the agent, switch to the Files tab
// — which keeps the active `selectedAgent` (only the chat/agents routes clear
// it, useNavigationController.handleNavSelect), so the real header toggle
// (`chat-drawer-toggle`, HeaderActions) renders — and click it. That docks the
// active conversation into `.chat-drawer` (App.tsx `openChatDrawer`). The
// assertions themselves are harness-independent.
import { expect, test } from './fixtures.js'
import { openResourcesNavItem } from './navigationHelpers.js'
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
    // Open a chat so an agent + conversation is active. On a chat tab the chat
    // IS the content, so the drawer is not available here yet.
    await enterAgentChat(appPage)

    // Switch to the Files tab: a non-chat tab where `drawerAvailable` is true, so
    // the real header toggle renders. Navigating to Files keeps the active agent
    // (only the chat/agents routes clear `selectedAgent`), so docking below
    // surfaces the conversation opened above rather than a blank drawer.
    await openResourcesNavItem(appPage, 'nav-files')

    // Dock the active conversation into the right-side chat drawer via the real
    // header toggle. `toBeVisible()` fails if the affordance is absent — no
    // silent no-op — so the spec can never green without actually reaching the
    // drawer.
    const drawerToggle = appPage.getByTestId('chat-drawer-toggle')
    await expect(drawerToggle).toBeVisible()
    await drawerToggle.click()
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
    // edge (so it is off the content that sits to the drawer's left; on the apps
    // route that content is the native embed).
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

    // Expand a row's sections submenu; confined, it must stay within the drawer.
    await appPage.locator('.agent-title-selector-row-dots').first().click()
    const nested = appPage.locator('.agent-title-selector-submenu')
    await expect(nested).toBeVisible()
    const nestedRect = await rectOf(appPage, '.agent-title-selector-submenu')
    // Confined to the DRAWER, not merely the viewport. Bounding the nested
    // submenu to the drawer's horizontal rect is what distinguishes a
    // drawer-bounded flyout from a viewport-bounded one — the useFlyoutPosition
    // regression where the portaled submenu clamped to the viewport and spilled
    // past the drawer's LEFT edge onto the content to its left. The left bound
    // is the real discriminant: the right-docked drawer sits at the viewport's
    // right edge, so the right bound nearly coincides with viewport width and
    // barely constrains. 1px tolerance on each edge for sub-pixel rounding.
    expect(nestedRect.left).toBeGreaterThanOrEqual(drawerRect.left - 1)
    expect(nestedRect.right).toBeLessThanOrEqual(drawerRect.right + 1)
  })
})
