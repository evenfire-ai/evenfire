/**
 * Codex subscription — Prompt Bridge journey.
 *
 * Contract:
 * - Entry point: isolated Electron launch, then visible login (no saved session).
 * - Actions: sign in, open Apps (Sandbox UI / Prompt Bridge host).
 * - Route/state: Apps workspace after IPC-backed session restore.
 * - UI: the plugin surface must not expose ticket, token, or proxy metadata.
 * - Business signal: Apps load over IPC without a Codex authorize hop.
 *
 * E2E_GUARDIAN_IPC_FLOW: Sandbox UI listings are forwarded by the Electron
 * main process. A Prompt Bridge authorize 200 is not expected without a grant.
 */
import { expect, test } from '@playwright/test'
import { launchDesktopApp } from '../helpers/launch-desktop'
import { loginDesktopVisible } from '../helpers/visible-login'

test.describe('Codex subscription Prompt Bridge', () => {
  test('apps workspace does not expose Codex broker metadata before a grant', async () => {
    test.skip(process.env.PLAYWRIGHT_DESKTOP_BUILT !== 'true', 'Desktop build is required')
    const app = await launchDesktopApp()
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await loginDesktopVisible(page)

    await page.getByTestId('nav-sandbox-ui').click()
    await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/sk-|access token|proxy url|ticket/i)).toHaveCount(0)
    await app.close()
  })
})
