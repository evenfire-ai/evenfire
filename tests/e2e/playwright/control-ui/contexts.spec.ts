/**
 * Control UI — Contexts section removal tests
 *
 * The /contexts section is gone from the UI; legacy deep links resolve
 * client-side to user-facing destinations instead of dead-ending.
 */
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD } from '../helpers/selectors'

const CONTROL_UI_URL = process.env.CONTROL_UI_URL ?? 'http://127.0.0.1:3000'

test.describe('Control UI — Contexts removal', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('sidebar has no Contexts item', async ({ authedPage }) => {
    await expect(authedPage.locator('.cu-sidebar__item', { hasText: 'Contexts' })).toHaveCount(0)
  })

  test('/contexts redirects to the Agents list', async ({ authedPage }) => {
    // authedPage runs in a manual browser context without baseURL, so
    // navigation needs the absolute URL (see helpers/auth-fixture.ts).
    await authedPage.goto(`${CONTROL_UI_URL}/contexts`)
    await authedPage.waitForURL('**/agents', { timeout: 15_000 })
    expect(authedPage.url()).toContain('/agents')
    await expect(
      authedPage
        .locator('main')
        .getByText(/^Agents( \(\d+\))?$/)
        .first()
    ).toBeVisible({ timeout: 15_000 })
  })

  test('/contexts/<unknown-slug> redirects to the Agents list', async ({ authedPage }) => {
    await authedPage.goto(`${CONTROL_UI_URL}/contexts/nonexistent-slug-xyz`)
    await authedPage.waitForURL('**/agents', { timeout: 15_000 })
    expect(authedPage.url()).toContain('/agents')
    await expect(
      authedPage
        .locator('main')
        .getByText(/^Agents( \(\d+\))?$/)
        .first()
    ).toBeVisible({ timeout: 15_000 })
  })
})
