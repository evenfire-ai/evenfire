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
// Contract: docs/testing/desktop-headful-journeys.md. This journey performs NO
// writes, messages, or paid calls, so it
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

async function findRowWithMenuAction(page: Page, actionLabel: string) {
  await expect(page.getByText('Loading files…', { exact: true })).toBeHidden({ timeout: 20_000 })
  const rows = page.locator('.da-gfs-drive__grid .da-grid__row')
  const rowCount = await rows.count()
  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index)
    const trigger = row.getByRole('button', { name: /^Options for / })
    if ((await trigger.count()) === 0) continue
    await trigger.click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const action = menu.getByRole('menuitem', { name: actionLabel, exact: true })
    const found = (await action.count()) > 0
    await page.keyboard.press('Escape')
    if (found) return row
  }
  return null
}

test('optional QA recorder: Desktop shared files browser journey', async ({}, testInfo) => {
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

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

    // Shared-with-me has titlebar actions; Copy link is intentionally disabled
    // because the virtual root does not have a shareable resource URL.
    const titlebar = page.getByRole('toolbar', { name: 'EvenDrive actions' })
    await expect(titlebar).toBeVisible({ timeout: 20_000 })
    await expect(titlebar.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible()
    await expect(titlebar.getByRole('button', { name: 'Copy link', exact: true })).toBeDisabled()
    await expect(titlebar.getByRole('button', { name: 'Open link', exact: true })).toBeVisible()

    // Download is in the file's action menu; verify the menu action without
    // clicking it because the native save dialog is not reliably drivable.
    const fileRow = await findRowWithMenuAction(page, 'Download')
    if (fileRow) {
      const fileName = (await fileRow.locator('.da-gfs-list__name button').textContent())?.trim()
      if (fileName) {
        await fileRow.getByRole('button', { name: `Options for ${fileName}` }).click()
        await expect(page.getByRole('menuitem', { name: 'Download', exact: true })).toBeVisible({
          timeout: 20_000,
        })
        await page.keyboard.press('Escape')
      }
    }

    await screenshotAndLog(page, testInfo, 'desktop-shared-files-root')

    // (2) If a directory row is present, open it and assert no crash.
    const folderRow = await findRowWithMenuAction(page, 'Open folder')
    if (folderRow) {
      await folderRow.locator('.da-gfs-list__name button').first().click()
      await expect(page.getByText('Loading files…', { exact: true })).toBeHidden({
        timeout: 20_000,
      })

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
      await expect(titlebar).toBeVisible({ timeout: 20_000 })
      await expect(titlebar.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible()
      await expect(titlebar.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled()
      await expect(titlebar.getByRole('button', { name: 'Open link', exact: true })).toBeVisible()
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
