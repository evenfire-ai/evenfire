// control-ui/e2e/gfs-drag-and-drop.spec.ts
//
// MUTATING Playwright flow tests for the EvenDrive drag-and-drop feature in
// Control UI. The suite is gated like the QA recorder journeys: it skips
// cleanly unless the mutation opt-in flag and admin credentials are
// configured, and every run asserts loopback (or explicitly allowed) targets.
//
// Fixtures are self-contained: each journey first creates its own folders
// through the visible New folder dialog, so only self-created resources are
// ever moved or uploaded. A finally block deletes the fixtures through the
// Control API proxy (the qa-recorder-global-fs.spec.ts cleanup pattern).
//
// Row drags are performed with raw mouse events: Playwright's dragAndDrop
// cannot synthesize the custom `application/x-evenfire-gfs-resource` payload
// the browser sets on the draggable rows, while mouse.down/move/up over a
// draggable=true element makes Chromium run the real HTML5 DnD sequence.
import { type APIRequestContext, type Locator, type Page, expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  createSecureTempFile,
  loginThroughUi,
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

const CONFIRM_MUTATIONS_FLAG = 'QA_RECORDER_CONFIRM_MUTATIONS'

/**
 * Unique fixture names. Bases are pairwise non-prefix so a full-name row
 * filter can never match a sibling fixture's row.
 */
function fixtureName(base: string): string {
  return uniqueE2EName(`gfs-dnd-${base}`)
}

/** Presence-only check of the admin credential candidates (values never read here). */
function adminCredentialsConfigured(): boolean {
  const username = [
    process.env.E2E_ADMIN_USER,
    process.env.ADMIN_USER,
    process.env.ADMIN_USERNAME,
  ].find(value => value?.trim())
  const password = [
    process.env.E2E_ADMIN_PASSWORD,
    process.env.ADMIN_PASSWORD,
    process.env.ADMIN_PASS,
    process.env.TEST_ADMIN_PASSWORD,
  ].find(value => value?.trim())
  return Boolean(username && password)
}

function resourceRow(page: Page, name: string): Locator {
  return page.locator('.cu-gfs-list__row').filter({ hasText: name })
}

function toast(page: Page, text: string): Locator {
  return page.locator('.cu-toast').filter({ hasText: text })
}

/**
 * Best-effort recursive cleanup: walk the drive from its root and delete
 * every fixture resource with a matching exact name, children before
 * parents. Journeys only move fixtures between self-created folders, so a
 * moved fixture always remains inside the fixture subtree the sweep covers.
 */
async function cleanupGfsDragDropFixtures(
  request: APIRequestContext,
  names: ReadonlySet<string>
): Promise<void> {
  try {
    const tree = await api<{ items?: GfsChild[]; rootResourceId?: string }>(
      request,
      'GET',
      '/api/v1/gfs/tree?drive=main'
    )
    const rootResourceId = tree.data.rootResourceId
    if (!rootResourceId) return
    async function sweep(parentResourceId: string): Promise<void> {
      const children = await api<{ items?: GfsChild[] }>(
        request,
        'GET',
        `/api/v1/gfs/resources/${encodeURIComponent(parentResourceId)}/children?drive=main`
      )
      for (const child of children.data.items ?? []) {
        if (!names.has(child.name)) continue
        if (child.kind === 'directory') await sweep(child.resourceId)
        await api(
          request,
          'DELETE',
          `/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(child.rid)}`,
          { ifMatch: child.version }
        )
      }
    }
    await sweep(rootResourceId)
  } catch {
    // Best-effort: EvenDrive is global, so leftover fixtures are the only concern.
  }
}

async function beginJourney(page: Page): Promise<void> {
  assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
  assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)
  await loginThroughUi(page, adminCredentials())
  await page.goto(`${CONTROL_UI_URL}/global-file-system`)
  await expect(
    page.getByText('Browse and manage drive resources and access grants from the admin plane.', {
      exact: true,
    })
  ).toBeVisible({ timeout: 20_000 })
  // The New folder action stays disabled until the drive root resource id
  // resolves — the same signal that makes root-level fixture creation work.
  await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeEnabled({
    timeout: 20_000,
  })
}

async function createFolderViaUi(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New folder', exact: true })
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await dialog.getByLabel('Folder name').fill(name)
  await dialog.getByRole('button', { name: 'Create folder', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
  await expect(resourceRow(page, name)).toBeVisible({ timeout: 20_000 })
}

function breadcrumbButton(page: Page, folderName: string): Locator {
  return page
    .getByRole('navigation', { name: 'Breadcrumb', exact: true })
    .getByRole('button', { name: folderName, exact: true })
}

async function openFolderViaUi(page: Page, name: string): Promise<void> {
  await page
    .getByRole('list', { name: 'Current folder resources' })
    .getByRole('button', { name, exact: true })
    .click()
  const crumb = breadcrumbButton(page, name)
  await expect(crumb).toBeVisible({ timeout: 20_000 })
  await expect(crumb).toHaveAttribute('aria-current', 'page')
}

async function goUpToFolderViaUi(page: Page, name: string): Promise<void> {
  const crumb = breadcrumbButton(page, name)
  await crumb.click()
  await expect(crumb).toHaveAttribute('aria-current', 'page', { timeout: 20_000 })
}

async function uploadFileViaUi(page: Page, tempFilePath: string, fileName: string): Promise<void> {
  await page.getByRole('button', { name: 'Upload file', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Upload file', exact: true })
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await dialog.getByLabel('Choose file to upload').setInputFiles(tempFilePath)
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
  await expect(resourceRow(page, fileName)).toBeVisible({ timeout: 60_000 })
}

/**
 * Drag one resource row onto another (folder) row with the mouse in three
 * phases: press on the source row's icon (never its name button, which is a
 * navigation control), advance toward the target in two moves so Chromium
 * synthesizes the HTML5 dragstart/dragover sequence for the draggable rows,
 * then — only once the target row advertises `data-drop-target="true"` —
 * release to drop.
 */
async function dragRowToRow(page: Page, sourceRow: Locator, targetRow: Locator): Promise<void> {
  await sourceRow.scrollIntoViewIfNeeded()
  await targetRow.scrollIntoViewIfNeeded()
  const iconBox = await sourceRow.locator('.cu-gfs-list__icon').boundingBox()
  const targetBox = await targetRow.boundingBox()
  if (!iconBox || !targetBox) {
    throw new Error('drag source or target row is not visible; cannot compute drag coordinates')
  }
  const start = { x: iconBox.x + iconBox.width / 2, y: iconBox.y + iconBox.height / 2 }
  const end = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 6 })
  await page.mouse.move(end.x, end.y, { steps: 6 })
  await expect(targetRow).toHaveAttribute('data-drop-target', 'true', { timeout: 10_000 })
  await page.mouse.up()
}

test.describe('EvenDrive drag and drop', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(
    process.env[CONFIRM_MUTATIONS_FLAG] !== '1' || !adminCredentialsConfigured(),
    `Mutating drag-and-drop journey. Set ${CONFIRM_MUTATIONS_FLAG}=1 and configure the admin credential env vars (see e2e/qa-recorder-helpers) on an owned dev environment to run it.`
  )
  test.setTimeout(600_000)

  test('file drag into folder moves it', async ({ page }, testInfo) => {
    const parentName = fixtureName('parent')
    const folderName = fixtureName('bin')
    const fileName = `${fixtureName('doc')}.txt`
    let tempFile: Awaited<ReturnType<typeof createSecureTempFile>> | undefined

    await beginJourney(page)
    try {
      await createFolderViaUi(page, parentName)
      await openFolderViaUi(page, parentName)
      await createFolderViaUi(page, folderName)
      tempFile = await createSecureTempFile(fileName, 'even-drive drag and drop file fixture\n')
      await uploadFileViaUi(page, tempFile.filePath, fileName)

      await dragRowToRow(page, resourceRow(page, fileName), resourceRow(page, folderName))

      // Files move without confirmation; assert the receipt toast immediately
      // (toasts auto-dismiss after 3.5s) and then the refreshed listing.
      await expect(toast(page, `Moved "${fileName}" to "${folderName}".`)).toBeVisible()
      await expect(resourceRow(page, fileName)).toHaveCount(0)
      await screenshotAndLog(page, testInfo, 'gfs-dnd-file-move')
    } finally {
      await tempFile?.cleanup().catch(() => {})
      await cleanupGfsDragDropFixtures(page.request, new Set([parentName, folderName, fileName]))
    }
  })

  test('folder drag opens the one confirmation and Cancel changes nothing', async ({
    page,
  }, testInfo) => {
    const parentName = fixtureName('parent')
    const sourceName = fixtureName('arch')
    const destinationName = fixtureName('keep')

    await beginJourney(page)
    try {
      await createFolderViaUi(page, parentName)
      await openFolderViaUi(page, parentName)
      await createFolderViaUi(page, sourceName)
      await createFolderViaUi(page, destinationName)

      await dragRowToRow(page, resourceRow(page, sourceName), resourceRow(page, destinationName))

      // rev-2 §1: exactly ONE confirmation explains the inherited-access
      // impact and records the naming policy — no second prompt follows.
      const dialog = page.getByRole('dialog', {
        name: `Move folder ${sourceName} to ${destinationName}`,
        exact: true,
      })
      await expect(dialog).toBeVisible({ timeout: 20_000 })
      await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(
        `Move “${sourceName}” to “${destinationName}”?`
      )
      await expect(
        dialog.getByText(
          'Inherited access to this folder and its contents follows the new location'
        )
      ).toBeVisible()
      await expect(
        dialog.getByLabel('Use a numbered name if needed', { exact: true })
      ).toBeVisible()

      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

      await expect(dialog).toBeHidden({ timeout: 20_000 })
      await expect(toast(page, `Moved "${sourceName}"`)).toHaveCount(0)
      await expect(resourceRow(page, sourceName)).toBeVisible()
      await screenshotAndLog(page, testInfo, 'gfs-dnd-folder-cancel')
    } finally {
      await cleanupGfsDragDropFixtures(
        page.request,
        new Set([parentName, sourceName, destinationName])
      )
    }
  })

  test('folder drag confirmation commits with impact info', async ({ page }, testInfo) => {
    const parentName = fixtureName('parent')
    const sourceName = fixtureName('arch')
    const destinationName = fixtureName('keep')

    await beginJourney(page)
    try {
      await createFolderViaUi(page, parentName)
      await openFolderViaUi(page, parentName)
      await createFolderViaUi(page, sourceName)
      await createFolderViaUi(page, destinationName)

      await dragRowToRow(page, resourceRow(page, sourceName), resourceRow(page, destinationName))

      const dialog = page.getByRole('dialog', {
        name: `Move folder ${sourceName} to ${destinationName}`,
        exact: true,
      })
      await expect(dialog).toBeVisible({ timeout: 20_000 })
      await expect(
        dialog.getByText(
          'Inherited access to this folder and its contents follows the new location'
        )
      ).toBeVisible()

      await dialog.getByRole('button', { name: 'Move', exact: true }).click()

      // Both the move receipt and the folder-access impact note land together.
      await expect(toast(page, `Moved "${sourceName}" to "${destinationName}".`)).toBeVisible()
      await expect(toast(page, 'access now follows the new location')).toBeVisible()
      await expect(dialog).toBeHidden({ timeout: 20_000 })
      await expect(resourceRow(page, sourceName)).toHaveCount(0)
      await screenshotAndLog(page, testInfo, 'gfs-dnd-folder-commit')
    } finally {
      await cleanupGfsDragDropFixtures(
        page.request,
        new Set([parentName, sourceName, destinationName])
      )
    }
  })

  test('folder into its own subfolder is refused by the Move dialog destination tree', async ({
    page,
  }, testInfo) => {
    const outerName = fixtureName('outer')
    const folderAName = fixtureName('arch')
    const childOfAName = fixtureName('kid')
    const siblingName = fixtureName('sib')

    await beginJourney(page)
    try {
      await createFolderViaUi(page, outerName)
      await openFolderViaUi(page, outerName)
      await createFolderViaUi(page, folderAName)
      await openFolderViaUi(page, folderAName)
      await createFolderViaUi(page, childOfAName)
      await goUpToFolderViaUi(page, outerName)
      await createFolderViaUi(page, siblingName)

      // Rows in one listing level are siblings only, so a true descendant
      // drop target is unreachable by row drag; the descendant guard is
      // covered through the Move dialog's destination tree instead.
      await resourceRow(page, folderAName)
        .getByRole('button', { name: `Actions for ${folderAName}`, exact: true })
        .click()
      const menu = page.getByRole('menu', { name: `Actions for ${folderAName}`, exact: true })
      await expect(menu).toBeVisible({ timeout: 20_000 })
      await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click()

      const dialog = page.getByRole('dialog', {
        name: `Move folder ${folderAName}`,
        exact: true,
      })
      await expect(dialog).toBeVisible({ timeout: 20_000 })
      const tree = dialog.getByRole('tree', {
        name: 'EvenDrive destination folders',
        exact: true,
      })
      await expect(tree.getByRole('button', { name: 'main', exact: true })).toBeVisible({
        timeout: 20_000,
      })

      // The dialog opens with the current trail expanded; expand OUTER
      // explicitly when that pre-expansion did not apply.
      const expandOuter = dialog.getByRole('button', {
        name: `Expand ${outerName}`,
        exact: true,
      })
      const collapseOuter = dialog.getByRole('button', {
        name: `Collapse ${outerName}`,
        exact: true,
      })
      await expect(expandOuter.or(collapseOuter)).toBeVisible({ timeout: 20_000 })
      if (await expandOuter.isVisible()) await expandOuter.click()

      // The sibling created next to A is offered once OUTER's children load…
      await expect(tree.getByRole('button', { name: siblingName, exact: true })).toBeVisible({
        timeout: 20_000,
      })
      // …while A itself and anything created inside A never appear as
      // destinations (A's subtree is excluded, not merely unexpanded).
      await expect(tree.getByRole('treeitem').filter({ hasText: folderAName })).toHaveCount(0)
      await expect(tree.getByRole('treeitem').filter({ hasText: childOfAName })).toHaveCount(0)
      await screenshotAndLog(page, testInfo, 'gfs-dnd-move-dialog-exclusion')

      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toBeHidden({ timeout: 20_000 })
    } finally {
      await cleanupGfsDragDropFixtures(
        page.request,
        new Set([outerName, folderAName, childOfAName, siblingName])
      )
    }
  })

  test('OS-file drop uploads into the open folder', async ({ page }, testInfo) => {
    const parentName = fixtureName('parent')
    const fileName = `${fixtureName('osfile')}.txt`

    await beginJourney(page)
    try {
      await createFolderViaUi(page, parentName)
      await openFolderViaUi(page, parentName)

      const card = page.locator('.cu-gfs-card')
      await expect(card).toBeVisible()

      // dragenter + dragover with an OS file payload flip the browser card
      // into its drop state. The DataTransfer is kept on the window so the
      // drop event carries the same synthesized File.
      await card.evaluate((element, droppedFileName) => {
        const dataTransfer = new DataTransfer()
        dataTransfer.items.add(
          new File(['even-drive os drop upload\n'], droppedFileName, {
            type: 'text/plain',
          })
        )
        for (const type of ['dragenter', 'dragover']) {
          element.dispatchEvent(
            new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer })
          )
        }
        const scope = window as Window & { __gfsDndOsDrop?: DataTransfer }
        scope.__gfsDndOsDrop = dataTransfer
      }, fileName)

      await expect(
        page.getByRole('status').filter({ hasText: `Drop files to upload to ${parentName}` })
      ).toBeVisible({ timeout: 10_000 })

      await card.evaluate(element => {
        const scope = window as Window & { __gfsDndOsDrop?: DataTransfer }
        const dataTransfer = scope.__gfsDndOsDrop
        if (!dataTransfer) throw new Error('OS drop data transfer missing before drop')
        element.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
        )
        delete scope.__gfsDndOsDrop
      })

      await expect(toast(page, 'File uploaded.')).toBeVisible({ timeout: 60_000 })
      await expect(resourceRow(page, fileName)).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, 'gfs-dnd-os-drop-upload')
    } finally {
      await cleanupGfsDragDropFixtures(page.request, new Set([parentName, fileName]))
    }
  })

  test('folder move with a name conflict numbered-renames when opted in', async ({ page }) => {
    const parentName = fixtureName('conflict-parent')
    const sourceName = fixtureName('clash')
    const destinationName = fixtureName('bin')
    try {
      await beginJourney(page)
      await createFolderViaUi(page, parentName)
      await openFolderViaUi(page, parentName)
      await createFolderViaUi(page, sourceName)
      await createFolderViaUi(page, destinationName)
      // Seed the destination with a same-named folder so the move conflicts.
      await openFolderViaUi(page, destinationName)
      await createFolderViaUi(page, sourceName)
      await goUpToFolderViaUi(page, parentName)

      await dragRowToRow(page, resourceRow(page, sourceName), resourceRow(page, destinationName))
      const dialog = page.getByRole('dialog', {
        name: `Move folder ${sourceName} to ${destinationName}`,
        exact: true,
      })
      await expect(dialog).toBeVisible({ timeout: 20_000 })
      const numberedToggle = dialog.getByLabel(/Use a numbered name if needed/)
      await expect(numberedToggle).toBeVisible()
      await numberedToggle.check()
      await dialog.getByRole('button', { name: 'Move', exact: true }).click()

      await expect(
        toast(page, `Moved "${sourceName}" to "${destinationName}" as "${sourceName} (1)".`)
      ).toBeVisible({ timeout: 30_000 })
      await openFolderViaUi(page, destinationName)
      await expect(resourceRow(page, `${sourceName} (1)`)).toBeVisible({ timeout: 20_000 })
    } finally {
      await cleanupGfsDragDropFixtures(
        page.request,
        new Set([parentName, sourceName, `${sourceName} (1)`, destinationName])
      )
    }
  })

  test('folder move with a name conflict refuses without the numbered-name opt-in', async ({
    page,
  }) => {
    const parentName = fixtureName('clash-parent')
    const sourceName = fixtureName('stubborn')
    const destinationName = fixtureName('vault')
    try {
      await beginJourney(page)
      await createFolderViaUi(page, parentName)
      await openFolderViaUi(page, parentName)
      await createFolderViaUi(page, sourceName)
      await createFolderViaUi(page, destinationName)
      await openFolderViaUi(page, destinationName)
      await createFolderViaUi(page, sourceName)
      await goUpToFolderViaUi(page, parentName)

      await dragRowToRow(page, resourceRow(page, sourceName), resourceRow(page, destinationName))
      const dialog = page.getByRole('dialog', {
        name: `Move folder ${sourceName} to ${destinationName}`,
        exact: true,
      })
      await expect(dialog).toBeVisible({ timeout: 20_000 })
      // Leave "Use a numbered name if needed" unchecked.
      await dialog.getByRole('button', { name: 'Move', exact: true }).click()
      await page.waitForTimeout(1500)
      const toastTexts = await page.locator('.cu-toast').allTextContents()
      // eslint-disable-next-line no-console
      console.log('POST-MOVE-TOASTS:', JSON.stringify(toastTexts))

      await expect(
        toast(
          page,
          'An item with this name already exists. Choose another folder, or use Move to change its name.'
        )
      ).toBeVisible({ timeout: 30_000 })
      // The source folder did not move.
      await expect(resourceRow(page, sourceName)).toBeVisible({ timeout: 20_000 })
    } finally {
      await cleanupGfsDragDropFixtures(
        page.request,
        new Set([parentName, sourceName, destinationName])
      )
    }
  })
})
