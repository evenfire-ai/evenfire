import type { Download, Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import {
  assertGfsFixtureCleaned,
  cleanupGfsFixture,
  getE2EUserId,
  getGfsChildResourceSummary,
  seedGfsDirectoryFixture,
  seedGfsFileFixture,
  seedGfsGrant,
  uniqueGfsFixtureName,
} from '../../../tests/e2e/gfsUiFixtures'
import {
  GFS_UPLOAD_V2_BOUNDARIES,
  createDiskUploadFixture,
  removeDiskUploadFixture,
} from '../../../tests/e2e/gfsUploadV2Fixtures'
import { test } from './fixtures'
import { openResourcesNavItem } from './navigationHelpers'

test.describe.configure({ mode: 'serial' })

async function hashDownload(download: Download): Promise<{ bytes: number; sha256: string }> {
  const stream = await download.createReadStream()
  if (!stream) throw new Error(`download stream unavailable for ${download.suggestedFilename()}`)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.length
    hash.update(chunk)
  }
  return { bytes, sha256: hash.digest('hex') }
}

async function openFolder(
  page: Page,
  folderName: string
): Promise<{ browser: Locator; manageDialog: Locator }> {
  const accessibleResponse = page.waitForResponse(
    response => response.request().method() === 'GET' && response.url().includes('/external/gfs')
  )
  await openResourcesNavItem(page, 'nav-files')
  await accessibleResponse.catch(() => undefined)
  await expect(page.getByRole('heading', { name: 'Files', exact: true })).toBeVisible({
    timeout: 30_000,
  })
  const shared = page.getByRole('region', { name: 'GFS resources shared with you' })
  await expect(shared.getByRole('button', { name: folderName, exact: true })).toBeVisible({
    timeout: 60_000,
  })
  await shared.getByRole('button', { name: folderName, exact: true }).click()
  const browser = page.getByRole('region', { name: 'Global File System browser' })
  await expect(browser).toBeVisible({ timeout: 30_000 })
  await expect(browser.getByRole('button', { name: `Options for ${folderName}` })).toBeVisible()
  await browser.getByRole('button', { name: `Options for ${folderName}` }).click()
  await browser.getByRole('menuitem', { name: 'Manage', exact: true }).click()
  const manageDialog = page.getByRole('dialog', {
    name: `Manage folder ${folderName}`,
    exact: true,
  })
  await expect(manageDialog).toBeVisible()
  return { browser, manageDialog }
}

async function observeTwoProgressValues(progress: Locator, timeout = 900_000): Promise<void> {
  const values = new Set<string>()
  await expect
    .poll(
      async () => {
        const value = await progress.getAttribute('aria-valuenow')
        if (value !== null) values.add(value)
        return values.size
      },
      { timeout, intervals: [250, 1_000] }
    )
    .toBeGreaterThanOrEqual(2)
}

async function grantFolderToE2eUser(resourceId: string): Promise<void> {
  seedGfsGrant({
    resourceId,
    subjectType: 'user',
    subjectId: getE2EUserId(),
    permissions: ['read', 'write', 'delete'],
    inherit: true,
    grantedBy: 'e2e:gfs-upload-v2',
  })
}

async function exerciseCreate(page: Page, byteLength: number): Promise<void> {
  const fixtureName = uniqueGfsFixtureName(`e2e-gfs-desktop-v2-create-${byteLength}`)
  const fixture = seedGfsDirectoryFixture(fixtureName)
  await grantFolderToE2eUser(fixture.resourceId)
  const source = await createDiskUploadFixture(byteLength, '.parquet', fixtureName)
  try {
    const { browser, manageDialog } = await openFolder(page, fixture.name)
    const uploadResponsePromise = page.waitForResponse(
      response => response.request().method() === 'GET' && response.url().includes('/external/gfs')
    )
    await manageDialog.getByRole('button', { name: 'Upload file', exact: true }).click()
    await page.getByLabel('Upload file', { exact: true }).setInputFiles(source.filePath)
    await uploadResponsePromise.catch(() => undefined)
    const progress = browser.getByRole('progressbar', {
      name: `GFS upload progress for ${source.fileName}`,
    })
    await expect(progress).toBeVisible({ timeout: 30_000 })
    await observeTwoProgressValues(progress)
    await expect(page.getByText(`Uploaded ${source.fileName}`, { exact: true })).toBeVisible({
      timeout: 1_200_000,
    })
    await page.getByRole('button', { name: 'Close manage dialog' }).click()
    const row = browser.getByRole('listitem').filter({ hasText: source.fileName })
    await expect(row).toBeVisible({ timeout: 60_000 })
    await expect(row).toContainText('200.0 MB')
    await expect
      .poll(
        () =>
          getGfsChildResourceSummary({
            parentResourceId: fixture.resourceId,
            name: source.fileName,
          }),
        { timeout: 60_000, intervals: [250, 1_000] }
      )
      .toMatchObject({ kind: 'file', bytes: byteLength, deleted: false })
    const downloadPromise = page.waitForEvent('download')
    await row.getByRole('button', { name: `Download ${source.fileName}` }).click()
    expect(await hashDownload(await downloadPromise)).toEqual({
      bytes: byteLength,
      sha256: source.sha256,
    })
  } finally {
    await removeDiskUploadFixture(source)
    cleanupGfsFixture(fixtureName)
    assertGfsFixtureCleaned(fixtureName)
  }
}

async function exerciseReplace(page: Page, byteLength: number): Promise<void> {
  const fixtureName = uniqueGfsFixtureName(`e2e-gfs-desktop-v2-replace-${byteLength}`)
  const fixture = seedGfsFileFixture(fixtureName)
  await grantFolderToE2eUser(fixture.resourceId)
  const source = await createDiskUploadFixture(byteLength, '.parquet', fixtureName)
  try {
    const { browser } = await openFolder(page, fixture.name)
    const before = await getGfsChildResourceSummary({
      parentResourceId: fixture.resourceId,
      name: fixture.fileName,
    })
    expect(before).toMatchObject({ kind: 'file', deleted: false })
    await page.getByRole('button', { name: 'Close manage dialog' }).click()
    const fileRow = browser.getByRole('listitem').filter({ hasText: fixture.fileName })
    await expect(fileRow).toBeVisible({ timeout: 30_000 })
    await fileRow.getByRole('button', { name: `Options for ${fixture.fileName}` }).click()
    await browser.getByRole('menuitem', { name: 'Manage', exact: true }).click()
    const manageFile = page.getByRole('dialog', {
      name: `Manage file ${fixture.fileName}`,
      exact: true,
    })
    await expect(manageFile).toBeVisible()
    const uploadResponsePromise = page.waitForResponse(
      response => response.request().method() === 'GET' && response.url().includes('/external/gfs')
    )
    await manageFile.getByRole('button', { name: 'Replace file', exact: true }).click()
    await page.getByLabel('Replace file', { exact: true }).setInputFiles(source.filePath)
    await uploadResponsePromise.catch(() => undefined)
    const progress = browser.getByRole('progressbar', {
      name: `GFS upload progress for ${source.fileName}`,
    })
    await expect(progress).toBeVisible({ timeout: 30_000 })
    await observeTwoProgressValues(progress)
    await expect(page.getByText(`Replaced ${fixture.fileName}`, { exact: true })).toBeVisible({
      timeout: 1_200_000,
    })
    await page.getByRole('button', { name: 'Close manage dialog' }).click()
    await expect
      .poll(
        () =>
          getGfsChildResourceSummary({
            parentResourceId: fixture.resourceId,
            name: fixture.fileName,
          }),
        { timeout: 60_000, intervals: [250, 1_000] }
      )
      .toMatchObject({
        kind: 'file',
        bytes: byteLength,
        version: (before?.version ?? 0) + 1,
        deleted: false,
      })
    await expect(fileRow).toContainText('200.0 MB')
    const downloadPromise = page.waitForEvent('download')
    await fileRow.getByRole('button', { name: `Download ${fixture.fileName}` }).click()
    expect(await hashDownload(await downloadPromise)).toEqual({
      bytes: byteLength,
      sha256: source.sha256,
    })
  } finally {
    await removeDiskUploadFixture(source)
    cleanupGfsFixture(fixtureName)
    assertGfsFixtureCleaned(fixtureName)
  }
}

test.describe('GFS Upload v2 — packaged Desktop project', () => {
  test.skip(
    process.env.GFS_UPLOAD_V2_E2E !== '1',
    'Set GFS_UPLOAD_V2_E2E=1 only on an owned non-production dev host with profile-scoped random URLs.'
  )
  test.setTimeout(45 * 60_000)

  for (const byteLength of GFS_UPLOAD_V2_BOUNDARIES) {
    test(`creates a ${byteLength}-byte file through the packaged Desktop UI`, async ({
      appPage,
    }) => {
      await exerciseCreate(appPage, byteLength)
    })

    test(`replaces a ${byteLength}-byte file through the packaged Desktop UI`, async ({
      appPage,
    }) => {
      await exerciseReplace(appPage, byteLength)
    })
  }
})
