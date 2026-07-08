import { expect, test } from '@playwright/test'
import { humanClick } from '../third-party-authn-first-party-mcphost/telegramE2eClient'
import {
  profilesSql,
  sqlLiteral,
} from '../third-party-authn-first-party-mcphost/workflowApprovalJourney'
import { E2E_EMAIL, launchAndLogin, loginAs } from '../workflowUi'

test.describe('Desktop channel fallback settings', () => {
  test('shows and persists channel fallback preferences from Settings', async () => {
    test.setTimeout(120_000)
    let app: Awaited<ReturnType<typeof launchAndLogin>>['app'] | null = null
    let userId = ''

    try {
      const login = await loginAs(E2E_EMAIL)
      userId = login.userId

      const launched = await launchAndLogin(E2E_EMAIL)
      app = launched.app
      const page = launched.page

      await test.step('Navigate to Settings → Notifications through the shell', async () => {
        const settingsMenu = page.getByTestId('nav-settings-menu')
        await expect(settingsMenu).toBeVisible({ timeout: 20_000 })
        await humanClick(settingsMenu)
        const settingsNav = page.getByTestId('nav-settings')
        await expect(settingsNav).toBeVisible({ timeout: 15_000 })
        await humanClick(settingsNav)
        await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({
          timeout: 15_000,
        })
        await humanClick(page.getByRole('tab', { name: 'Notifications' }))
        await expect(page.getByRole('heading', { name: 'Channel fallback' })).toBeVisible({
          timeout: 15_000,
        })
      })

      await test.step('Toggle fallback preference and verify the business signal in Postgres', async () => {
        const fallbackCheckbox = page.getByRole('checkbox', {
          name: 'Allow Telegram/Slack fallback when desktop delivery is unavailable',
        })
        await expect(fallbackCheckbox).toBeVisible()
        const initialChecked = await fallbackCheckbox.isChecked()
        await humanClick(fallbackCheckbox)
        const channelFallbackSection = page
          .locator('section')
          .filter({ has: page.getByRole('heading', { name: 'Channel fallback' }) })
        await humanClick(channelFallbackSection.getByRole('button', { name: 'Save changes' }))

        await expect
          .poll(
            () => {
              const row = profilesSql(`
                SELECT channel_fallback_enabled::text
                  FROM user_notification_preferences
                 WHERE user_id = ${sqlLiteral(userId)}::uuid
                 LIMIT 1;
              `)
              return row.trim()
            },
            { timeout: 20_000, message: 'channel fallback preference should persist' }
          )
          .toBe(initialChecked ? 'false' : 'true')
      })
    } finally {
      if (app) await app.close().catch(() => undefined)
    }
  })
})
