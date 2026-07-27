// control-ui/e2e/qa-recorder-shared-fs-folders.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Provisions a SharedFileSystem, then creates and renames a folder in its file
// browser. The SharedFileSystem is removed via Control API in finally.
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

function sharedFsDeletePath(name: string): string {
  return `/api/v1/admin/shared-filesystems/${encodeURIComponent(name)}`
}

test.describe('optional QA recorder: Control UI SharedFileSystem folders', () => {
  test('SharedFileSystem — folder create + rename', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey provisions a SharedFileSystem and creates/renames a folder in it.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const sharedFsName = uniqueE2EName('qa-recorder-shared-fs')
    const folderName = 'qa-recorder-folder'
    const renamedFolderName = 'qa-recorder-folder-renamed'

    try {
      await loginThroughUi(page, credentials)

      await page.goto(`${CONTROL_UI_URL}/agent-files/new`)
      await expect(
        page.getByRole('heading', { name: 'Create SharedFileSystem', exact: true })
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
      await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeVisible({
        timeout: 20_000,
      })

      await page.getByRole('button', { name: 'New folder', exact: true }).click()
      const newFolderDialog = page.getByRole('dialog', { name: 'New folder', exact: true })
      await expect(newFolderDialog).toBeVisible({ timeout: 20_000 })
      await newFolderDialog.getByLabel('Folder name').fill(folderName)
      await newFolderDialog.getByRole('button', { name: 'Create', exact: true }).click()

      await expect(page.getByRole('button', { name: folderName, exact: true })).toBeVisible({
        timeout: 20_000,
      })

      await page.getByRole('button', { name: `Rename ${folderName}`, exact: true }).click()
      const renameDialog = page.getByRole('dialog', {
        name: `Rename ${folderName}`,
        exact: true,
      })
      await expect(renameDialog).toBeVisible({ timeout: 20_000 })
      await renameDialog.getByLabel('New name').fill(renamedFolderName)
      await renameDialog.getByRole('button', { name: 'Rename', exact: true }).click()

      await expect(page.getByRole('button', { name: renamedFolderName, exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(
        page.getByRole('button', { name: `Rename ${folderName}`, exact: true })
      ).toBeHidden({ timeout: 20_000 })

      await screenshotAndLog(page, testInfo, 'control-ui-shared-fs-folders')
    } finally {
      await api(page.request, 'DELETE', sharedFsDeletePath(sharedFsName))
    }
  })
})
