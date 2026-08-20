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
  createOversizedDiskUploadFixture,
  removeDiskUploadFixture,
} from '../../tests/e2e/gfsUploadV2Fixtures'
import {
  readGfsUploadProductMaxBytes,
  readGfsUploadV2Enabled,
  restartGfsWriter,
  setGfsUploadProductMaxBytes,
  setGfsUploadV2Enabled,
} from '../../tests/e2e/gfsUploadV2Runtime'
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

/**
 * Exercise the actual drop target while retaining Playwright's file-backed
 * File object. The capture listener runs before the React change handler clears
 * the native input, then the same file is delivered through a real DragEvent
 * sequence to the visible drop zone. This keeps the journey user-facing while
 * avoiding a synthetic upload request or direct storage mutation.
 */
async function dropFileIntoUploadDialog(
  dialog: import('@playwright/test').Locator,
  filePath: string
): Promise<void> {
  const input = dialog.getByLabel('Choose file to upload')
  const initialDropzone = dialog.locator('label').filter({ hasText: 'Drag and drop' })
  const labelFor = await initialDropzone.getAttribute('for')
  if (!labelFor) throw new Error('upload drop zone has no associated file input')
  await input.evaluate(element => {
    element.addEventListener(
      'change',
      event => {
        const file = (event.currentTarget as HTMLInputElement).files?.[0]
        if (file) (window as Window & { __gfsDropFile?: File }).__gfsDropFile = file
      },
      { capture: true, once: true }
    )
  })
  await input.setInputFiles(filePath)
  await dialog.locator(`label[for="${labelFor}"]`).evaluate(element => {
    const file = (window as Window & { __gfsDropFile?: File }).__gfsDropFile
    if (!file) throw new Error('file capture failed before drag-and-drop')
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    for (const type of ['dragenter', 'dragover', 'drop']) {
      element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }))
    }
    delete (window as Window & { __gfsDropFile?: File }).__gfsDropFile
  })
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

function isSuccessfulResponse(response: import('@playwright/test').Response): boolean {
  return response.status() >= 200 && response.status() < 300
}

function formattedControlUiBytes(byteLength: number): string {
  const mebibytes = byteLength / (1024 * 1024)
  return `${mebibytes >= 10 ? mebibytes.toFixed(0) : mebibytes.toFixed(1)} MB`
}

function uploadIdFromEnvelope(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('upload response is not an object')
  const root = body as Record<string, unknown>
  const data =
    root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : root
  const session =
    data.session && typeof data.session === 'object'
      ? (data.session as Record<string, unknown>)
      : data
  const uploadId = session.uploadId ?? session.upload_id ?? data.uploadId ?? data.upload_id
  if (typeof uploadId !== 'string' || !uploadId.trim())
    throw new Error('upload response did not contain a session uploadId')
  return uploadId
}

async function exerciseCreate(
  page: import('@playwright/test').Page,
  byteLength: number
): Promise<void> {
  const fixtureName = uniqueGfsFixtureName(`e2e-gfs-v2-create-${byteLength}`)
  let cleanupFixture: ReturnType<typeof seedGfsDirectoryFixture> | undefined
  let cleanupSource: Awaited<ReturnType<typeof createDiskUploadFixture>> | undefined
  try {
    const fixture = seedGfsDirectoryFixture(fixtureName)
    cleanupFixture = fixture
    const source = await createDiskUploadFixture(byteLength, '.parquet', fixtureName)
    cleanupSource = source
    const current = await openWritableFolder(page, fixture.name)
    const createResponse = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().includes('/gfs/proxy/v1/uploads') &&
        !response.url().endsWith('/complete') &&
        isSuccessfulResponse(response)
    )
    const completeResponse = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/complete') &&
        isSuccessfulResponse(response)
    )
    await page.getByRole('button', { name: 'Upload file', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Upload file' })
    await dialog.getByLabel('Choose file to upload').setInputFiles(source.filePath)
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
    const created = await createResponse
    expect(isSuccessfulResponse(created), `${created.url()} ${await created.text()}`).toBe(true)
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
    await expect(row).toContainText(formattedControlUiBytes(byteLength))
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
    if (cleanupSource) await removeDiskUploadFixture(cleanupSource)
    if (cleanupFixture) {
      cleanupGfsFixture(fixtureName)
      assertGfsFixtureCleaned(fixtureName)
    }
  }
}

async function exerciseReplace(
  page: import('@playwright/test').Page,
  byteLength: number
): Promise<void> {
  const fixtureName = uniqueGfsFixtureName(`e2e-gfs-v2-replace-${byteLength}`)
  let cleanupFixture: ReturnType<typeof seedGfsFileFixture> | undefined
  let cleanupSource: Awaited<ReturnType<typeof createDiskUploadFixture>> | undefined
  try {
    const fixture = seedGfsFileFixture(fixtureName)
    cleanupFixture = fixture
    const source = await createDiskUploadFixture(byteLength, '.parquet', fixtureName)
    cleanupSource = source
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
        !response.url().endsWith('/complete') &&
        isSuccessfulResponse(response)
    )
    const completeResponse = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/complete') &&
        isSuccessfulResponse(response)
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
    expect(isSuccessfulResponse(created), `${created.url()} ${await created.text()}`).toBe(true)
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
    await expect(row).toContainText(formattedControlUiBytes(byteLength))
    const downloadPromise = page.waitForEvent('download')
    await row.getByRole('button', { name: `Download ${fixture.fileName}` }).click()
    const downloaded = await hashDownload(await downloadPromise)
    expect(downloaded).toEqual({ bytes: byteLength, sha256: source.sha256 })
  } finally {
    if (cleanupSource) await removeDiskUploadFixture(cleanupSource)
    if (cleanupFixture) {
      cleanupGfsFixture(fixtureName)
      assertGfsFixtureCleaned(fixtureName)
    }
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

  test('resumes the same persisted session after a visible drag-and-drop pause and reload', async ({
    page,
  }) => {
    const fixtureName = uniqueGfsFixtureName('e2e-gfs-v2-drag-resume')
    let cleanupFixture: ReturnType<typeof seedGfsDirectoryFixture> | undefined
    let cleanupSource: Awaited<ReturnType<typeof createDiskUploadFixture>> | undefined
    try {
      const fixture = seedGfsDirectoryFixture(fixtureName)
      cleanupFixture = fixture
      const source = await createDiskUploadFixture(32 * 1024 * 1024, '.bin', fixtureName)
      cleanupSource = source
      await openWritableFolder(page, fixture.name)
      const createResponse = page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          response.url().includes('/gfs/proxy/v1/uploads') &&
          !response.url().endsWith('/complete') &&
          isSuccessfulResponse(response)
      )
      await page.getByRole('button', { name: 'Upload file', exact: true }).click()
      let dialog = page.getByRole('dialog', { name: 'Upload file' })
      await dropFileIntoUploadDialog(dialog, source.filePath)
      await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
      const created = await createResponse
      expect(isSuccessfulResponse(created)).toBe(true)
      const uploadId = uploadIdFromEnvelope(await created.json())

      const progress = page.getByRole('progressbar', {
        name: `Upload progress for ${source.fileName}`,
      })
      await expect(progress).toBeVisible({ timeout: 60_000 })
      await dialog.getByRole('button', { name: 'Pause', exact: true }).click()
      await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeVisible({
        timeout: 60_000,
      })

      await page.reload()
      const resumedCurrent = await openWritableFolder(page, fixture.name)
      await page.getByRole('button', { name: 'Upload file', exact: true }).click()
      dialog = page.getByRole('dialog', { name: 'Upload file' })
      const statusResponse = page.waitForResponse(
        response =>
          response.request().method() === 'GET' &&
          response.url().includes('/gfs/proxy/v1/uploads/') &&
          response.url().includes('/status'),
        { timeout: 60_000 }
      )
      await dropFileIntoUploadDialog(dialog, source.filePath)
      await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
      const resumedStatus = await statusResponse
      expect(resumedStatus.status()).toBe(200)
      expect(uploadIdFromEnvelope(await resumedStatus.json())).toBe(uploadId)
      await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeVisible({
        timeout: 60_000,
      })
      const resumeResponse = page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          response.url().endsWith(`/uploads/${uploadId}/resume`),
        { timeout: 60_000 }
      )
      await dialog.getByRole('button', { name: 'Resume', exact: true }).click()
      const resumed = await resumeResponse
      expect(isSuccessfulResponse(resumed), `${resumed.url()} ${await resumed.text()}`).toBe(true)
      await expect(page.getByText('File uploaded.', { exact: true })).toBeVisible({
        timeout: 600_000,
      })
      await expect
        .poll(
          () =>
            getGfsChildResourceSummary({
              parentResourceId: fixture.resourceId,
              name: source.fileName,
            }),
          { timeout: 60_000, intervals: [250, 1_000] }
        )
        .toMatchObject({ kind: 'file', bytes: source.byteLength, deleted: false })
      await expect(
        resumedCurrent.getByRole('listitem').filter({ hasText: source.fileName })
      ).toHaveCount(1)
    } finally {
      if (cleanupSource) await removeDiskUploadFixture(cleanupSource)
      if (cleanupFixture) {
        cleanupGfsFixture(fixtureName)
        assertGfsFixtureCleaned(fixtureName)
      }
    }
  })
})

test.describe('GFS Upload v2 — Control UI runtime product policy', () => {
  test.skip(
    process.env.GFS_UPLOAD_V2_RUNTIME_LIMIT_E2E !== '1',
    'Set GFS_UPLOAD_V2_RUNTIME_LIMIT_E2E=1 only on an owned non-production dev host.'
  )
  test.setTimeout(75 * 60_000)

  test('uses 100 MiB then 300 MiB without rebuilding the deployed UI bundle', async ({ page }) => {
    const previous = await readGfsUploadProductMaxBytes()
    const lowerMax = 100 * 1024 * 1024
    const raisedMax = 300 * 1024 * 1024
    const rejectedFixtureName = uniqueGfsFixtureName('e2e-gfs-v2-runtime-cap-ui')
    let cleanupFixture: ReturnType<typeof seedGfsDirectoryFixture> | undefined
    let cleanupSource: Awaited<ReturnType<typeof createOversizedDiskUploadFixture>> | undefined
    try {
      const rejectedFixture = seedGfsDirectoryFixture(rejectedFixtureName)
      cleanupFixture = rejectedFixture
      const rejectedSource = await createOversizedDiskUploadFixture(
        '.parquet',
        rejectedFixtureName,
        lowerMax
      )
      cleanupSource = rejectedSource
      await setGfsUploadProductMaxBytes(lowerMax)
      await exerciseCreate(page, lowerMax)

      await openWritableFolder(page, rejectedFixture.name)
      await page.getByRole('button', { name: 'Upload file', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Upload file' })
      await dialog.getByLabel('Choose file to upload').setInputFiles(rejectedSource.filePath)
      await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
      await expect(
        page.getByRole('status').filter({ hasText: `GFS writer limit is ${lowerMax} bytes` })
      ).toBeVisible({ timeout: 30_000 })
      expect(
        await getGfsChildResourceSummary({
          parentResourceId: rejectedFixture.resourceId,
          name: rejectedSource.fileName,
        })
      ).toBeNull()

      await page.reload()
      await setGfsUploadProductMaxBytes(raisedMax)
      await exerciseCreate(page, 250 * 1024 * 1024)
    } finally {
      try {
        await setGfsUploadProductMaxBytes(previous)
      } finally {
        if (cleanupSource) await removeDiskUploadFixture(cleanupSource)
        if (cleanupFixture) {
          cleanupGfsFixture(rejectedFixtureName)
          assertGfsFixtureCleaned(rejectedFixtureName)
        }
      }
    }
  })
})

test.describe('GFS Upload v2 — approved negative Control UI journeys', () => {
  test.skip(
    process.env.GFS_UPLOAD_V2_NEGATIVE_E2E !== '1',
    'Set GFS_UPLOAD_V2_NEGATIVE_E2E=1 only on an owned non-production dev host with the profile-scoped random URLs.'
  )
  test.setTimeout(45 * 60_000)

  test('rejects a 209715201-byte file through the visible upload modal', async ({ page }) => {
    const fixtureName = uniqueGfsFixtureName('e2e-gfs-v2-negative-oversize-ui')
    let cleanupFixture: ReturnType<typeof seedGfsDirectoryFixture> | undefined
    let cleanupSource: Awaited<ReturnType<typeof createOversizedDiskUploadFixture>> | undefined
    try {
      const fixture = seedGfsDirectoryFixture(fixtureName)
      cleanupFixture = fixture
      const source = await createOversizedDiskUploadFixture('.parquet', fixtureName)
      cleanupSource = source
      const current = await openWritableFolder(page, fixture.name)
      await page.getByRole('button', { name: 'Upload file', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Upload file' })
      await dialog.getByLabel('Choose file to upload').setInputFiles(source.filePath)
      await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'GFS writer limit is 209715200 bytes' })
      ).toBeVisible({ timeout: 15_000 })
      await expect
        .poll(
          () =>
            getGfsChildResourceSummary({
              parentResourceId: fixture.resourceId,
              name: source.fileName,
            }),
          { timeout: 15_000 }
        )
        .toBeNull()
      await expect(current.getByRole('listitem').filter({ hasText: source.fileName })).toHaveCount(
        0
      )
    } finally {
      if (cleanupSource) await removeDiskUploadFixture(cleanupSource)
      if (cleanupFixture) {
        cleanupGfsFixture(fixtureName)
        assertGfsFixtureCleaned(fixtureName)
      }
    }
  })

  test('falls back to the legacy path when v2 is disabled', async ({ page }) => {
    const previous = await readGfsUploadV2Enabled()
    const fixtureName = uniqueGfsFixtureName('e2e-gfs-v2-negative-legacy-ui')
    let cleanupFixture: ReturnType<typeof seedGfsDirectoryFixture> | undefined
    let cleanupSource: Awaited<ReturnType<typeof createDiskUploadFixture>> | undefined
    try {
      const fixture = seedGfsDirectoryFixture(fixtureName)
      cleanupFixture = fixture
      const source = await createDiskUploadFixture(2 * 1024 * 1024, '.bin', fixtureName)
      cleanupSource = source
      await setGfsUploadV2Enabled(false)
      const current = await openWritableFolder(page, fixture.name)
      await page.getByRole('button', { name: 'Upload file', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Upload file' })
      await dialog.getByLabel('Choose file to upload').setInputFiles(source.filePath)
      await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
      await expect(
        page
          .getByRole('status')
          .filter({ hasText: 'Resumable upload is unavailable; using the legacy 16 MiB path.' })
      ).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('File uploaded.', { exact: true })).toBeVisible({
        timeout: 120_000,
      })
      await expect
        .poll(
          () =>
            getGfsChildResourceSummary({
              parentResourceId: fixture.resourceId,
              name: source.fileName,
            }),
          { timeout: 60_000, intervals: [250, 1_000] }
        )
        .toMatchObject({ kind: 'file', bytes: source.byteLength, deleted: false })
      await expect(current.getByRole('listitem').filter({ hasText: source.fileName })).toBeVisible()
    } finally {
      try {
        await setGfsUploadV2Enabled(previous)
      } finally {
        if (cleanupSource) await removeDiskUploadFixture(cleanupSource)
        if (cleanupFixture) {
          cleanupGfsFixture(fixtureName)
          assertGfsFixtureCleaned(fixtureName)
        }
      }
    }
  })

  test('recovers a visible upload after the writer deployment restarts', async ({ page }) => {
    const fixtureName = uniqueGfsFixtureName('e2e-gfs-v2-negative-restart-ui')
    let cleanupFixture: ReturnType<typeof seedGfsDirectoryFixture> | undefined
    let cleanupSource: Awaited<ReturnType<typeof createDiskUploadFixture>> | undefined
    try {
      const fixture = seedGfsDirectoryFixture(fixtureName)
      cleanupFixture = fixture
      const source = await createDiskUploadFixture(64 * 1024 * 1024, '.bin', fixtureName)
      cleanupSource = source
      const current = await openWritableFolder(page, fixture.name)
      const capabilitiesResponse = page.waitForResponse(
        response =>
          response.request().method() === 'GET' &&
          response.url().includes('/gfs/proxy/v1/capabilities') &&
          isSuccessfulResponse(response)
      )
      const createResponse = page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          response.url().includes('/gfs/proxy/v1/uploads') &&
          !response.url().endsWith('/complete') &&
          isSuccessfulResponse(response)
      )
      await page.getByRole('button', { name: 'Upload file', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Upload file' })
      await dialog.getByLabel('Choose file to upload').setInputFiles(source.filePath)
      await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
      const capabilities = await capabilitiesResponse
      const capabilitiesBody = (await capabilities.json()) as {
        upload?: { resumableV2?: { enabled?: boolean } }
        data?: { upload?: { resumableV2?: { enabled?: boolean } } }
      }
      const resumable =
        capabilitiesBody.upload?.resumableV2 ?? capabilitiesBody.data?.upload?.resumableV2
      expect(
        capabilities.status(),
        `${capabilities.url()} ${JSON.stringify(capabilitiesBody)}`
      ).toBe(200)
      expect(
        resumable?.enabled,
        'restart journey must exercise the v2 writer, not legacy fallback'
      ).toBe(true)
      const created = await createResponse
      const createdBody = await created.text()
      expect(isSuccessfulResponse(created), `${created.url()} ${createdBody}`).toBe(true)
      expect(createdBody).toMatch(/uploadId|upload_id|data/)
      const progress = page.getByRole('progressbar', {
        name: `Upload progress for ${source.fileName}`,
      })
      // Establish the visible in-flight state, then inject a real writer pod
      // loss. Completion after this point is the recovery assertion; the
      // positive journeys separately enforce two intermediate progress values.
      await expect(progress).toBeVisible({ timeout: 60_000 })
      await restartGfsWriter()
      await expect(page.getByText('File uploaded.', { exact: true })).toBeVisible({
        timeout: 1_200_000,
      })
      await expect
        .poll(
          () =>
            getGfsChildResourceSummary({
              parentResourceId: fixture.resourceId,
              name: source.fileName,
            }),
          { timeout: 60_000, intervals: [250, 1_000] }
        )
        .toMatchObject({ kind: 'file', bytes: source.byteLength, deleted: false })
      await expect(current.getByRole('listitem').filter({ hasText: source.fileName })).toBeVisible()
    } finally {
      if (cleanupSource) await removeDiskUploadFixture(cleanupSource)
      if (cleanupFixture) {
        cleanupGfsFixture(fixtureName)
        assertGfsFixtureCleaned(fixtureName)
      }
    }
  })
})
