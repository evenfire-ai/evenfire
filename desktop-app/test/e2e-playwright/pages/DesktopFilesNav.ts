// E2E_GUARDIAN_IPC_FLOW: Desktop Files transitions are brokered through Electron IPC.
import { type Page, expect } from '@playwright/test'
import { humanRecordedPause } from '../helpers/humanPause'
import { openResourcesNavItem } from '../navigationHelpers'

export class DesktopFilesNav {
  constructor(private readonly page: Page) {}

  async openFiles(): Promise<void> {
    await openResourcesNavItem(this.page, 'nav-files')
    await expect(this.page.getByRole('region', { name: 'EvenDrive browser' })).toBeVisible()
    await humanRecordedPause([600, 1200])
  }

  async openMyHome(): Promise<void> {
    const home = this.page.getByRole('treeitem', { name: 'My home' })
    await expect(home).toBeEnabled({ timeout: 150_000 })
    await home.click()
    await expect(this.page.getByRole('region', { name: 'EvenDrive browser' })).toBeVisible()
    await expect(
      this.page.getByRole('navigation', { name: 'File location' }).locator('[aria-current="page"]')
    ).toBeVisible()
    await humanRecordedPause([600, 1200])
  }

  async expectHomeState(
    state: 'ready' | 'pending' | 'conflict' | 'retired' | 'unavailable'
  ): Promise<void> {
    if (state === 'retired') {
      await expect(this.page.getByRole('treeitem', { name: 'My home' })).toHaveCount(0)
    } else if (state === 'pending') {
      await expect(this.page.getByText('Your home folder is being prepared')).toBeVisible()
    } else if (state === 'conflict') {
      await expect(
        this.page.getByText('Your home folder needs attention from an administrator')
      ).toBeVisible()
    } else if (state === 'ready') {
      await expect(this.page.getByRole('treeitem', { name: 'My home' })).toBeEnabled()
    } else {
      await expect(
        this.page.getByRole('tree', { name: 'File destinations' }).getByRole('alert')
      ).toBeVisible()
    }
  }

  async openSharedWithMe(): Promise<void> {
    await this.page.getByRole('treeitem', { name: 'Shared with me' }).click()
    await expect(
      this.page
        .getByRole('navigation', { name: 'File location' })
        .getByRole('button', { name: 'Shared with me' })
    ).toBeVisible()
    await humanRecordedPause([600, 1200])
  }
}
