// control-ui/e2e/qa-recorder-context-connector.spec.ts
//
// MUTATING journey: creates a context plus a stdio discovery-only connector and
// attaches the connector to the context. Self-contained (no external creds).
// Guarded by QA_RECORDER_CONFIRM_MUTATIONS; connector then context are deleted
// via the Control API in a finally.
import { type Page, expect, test } from '@playwright/test'
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

// The connector-form selects are not label-associated (no htmlFor/id), so scope
// to the wrapping `.cu-field` by its visible label text and drive its <select>.
async function fieldSelect(page: Page, fieldLabelText: string, value: string): Promise<void> {
  const field = page.locator('.cu-field', { hasText: fieldLabelText }).first()
  await field.locator('select').selectOption(value)
}

async function createEmptyContext(page: Page, contextName: string): Promise<void> {
  await page.getByRole('link', { name: 'Contexts', exact: true }).click()
  await expect(page).toHaveURL(/\/contexts$/, { timeout: 20_000 })
  await page.getByRole('button', { name: 'Create context', exact: true }).click()
  await expect(page).toHaveURL(/\/contexts\/new$/, { timeout: 20_000 })
  await page.getByPlaceholder('context1').fill(contextName)
  await page
    .getByPlaceholder('Human-readable context description')
    .fill('QA recorder temporary context')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(
    page
      .getByText('No connectors found.', { exact: true })
      .or(page.getByPlaceholder('Search connectors...'))
  ).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Create context', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/contexts/${contextName}$`), { timeout: 20_000 })
  await expect(
    page.getByText('Review details, manage connectors, agents, teams, and members.', {
      exact: true,
    })
  ).toBeVisible({ timeout: 20_000 })
}

async function createDiscoveryConnector(
  page: Page,
  connectorName: string,
  contextName: string
): Promise<void> {
  await page.getByRole('link', { name: 'Installed connectors', exact: true }).click()
  await expect(page).toHaveURL(/\/connectors$/, { timeout: 20_000 })
  await page.getByRole('button', { name: 'Create Connector', exact: true }).click()
  await expect(page).toHaveURL(/\/connectors\/new$/, { timeout: 20_000 })

  // Step Connector.
  await page.getByPlaceholder('my-mcp-server').fill(connectorName)
  await page
    .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest')
    .fill('qa-recorder/example:dev')
  await page
    .getByPlaceholder('Optional description of this connector')
    .fill('QA recorder discovery-only connector')

  // Context single-select is disabled while contexts load; wait, then pick ours.
  const contextDropdown = page.locator('.cu-selection-dropdown__button')
  await expect(contextDropdown).toBeEnabled({ timeout: 20_000 })
  await contextDropdown.click()
  await expect(page.getByPlaceholder('Search contexts...')).toBeVisible({ timeout: 20_000 })
  const contextOption = page.getByRole('option', { name: contextName, exact: true })
  await expect(contextOption).toBeVisible({ timeout: 20_000 })
  await contextOption.click()

  await page.getByRole('button', { name: 'Continue', exact: true }).click()

  // Step Runtime: stdio hides the Port field; discovery-only means Not managed.
  await fieldSelect(page, 'Transport Type', 'stdio')
  await expect(page.locator('input[type="number"]')).toHaveCount(0)
  await fieldSelect(page, 'Managed', 'false')

  await page.getByRole('button', { name: 'Continue', exact: true }).click()

  // Step Network: EgressEditor renders closed-by-default; leave egress empty.
  await expect(page.getByText('External Egress', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Egress mode', { exact: true })).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Continue', exact: true }).click()

  // Step Secrets: envSecret stays off for this discovery connector.
  await expect(
    page.getByRole('checkbox', { name: 'Use Kubernetes Secret for credentials', exact: true })
  ).not.toBeChecked()

  await page.getByRole('button', { name: 'Create connector', exact: true }).click()
  await expect(page.getByText('Connector created successfully.', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page).toHaveURL(/\/connectors$/, { timeout: 20_000 })
}

test.describe('optional QA recorder: Control UI context and connector', () => {
  test('records creating a context plus a stdio discovery connector and attaching it', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes local context and connector resources.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const contextName = uniqueE2EName('qa-recorder-context')
    const connectorName = uniqueE2EName('qa-recorder-connector')

    try {
      await loginThroughUi(page, credentials)

      await createEmptyContext(page, contextName)
      await createDiscoveryConnector(page, connectorName, contextName)

      // The create flow auto-attaches the connector; verify it on the context's
      // Connectors tab.
      await page.getByRole('link', { name: 'Contexts', exact: true }).click()
      await expect(page).toHaveURL(/\/contexts$/, { timeout: 20_000 })
      await page.getByRole('row', { name: `Open context ${contextName}`, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/contexts/${contextName}/connectors$`), {
        timeout: 20_000,
      })
      await expect(page.getByRole('row').filter({ hasText: connectorName })).toBeVisible({
        timeout: 20_000,
      })

      await screenshotAndLog(page, testInfo, 'control-ui-context-connector')
    } finally {
      await api(
        page.request,
        'DELETE',
        `/api/v1/admin/mcp-servers/${encodeURIComponent(connectorName)}`
      )
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
    }
  })
})
