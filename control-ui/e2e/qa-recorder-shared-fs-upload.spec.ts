// control-ui/e2e/qa-recorder-shared-fs-upload.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Provisions a SharedFileSystem, uploads a file through the detail browser,
// then deletes the file. The SharedFileSystem is removed via Control API in finally.
import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  createSecureTempFile,
  loginThroughUi,
  requireRecorderConfirm,
  screenshotAndLog,
  uniqueE2EName,
} from './qa-recorder-helpers'

function sharedFsDeletePath(name: string): string {
  return `/api/v1/admin/shared-filesystems/${encodeURIComponent(name)}`
}

test.describe('optional QA recorder: Control UI SharedFileSystem', () => {
  test('SharedFileSystem — provision + upload + delete file', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey provisions a SharedFileSystem, uploads a file, and deletes it.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const sharedFsName = uniqueE2EName('qa-recorder-shared-fs')
    const seedFolder = 'qa-recorder-seed'
    const uploadName = 'qa-recorder-upload.txt'
    let tempFile: Awaited<ReturnType<typeof createSecureTempFile>> | undefined

    try {
      await loginThroughUi(page, credentials)

      await page.goto(`${CONTROL_UI_URL}/agent-files/new`)
      await expect(
        page.getByRole('heading', { name: 'Create SharedFileSystem', exact: true })
      ).toBeVisible({ timeout: 20_000 })
      await expect(
        page.getByText(
          'Provision workspace storage that agents can mount read-only into their pods.',
          { exact: true }
        )
      ).toBeVisible({ timeout: 20_000 })

      await page.getByPlaceholder('team-mission').fill(sharedFsName)
      await page.getByLabel('Shared filesystem size').fill('5')
      await page.getByLabel('Shared filesystem size unit').selectOption({ value: 'Gi' })
      await page
        .locator('.cu-create-actions')
        .getByRole('button', { name: 'Continue', exact: true })
        .click()

      await expect(page.getByText('Access and retention', { exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await page.getByLabel('Access mode').selectOption({ value: 'ReadWriteOnce' })
      await page.getByLabel(/Keep storage after deletion/i).check()
      await page
        .locator('.cu-create-actions')
        .getByRole('button', { name: 'Continue', exact: true })
        .click()

      await expect(page.getByText('Initial folders', { exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await page.getByLabel('Directory name').fill(seedFolder)
      await page.getByRole('button', { name: 'Add folder', exact: true }).click()
      await expect(
        page.locator('.cu-folder-list__items').getByText(seedFolder, { exact: true })
      ).toBeVisible()
      await page
        .locator('.cu-create-actions')
        .getByRole('button', { name: 'Create', exact: true })
        .click()

      await expect(
        page.getByText(`Shared filesystem "${sharedFsName}" created.`, { exact: true })
      ).toBeVisible({ timeout: 20_000 })

      await page.goto(`${CONTROL_UI_URL}/agent-files/${encodeURIComponent(sharedFsName)}`)
      await expect(page.getByRole('heading', { name: sharedFsName, exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.getByRole('button', { name: 'Upload file', exact: true })).toBeVisible({
        timeout: 20_000,
      })

      tempFile = await createSecureTempFile(uploadName, 'qa-recorder shared filesystem upload\n')
      await page.getByRole('button', { name: 'Upload file', exact: true }).click()
      await page.getByLabel('Choose file to upload').setInputFiles(tempFile.filePath)
      await page.getByRole('button', { name: 'Upload', exact: true }).click()

      await expect(
        page.getByRole('button', { name: `Open or download ${uploadName}`, exact: true })
      ).toBeVisible({ timeout: 20_000 })

      await page.getByRole('button', { name: `Delete ${uploadName}`, exact: true }).click()
      await expect(
        page.getByRole('alertdialog').getByText(`Delete "${uploadName}"?`, { exact: true })
      ).toBeVisible()
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Delete', exact: true })
        .click()
      await expect(
        page.getByRole('button', { name: `Delete ${uploadName}`, exact: true })
      ).toBeHidden({ timeout: 20_000 })

      await screenshotAndLog(page, testInfo, 'control-ui-shared-fs-upload')
    } finally {
      await tempFile?.cleanup().catch(() => {})
      await api(page.request, 'DELETE', sharedFsDeletePath(sharedFsName))
    }
  })
})
