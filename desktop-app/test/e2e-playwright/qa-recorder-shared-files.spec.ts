// desktop-app/test/e2e-playwright/qa-recorder-shared-files.spec.ts
//
// Optional QA recorder journey: Desktop shared files browser.
//
// Read-only browse of Resources -> Files (the GFS "Shared with me" browser
// shell rendered by FilesPage). The journey proves the shell renders, that
// opening a directory row does not crash the page, that the breadcrumb root
// returns to the shared root, and that the download affordance is present —
// without ever triggering a real native save dialog. It is resilient to
// empty/loading/error states and only hard-asserts on the shell, which always
// exists for an authenticated user.
//
// Contract: docs/testing/optional-playwright-qa-recorder.md ("Extending the
// recorder"). This journey performs NO writes, messages, or paid calls, so it
// needs no confirmation flag — but it still guards both target URLs up front.
import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  openResourcesNavItem,
  screenshotAndLog,
} from './qa-recorder-helpers'

test('optional QA recorder: Desktop shared files browser journey', async ({}, testInfo) => {
  assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page

    await login(page, credentials)
    await openResourcesNavItem(page, 'nav-files')

    // (1) Shell proof — the Files page heading and the GFS browser card always
    // render for an authenticated user, regardless of how much is shared.
    const filesHeading = page.getByRole('heading', { name: 'Files', exact: true })
    const browserCard = page.locator('.da-gfs-drive')
    await expect(filesHeading).toBeVisible({ timeout: 20_000 })
    await expect(browserCard).toBeVisible({ timeout: 20_000 })

    // Resilient content check: the card shows a loading state, an empty state
    // (root or folder), or a populated resource grid. At least one must hold.
    const loadingFiles = page.getByText('Loading files…', { exact: true })
    const emptyRoot = page.getByText('No shared files yet', { exact: true })
    const emptyFolder = page.getByText('This folder is empty', { exact: true })
    const anyRow = page.locator('.da-gfs-drive__grid .da-grid__row').first()
    await expect(loadingFiles.or(emptyRoot).or(emptyFolder).or(anyRow)).toBeVisible({
      timeout: 20_000,
    })

    // The "Open GFS link" affordance lives in the card header and is always
    // present — a stable proof that the browse/open affordances rendered.
    await expect(page.getByRole('button', { name: 'Open GFS link', exact: true })).toBeVisible({
      timeout: 20_000,
    })

    // Download affordance: when a file row is present it exposes a Download
    // button. We only assert its presence — we never click it, because the
    // native save dialog is not reliably drivable in the recorder.
    const fileRow = page
      .locator('.da-gfs-drive__grid .da-grid__row')
      .filter({ has: page.locator('.da-gfs-drive__type', { hasText: 'File' }) })
      .first()
    if (await fileRow.isVisible().catch(() => false)) {
      await expect(fileRow.getByRole('button', { name: /Download / })).toBeVisible({
        timeout: 20_000,
      })
    }

    await screenshotAndLog(page, testInfo, 'desktop-shared-files-root')

    // (2) If a directory row is present, open it and assert no crash.
    const folderRow = page
      .locator('.da-gfs-drive__grid .da-grid__row')
      .filter({ has: page.locator('.da-gfs-drive__type', { hasText: 'Folder' }) })
      .first()
    if (await folderRow.isVisible().catch(() => false)) {
      await folderRow.locator('.da-gfs-list__name button').first().click()

      // After navigation the card either loads, lists the folder contents, or
      // reports the folder is empty. The shell itself stays mounted (no crash).
      const insideLoading = page.getByText('Loading files…', { exact: true })
      const insideEmpty = page.getByText('This folder is empty', { exact: true })
      const insideRow = page.locator('.da-gfs-drive__grid .da-grid__row').first()
      await expect(insideLoading.or(insideEmpty).or(insideRow)).toBeVisible({
        timeout: 20_000,
      })
      await expect(filesHeading).toBeVisible({ timeout: 20_000 })
      await expect(browserCard).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, 'desktop-shared-files-inside')

      // (3) Navigate back via the breadcrumb root ("Shared with me") and assert
      // the shell is still mounted.
      await page.getByRole('button', { name: 'Shared with me', exact: true }).click()
      await expect(filesHeading).toBeVisible({ timeout: 20_000 })
      await expect(browserCard).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, 'desktop-shared-files-back')
    }

    await screenshotAndLog(page, testInfo, 'desktop-shared-files')
  } finally {
    await finalizeRecording(app, page)
  }
})
