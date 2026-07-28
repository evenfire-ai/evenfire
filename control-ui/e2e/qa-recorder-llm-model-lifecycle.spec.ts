// control-ui/e2e/qa-recorder-llm-model-lifecycle.spec.ts
//
// Optional QA recorder journey (MUTATING): records the full LLM allowlist model
// lifecycle (add → disable → remove) through the Control UI. Run with
// QA_RECORDER_CONFIRM_MUTATIONS=1.
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

type LlmModelRow = { id?: string; provider?: string; model?: string }

const PROVIDER = 'openai'
const PROVIDER_DISPLAY_LABEL = 'OpenAI'

test.describe('optional QA recorder: Control UI LLM model lifecycle', () => {
  test('records the add → disable → remove lifecycle for an allowed model', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates, edits, and deletes a local LLM allowlist model.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const modelName = uniqueE2EName('qa-recorder-model')
    const displayName = 'QA Recorder Model'

    try {
      await loginThroughUi(page, credentials)

      await page.goto(`${CONTROL_UI_URL}/llm-models/new`)
      await expect(
        page.getByRole('heading', { name: 'Add allowed model', exact: true })
      ).toBeVisible({
        timeout: 20_000,
      })
      await expect(
        page.getByText('Allow a provider/model so agents and runtime can select it.', {
          exact: true,
        })
      ).toBeVisible()

      await page.getByLabel('Provider').selectOption(PROVIDER)
      await page.getByPlaceholder('claude-haiku-4-5').fill(modelName)
      await page.getByLabel('Display name', { exact: true }).fill(displayName)
      await page.getByRole('button', { name: 'Add model', exact: true }).click()

      await expect(
        page.getByText(`${PROVIDER}/${modelName} added to the allowlist.`, { exact: true })
      ).toBeVisible()
      await expect(page).toHaveURL(/\/llm-models$/, { timeout: 20_000 })

      // The list shows a static Enabled/Disabled badge (no inline toggle), so the
      // disable step goes through the edit page. The pencil's name is provider/model.
      const editButton = page.getByRole('button', {
        name: `Edit model ${PROVIDER}/${modelName}`,
        exact: true,
      })
      await expect(editButton).toBeVisible({ timeout: 20_000 })
      await editButton.click()
      await expect(page).toHaveURL(/\/llm-models\/.+\/edit$/, { timeout: 20_000 })
      await expect(
        page.getByRole('heading', { name: 'Edit allowed model', exact: true })
      ).toBeVisible({ timeout: 20_000 })

      const enabledCheckbox = page.getByRole('checkbox', { name: 'Enabled' })
      await expect(enabledCheckbox).toBeVisible({ timeout: 20_000 })
      await expect(enabledCheckbox).toBeChecked()
      await enabledCheckbox.uncheck()
      await page.getByRole('button', { name: 'Save model', exact: true }).click()

      await expect(
        page.getByText(`${PROVIDER}/${modelName} updated.`, { exact: true })
      ).toBeVisible()
      await expect(page).toHaveURL(/\/llm-models$/, { timeout: 20_000 })

      const row = page.getByRole('row').filter({ hasText: modelName })
      await expect(row).toBeVisible({ timeout: 20_000 })
      await expect(row).toContainText('Disabled')

      // Remove from the allowlist via the row's delete action + confirm dialog.
      const deleteButton = page.getByRole('button', {
        name: `Delete model ${PROVIDER}/${modelName}`,
        exact: true,
      })
      await deleteButton.click()

      const confirmDialog = page.getByRole('alertdialog')
      await expect(confirmDialog).toBeVisible()
      await expect(confirmDialog).toContainText(
        `Remove ${PROVIDER_DISPLAY_LABEL}/${modelName} from the allowlist?`
      )
      await expect(confirmDialog).toContainText(
        'Existing agents keep running, but this model can no longer be selected.'
      )
      await confirmDialog.getByRole('button', { name: 'Delete', exact: true }).click()

      await expect(page.getByText(modelName, { exact: true })).toHaveCount(0, { timeout: 20_000 })

      await screenshotAndLog(page, testInfo, 'control-ui-llm-model-lifecycle')
    } finally {
      // Best-effort API cleanup if a matching model still exists (UI removal is
      // the primary path; this covers a mid-journey failure).
      try {
        const { data } = await api<{ rows?: LlmModelRow[] }>(
          page.request,
          'GET',
          '/api/v1/admin/llm-models'
        )
        const leftover = (data.rows ?? []).find(
          row => row.provider === PROVIDER && row.model === modelName
        )
        if (leftover?.id) {
          await api(page.request, 'DELETE', `/api/v1/admin/llm-models/${leftover.id}`)
        }
      } catch {
        // Best-effort: ignore cleanup failures.
      }
    }
  })
})
