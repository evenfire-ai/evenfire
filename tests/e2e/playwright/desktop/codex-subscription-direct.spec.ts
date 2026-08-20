/**
 * Codex subscription — Desktop direct chat journey.
 *
 * Contract:
 * - Entry point: Electron app launch, then visible login (no saved session).
 * - Actions: sign in, open the agent model picker, choose a Codex model.
 * - Route/state: Agents workspace after IPC-backed session restore.
 * - UI: a Codex subscription model is visible and selectable.
 * - Business signal: a provider-attempt authorize response is observed.
 *
 * E2E_GUARDIAN_IPC_FLOW: Desktop session and model catalog arrive through the
 * main-process IPC bridge after password-login. The Codex model list is an
 * IPC-backed renderer observable, not a mocked route.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import path from 'path'
import { loginDesktopVisible } from '../helpers/visible-login'

const DESKTOP_APP_DIR = path.resolve(__dirname, '../../../../desktop-app')
const MAIN_JS = path.join(DESKTOP_APP_DIR, 'dist/main.js')
const EXTERNAL_API_URL = process.env.EXTERNAL_REST_API_URL ?? 'http://127.0.0.1:8091'

test.describe('Codex subscription desktop direct chat', () => {
  test('desktop can start a Codex subscription attempt from the model picker', async () => {
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

    await expect(page.getByRole('button', { name: 'Agents' })).toBeVisible({ timeout: 20_000 })
    const authorize = page.waitForResponse(response =>
      response.url().includes('/api/v1/mcp-host/llm/provider-attempts/authorize')
    )
    await page.getByRole('button', { name: /codex/i }).click()
    const response = await authorize
    expect(response.ok()).toBe(true)
    await app.close()
  })
})
