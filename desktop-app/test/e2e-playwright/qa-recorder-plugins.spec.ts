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
// Read-only inventory + detail-panel assertions always run. The trigger step is
// gated behind QA_RECORDER_CONFIRM_MUTATIONS=1 (it creates a real workflow run
// and may incur provider cost) and only fires when a triggerable recipe with an
// input contract is selected. Contract: docs/testing/optional-playwright-qa-recorder.md.
//
// Note on selectors: WorkflowsPage renders no `workflows-page`, `workflow-row`,
// `selected-workflow`, `run-count`, or `runs-loading` data-testids. The real
// anchors are the `Plugins` <h2> shell, the `button.da-grid__row--clickable`
// rows, the `Details`/`Recent Runs` headings, the `workflow-run-row` run rows,
// the `.input-contract-form`, and the `Trigger`/`Triggering...` button.

test('optional QA recorder: Desktop plugins journey', async ({}, testInfo) => {
  assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

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
      .getByText('View deployed recipes. Select one to see recent runs or trigger it.')
      .first()
    await expect(pluginsHeading).toBeVisible({ timeout: 20_000 })
    await expect(subtitle).toBeVisible({ timeout: 20_000 })

    // Wait for the list to settle out of the loading state into either a row or
    // the empty state. No plugin fixtures are guaranteed for the QA user, so this
    // is first-available and must pass when the cluster has zero recipes.
    const workflowRow = page.locator('button.da-grid__row--clickable').first()
    const emptyRecipes = page.getByText('No recipes are deployed in this cluster.')
    await expect(workflowRow.or(emptyRecipes)).toBeVisible({ timeout: 20_000 })

    // (2, read-only) If a row is present, open its detail panel and assert the
    // detail shell + Recent Runs section render in one of their states.
    if (await workflowRow.isVisible().catch(() => false)) {
      await workflowRow.click()

      const detailsHeading = page.getByRole('heading', { name: 'Details', exact: true })
      const recentRunsHeading = page.getByRole('heading', { name: 'Recent Runs', exact: true })
      await expect(detailsHeading).toBeVisible({ timeout: 20_000 })
      await expect(recentRunsHeading).toBeVisible({ timeout: 20_000 })

      const runsLoading = page.getByText('Loading runs...')
      const runsEmpty = page.getByText('No runs recorded yet.')
      const runRow = page.getByTestId('workflow-run-row')
      await expect(runsLoading.or(runsEmpty).or(runRow)).toBeVisible({ timeout: 20_000 })

      // (3, OPTIONAL + gated) Only when the operator opts in via
      // QA_RECORDER_CONFIRM_MUTATIONS=1 AND the selected recipe is triggerable
      // AND declares an input contract. Otherwise the read-only journey above
      // remains the proof and the test still passes.
      if (process.env.QA_RECORDER_CONFIRM_MUTATIONS === '1') {
        const triggerButton = page.getByRole('button', { name: /^Trigger$/ })
        const inputForm = page.locator('.input-contract-form')
        if (
          (await triggerButton.isVisible().catch(() => false)) &&
          (await inputForm.isVisible().catch(() => false))
        ) {
          const runCountBefore = await page.getByTestId('workflow-run-row').count()

          // Fill free-text inputs with a sentinel value and numeric inputs with a
          // valid number. Enums (<select>) and booleans (checkboxes) keep their
          // defaults so we never send an invalid enum/required value.
          const textFields = inputForm.locator('input[type="text"]')
          const textCount = await textFields.count()
          for (let i = 0; i < textCount; i++) {
            const field = textFields.nth(i)
            if (await field.isEnabled().catch(() => false)) {
              await field.fill('qa-recorder')
            }
          }

          const numberFields = inputForm.locator('input[type="number"]')
          const numberCount = await numberFields.count()
          for (let i = 0; i < numberCount; i++) {
            const field = numberFields.nth(i)
            if (await field.isEnabled().catch(() => false)) {
              await field.fill('1')
            }
          }

          await triggerButton.click()

          // Success = the trigger was acknowledged (button flips to
          // "Triggering...") OR a new run row appears in Recent Runs.
          const triggering = page.getByRole('button', { name: 'Triggering...' })
          const newRunRow = page.getByTestId('workflow-run-row').nth(runCountBefore)
          await expect(triggering.or(newRunRow)).toBeVisible({ timeout: 60_000 })
        }
      }
    }

    await screenshotAndLog(page, testInfo, 'desktop-plugins')
  } finally {
    await finalizeRecording(app, page)
  }
})
