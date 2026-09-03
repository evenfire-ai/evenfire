/**
 * Control UI — Agent create wizard step rail
 *
 * The /agents/new wizard must present agents, not contexts: the rail titles
 * are Agent / Model & Credentials / Access / Add Connectors, and the word
 * "Context" does not appear anywhere on the page. This spec is read-only —
 * it never submits the wizard.
 */
import type { Page } from '@playwright/test'
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD } from '../helpers/selectors'

const EXPECTED_RAIL_TITLES = ['Agent', 'Model & Credentials', 'Access', 'Add Connectors']

async function dismissAdminEmailPromptIfPresent(page: Page): Promise<void> {
  // AdminBridgeAlerts shows "Set up your admin email" for admin accounts
  // without a recovery email and overlays the page. Dismissing it is a named
  // test precondition (this suite does not test that prompt); the click is
  // logged so a run transcript shows exactly what happened.
  const remindLater = page.getByRole('button', { name: 'Remind me later' })
  try {
    await remindLater.waitFor({ state: 'visible', timeout: 3_000 })
  } catch {
    return // prompt not shown — nothing to dismiss
  }
  console.log('[e2e] dismissing "Set up your admin email" prompt (Remind me later)')
  await remindLater.click()
  await remindLater.waitFor({ state: 'hidden', timeout: 5_000 })
}

test.describe('Control UI — Agent create wizard', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('step rail lists agent-facing steps and never mentions contexts; Next stays disabled without a name', async ({
    authedPage,
  }) => {
    await authedPage.goto('/agents/new')
    await expect(
      authedPage.getByRole('heading', { name: 'Create agent', exact: true })
    ).toBeVisible({ timeout: 15_000 })
    await dismissAdminEmailPromptIfPresent(authedPage)

    // Step 0 — the rail shows exactly the four agent-facing step titles, in
    // order. The old context step must not survive as a rail entry.
    const railTitles = authedPage.locator('.cu-agent-step-rail__title')
    await expect(railTitles).toHaveCount(EXPECTED_RAIL_TITLES.length)
    await expect(railTitles).toHaveText(EXPECTED_RAIL_TITLES)

    // The reachable step body is the name field; with it empty the wizard
    // cannot advance (Next is the forward action on this wizard).
    await expect(authedPage.getByPlaceholder('agent-name')).toBeVisible()
    const nextButton = authedPage.getByRole('button', { name: 'Next', exact: true })
    await expect(nextButton).toBeVisible()
    await expect(nextButton).toBeDisabled()

    // The word "Context" must not appear anywhere in the wizard surface
    // (rail, step panel, header — the sidebar lives outside <main>).
    const mainText = await authedPage.locator('main').innerText()
    expect(mainText).not.toMatch(/\bcontext\b/i)

    // Leave without creating anything.
    await authedPage.getByRole('button', { name: 'Back to agents' }).click()
    await authedPage.waitForURL('**/agents', { timeout: 15_000 })
  })
})
