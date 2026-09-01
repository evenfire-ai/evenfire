import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  openResourcesNavItem,
  screenshotAndLog,
} from './qa-recorder-helpers'

// desktop-app/test/e2e-playwright/qa-recorder-plugins.spec.ts
//
// Optional headful QA recorder journey for the Plugins (Workflows) page.
// Read-only inventory assertions always run. The trigger step is gated behind
// QA_RECORDER_CONFIRM_MUTATIONS=1 (it creates a real workflow run and may incur
// provider cost) and only fires when a triggerable recipe is present.
// Contract: docs/testing/optional-playwright-qa-recorder.md.
//
// Note on selectors (spec 12 §5.F — flat DataTable, no accordion): WorkflowsPage
// renders a `.da-table` with the columns `Name` / `Status` / `Recent Runs` /
// `Actions`. Each recipe is a `<tr>` (no clickable row, no detail panel). The
// Trigger action opens a `role="dialog"` modal carrying the `.input-contract-form`
// only when the recipe declares an input contract; otherwise it fires directly.

test('optional QA recorder: Desktop plugins journey', async ({}, testInfo) => {
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page

    await login(page, credentials)

    // (1, read-only) Resources -> Plugins renders the workflows page shell. The
    // `Plugins` heading and subtitle are present in every render branch
    // (loading / error / empty / populated), so they are the robust shell proof.
    await openResourcesNavItem(page, 'nav-workflows')
    const pluginsHeading = page.getByRole('heading', { name: 'Plugins', exact: true })
    const subtitle = page
      .getByText('View deployed recipes, see their recent runs, and trigger them.')
      .first()
    await expect(pluginsHeading).toBeVisible({ timeout: 20_000 })
    await expect(subtitle).toBeVisible({ timeout: 20_000 })

    // Wait for the list to settle out of the loading state into either a row or
    // the empty state. No plugin fixtures are guaranteed for the QA user, so this
    // is first-available and must pass when the cluster has zero recipes.
    const table = page.locator('table.da-table')
    const workflowRow = table.locator('tbody tr').first()
    const emptyRecipes = page.getByText('No recipes are deployed in this cluster.')
    await expect(workflowRow.or(emptyRecipes)).toBeVisible({ timeout: 20_000 })

    // (2, read-only) When a row is present, assert the flat-table columns and
    // the compact Recent Runs cell render (no accordion / detail panel).
    if (await workflowRow.isVisible().catch(() => false)) {
      for (const column of ['Name', 'Status', 'Recent Runs', 'Actions']) {
        await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible({
          timeout: 20_000,
        })
      }

      // (3, OPTIONAL + gated) Only when the operator opts in via
      // QA_RECORDER_CONFIRM_MUTATIONS=1 AND a triggerable recipe is present.
      // Otherwise the read-only journey above remains the proof.
      if (process.env.QA_RECORDER_CONFIRM_MUTATIONS === '1') {
        const triggerButton = workflowRow.getByRole('button', { name: /^Trigger$/ })
        if (
          (await triggerButton.isVisible().catch(() => false)) &&
          (await triggerButton.isEnabled().catch(() => false))
        ) {
          await triggerButton.click()

          // A recipe with an input contract opens the Trigger modal; one without
          // fires directly. Handle both.
          const dialog = page.getByRole('dialog')
          const inputForm = dialog.locator('.input-contract-form')
          if (await inputForm.isVisible().catch(() => false)) {
            // Fill free-text inputs with a sentinel and numeric inputs with a
            // valid number; enums/booleans keep their defaults.
            const textFields = inputForm.locator('input[type="text"]')
            const textCount = await textFields.count()
            for (let i = 0; i < textCount; i++) {
              const field = textFields.nth(i)
              if (await field.isEnabled().catch(() => false)) await field.fill('qa-recorder')
            }
            const numberFields = inputForm.locator('input[type="number"]')
            const numberCount = await numberFields.count()
            for (let i = 0; i < numberCount; i++) {
              const field = numberFields.nth(i)
              if (await field.isEnabled().catch(() => false)) await field.fill('1')
            }

            await dialog.getByRole('button', { name: /^Trigger(ing…)?$/ }).click()
          }

          // Success = the trigger was acknowledged: the acting Trigger button
          // flips to its busy label, or the modal closes without an error.
          const triggering = page.getByRole('button', { name: 'Triggering…' })
          await expect(triggering.or(page.getByRole('dialog'))).toBeHidden({ timeout: 60_000 })
        }
      }
    }

    await screenshotAndLog(page, testInfo, 'desktop-plugins')
  } finally {
    await finalizeRecording(app, page)
  }
})
