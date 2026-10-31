// E2E_GUARDIAN_IPC_FLOW: Share mutations are brokered through Electron IPC.
import { type Page, expect } from '@playwright/test'
import { humanRecordedPause } from '../helpers/humanPause'

export class DesktopShareDialog {
  constructor(private readonly page: Page) {}

  private row(subjectLabel: string) {
    return this.page
      .getByRole('list', { name: 'Resource access' })
      .getByRole('listitem')
      .filter({ has: this.page.getByText(subjectLabel, { exact: true }) })
  }

  async close(): Promise<void> {
    const dialog = this.page.getByRole('dialog', { name: /^Share (folder|file) / })
    await dialog.getByRole('button', { name: 'Close share dialog', exact: true }).click()
    await expect(dialog).toBeHidden()
  }

  async grant(
    subjectLabel: string,
    role: 'Read' | 'Editor',
    options: { includeContents: boolean }
  ): Promise<void> {
    const picker = this.page.getByRole('combobox', { name: 'Add people, teams, or agents' })
    await picker.fill(subjectLabel)
    await this.page
      .getByRole('listbox', { name: 'Available people, teams, and agents' })
      .getByRole('option')
      .filter({ has: this.page.getByText(subjectLabel, { exact: true }) })
      .click()
    await this.page.getByRole('button', { name: 'Access role for selected recipients' }).click()
    await this.page.getByRole('option', { name: role, exact: true }).click()
    const contents = this.page.getByRole('checkbox', { name: 'Include contents of this folder' })
    if (options.includeContents) await contents.check()
    else if (await contents.count()) await contents.uncheck()
    await this.page.getByRole('dialog').getByRole('button', { name: 'Share', exact: true }).click()
    await expect(this.row(subjectLabel)).toBeVisible()
    await humanRecordedPause([600, 1200])
  }

  async changeRole(subjectLabel: string, role: 'Read' | 'Editor'): Promise<void> {
    const row = this.row(subjectLabel)
    const inherited = (await row.getAttribute('data-inherited')) === 'true'
    await row.getByRole('button', { name: `Access role for ${subjectLabel}` }).click()
    await this.page.getByRole('option', { name: role, exact: true }).click()
    if (inherited) {
      const confirmation = this.page.getByRole('alertdialog', {
        name: 'Update role on parent folder?',
      })
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: 'Update role' }).click()
      await expect(confirmation).toBeHidden()
    }
    await expect(
      row.getByRole('button', { name: `Access role for ${subjectLabel}` })
    ).toContainText(role)
    await humanRecordedPause([600, 1200])
  }

  /** D26: an Editor-strength share row offers only "Read"; afterwards it is text. */
  async lowerShare(subjectLabel: string): Promise<void> {
    const row = this.row(subjectLabel)
    const role = row.getByRole('button', { name: `Access role for ${subjectLabel}` })
    await expect(role).toContainText('Editor')
    await role.click()
    await this.page.getByRole('option', { name: 'Read', exact: true }).click()
    await expect(role).toHaveCount(0)
    await expect(row).toContainText('Read')
    await humanRecordedPause([600, 1200])
  }

  async revoke(subjectLabel: string): Promise<void> {
    const row = this.row(subjectLabel)
    const inherited = (await row.getAttribute('data-inherited')) === 'true'
    await row.getByRole('button', { name: `Actions for ${subjectLabel}` }).click()
    await this.page
      .getByRole('menu', { name: `Actions for ${subjectLabel}` })
      .getByRole('menuitem', { name: 'Remove access' })
      .click()
    if (inherited) {
      const confirmation = this.page.getByRole('alertdialog', {
        name: 'Remove from parent folder?',
      })
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: 'Remove', exact: true }).click()
      await expect(confirmation).toBeHidden()
    }
    await expect(row).toHaveCount(0)
    await humanRecordedPause([600, 1200])
  }

  async expectRow(
    subjectLabel: string,
    role: 'Read' | 'Editor',
    inherited: boolean
  ): Promise<void> {
    const row = this.row(subjectLabel)
    await expect(row).toBeVisible()
    await expect(row).toContainText(role)
    if (inherited) await expect(row).toHaveAttribute('data-inherited', 'true')
  }

  async expectNoRevoke(subjectLabel: string): Promise<void> {
    const row = this.row(subjectLabel)
    await expect(row).toBeVisible()
    await expect(row.getByRole('button', { name: `Actions for ${subjectLabel}` })).toHaveCount(0)
  }
}
