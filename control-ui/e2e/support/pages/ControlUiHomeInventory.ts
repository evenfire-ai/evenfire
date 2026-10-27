import { type Page, expect } from '@playwright/test'

type HomeState = 'pending' | 'ready' | 'conflict' | 'retired'

export class ControlUiHomeInventory {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    const response = this.page.waitForResponse(
      result =>
        result.request().method() === 'GET' &&
        new URL(result.url()).pathname.endsWith('/gfs/user-homes')
    )
    const files = this.page.getByRole('button', { name: 'Files', exact: true })
    await expect(files).toBeVisible()
    if ((await files.getAttribute('aria-expanded')) !== 'true') await files.click()
    await this.page.getByRole('link', { name: 'Home folders', exact: true }).click()
    expect((await response).ok()).toBe(true)
    await expect(this.page).toHaveURL(/\/global-file-system\/user-homes(?:\?|$)/)
    await expect(this.page.getByRole('table', { name: 'Home folders' })).toBeVisible()
  }

  async filter(state: HomeState): Promise<void> {
    const response = this.page.waitForResponse(
      result =>
        result.request().method() === 'GET' &&
        new URL(result.url()).pathname.endsWith('/gfs/user-homes') &&
        new URL(result.url()).searchParams.get('state') === state
    )
    await this.page.getByLabel('Home state').selectOption(state)
    expect((await response).ok()).toBe(true)
    await expect(this.page.getByLabel('Home state')).toHaveValue(state)
  }

  async expectUserListed(userId: string, state: HomeState): Promise<void> {
    const link = this.page.getByRole('link', { name: userId, exact: true })
    for (let pageNumber = 0; pageNumber < 1_000 && (await link.count()) === 0; pageNumber += 1) {
      const next = this.page.getByRole('button', { name: 'Next', exact: true })
      await expect(next, `Home for ${userId} was not found in the inventory`).toBeEnabled()
      const response = this.page.waitForResponse(
        result =>
          result.request().method() === 'GET' &&
          new URL(result.url()).pathname.endsWith('/gfs/user-homes')
      )
      await next.click()
      expect((await response).ok()).toBe(true)
      await expect(
        this.page.getByRole('table', { name: 'Home folders' }).getByText('Loading home folders…')
      ).toHaveCount(0)
    }
    const row = this.page.getByRole('row').filter({ has: link })
    await expect(row).toBeVisible()
    await expect(row.getByText(state, { exact: true })).toBeVisible()
  }

  async openUser(userId: string): Promise<void> {
    const response = this.page.waitForResponse(
      result =>
        result.request().method() === 'GET' &&
        new URL(result.url()).pathname.endsWith(`/gfs/user-homes/${userId}`)
    )
    await this.page.getByRole('link', { name: userId, exact: true }).click()
    expect((await response).ok()).toBe(true)
    await expect(this.page.getByRole('region', { name: 'Home folder' })).toBeVisible()
  }
}
