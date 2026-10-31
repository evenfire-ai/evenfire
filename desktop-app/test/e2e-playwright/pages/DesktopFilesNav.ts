// E2E_GUARDIAN_IPC_FLOW: Desktop Files transitions are brokered through Electron IPC.
import { type Page, expect } from '@playwright/test'
import { humanRecordedPause } from '../helpers/humanPause'
import { openResourcesNavItem } from '../navigationHelpers'

export class DesktopFilesNav {
  constructor(private readonly page: Page) {}

  async openFiles(): Promise<void> {
    await openResourcesNavItem(this.page, 'nav-files')
    await expect(this.page.getByRole('heading', { name: 'Files', level: 2 })).toBeVisible()
    await humanRecordedPause([600, 1200])
  }

  async openMyHome(): Promise<void> {
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
      await expect(this.page.getByText('Your home folder is being prepared')).toBeVisible()
    } else if (state === 'conflict') {
      await expect(
        this.page.getByText('Your home folder needs attention from an administrator')
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
    await expect(
      this.page
        .getByRole('region', { name: 'My home' })
        .getByRole('button', { name: 'My home', exact: true })
    ).toBeVisible()
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

  /** The EvenDrive overview: the files tab with no folder selected. */
  async openEvenDriveOverview(): Promise<void> {
    await this.openFiles()
    await expect(this.page.getByRole('region', { name: 'My home' })).toBeVisible()
    await expect(this.recentFiles()).toBeVisible()
    await humanRecordedPause([600, 1200])
  }

  recentFiles(): ReturnType<Page['getByRole']> {
    return this.page.getByRole('region', { name: 'Recent files' })
  }

  /** The card's rows: `aria-label="Open <name>"`, never its inner name button. */
  recentRows(): ReturnType<Page['getByRole']> {
    return this.recentFiles().getByRole('button', { name: /^Open / })
  }

  /** The overview shows at most ten recent names, subject to available space. */
  async expectRecentFiles(names: string[]): Promise<void> {
    await this.openEvenDriveOverview()
    await expect(this.recentFiles()).toHaveAttribute('aria-busy', 'false')
    await expect(this.recentRows()).toHaveCount(names.length)
    await expect
      .poll(() =>
        this.recentRows().evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')))
      )
      .toEqual(names.map(name => `Open ${name}`))
    await humanRecordedPause([400, 800])
  }

  async expectNoRecentFiles(): Promise<void> {
    await this.openEvenDriveOverview()
    await expect(this.recentFiles()).toHaveAttribute('aria-busy', 'false')
    await expect(this.recentFiles().getByText('No recent files', { exact: true })).toBeVisible()
    await expect(this.recentRows()).toHaveCount(0)
    await humanRecordedPause([400, 800])
  }

  async openRecentFile(name: string): Promise<void> {
    await this.recentFiles()
      .getByRole('button', { name: `Open ${name}`, exact: true })
      .click()
    await humanRecordedPause([600, 1200])
  }

  /**
   * The card is overview-only. The Shared with me view is asserted through its
   * own active crumb, so a card rendered there would be caught.
   */
  async expectNoRecentCardInSharedWithMe(): Promise<void> {
    await this.openSharedWithMe()
    await expect(this.recentFiles()).toHaveCount(0)
    await humanRecordedPause([400, 800])
  }

  async openSharedWithMe(): Promise<void> {
    await this.page.getByRole('treeitem', { name: 'Shared with me' }).click()
    await expect(
      this.page
        .getByRole('navigation', { name: 'File location' })
        .getByRole('button', { name: 'Shared with me' })
    ).toHaveAttribute('aria-current', 'page')
    await humanRecordedPause([600, 1200])
  }
}
