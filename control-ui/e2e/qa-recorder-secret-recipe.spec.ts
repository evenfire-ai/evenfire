// control-ui/e2e/qa-recorder-secret-recipe.spec.ts
//
// Optional QA recorder journey (MUTATING): records create → list → delete for a
// shared recipe secret (dummy values) through the Control UI. Run with
// QA_RECORDER_CONFIRM_MUTATIONS=1.
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

const RECIPE_NAMESPACE = 'sandbox-recipes'

test.describe('optional QA recorder: Control UI recipe secret lifecycle', () => {
  test('records create → list → delete for a shared recipe secret', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes a local recipe secret.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const secretName = uniqueE2EName('qa-recorder-recipe-secret')
    let secretIdentity: SecretIdentity | null = null
    let deletedThroughUi = false

    try {
      await loginThroughUi(page, credentials)

      await page.getByRole('link', { name: 'Secrets', exact: true }).click()
      await expect(page).toHaveURL(/\/secrets$/, { timeout: 20_000 })
      await page.getByRole('tab', { name: 'Recipe', exact: true }).click()
      await expect(page).toHaveURL(/\/secrets\/recipe$/, { timeout: 20_000 })
      await page.getByRole('button', { name: 'Add recipe secret', exact: true }).click()
      await expect(
        page.getByRole('heading', { name: 'Create recipe secret', exact: true })
      ).toBeVisible({ timeout: 20_000 })
      await expect(
        page.getByText(
          `Create a Kubernetes secret in ${RECIPE_NAMESPACE} for recipe credential injection.`,
          { exact: true }
        )
      ).toBeVisible()

      await page.getByPlaceholder('my-recipe-credentials').fill(secretName)
      await page
        .getByText('Shared across all recipes (e.g. one Anthropic key reused by many)', {
          exact: true,
        })
        .click()
      await page.getByRole('button', { name: 'Continue', exact: true }).click()

      await expect(page.getByPlaceholder('API_KEY')).toBeVisible({ timeout: 20_000 })
      await page.getByPlaceholder('API_KEY').fill('API_KEY')
      await page.getByPlaceholder('secret value').fill('qa-recorder-dummy')
      const createSecretResponse = page.waitForResponse(
        response => {
          const request = response.request()
          if (!response.url().includes('/admin/recipe-secrets') || request.method() !== 'POST') {
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
      secretIdentity = requireSecretIdentity(await created.json(), 'Create recipe Secret')

      await expect(page.getByText(`Secret ${secretName} created.`, { exact: true })).toBeVisible({
        timeout: 20_000,
      })

      await expect(page).toHaveURL(/\/secrets\/recipe$/, { timeout: 20_000 })
      const deleteButton = page.getByRole('button', {
        name: `Delete recipe secret ${secretName}`,
        exact: true,
      })
      await expect(deleteButton).toBeVisible({ timeout: 20_000 })

      await deleteButton.click()
      const confirmDialog = page.getByRole('alertdialog')
      await expect(confirmDialog).toBeVisible()
      await expect(confirmDialog).toContainText(
        `Delete recipe secret ${secretName} from ${RECIPE_NAMESPACE}?`
      )
      await confirmDialog.getByRole('button', { name: 'Delete', exact: true }).click()

      await expect(page.getByText(secretName, { exact: true })).toHaveCount(0, { timeout: 20_000 })
      deletedThroughUi = true

      await screenshotAndLog(page, testInfo, 'control-ui-secret-recipe')
    } finally {
      if (secretIdentity && !deletedThroughUi) {
        const deleted = await api(
          page.request,
          'DELETE',
          `/api/v1/admin/recipe-secrets/${encodeURIComponent(secretName)}?targetNamespace=${encodeURIComponent(RECIPE_NAMESPACE)}`,
          secretIdentity
        )
        expect(deleted.status, 'cleanup recipe Secret').toBe(200)
      }
    }
  })
})
