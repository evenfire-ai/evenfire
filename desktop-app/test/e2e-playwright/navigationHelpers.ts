import { type Page, expect } from '@playwright/test'

export async function openResourcesNavItem(page: Page, itemTestId: string): Promise<void> {
  const item = page.getByTestId(itemTestId)
  if (!(await item.isVisible().catch(() => false))) {
    const settingsMenu = page.getByTestId('nav-settings-menu')
    await expect(settingsMenu).toBeVisible({ timeout: 15_000 })
    if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
      await settingsMenu.click()
    }
    await expect(settingsMenu).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 })

    const resourcesMenu = page.getByTestId('nav-data-menu')
    await expect(resourcesMenu).toBeVisible({ timeout: 15_000 })
    if (!(await item.isVisible().catch(() => false))) {
      await resourcesMenu.click()
    }
  }

  await expect(item).toBeVisible({ timeout: 15_000 })
  await item.click()
}

export async function openAgentsPage(page: Page): Promise<void> {
  await openResourcesNavItem(page, 'nav-agents')
}
