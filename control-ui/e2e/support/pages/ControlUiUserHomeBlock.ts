import { type Page, type Response, expect } from '@playwright/test'
import { humanRecordedPause } from '../../../../desktop-app/test/e2e-playwright/helpers/humanPause'

type HomeState = 'pending' | 'ready' | 'conflict' | 'retired'

export class ControlUiUserHomeBlock {
  constructor(private readonly page: Page) {}

  async open(userId: string): Promise<void> {
    await expect(this.page.getByRole('navigation', { name: 'Main sections' })).toBeVisible()
    const isHomeResponse = (result: Response) =>
      result.request().method() === 'GET' && result.url().includes(`/gfs/user-homes/${userId}`)
    const [, response] = await Promise.all([
      // E2E_GUARDIAN_NAVIGATION: user-detail-entry — operator opens this member after login
      this.page.goto(
        `/users-and-teams/users/${
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(userId)?.[0] ??
          (() => {
            throw new Error('Invalid user ID')
          })()
        }`
      ),
      this.page.waitForResponse(isHomeResponse),
    ])
    expect(response.ok()).toBe(true)
    await expect(this.page.getByRole('region', { name: 'Home folder' })).toBeVisible()
    await humanRecordedPause([600, 1200])
  }

  async expectState(state: HomeState, path?: string): Promise<void> {
    const home = this.page.getByRole('region', { name: 'Home folder' })
    await expect(home.getByText(state, { exact: true })).toBeVisible()
    if (path !== undefined) await expect(home.getByText(path, { exact: true })).toBeVisible()
  }

  async retryWithName(name: string): Promise<void> {
    const home = this.page.getByRole('region', { name: 'Home folder' })
    const folderName = home.getByLabel('Folder name')
    await expect(folderName).toBeEditable()
    await folderName.fill(name)
    const response = this.page.waitForResponse(
      result =>
        result.request().method() === 'POST' &&
        /\/gfs\/user-homes\/[^/]+\/retry$/.test(new URL(result.url()).pathname)
    )
    await home.getByRole('button', { name: 'Retry', exact: true }).click()
    const result = await response
    expect(result.ok()).toBe(true)
    expect(result.request().postDataJSON()).toEqual({ storageUsername: name })
    await expect(home.getByText(/^(pending|ready)$/, { exact: true })).toBeVisible()
    await humanRecordedPause([600, 1200])
  }

  async restoreOwner(): Promise<void> {
    const home = this.page.getByRole('region', { name: 'Home folder' })
    const response = this.page.waitForResponse(
      result =>
        result.request().method() === 'POST' &&
        /\/gfs\/user-homes\/[^/]+\/restore-owner$/.test(new URL(result.url()).pathname)
    )
    await home.getByRole('button', { name: 'Restore owner access', exact: true }).click()
    expect((await response).ok()).toBe(true)
    await this.expectState('ready')
    await humanRecordedPause([600, 1200])
  }

  async deleteUser(): Promise<void> {
    await this.page.getByRole('button', { name: 'Delete account…', exact: true }).click()
    const dialog = this.page.getByRole('alertdialog', {
      name: 'Delete member account permanently?',
    })
    await expect(dialog).toBeVisible()
    const response = this.page.waitForResponse(
      result =>
        result.request().method() === 'DELETE' &&
        /\/admin\/users\/[^/]+$/.test(new URL(result.url()).pathname)
    )
    await dialog.getByRole('button', { name: 'Delete account', exact: true }).click()
    expect((await response).ok()).toBe(true)
    await expect(this.page).toHaveURL(/\/users-and-teams\/users(?:\?|$)/)
  }
}
