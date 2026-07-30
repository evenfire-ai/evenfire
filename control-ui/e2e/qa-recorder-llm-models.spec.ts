import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

// Optional QA recorder journey: LLM Models catalog + Secrets management pages.
// Read-only — only asserts the two inventory pages render their shells after
// sign-in. No model/secret is created, edited, or deleted.

test.describe('optional QA recorder: Control UI LLM models and secrets', () => {
  test('records the LLM models catalog and secrets pages', async ({ page }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    const mainNav = page.getByRole('navigation', { name: 'Main sections' })

    // (1) Unified LLM Models surface. Catalog and Discovery Review use
    // route-backed tabs under the same direct sidebar destination.
    await mainNav.getByRole('link', { name: 'LLM Models', exact: true }).click()
    await expect(page).toHaveURL(/\/llm-models/, { timeout: 20_000 })
    await expect(page.getByText('Context window').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('tab', { name: 'Discovery review' })).toBeVisible({
      timeout: 20_000,
    })
    await screenshotAndLog(page, testInfo, 'control-ui-llm-models')

    // (2) Secrets management (LLM scope). 'Secrets' is a direct sidebar link to
    // /secrets/llm. Assert the canonical URL and that the page loaded within the
    // authenticated shell (the 'Main sections' nav persists).
    await mainNav.getByRole('link', { name: 'Secrets', exact: true }).click()
    await expect(page).toHaveURL(/\/secrets\/(llm|mcp|recipe)/, { timeout: 20_000 })
    await expect(mainNav).toBeVisible({ timeout: 20_000 })
    await screenshotAndLog(page, testInfo, 'control-ui-secrets')
  })
})
