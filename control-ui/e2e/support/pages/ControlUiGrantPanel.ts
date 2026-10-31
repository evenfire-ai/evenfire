import { type Page, type Response, expect } from '@playwright/test'
import { revealInFolderListing } from '../../../../desktop-app/test/e2e-playwright/helpers/gfsFolderListing'
import { humanRecordedPause } from '../../../../desktop-app/test/e2e-playwright/helpers/humanPause'
import { openGlobalFileSystemFromSidebar } from '../gfs-control-ui-session'

type AccessRole = 'Read' | 'Editor'

export class ControlUiGrantPanel {
  constructor(private readonly page: Page) {}

  private async openParent(path: string): Promise<string> {
    const parts = path.split('/').filter(Boolean)
    if (
      !path.startsWith('/') ||
      parts.length === 0 ||
      parts.some(part => part === '.' || part === '..')
    ) {
      throw new Error('A resource path under the main drive is required')
    }
    await openGlobalFileSystemFromSidebar(this.page)
    await expect(this.page.getByRole('region', { name: 'EvenDrive browser' })).toBeVisible()
    const root = this.page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('button', { name: 'main', exact: true })
    if ((await root.getAttribute('aria-current')) !== 'page') {
      const response = this.page.waitForResponse(
        result =>
          result.request().method() === 'GET' &&
          new URL(result.url()).pathname.endsWith('/gfs/tree')
      )
      await root.click()
      expect((await response).ok()).toBe(true)
      await expect(root).toHaveAttribute('aria-current', 'page')
    }
    const resources = this.page.getByRole('list', { name: 'Current folder resources' })
    for (const name of parts.slice(0, -1)) {
      const response = this.page.waitForResponse(
        result =>
          result.request().method() === 'GET' &&
          /\/gfs\/resources\/[^/]+\/children(?:\?|$)/.test(result.url())
      )
      const folderButton = resources.getByRole('button', { name, exact: true })
      await revealInFolderListing(this.page, folderButton)
      await folderButton.click()
      expect((await response).ok()).toBe(true)
      await expect(this.page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(name)
    }
    return parts[parts.length - 1]
  }

  async openResource(path: string): Promise<void> {
    const name = await this.openParent(path)
    const resources = this.page.getByRole('list', { name: 'Current folder resources' })
    await resources.getByRole('button', { name: `Actions for ${name}`, exact: true }).click()
    await this.page
      .getByRole('menu', { name: `Actions for ${name}` })
      .getByRole('menuitem', {
        name: 'Share',
        exact: true,
      })
      .hover()
    await this.page
      .getByRole('menu', { name: `Share options for ${name}` })
      .getByRole('menuitem', {
        name: 'Share',
        exact: true,
      })
      .click()
    await expect(
      this.page.getByRole('dialog', { name: new RegExp(`^Share (folder|file) `) })
    ).toBeVisible()
    await expect(this.page.getByRole('heading', { name: `Share “${name}”` })).toBeVisible()
    await humanRecordedPause([600, 1200])
  }

  async openFile(path: string): Promise<void> {
    const name = await this.openParent(path)
    const response = this.page.waitForResponse(
      result =>
        result.request().method() === 'GET' &&
        /\/gfs\/proxy\/v1\/resources\/[^/]+\/content/.test(new URL(result.url()).pathname)
    )
    await this.page
      .getByRole('list', { name: 'Current folder resources' })
      .getByRole('button', { name, exact: true })
      .click()
    expect((await response).ok()).toBe(true)
    await expect(this.page.getByRole('dialog', { name })).toBeVisible()
    await humanRecordedPause([600, 1200])
  }

  async grant(subject: string, role: AccessRole): Promise<void> {
    const response = await this.submitGrant(subject, role)
    expect(response.ok()).toBe(true)
    await this.expectRow(subject, role)
    await humanRecordedPause([600, 1200])
  }

  /** The server refuses the grant with `status`; the dialog shows `message`. */
  async grantRefused(
    subject: string,
    role: AccessRole,
    status: number,
    message: string
  ): Promise<void> {
    const response = await this.submitGrant(subject, role)
    expect(response.status()).toBe(status)
    await expect(
      this.page.getByRole('dialog').getByRole('alert').filter({ hasText: message })
    ).toBeVisible()
    await expect(this.page.getByRole('button', { name: `Access role for ${subject}` })).toHaveCount(
      0
    )
    await humanRecordedPause([600, 1200])
  }

  async close(): Promise<void> {
    const dialog = this.page.getByRole('dialog', { name: /^Share (folder|file) / })
    await dialog.getByRole('button', { name: 'Close share dialog' }).click()
    await expect(dialog).toBeHidden()
    await humanRecordedPause([600, 1200])
  }

  private async submitGrant(subject: string, role: AccessRole): Promise<Response> {
    const picker = this.page.getByRole('combobox', {
      name: 'Add people, teams, agents, or workflows',
    })
    await picker.fill(subject)
    await this.page
      .getByRole('listbox', { name: 'Available grant subjects' })
      .getByRole('option', {
        name: subject,
        exact: true,
      })
      .click()
    await this.page.getByRole('button', { name: 'Access role for selected recipients' }).click()
    await this.page.getByRole('option', { name: role, exact: true }).click()
    const response = this.page.waitForResponse(
      result => result.request().method() === 'PUT' && result.url().includes('/gfs/grants')
    )
    await this.page.getByRole('dialog').getByRole('button', { name: 'Share', exact: true }).click()
    return response
  }

  async changeRole(subject: string, role: AccessRole): Promise<void> {
    await this.page.getByRole('button', { name: `Access role for ${subject}` }).click()
    const response = this.page.waitForResponse(
      result => result.request().method() === 'PUT' && result.url().includes('/gfs/grants')
    )
    await this.page.getByRole('option', { name: role, exact: true }).click()
    expect((await response).ok()).toBe(true)
    await this.expectRow(subject, role)
    await humanRecordedPause([600, 1200])
  }

  async revoke(subject: string): Promise<void> {
    // Scoped to the access list: a home folder named after its user has the
    // same "Actions for <name>" menu in the resource list.
    await this.page
      .getByRole('region', { name: 'People with access' })
      .getByRole('button', { name: `Actions for ${subject}`, exact: true })
      .click()
    await this.page.getByRole('menuitem', { name: 'Remove access', exact: true }).click()
    const confirmation = this.page.getByRole('alertdialog')
    await expect(confirmation).toContainText(subject)
    const response = this.page.waitForResponse(
      result => result.request().method() === 'DELETE' && result.url().includes('/gfs/grants/')
    )
    await confirmation.getByRole('button', { name: 'Remove access', exact: true }).click()
    expect((await response).ok()).toBe(true)
    await expect(this.page.getByRole('button', { name: `Access role for ${subject}` })).toHaveCount(
      0
    )
    await humanRecordedPause([600, 1200])
  }

  async expectRow(subject: string, role: AccessRole): Promise<void> {
    await expect(this.page.getByRole('button', { name: `Access role for ${subject}` })).toHaveText(
      role
    )
  }
}
