// control-ui/e2e/qa-recorder-secret-connector.spec.ts
//
// Optional QA recorder journey (MUTATING): records creation of a connector
// (MCP) secret with dummy values and verifies the connector secrets shell. Run
// with QA_RECORDER_CONFIRM_MUTATIONS=1.
//
// Note: the /secrets/connector list is derived from McpServer resources and the
// UI exposes no inline delete for connector scope, so this journey records
// creation + the connector shell; the secret is removed via the Control API in
// `finally` (DELETE /api/v1/admin/mcp-secrets/<name>).
import { expect, test } from '@playwright/test'
import { requireSecretIdentity, type SecretIdentity } from '../test-utils/secretIdentity'
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

test.describe('optional QA recorder: Control UI connector secret lifecycle', () => {
  test('records create → connector shell for a connector (MCP) secret', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes a local connector (MCP) secret.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const secretName = uniqueE2EName('qa-recorder-connector-secret')
    let secretIdentity: SecretIdentity | null = null

    try {
      await loginThroughUi(page, credentials)

      await page.getByRole('link', { name: 'Secrets', exact: true }).click()
      await expect(page).toHaveURL(/\/secrets$/, { timeout: 20_000 })
      await page.getByRole('tab', { name: 'Connector', exact: true }).click()
      await expect(page).toHaveURL(/\/secrets\/connector$/, { timeout: 20_000 })
      await page.getByRole('button', { name: 'Add connector secret', exact: true }).click()
      await expect(
        page.getByRole('heading', { name: 'Create connector secret', exact: true })
      ).toBeVisible({ timeout: 20_000 })
      await expect(
        page.getByText('Create a Kubernetes secret for connector credential injection.', {
          exact: true,
        })
      ).toBeVisible()

      await page.getByPlaceholder('airtable-credentials').fill(secretName)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()

      await expect(page.getByPlaceholder('API_KEY')).toBeVisible({ timeout: 20_000 })
      await page.getByPlaceholder('API_KEY').fill('API_KEY')
      await page.getByPlaceholder('secret value').fill('qa-recorder-dummy')
      const createSecretResponse = page.waitForResponse(
        response => {
          const request = response.request()
          if (!response.url().includes('/admin/mcp-secrets') || request.method() !== 'POST') {
            return false
          }
          const body = request.postDataJSON() as { name?: string } | null
          return body?.name === secretName
        },
        { timeout: 30_000 }
      )
      await page.getByRole('button', { name: 'Create secret', exact: true }).click()

      const created = await createSecretResponse
      expect(created.status()).toBe(201)
      secretIdentity = requireSecretIdentity(await created.json(), 'Create MCP Secret')

      await expect(page.getByText(`Secret ${secretName} created.`, { exact: true })).toBeVisible({
        timeout: 20_000,
      })

      // The connector list is McpServer-derived; a standalone secret is not listed
      // and connector scope has no delete action in the UI. Record the connector
      // shell and clean up through the Control API below.
      await expect(page).toHaveURL(/\/secrets\/connector$/, { timeout: 20_000 })
      await expect(
        page.getByText('Manage LLM, connector, and recipe credentials in one place.', {
          exact: true,
        })
      ).toBeVisible({ timeout: 20_000 })

      await screenshotAndLog(page, testInfo, 'control-ui-secret-connector')
    } finally {
      if (secretIdentity) {
        const deleted = await api(
          page.request,
          'DELETE',
          `/api/v1/admin/mcp-secrets/${encodeURIComponent(secretName)}`,
          secretIdentity
        )
        expect(deleted.status, 'cleanup MCP Secret').toBe(200)
      }
    }
  })
})
