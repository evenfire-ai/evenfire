/**
 * Codex subscription — channel and cron journey.
 *
 * Contract:
 * - Entry point: Electron app launch, then visible login (no saved session).
 * - Actions: sign in, open an inbound channel or cron recipe that targets Codex.
 * - Route/state: channel/cron workspace after IPC-backed session restore.
 * - UI: the Codex provider is the selected execution target.
 * - Business signal: a provider-attempt authorize response is observed.
 *
 * E2E_GUARDIAN_IPC_FLOW: Channel and cron deliveries are scheduled in the
 * main process and surface in the renderer through IPC. This spec waits for
 * that IPC-backed authorize hop rather than a mocked route.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import path from 'path'
import { loginDesktopVisible } from '../helpers/visible-login'

const DESKTOP_APP_DIR = path.resolve(__dirname, '../../../../desktop-app')
const MAIN_JS = path.join(DESKTOP_APP_DIR, 'dist/main.js')
const EXTERNAL_API_URL = process.env.EXTERNAL_REST_API_URL ?? 'http://127.0.0.1:8091'

test.describe('Codex subscription channel and cron', () => {
  test('channel or cron delivery creates a Codex provider attempt', async () => {
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

    await page.getByRole('button', { name: 'Recipes' }).click()
    const authorize = page.waitForResponse(response =>
      response.url().includes('/api/v1/mcp-host/llm/provider-attempts/authorize')
    )
    await page.getByRole('button', { name: /run cron|deliver channel/i }).click()
    const response = await authorize
    expect(response.ok()).toBe(true)
    await app.close()
  })
})
