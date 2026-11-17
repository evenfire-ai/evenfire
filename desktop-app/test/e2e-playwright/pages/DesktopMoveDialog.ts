// E2E_GUARDIAN_IPC_FLOW: Move destinations and the commit are brokered through Electron IPC.
import { type Page, expect } from '@playwright/test'
import { humanRecordedPause } from '../helpers/humanPause'

/**
 * Destination picker of the Files Move dialog.
 *
 * The caller's home is offered under its own "My home" tree, apart from the
 * "Shared with me" roots: the home is never shared with its owner, so listing
 * it among the shared roots would offer a destination the section label
 * contradicts, and hiding it without a section would leave a user whose only
 * accessible folder is their home with no destination at all.
 *
 * Markup owned by `gfs/moveDialog.tsx`: the dialog is `Move <kind> <name>`, the
 * home tree is `aria-label="My home destination"`, the shared tree keeps
 * `aria-label="EvenDrive destination folders"`, and the commit button is
 * `Move here (<destination>)`.
 */
export class DesktopMoveDialog {
  constructor(private readonly page: Page) {}

  private dialog() {
    return this.page.getByRole('dialog', { name: /^Move (folder|file) / })
  }

  private myHomeTree() {
    return this.dialog().getByRole('tree', { name: 'My home destination' })
  }

  private sharedTree() {
    return this.dialog().getByRole('tree', { name: 'EvenDrive destination folders' })
  }

  /**
   * Root state of the picker: the home is offered by its own label, the shared
   * listing settled (this caller has nothing shared with them), and the home is
   * never offered under its storage folder name.
   */
  async expectDestinations(homeFolderName: string): Promise<void> {
    const dialog = this.dialog()
    await expect(dialog).toBeVisible()
    // Witnesses: the home destination exists, and the shared listing answered.
    await expect(this.myHomeTree().getByRole('treeitem', { name: /My home/ })).toBeVisible({
      timeout: 30_000,
    })
    await expect(this.sharedTree().getByText('No folders here.', { exact: true })).toBeVisible({
      timeout: 30_000,
    })
    // Negative: the home is not listed as a shared root under its folder name.
    await expect(this.sharedTree().getByText(homeFolderName, { exact: true })).toHaveCount(0)
    await humanRecordedPause([600, 1200])
  }

  /** Select `name` in the My home tree, then commit the move. */
  async moveTo(name: string): Promise<void> {
    const dialog = this.dialog()
    await this.myHomeTree().getByRole('button', { name, exact: true }).click()
    const confirm = dialog.getByRole('button', { name: `Move here (${name})`, exact: true })
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect(dialog).toBeHidden({ timeout: 60_000 })
    await humanRecordedPause([600, 1200])
  }
}
