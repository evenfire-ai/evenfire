import type { Locator, Page } from '@playwright/test'
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

async function selectFileThroughVisibleAction(
  page: Page,
  trigger: Locator,
  filePath: string
): Promise<void> {
  const fileChooserPromise = page.waitForEvent('filechooser')
  await trigger.click()
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(filePath)
}

async function observeProgressOrCompletion(
  page: Page,
  progress: Locator,
  completedText: string,
  timeout = 900_000
): Promise<void> {
  const values = new Set<string>()
  const completed = page.getByText(completedText, { exact: true })
  const errorToast = page.getByRole('alert').filter({ hasText: /file|gfs|upload/i })
  let outcome:
    | 'waiting'
    | 'progress'
    | 'error'
    | `completed:${number}`
    | `invalid_completion:${number}` = 'waiting'
  await expect
    .poll(
      async () => {
        if ((await progress.count()) > 0) {
          const value = await progress.getAttribute('aria-valuenow', { timeout: 250 })
          if (value !== null) values.add(value)
        }
        outcome = values.size >= 2 ? 'progress' : outcome
        if (outcome === 'waiting' && (await completed.isVisible().catch(() => false))) {
          outcome =
            values.size >= 2 ? `completed:${values.size}` : `invalid_completion:${values.size}`
        }
        if (outcome === 'waiting' && (await errorToast.isVisible().catch(() => false))) {
          outcome = 'error'
        }
        return outcome !== 'waiting'
      },
      { timeout, intervals: [50, 250, 1_000] }
    )
    .toBeTruthy()

  if (outcome === 'progress') return
  if (outcome === 'error') {
    throw new Error(
      `Desktop rejected the selected local file before two progress values: ${(await errorToast.textContent())?.trim() || 'Unknown Desktop upload error'}`
    )
  }
  if (outcome.startsWith('invalid_completion:')) {
    throw new Error(
      `Desktop completed before two visible progress values (observed ${outcome.slice('invalid_completion:'.length)})`
    )
  }
  if (outcome.startsWith('completed:')) return
  throw new Error(`Desktop upload progress observation ended unexpectedly (${outcome})`)
}

function fileResourceControls(browser: Locator, resourceName: string) {
  return {
    name: browser.getByRole('button', { name: resourceName, exact: true }),
    options: browser.getByRole('button', {
      name: `Options for ${resourceName}`,
      exact: true,
    }),
    download: browser.getByRole('button', {
      name: `Download ${resourceName}`,
      exact: true,
    }),
  }
}

async function returnToFolder(browser: Locator, folderName: string): Promise<void> {
  const location = browser.getByRole('navigation', { name: 'File location' })
  const sharedRoot = location.getByRole('button', { name: 'Shared with me', exact: true })
  await expect(sharedRoot).toBeEnabled()
  await sharedRoot.click()
  const folder = browser.getByRole('button', { name: folderName, exact: true })
  await expect(folder).toBeVisible({ timeout: 60_000 })
  await folder.click()
  await expect(location.getByRole('button', { name: folderName, exact: true })).toBeDisabled({
    timeout: 30_000,
  })
}

async function installGfsDownloadCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    type CapturedGfsDownload = {
      filename: string
      blob: Blob
    }
    const win = window as Window & {
      __clerumE2eGfsDownloads?: CapturedGfsDownload[]
      __clerumE2eGfsDownloadCaptureInstalled?: boolean
    }
    if (win.__clerumE2eGfsDownloadCaptureInstalled) return
    win.__clerumE2eGfsDownloadCaptureInstalled = true
    win.__clerumE2eGfsDownloads = []

    // Observe the Blob produced from the real preload/IPC response while
    // preserving both production APIs. This does not replace or mock GFS.
    const blobByUrl = new Map<string, Blob>()
    const originalCreateObjectURL = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = originalCreateObjectURL(object)
      if (object instanceof Blob) blobByUrl.set(url, object)
      return url
    }

    const originalAnchorClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      const filename = this.download
      const blob = blobByUrl.get(this.href)
      if (filename && blob) win.__clerumE2eGfsDownloads?.push({ filename, blob })
      return originalAnchorClick.call(this)
    }
  })
}

async function hashCapturedGfsDownload(
  page: Page,
  filename: string,
  bytes: number
): Promise<string> {
  const hash = createHash('sha256')
  const chunkBytes = 8 * 1024 * 1024
  for (let offset = 0; offset < bytes; offset += chunkBytes) {
    const encoded = await page.evaluate(
      async ({ filenameToFind, start, end }) => {
        const downloads =
          (
            window as Window & {
              __clerumE2eGfsDownloads?: Array<{ filename: string; blob: Blob }>
            }
          ).__clerumE2eGfsDownloads ?? []
        const download = downloads.find(item => item.filename === filenameToFind)
        if (!download) throw new Error(`captured GFS download not found: ${filenameToFind}`)
        const chunk = new Uint8Array(await download.blob.slice(start, end).arrayBuffer())
        let binary = ''
        for (let index = 0; index < chunk.length; index += 0x8000) {
          binary += String.fromCharCode(...chunk.subarray(index, index + 0x8000))
        }
        return btoa(binary)
      },
      { filenameToFind: filename, start: offset, end: Math.min(bytes, offset + chunkBytes) }
    )
    hash.update(Buffer.from(encoded, 'base64'))
  }
  return hash.digest('hex')
}

async function expectGfsDownload(
  page: Page,
  button: Locator,
  filename: string,
  expected: { bytes: number; sha256: string }
): Promise<void> {
  await installGfsDownloadCapture(page)
  await expect(button).toBeVisible()
  await button.click()
  await expect(page.getByText(`Downloaded ${filename}`, { exact: true })).toBeVisible({
    timeout: 300_000,
  })
  await expect
    .poll(
      () =>
        page.evaluate(filenameToFind => {
          const downloads =
            (
              window as Window & {
                __clerumE2eGfsDownloads?: Array<{
                  filename: string
                  blob: Blob
                }>
              }
            ).__clerumE2eGfsDownloads ?? []
          const download = downloads.find(item => item.filename === filenameToFind)
          return download ? { filename: download.filename, bytes: download.blob.size } : null
        }, filename),
      {
        timeout: 300_000,
        intervals: [100, 500, 1_000],
        message: `Desktop should expose the real GFS IPC bytes for ${filename}`,
      }
    )
    .toEqual({ filename, bytes: expected.bytes })
  expect(await hashCapturedGfsDownload(page, filename, expected.bytes)).toBe(expected.sha256)
}

async function openFolder(
  page: Page,
  folderName: string
): Promise<{ browser: Locator; manageDialog: Locator }> {
  /*
   * E2E_GUARDIAN_IPC_FLOW: Desktop GFS discovery is brokered through the
   * main-process `window.clerum.gfs.listAccessible` bridge, so the renderer
   * has no HTTP response to await for this transition. The Files heading,
   * browser region, and seeded folder row are the visible/business signals.
   */
  const filesHeading = page.getByRole('heading', { name: 'Files', exact: true })
  const openFilesAttempt = async (timeout: number): Promise<void> => {
    await openResourcesNavItem(page, 'nav-files')
    await expect(filesHeading).toBeVisible({ timeout })
    await expect(page.getByRole('region', { name: 'Global File System browser' })).toBeVisible({
      timeout,
    })
  }

  try {
    await openFilesAttempt(15_000)
  } catch (firstNavigationError) {
    // The authenticated Desktop shell can finish its initial data refresh just
    // after the first visible menu click and restore Chat. Retry the same user
    // action once, bounded by the Files heading and its GFS request, instead of
    // hiding the race behind a fixed sleep or navigating directly to a terminal
    // route.
    try {
      await openFilesAttempt(30_000)
    } catch {
      throw firstNavigationError
    }
  }
  const browser = page.getByRole('region', { name: 'Global File System browser' })
  await expect(browser.getByRole('button', { name: folderName, exact: true })).toBeVisible({
    timeout: 60_000,
  })
  await browser.getByRole('button', { name: folderName, exact: true }).click()
  await expect(browser).toBeVisible({ timeout: 30_000 })
  await expect(
    browser
      .getByRole('navigation', { name: 'File location' })
      .getByRole('button', { name: folderName, exact: true })
  ).toBeDisabled({ timeout: 30_000 })
  const currentFolderOptions = browser.getByRole('button', {
    name: `Options for ${folderName}`,
    exact: true,
  })
  await expect(currentFolderOptions).toBeVisible()
  await currentFolderOptions.click()
  await browser.getByRole('menuitem', { name: 'Manage', exact: true }).click()
  const manageDialog = page.getByRole('dialog', {
    name: `Manage folder ${folderName}`,
    exact: true,
  })
  await expect(manageDialog).toBeVisible()
  return { browser, manageDialog }
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
    await selectFileThroughVisibleAction(
      page,
      manageDialog.getByRole('button').filter({ hasText: /^Upload file$/ }),
      source.filePath
    )
    const progress = browser.getByRole('progressbar', {
      name: `GFS upload progress for ${source.fileName}`,
    })
    await observeProgressOrCompletion(page, progress, `Uploaded ${source.fileName}`)
    await expect(page.getByText(`Uploaded ${source.fileName}`, { exact: true })).toBeVisible({
      timeout: 1_200_000,
    })
    await page.getByRole('button', { name: 'Close manage dialog' }).click()
    const resource = fileResourceControls(browser, source.fileName)
    await expect(resource.name).toBeVisible({ timeout: 60_000 })
    await expect(browser.getByText(/^200\.0 MB · v\d+$/)).toBeVisible()
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
    await expectGfsDownload(page, resource.download, source.fileName, {
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
    const resource = fileResourceControls(browser, fixture.fileName)
    await expect(resource.name).toBeVisible({ timeout: 30_000 })
    await resource.options.click()
    await browser.getByRole('menuitem', { name: 'Manage', exact: true }).click()
    const manageFile = page.getByRole('dialog', {
      name: `Manage file ${fixture.fileName}`,
      exact: true,
    })
    await expect(manageFile).toBeVisible()
    await selectFileThroughVisibleAction(
      page,
      manageFile.getByRole('button').filter({ hasText: /^Replace file$/ }),
      source.filePath
    )
    const progress = browser.getByRole('progressbar', {
      name: `GFS upload progress for ${fixture.fileName}`,
    })
    await observeProgressOrCompletion(page, progress, `Replaced ${fixture.fileName}`)
    await expect(page.getByText(`Replaced ${fixture.fileName}`, { exact: true })).toBeVisible({
      timeout: 1_200_000,
    })
    await page.getByRole('button', { name: 'Close manage dialog' }).click()
    await returnToFolder(browser, fixture.name)
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
    await expect(resource.name).toBeVisible({ timeout: 60_000 })
    await expect(browser.getByText(/^200\.0 MB · v\d+$/)).toBeVisible()
    await expectGfsDownload(page, resource.download, fixture.fileName, {
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
