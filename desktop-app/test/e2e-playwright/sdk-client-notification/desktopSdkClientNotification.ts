import { type Page, expect } from '@playwright/test'
import { humanClick } from '../third-party-authn-first-party-mcphost/telegramE2eClient'

export async function expectDesktopSdkNotificationInBell(
  page: Page,
  recipeName: string,
  notificationBody: string
): Promise<void> {
  const bell = page.getByTestId('notification-bell')
  await expect(bell).toBeVisible({ timeout: 20_000 })
  if ((await bell.getAttribute('aria-expanded')) !== 'true') {
    await humanClick(bell)
  }

  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  await expect(panel).toBeVisible({ timeout: 10_000 })

  const sdkItem = panel
    .getByTestId('notification-menu-item')
    .filter({ hasText: recipeName })
    .filter({ hasText: notificationBody })
    .first()

  await expect(sdkItem).toBeVisible({ timeout: 60_000 })
  await expect(sdkItem).toContainText('Plugin notification')
}
