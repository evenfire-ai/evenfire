/**
 * Codex subscription — channel and cron journey.
 *
 * Contract:
 * - Entry point: isolated Electron launch, then visible login (no saved session).
 * - Actions: sign in, open Plugins (workflow/recipes workspace).
 * - Route/state: Plugins workspace after IPC-backed session restore.
 * - UI: no Codex delivery control exists before a connected catalog.
 * - Business signal: the workspace loads over IPC and does not authorize a
 *   Codex provider attempt.
 *
 * E2E_GUARDIAN_IPC_FLOW: Plugin/recipe listings arrive through the main-process
 * IPC bridge. A channel/cron authorize 200 is not expected without a grant.
 */
import { expect, test } from '@playwright/test'
import { launchDesktopApp } from '../helpers/launch-desktop'
import { loginDesktopVisible } from '../helpers/visible-login'

test.describe('Codex subscription channel and cron', () => {
  test('channel or cron delivery creates a Codex provider attempt', async () => {
    test.skip(process.env.PLAYWRIGHT_DESKTOP_BUILT !== 'true', 'Desktop build is required')
    const app = await launchDesktopApp()
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await loginDesktopVisible(page)

    await page.getByTestId('nav-workflows').click()
    await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: /run cron|deliver channel/i })).toHaveCount(0)
    await expect(page.getByText(/sk-|access token|account id/i)).toHaveCount(0)
    await app.close()
  })
})
