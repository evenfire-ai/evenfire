// control-ui/e2e/qa-recorder-global-fs.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Creates a folder, uploads a file, and renames it in the Global File System.
// Best-effort cleanup deletes the file and folder through the Control API in finally.
import { type APIRequestContext, expect, test } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
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

type GfsChild = {
  resourceId: string
  rid: string
  name: string
  kind: string
  version: number
}

async function cleanupGfsArtifacts(
  request: APIRequestContext,
  folderName: string,
  fileNames: string[]
): Promise<void> {
  try {
    const tree = await api<{ items?: GfsChild[]; rootResourceId?: string }>(
      request,
      'GET',
      '/api/v1/gfs/tree?drive=main'
    )
    const rootId = tree.data.rootResourceId
    if (!rootId) return
    const folder = (tree.data.items ?? []).find(
      item => item.name === folderName && item.kind === 'directory'
    )
    if (!folder) return

    const children = await api<{ items?: GfsChild[] }>(
      request,
      'GET',
      `/api/v1/gfs/resources/${encodeURIComponent(folder.resourceId)}/children?drive=main`
    )
    for (const child of children.data.items ?? []) {
      if (fileNames.includes(child.name)) {
        await api(
          request,
          'DELETE',
          `/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(child.rid)}`,
          { ifMatch: child.version }
        )
      }
    }
    await api(
      request,
      'DELETE',
      `/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(folder.rid)}`,
      { ifMatch: folder.version }
    )
  } catch {
    // Best-effort: GFS is global, so leftover artifacts are the only concern.
  }
}

test.describe('optional QA recorder: Control UI Global File System', () => {
  test('Global file system — folder + upload + rename', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates a folder, uploads a file, and renames it in the Global File System.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const folderName = uniqueE2EName('qa-recorder-folder')
    const uploadName = `qa-recorder-file-${Date.now().toString(36)}.txt`
    const renamedUploadName = uploadName.replace(/\.txt$/, '-renamed.txt')
    let tempFilePath = ''

    try {
      await loginThroughUi(page, credentials)

      await page.goto(`${CONTROL_UI_URL}/global-file-system`)
      await expect(
        page.getByText(
          'Browse and manage drive resources and access grants from the admin plane.',
          { exact: true }
        )
      ).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeEnabled({
        timeout: 20_000,
      })

      await page.getByRole('button', { name: 'New folder', exact: true }).click()
      const newFolderDialog = page.getByRole('dialog', { name: 'New folder', exact: true })
      await expect(newFolderDialog).toBeVisible({ timeout: 20_000 })
      await newFolderDialog.getByLabel('Folder name').fill(folderName)
      await newFolderDialog.getByRole('button', { name: 'Create folder', exact: true }).click()

      await expect(page.locator('.cu-gfs-list__row').filter({ hasText: folderName })).toBeVisible({
        timeout: 20_000,
      })

      tempFilePath = path.join(os.tmpdir(), `qa-recorder-gfs-${Date.now()}.txt`)
      await fs.writeFile(tempFilePath, 'qa-recorder global file system upload\n', 'utf8')
      await page.getByRole('button', { name: 'Upload file', exact: true }).click()
      await page.getByLabel('Choose file to upload').setInputFiles(tempFilePath)
      await page.getByRole('button', { name: 'Upload', exact: true }).click()

      await expect(page.locator('.cu-gfs-list__row').filter({ hasText: uploadName })).toBeVisible({
        timeout: 20_000,
      })

      await page.getByRole('button', { name: `Actions for ${uploadName}`, exact: true }).click()
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
      await page.getByLabel('New name').fill(renamedUploadName)
      await page.getByRole('button', { name: 'Save', exact: true }).click()

      await expect(
        page.locator('.cu-gfs-list__row').filter({ hasText: renamedUploadName })
      ).toBeVisible({ timeout: 20_000 })

      await screenshotAndLog(page, testInfo, 'control-ui-global-fs')
    } finally {
      if (tempFilePath) await fs.rm(tempFilePath, { force: true }).catch(() => {})
      await cleanupGfsArtifacts(page.request, folderName, [uploadName, renamedUploadName])
    }
  })
})
