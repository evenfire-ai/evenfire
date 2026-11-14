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
    await this.ensureExplorerOpen()
    // Only the ready home is a section listing its folders (aria-expanded
    // true); like "Shared with me", one click on its label opens it in Files.
    const home = this.page.getByRole('treeitem', { name: 'My home' })
    await expect(home).toHaveAttribute('aria-expanded', 'true', { timeout: 150_000 })
    await home.getByRole('button', { name: 'My home', exact: true }).click()
    await expect(this.page.getByRole('region', { name: 'EvenDrive browser' })).toBeVisible()
    await expect(
      this.page
        .getByRole('navigation', { name: 'File location' })
        .getByRole('button', { name: 'My home', exact: true })
    ).toHaveAttribute('aria-current', 'page')
    await humanRecordedPause([600, 1200])
  }

  async expectHomeState(
    state: 'ready' | 'pending' | 'conflict' | 'retired' | 'unavailable'
  ): Promise<void> {
    if (state === 'retired') {
      await expect(this.page.getByRole('treeitem', { name: 'My home' })).toHaveCount(0)
    } else if (state === 'pending') {
      await expect(
        this.page
          .getByRole('tree', { name: 'File destinations' })
          .getByText('Your home folder is being prepared')
      ).toBeVisible()
    } else if (state === 'conflict') {
      await expect(
        this.page
          .getByRole('tree', { name: 'File destinations' })
          .getByText('Your home folder needs attention from an administrator')
      ).toBeVisible()
    } else if (state === 'ready') {
      await expect(this.page.getByRole('treeitem', { name: 'My home' })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
    } else {
      await expect(
        this.page.getByRole('tree', { name: 'File destinations' }).getByRole('alert')
      ).toBeVisible()
    }
  }

  /**
   * The Files page overview's "My home" card for a home that is not ready: a
   * status line while it is prepared, an alert for a conflict or a load error.
   */
  async expectFilesHomeState(state: 'pending' | 'conflict' | 'unavailable'): Promise<void> {
    const card = this.page.getByRole('region', { name: 'My home' })
    if (state === 'pending') {
      await expect(
        card.getByRole('status').getByText('Your home folder is being prepared')
      ).toBeVisible()
    } else if (state === 'conflict') {
      await expect(
        card.getByRole('alert').getByText('Your home folder needs attention from an administrator')
      ).toBeVisible()
    } else {
      await expect(card.getByRole('alert')).toBeVisible()
    }
  }

  /**
   * The caller's own home is not shared with them: it is never a row of the
   * "Shared with me" view nor a root of the sidebar "Shared files" tree. The
   * EvenDrive overview shows it in its own "My home" card, and the sidebar
   * lists it as the "My home" section.
   */
  async expectHomeOutsideSharedWithMe(homeFolderName: string): Promise<void> {
    await this.openSharedWithMe()
    const shared = this.page.getByRole('region', { name: 'EvenDrive browser' })
    // Witness: the Shared with me view is the one being inspected.
    await expect(
      shared
        .getByRole('navigation', { name: 'File location' })
        .getByRole('button', { name: 'Shared with me' })
    ).toHaveAttribute('aria-current', 'page')
    await expect(shared.getByText('My home', { exact: true })).toHaveCount(0)
    await expect(shared.getByText(homeFolderName, { exact: true })).toHaveCount(0)
    await expect(this.page.getByRole('region', { name: 'My home' })).toHaveCount(0)
    // The EvenDrive overview adds the home, in its own card.
    await this.openFiles()
    const openHome = this.page
      .getByRole('region', { name: 'My home' })
      .getByRole('button', { name: 'My home', exact: true })
    await expect(openHome).toBeVisible()
    // A home that is not ready shows a disabled "My home" label in the same card.
    await expect(openHome).toBeEnabled()
    await expect(
      this.page
        .getByRole('region', { name: 'EvenDrive browser' })
        .getByText(homeFolderName, { exact: true })
    ).toHaveCount(0)
    await expect(
      this.page.getByRole('tree', { name: 'File destinations' }).getByRole('treeitem', {
        name: 'My home',
      })
    ).toBeVisible()
    await expect(
      this.page
        .getByRole('tree', { name: 'Shared files' })
        .getByRole('treeitem', { name: homeFolderName, exact: true })
    ).toHaveCount(0)
    await humanRecordedPause([600, 1200])
  }

  async openSharedWithMe(): Promise<void> {
    await this.ensureExplorerOpen()
    await this.page.getByRole('treeitem', { name: 'Shared with me' }).click()
    await expect(
      this.page
        .getByRole('navigation', { name: 'File location' })
        .getByRole('button', { name: 'Shared with me' })
    ).toHaveAttribute('aria-current', 'page')
    await humanRecordedPause([600, 1200])
  }

  private async ensureExplorerOpen(): Promise<void> {
    const toggle = this.page.getByTestId('nav-files-explorer-toggle')
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  }
}
