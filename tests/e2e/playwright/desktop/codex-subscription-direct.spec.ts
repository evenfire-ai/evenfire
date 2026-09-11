/**
 * Codex subscription — Desktop direct chat journey.
 *
 * Contract:
 * - Entry point: isolated Electron launch, then visible login (no saved session).
 * - Actions: sign in, open Chat, inspect the model selector.
 * - Route/state: Chat workspace after IPC-backed session restore.
 * - UI: Codex models stay absent until an operator-enabled catalog exists.
 * - Business signal: the IPC-backed model list loads without a Codex pick.
 *
 * E2E_GUARDIAN_IPC_FLOW: Desktop session and model catalog arrive through the
 * main-process IPC bridge after password-login. A successful authorize is not
 * expected without a connected subscription.
 */
import { expect, test } from '@playwright/test'
import { launchDesktopApp } from '../helpers/launch-desktop'
import { loginDesktopVisible } from '../helpers/visible-login'

test.describe('Codex subscription desktop direct chat', () => {
  test('desktop chat hides Codex models until a connected catalog exists', async () => {
    test.skip(process.env.PLAYWRIGHT_DESKTOP_BUILT !== 'true', 'Desktop build is required')
    const app = await launchDesktopApp()
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await loginDesktopVisible(page)

    await page.getByTestId('nav-chat').click()
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: /codex/i })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: /codex/i })).toHaveCount(0)
    await app.close()
  })
})
