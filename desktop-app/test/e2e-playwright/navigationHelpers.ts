import { type Page, expect } from '@playwright/test'

export async function openResourcesNavItem(page: Page, itemTestId: string): Promise<void> {
  const item = page.getByTestId(itemTestId)
  // Top-level items (e.g. nav-files) are always visible; the data items
  // (nav-agents / nav-mcp-servers / nav-workflows) now hang directly off the
  // footer Settings popover — there is no intermediate "Resources" submenu.
  if (!(await item.isVisible().catch(() => false))) {
    const settingsMenu = page.getByTestId('nav-settings-menu')
    await expect(settingsMenu).toBeVisible({ timeout: 15_000 })
    if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
      await settingsMenu.click()
    }
    await expect(settingsMenu).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 })
  }

  await expect(item).toBeVisible({ timeout: 15_000 })
  await item.click()
}

export async function openAgentsPage(page: Page): Promise<void> {
  await openResourcesNavItem(page, 'nav-agents')
}
