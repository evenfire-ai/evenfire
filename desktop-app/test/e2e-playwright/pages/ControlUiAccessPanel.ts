import { type Page, expect } from '@playwright/test'
import { revealInFolderListing } from '../helpers/gfsFolderListing'

type AccessRole = 'Read' | 'Editor'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Operator grant panel in Control UI, driven from a Desktop journey (J6).
 * Labels match `control-ui/components/GfsBrowser.tsx`, `GfsGrantPanel.tsx`,
 * `GfsResourceMenu/index.tsx` and `GfsSubjectPicker/index.tsx`. Each action
 * returns only after the server answered and the panel shows the new state.
 */
export class ControlUiAccessPanel {
  constructor(private readonly page: Page) {}

  async login(username: string, password: string): Promise<void> {
    const signIn = this.page.getByRole('button', { name: 'Sign in', exact: true })
    // E2E_GUARDIAN_NAVIGATION: root-entry — the operator signs in at the Control UI entry
    await this.page.goto('/')
    await expect(signIn).toBeVisible({ timeout: 60_000 })
    await this.page.getByLabel('Username or email').fill(username)
    await this.page.getByLabel('Password').fill(password)
    const login = this.page.waitForResponse(
      response =>
        response.request().method() === 'POST' && response.url().includes('/admin/auth/login')
    )
    await signIn.click()
    expect((await login).ok()).toBe(true)
    await expect(this.page.getByRole('navigation', { name: 'Main sections' })).toBeVisible({
      timeout: 20_000,
    })
  }

  /** Opens the Share panel of the resource at `path` on drive main (D16). */
  async openResource(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean)
    if (!path.startsWith('/') || parts.length === 0 || parts.some(p => p === '.' || p === '..')) {
      throw new Error(`A resource path under the main drive is required, got ${path}`)
    }
    const files = this.page.getByRole('button', { name: 'Files', exact: true })
    await expect(files).toBeVisible()
    if ((await files.getAttribute('aria-expanded')) !== 'true') await files.click()
    await this.page.getByRole('link', { name: 'EvenDrive', exact: true }).click()
    await expect(this.page.getByRole('region', { name: 'EvenDrive browser' })).toBeVisible()
    const resources = this.page.getByRole('list', { name: 'Current folder resources' })
    for (const folder of parts.slice(0, -1)) {
      const children = this.page.waitForResponse(
        response =>
          response.request().method() === 'GET' &&
          /\/gfs\/resources\/[^/]+\/children(?:\?|$)/.test(response.url())
      )
      const folderButton = resources.getByRole('button', { name: folder, exact: true })
      await revealInFolderListing(this.page, folderButton)
      await folderButton.click()
      expect((await children).ok()).toBe(true)
      await expect(this.page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(folder)
    }
    await this.openResourceInCurrentFolder(parts[parts.length - 1]!)
  }

  /** Reopen a resource without leaving the current folder. */
  async openResourceInCurrentFolder(name: string): Promise<void> {
    const resources = this.page.getByRole('list', { name: 'Current folder resources' })
    await resources.getByRole('button', { name: `Actions for ${name}`, exact: true }).click()
    await this.page
      .getByRole('menu', { name: `Actions for ${name}` })
      .getByRole('menuitem', { name: 'Share', exact: true })
      .hover()
    const grantList = this.page.waitForResponse(
      response =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname.endsWith('/gfs/grants')
    )
    await this.page
      .getByRole('menu', { name: `Share options for ${name}` })
      .getByRole('menuitem', { name: 'Share', exact: true })
      .click()
    expect((await grantList).ok()).toBe(true)
    await expect(this.page.getByRole('heading', { name: `Share “${name}”` })).toBeVisible()
  }

  /** Role control of a row. Agents are labelled `<name> (<lifecycle>)`, users by name. */
  roleControl(subject: { label: string } | { agentName: string }) {
    if ('label' in subject) {
      return this.page.getByRole('button', {
        name: `Access role for ${subject.label}`,
        exact: true,
      })
    }
    return this.page.getByRole('button', {
      name: new RegExp(`^Access role for ${escapeRegExp(subject.agentName)} \\(`),
    })
  }

  async expectRole(subject: { label: string } | { agentName: string }, role: AccessRole) {
    await expect(this.roleControl(subject)).toHaveText(role)
  }

  async changeRole(subject: { label: string } | { agentName: string }, role: AccessRole) {
    await this.roleControl(subject).click()
    const put = this.page.waitForResponse(
      response => response.request().method() === 'PUT' && response.url().includes('/gfs/grants')
    )
    await this.page.getByRole('option', { name: role, exact: true }).click()
    expect((await put).ok()).toBe(true)
    await this.expectRole(subject, role)
  }

  async revoke(subject: { label: string } | { agentName: string }): Promise<void> {
    const control = this.roleControl(subject)
    const accessibleName = await control.getAttribute('aria-label')
    if (!accessibleName?.startsWith('Access role for ')) {
      throw new Error(`Access row not found for ${JSON.stringify(subject)}`)
    }
    const label = accessibleName.slice('Access role for '.length)
    await this.page.getByRole('button', { name: `Actions for ${label}`, exact: true }).click()
    await this.page.getByRole('menuitem', { name: 'Remove access', exact: true }).click()
    const confirmation = this.page.getByRole('alertdialog')
    await expect(confirmation).toContainText('Remove access?')
    const del = this.page.waitForResponse(
      response =>
        response.request().method() === 'DELETE' && response.url().includes('/gfs/grants/')
    )
    await confirmation.getByRole('button', { name: 'Remove access', exact: true }).click()
    expect((await del).ok()).toBe(true)
    await expect(control).toHaveCount(0)
  }

  async grant(userLabel: string, role: AccessRole): Promise<void> {
    await this.page
      .getByRole('combobox', { name: 'Add people, teams, agents, or workflows' })
      .fill(userLabel)
    await this.page
      .getByRole('listbox', { name: 'Available grant subjects' })
      .getByRole('option', { name: userLabel, exact: true })
      .click()
    await this.page.getByRole('button', { name: 'Access role for selected recipients' }).click()
    await this.page.getByRole('option', { name: role, exact: true }).click()
    const put = this.page.waitForResponse(
      response => response.request().method() === 'PUT' && response.url().includes('/gfs/grants')
    )
    await this.page.getByRole('dialog').getByRole('button', { name: 'Share', exact: true }).click()
    expect((await put).ok()).toBe(true)
    await this.expectRole({ label: userLabel }, role)
  }
}
