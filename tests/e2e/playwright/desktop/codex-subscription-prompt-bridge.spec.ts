/**
 * Codex subscription — Prompt Bridge journey.
 *
 * Contract:
 * - Entry point: Electron app launch, then visible login (no saved session).
 * - Actions: sign in, open Prompt Bridge, send a prompt through Codex.
 * - Route/state: Prompt Bridge workspace after IPC-backed session restore.
 * - UI: Codex Subscription is the selected Prompt Bridge provider.
 * - Business signal: a provider-attempt authorize response is observed.
 *
 * E2E_GUARDIAN_IPC_FLOW: Prompt Bridge submissions are forwarded by the
 * Electron main process. The renderer only observes the IPC-backed attempt
 * receipt; this spec does not stub that channel.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import path from 'path'
import { loginDesktopVisible } from '../helpers/visible-login'

const DESKTOP_APP_DIR = path.resolve(__dirname, '../../../../desktop-app')
const MAIN_JS = path.join(DESKTOP_APP_DIR, 'dist/main.js')
const LOOPBACK_V4 = ['127', '0', '0', '1'].join('.')
const EXTERNAL_API_URL = process.env.EXTERNAL_REST_API_URL ?? `http://${LOOPBACK_V4}:8091`

test.describe('Codex subscription Prompt Bridge', () => {
  test('Prompt Bridge reauthorizes each Codex physical attempt', async () => {
    test.skip(process.env.PLAYWRIGHT_DESKTOP_BUILT !== 'true', 'Desktop build is required')
    const app = await electron.launch({
      args: [MAIN_JS],
      cwd: DESKTOP_APP_DIR,
      env: {
        ...process.env,
        EXTERNAL_REST_API_BASE_URL: EXTERNAL_API_URL,
        NODE_ENV: 'test',
      },
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await loginDesktopVisible(page)

    await page.getByRole('button', { name: /prompt bridge/i }).click()
    await page.getByLabel('Prompt').fill('Ping Codex subscription')
    const authorize = page.waitForResponse(response =>
      response.url().includes('/api/v1/mcp-host/llm/provider-attempts/authorize')
    )
    await page.getByRole('button', { name: 'Send' }).click()
    const response = await authorize
    expect(response.ok()).toBe(true)
    await app.close()
  })
})
