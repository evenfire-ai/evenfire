import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import {
  assertGfsFixtureCleaned,
  cleanupGfsFixture,
  getGfsChildResourceSummary,
  seedGfsDirectoryFixture,
  seedGfsFileFixture,
  uniqueGfsFixtureName,
} from '../../tests/e2e/gfsUiFixtures'
import {
  GFS_UPLOAD_V2_BOUNDARIES,
  createDiskUploadFixture,
  removeDiskUploadFixture,
} from '../../tests/e2e/gfsUploadV2Fixtures'
import { loginControlUi, openGlobalFileSystemFromSidebar } from './support/gfs-control-ui-session'

test.describe.configure({ mode: 'serial' })

async function hashDownload(
  download: import('@playwright/test').Download
): Promise<{ bytes: number; sha256: string }> {
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

async function openWritableFolder(
  page: import('@playwright/test').Page,
  folderName: string
): Promise<import('@playwright/test').Locator> {
  await loginControlUi(page)
  await openGlobalFileSystemFromSidebar(page)
  await expect(page).toHaveURL(/\/global-file-system(?:$|\?)/)
  const resources = page.getByRole('list', { name: 'Current folder resources' })
  await resources.getByRole('button', { name: folderName, exact: true }).click()
  const current = page.getByRole('list', { name: 'Current folder resources' })
  await expect(current).toBeVisible()
  return current
}

async function observeTwoProgressValues(
  progress: import('@playwright/test').Locator,
  timeout = 600_000
): Promise<void> {
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

async function exerciseCreate(
  page: import('@playwright/test').Page,
  byteLength: number
): Promise<void> {
  const fixtureName = uniqueGfsFixtureName(`e2e-gfs-v2-create-${byteLength}`)
  const fixture = seedGfsDirectoryFixture(fixtureName)
  const source = await createDiskUploadFixture(byteLength, '.parquet', fixtureName)
  try {
    const current = await openWritableFolder(page, fixture.name)
    const createResponse = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().includes('/gfs/proxy/v1/uploads') &&
        !response.url().endsWith('/complete')
    )
    const completeResponse = page.waitForResponse(
      response => response.request().method() === 'POST' && response.url().endsWith('/complete')
    )
    await page.getByRole('button', { name: 'Upload file', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Upload file' })
    await dialog.getByLabel('Choose file to upload').setInputFiles(source.filePath)
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
    const created = await createResponse
    expect(created.status(), `${created.url()} ${await created.text()}`).toBeGreaterThanOrEqual(200)
    const progress = page.getByRole('progressbar', {
      name: `Upload progress for ${source.fileName}`,
    })
    await expect(progress).toBeVisible()
    await observeTwoProgressValues(progress)
    const completed = await completeResponse
    expect(
      completed.status(),
      `${completed.url()} ${await completed.text()}`
    ).toBeGreaterThanOrEqual(200)
    await expect(page.getByText('File uploaded.', { exact: true })).toBeVisible({ timeout: 60_000 })

    const row = current.getByRole('listitem').filter({ hasText: source.fileName })
    await expect(row).toBeVisible({ timeout: 60_000 })
    await expect(row).toContainText('200 MB')
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
    const downloaded = await hashDownload(await downloadPromise)
    expect(downloaded).toEqual({ bytes: byteLength, sha256: source.sha256 })
  } finally {
    await removeDiskUploadFixture(source)
    cleanupGfsFixture(fixtureName)
    assertGfsFixtureCleaned(fixtureName)
  }
}

async function exerciseReplace(
  page: import('@playwright/test').Page,
  byteLength: number
): Promise<void> {
  const fixtureName = uniqueGfsFixtureName(`e2e-gfs-v2-replace-${byteLength}`)
  const fixture = seedGfsFileFixture(fixtureName)
  const source = await createDiskUploadFixture(byteLength, '.parquet', fixtureName)
  try {
    const current = await openWritableFolder(page, fixture.name)
    const before = await getGfsChildResourceSummary({
      parentResourceId: fixture.resourceId,
      name: fixture.fileName,
    })
    expect(before).toMatchObject({ kind: 'file', deleted: false })
    const createResponse = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().includes('/gfs/proxy/v1/uploads') &&
        !response.url().endsWith('/complete')
    )
    const completeResponse = page.waitForResponse(
      response => response.request().method() === 'POST' && response.url().endsWith('/complete')
    )
    const row = current.getByRole('listitem').filter({ hasText: fixture.fileName })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.getByRole('button', { name: `Actions for ${fixture.fileName}` }).click()
    await page.getByRole('menuitem', { name: 'Replace file', exact: true }).click()
    await page.getByLabel(`Replace ${fixture.fileName}`).setInputFiles(source.filePath)
    const progress = page.getByRole('progressbar', {
      name: `Upload progress for ${source.fileName}`,
    })
    await expect(progress).toBeVisible()
    const created = await createResponse
    expect(created.status(), `${created.url()} ${await created.text()}`).toBeGreaterThanOrEqual(200)
    await observeTwoProgressValues(progress)
    const completed = await completeResponse
    expect(
      completed.status(),
      `${completed.url()} ${await completed.text()}`
    ).toBeGreaterThanOrEqual(200)
    await expect(page.getByText('File replaced.', { exact: true })).toBeVisible({ timeout: 60_000 })
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
    await expect(row).toContainText('200 MB')
    const downloadPromise = page.waitForEvent('download')
    await row.getByRole('button', { name: `Download ${fixture.fileName}` }).click()
    const downloaded = await hashDownload(await downloadPromise)
    expect(downloaded).toEqual({ bytes: byteLength, sha256: source.sha256 })
  } finally {
    await removeDiskUploadFixture(source)
    cleanupGfsFixture(fixtureName)
    assertGfsFixtureCleaned(fixtureName)
  }
}

test.describe('GFS Upload v2 — Control UI large-upload project', () => {
  test.skip(
    process.env.GFS_UPLOAD_V2_E2E !== '1',
    'Set GFS_UPLOAD_V2_E2E=1 only on an owned non-production dev host with the profile-scoped random URLs.'
  )
  test.setTimeout(45 * 60_000)

  for (const byteLength of GFS_UPLOAD_V2_BOUNDARIES) {
    test(`creates a ${byteLength}-byte file through visible Control UI actions`, async ({
      page,
    }) => {
      await exerciseCreate(page, byteLength)
    })

    test(`replaces a file with ${byteLength} bytes through visible Control UI actions`, async ({
      page,
    }) => {
      await exerciseReplace(page, byteLength)
    })
  }
})
