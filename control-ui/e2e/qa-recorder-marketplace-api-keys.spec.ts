// control-ui/e2e/qa-recorder-marketplace-api-keys.spec.ts
//
// Optional headful QA recorder journey for the Control UI Marketplace ->
// registry API keys panel. MUTATING: it creates a publish-scoped API key,
// drives the one-time reveal modal, then revokes the key from the table and
// best-effort revokes it through the Control API in finally. Requires
// QA_RECORDER_CONFIRM_MUTATIONS=1.
import { type APIRequestContext, expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  requireRecorderConfirm,
  screenshotAndLog,
} from './qa-recorder-helpers'

type RegistryKeyRow = { id: string; description: string | null }

async function findKeyId(
  request: APIRequestContext,
  description: string
): Promise<string | undefined> {
  const { status, data } = await api<{ keys?: RegistryKeyRow[] }>(
    request,
    'GET',
    '/api/v1/admin/registry/keys'
  )
  if (status !== 200) return undefined
  return (data.keys ?? []).find(key => key.description === description)?.id
}

async function waitForKeyId(request: APIRequestContext, description: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = await findKeyId(request, description)
    if (id) return id
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Created API key "${description}" did not appear through Control API.`)
}

test.describe('optional QA recorder: Control UI marketplace API keys', () => {
  test('Marketplace API key — create, reveal, revoke', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and revokes a marketplace API key.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const description = 'qa-recorder CI publisher'
    let keyId = ''

    try {
      await loginThroughUi(page, credentials)

      await page.goto(`${CONTROL_UI_URL}/marketplace/keys`)
      // The "+ Create key" CTA only renders once the panel reaches its ready
      // state, so it doubles as the shell + readiness assertion.
      await expect(page.getByRole('button', { name: '+ Create key', exact: true })).toBeVisible({
        timeout: 20_000,
      })

      await page.getByRole('button', { name: '+ Create key', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Create API key', exact: true })).toBeVisible({
        timeout: 20_000,
      })

      await page.locator('#key-desc').fill(description)
      // Default scopes are read + publish + update; narrow to publish only.
      await page.getByLabel('registry:read').uncheck()
      await page.getByLabel('registry:update').uncheck()
      await expect(page.getByLabel('registry:publish')).toBeChecked()
      await page.getByRole('button', { name: '90 days', exact: true }).click()
      await expect(page.locator('#key-expiry')).toHaveValue('90')

      await page.getByRole('button', { name: 'Create key', exact: true }).click()

      // One-time reveal modal: the secret is shown once, then dismissed.
      await expect(page.getByRole('heading', { name: 'API key created', exact: true })).toBeVisible(
        {
          timeout: 20_000,
        }
      )
      await page.getByRole('button', { name: /I.+ve saved it/ }).click()
      await expect(page.getByRole('heading', { name: 'API key created', exact: true })).toBeHidden()

      keyId = await waitForKeyId(page.request, description)
      expect(keyId).toBeTruthy()

      // The new key row surfaces its description in the table.
      await expect(page.getByText(description)).toBeVisible({ timeout: 20_000 })

      // Revoke from the row, confirming via the danger dialog.
      const row = page.locator('table.cu-table tr', { hasText: description })
      await row.getByRole('button', { name: 'Revoke', exact: true }).click()
      const confirmDialog = page.getByRole('alertdialog', { name: 'Revoke API key' })
      await expect(confirmDialog).toBeVisible({ timeout: 20_000 })
      await confirmDialog.getByRole('button', { name: 'Revoke', exact: true }).click()
      await expect(page.getByText(description)).toBeHidden({ timeout: 20_000 })

      await screenshotAndLog(page, testInfo, 'control-ui-marketplace-api-keys')
    } finally {
      const id = keyId || (await findKeyId(page.request, description))
      if (id) {
        try {
          await api(page.request, 'DELETE', `/api/v1/admin/registry/keys/${encodeURIComponent(id)}`)
        } catch {
          // Best-effort: the key may already be revoked (404) or gone.
        }
      }
    }
  })
})
