// control-ui/e2e/qa-recorder-context-create.spec.ts
//
// MUTATING journey: creates a context with an empty connector allowlist, then
// tours every context-detail tab. Guarded by QA_RECORDER_CONFIRM_MUTATIONS and
// cleaned up via the Control API (`/api/v1/admin/contexts/<name>`) in a finally.
import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  requireRecorderConfirm,
  screenshotAndLog,
  uniqueE2EName,
} from './qa-recorder-helpers'

test.describe('optional QA recorder: Control UI context create', () => {
  test('records context creation with an empty allowlist and a full detail tab tour', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes a local context resource.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const name = uniqueE2EName('qa-recorder-context')
    try {
      await loginThroughUi(page, credentials)

      await page.getByRole('link', { name: 'Contexts', exact: true }).click()
      await expect(page).toHaveURL(/\/contexts$/, { timeout: 20_000 })

      await page.getByRole('button', { name: 'Create context', exact: true }).click()
      await expect(page).toHaveURL(/\/contexts\/new$/, { timeout: 20_000 })
      await expect(page.getByRole('heading', { name: 'Create context', exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(
        page.getByText('Define a new context and attach connectors.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })

      // Step Context: identity.
      await page.getByPlaceholder('context1').fill(name)
      await page
        .getByPlaceholder('Human-readable context description')
        .fill('QA recorder temporary context')
      await page.getByRole('button', { name: 'Continue', exact: true }).click()

      // Step Connectors: the multi-select renders when connectors exist, otherwise
      // the empty hint. Either is valid for an empty allowlist; leave it unselected.
      await expect(
        page
          .getByText('No connectors found.', { exact: true })
          .or(page.getByPlaceholder('Search connectors...'))
      ).toBeVisible({ timeout: 20_000 })

      await page.getByRole('button', { name: 'Create context', exact: true }).click()

      await expect(page).toHaveURL(new RegExp(`/contexts/${name}$`), { timeout: 20_000 })
      await expect(
        page.getByText('Review details, manage connectors, agents, teams, and members.', {
          exact: true,
        })
      ).toBeVisible({ timeout: 20_000 })

      // Tour every detail tab; Members is the final stop and must be selected.
      for (const tabLabel of ['Connectors', 'Agent Files', 'Agents', 'Teams', 'Members']) {
        const tab = page.getByRole('tab', { name: tabLabel, exact: true })
        await expect(tab).toBeVisible({ timeout: 20_000 })
        await tab.click()
      }
      await expect(page.getByRole('tab', { name: 'Members', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      )

      await screenshotAndLog(page, testInfo, 'control-ui-context-create')
    } finally {
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(name)}`)
    }
  })
})
