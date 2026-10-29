import { type Page, type Response, expect } from '@playwright/test'
import { humanRecordedPause } from '../../../../desktop-app/test/e2e-playwright/helpers/humanPause'

type HomeState = 'pending' | 'ready' | 'conflict' | 'retired'

export class ControlUiUserHomeBlock {
  /** State in the last home response the field rendered (the GET on open, or a retry/restore). */
  private respondedState: HomeState | undefined

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
    this.respondedState = ((await response.json()) as { home: { state: HomeState } }).home.state
    await expect(this.page.getByRole('region', { name: 'Home folder' })).toBeVisible()
    await humanRecordedPause([600, 1200])
  }

  /**
   * The field shows one line per state, never the raw state word: the home path when it is
   * ready (and for a bound conflict), "Being created…"/"Still pending" while pending, the
   * retired line, and a warn status banner for a conflict.
   */
  async expectState(state: HomeState, path?: string): Promise<void> {
    // The response decides the state; the visible line below proves the field rendered it.
    expect(this.respondedState, 'state in the home response the field rendered').toBe(state)
    const home = this.page.getByRole('region', { name: 'Home folder' })
    const banner = home.locator('.cu-banner--warn[role="status"]')
    if (state === 'ready') {
      if (path === undefined) throw new Error('A ready home is asserted by its path')
      // Positive witness first: the path line is on screen, then no conflict banner.
      await expect(home.getByText(path, { exact: true })).toBeVisible()
      await expect(banner).toHaveCount(0)
      return
    }
    if (state === 'pending') {
      await expect(home.getByText(/^(Being created…|Still pending)$/)).toBeVisible()
      return
    }
    if (state === 'retired') {
      await expect(
        home.getByText('Retired — files kept for operators', { exact: true })
      ).toBeVisible()
      return
    }
    await expect(banner).toBeVisible()
    if (path !== undefined) await expect(home.getByText(path, { exact: true })).toBeVisible()
  }

  async retryWithName(name: string): Promise<void> {
    const home = this.page.getByRole('region', { name: 'Home folder' })
    await home.getByRole('button', { name: 'Retry with another name…', exact: true }).click()
    const dialog = this.page.getByRole('dialog', { name: 'Retry with another name' })
    await expect(dialog).toBeVisible()
    const folderName = dialog.getByLabel('Folder name')
    await expect(folderName).toBeEditable()
    await folderName.fill(name)
    const response = this.page.waitForResponse(
      result =>
        result.request().method() === 'POST' &&
        /\/gfs\/user-homes\/[^/]+\/retry$/.test(new URL(result.url()).pathname)
    )
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click()
    const result = await response
    expect(result.ok()).toBe(true)
    expect(result.request().postDataJSON()).toEqual({ storageUsername: name })
    await expect(dialog).toBeHidden()
    const body = (await result.json()) as { home: { state: HomeState; path: string | null } }
    this.respondedState = body.home.state
    await this.expectState(body.home.state, body.home.path ?? undefined)
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
    const result = await response
    expect(result.ok()).toBe(true)
    const body = (await result.json()) as { home: { state: HomeState; path: string | null } }
    expect(body.home.state).toBe('ready')
    this.respondedState = body.home.state
    await this.expectState('ready', body.home.path ?? undefined)
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
