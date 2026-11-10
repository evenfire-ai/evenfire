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
import { type Locator, type Page, expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
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
 * Call the Control API operator plane FROM THE PAGE, so the admin session
 * cookie is always attached.
 *
 * `page.request` is not used here on purpose: Playwright's request context
 * only exempts `localhost` from the secure-cookie-over-http filter, so a
 * `http://127.0.0.1:<port>` CONTROL_UI_URL makes every `page.request` call
 * unauthenticated (401) while the browser session itself is live. A cleanup
 * that silently 401s leaves the shared drive dirty and still reports the
 * journey as green. Fetching from inside the page uses the browser's own
 * cookie jar, so the cleanup behaves the same for every host spelling.
 */
async function adminFetch(
  page: Page,
  method: string,
  pathName: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  return page.evaluate(
    async ([requestMethod, requestPath, requestBody]) => {
      const response = await fetch(requestPath, {
        method: requestMethod,
        headers: requestBody ? { 'content-type': 'application/json' } : {},
        body: requestBody ? JSON.stringify(requestBody) : undefined,
        credentials: 'same-origin',
      })
      const text = await response.text()
      let data: Record<string, unknown> = {}
      try {
        data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
      } catch {
        data = { raw: text }
      }
      return { status: response.status, data }
    },
    [method, pathName, body ?? null] as const
  )
}

/** Every child of a folder, following the listing cursor to the end. */
async function listChildren(page: Page, parentResourceId: string): Promise<GfsChild[]> {
  const items: GfsChild[] = []
  let cursor: string | null = null
  do {
    const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
    const response = await adminFetch(
      page,
      'GET',
      `/control-api/api/v1/gfs/resources/${encodeURIComponent(parentResourceId)}/children?drive=main${query}`
    )
    if (response.status !== 200) {
      throw new Error(`children listing failed with HTTP ${response.status}`)
    }
    const payload = response.data as { items?: GfsChild[]; nextCursor?: string | null }
    items.push(...(payload.items ?? []))
    cursor = payload.nextCursor ?? null
  } while (cursor)
  return items
}

/**
 * Recursive cleanup: walk the drive from its root and delete every fixture
 * resource with a matching exact name, children before parents. Journeys only
 * move fixtures between self-created folders, so a moved fixture always
 * remains inside the fixture subtree the sweep covers.
 *
 * The cleanup PROVES itself: every fixture name must be gone when the sweep
 * finishes. A leftover fixture fails the journey loudly instead of silently
 * dirtying the shared drive.
 */
async function cleanupGfsDragDropFixtures(page: Page, names: ReadonlySet<string>): Promise<void> {
  const failures: string[] = []
  try {
    const tree = await adminFetch(page, 'GET', '/control-api/api/v1/gfs/tree?drive=main')
    if (tree.status !== 200) {
      throw new Error(`drive tree failed with HTTP ${tree.status}`)
    }
    const rootResourceId = (tree.data as { rootResourceId?: string }).rootResourceId
    if (!rootResourceId) throw new Error('the drive root id did not resolve')
    async function sweep(parentResourceId: string): Promise<void> {
      for (const child of await listChildren(page, parentResourceId)) {
        if (!names.has(child.name)) continue
        if (child.kind === 'directory') await sweep(child.resourceId)
        const deleted = await adminFetch(
          page,
          'DELETE',
          `/control-api/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(child.rid)}`,
          { ifMatch: child.version }
        )
        if (deleted.status >= 300) {
          failures.push(`delete ${child.name} failed with HTTP ${deleted.status}`)
        }
      }
    }
    await sweep(rootResourceId)
  } catch (caught) {
    failures.push(`sweep failed: ${caught instanceof Error ? caught.message : String(caught)}`)
  }

  // Prove the cleanup: no fixture name may survive anywhere under the root.
  const survivors: string[] = []
  try {
    const tree = await adminFetch(page, 'GET', '/control-api/api/v1/gfs/tree?drive=main')
    const rootResourceId = (tree.data as { rootResourceId?: string }).rootResourceId
    if (!rootResourceId) throw new Error('the drive root id did not resolve for the check')
    const walk = async (parentResourceId: string, depth: number): Promise<void> => {
      if (depth > 6) return
      for (const child of await listChildren(page, parentResourceId)) {
        if (names.has(child.name)) survivors.push(child.name)
        if (child.kind === 'directory') await walk(child.resourceId, depth + 1)
      }
    }
    await walk(rootResourceId, 0)
  } catch (caught) {
    failures.push(
      `cleanup verification failed: ${caught instanceof Error ? caught.message : String(caught)}`
    )
  }

  if (survivors.length > 0) {
    failures.push(`fixtures still present after cleanup: ${survivors.join(', ')}`)
  }
  if (failures.length > 0) {
    throw new Error(`[gfs-dnd] fixture cleanup incomplete — ${failures.join(' | ')}`)
  }
}

/** The drive root's resource id, read through the operator plane. */
async function driveRootId(page: Page): Promise<string> {
  const response = await adminFetch(page, 'GET', '/control-api/api/v1/gfs/tree?drive=main')
  if (response.status !== 200) throw new Error(`drive tree failed with HTTP ${response.status}`)
  const rootResourceId = (response.data as { rootResourceId?: string }).rootResourceId
  if (!rootResourceId) throw new Error('the drive root id did not resolve')
  return rootResourceId
}

/** The resource id of a folder with an exact name, or null when it is absent. */
async function findChildByName(
  page: Page,
  parentResourceId: string,
  name: string
): Promise<string | null> {
  for (const child of await listChildren(page, parentResourceId)) {
    if (child.name === name) return child.resourceId
  }
  return null
}

/** The names of a folder's live children, read through the operator plane. */
async function childNames(page: Page, parentResourceId: string): Promise<string[]> {
  return (await listChildren(page, parentResourceId)).map(child => child.name)
}

/**
 * Dismiss the admin account-setup notice.
 *
 * The notice renders as an OVERLAY that covers the toolbar, and a click under
 * an overlay never lands: Playwright waits for the element to receive the
 * event, so an undismissed notice hangs the journey until the test timeout.
 * It appears once the admin profile resolves — after the shell — so the
 * dismissal waits for it with a bounded timeout instead of racing it.
 */
async function dismissAccountNotice(page: Page): Promise<void> {
  const remindLater = page.getByRole('button', { name: 'Remind me later' })
  try {
    await remindLater.click({ timeout: 5_000 })
  } catch {
    // No notice on this run: nothing to dismiss.
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
  await dismissAccountNotice(page)
}

async function createFolderViaUi(page: Page, name: string): Promise<void> {
  // The overlay notice can render after the journey started; the first click
  // is the one it would swallow.
  await dismissAccountNotice(page)
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

/**
 * Drag a resource row onto a breadcrumb crumb button. Same mouse sequence as
 * dragRowToRow, but the release waits for the crumb to advertise its
 * `data-drop-state` verdict — the breadcrumb drop targets paint a tokenized
 * state (allowed/checking/denied/unavailable/same-parent) instead of the row
 * affordance.
 */
async function dragRowToCrumb(
  page: Page,
  sourceRow: Locator,
  crumb: Locator,
  expectedState: 'allowed' | 'checking' | 'same-parent' | 'unavailable' = 'allowed'
): Promise<void> {
  await sourceRow.scrollIntoViewIfNeeded()
  const iconBox = await sourceRow.locator('.cu-gfs-list__icon').boundingBox()
  const crumbBox = await crumb.boundingBox()
  if (!iconBox || !crumbBox) {
    throw new Error(
      'drag source row or breadcrumb crumb is not visible; cannot compute drag coordinates'
    )
  }
  const start = { x: iconBox.x + iconBox.width / 2, y: iconBox.y + iconBox.height / 2 }
  const end = { x: crumbBox.x + crumbBox.width / 2, y: crumbBox.y + crumbBox.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 6 })
  await page.mouse.move(end.x, end.y, { steps: 6 })
  await expect(crumb).toHaveAttribute('data-drop-state', expectedState, { timeout: 10_000 })
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
      // The business signal, not just the receipt: the file really is a
      // child of the destination folder now.
      const rootId = await driveRootId(page)
      const parentId = await findChildByName(page, rootId, parentName)
      expect(parentId).not.toBeNull()
      const destinationId = await findChildByName(page, parentId as string, folderName)
      expect(destinationId).not.toBeNull()
      await expect
        .poll(async () => (await childNames(page, destinationId as string)).includes(fileName), {
          timeout: 30_000,
          intervals: [250, 1_000],
        })
        .toBe(true)
      await screenshotAndLog(page, testInfo, 'gfs-dnd-file-move')
    } finally {
      await tempFile?.cleanup().catch(() => {})
      await cleanupGfsDragDropFixtures(page, new Set([parentName, folderName, fileName]))
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
      await cleanupGfsDragDropFixtures(page, new Set([parentName, sourceName, destinationName]))
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
      // The business signal: the moved folder really is a child of the
      // destination folder now.
      const rootId = await driveRootId(page)
      const parentId = await findChildByName(page, rootId, parentName)
      expect(parentId).not.toBeNull()
      const destinationId = await findChildByName(page, parentId as string, destinationName)
      expect(destinationId).not.toBeNull()
      await expect
        .poll(async () => (await childNames(page, destinationId as string)).includes(sourceName), {
          timeout: 30_000,
          intervals: [250, 1_000],
        })
        .toBe(true)
      await screenshotAndLog(page, testInfo, 'gfs-dnd-folder-commit')
    } finally {
      await cleanupGfsDragDropFixtures(page, new Set([parentName, sourceName, destinationName]))
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
        page,
        new Set([outerName, folderAName, childOfAName, siblingName])
      )
    }
  })

  test('file drag onto a breadcrumb crumb moves it up after one confirmation', async ({
    page,
  }, testInfo) => {
    const parentName = fixtureName('parent')
    const childName = fixtureName('kid')
    const fileName = `${fixtureName('doc')}.txt`
    let tempFile: Awaited<ReturnType<typeof createSecureTempFile>> | undefined

    await beginJourney(page)
    try {
      await createFolderViaUi(page, parentName)
      await openFolderViaUi(page, parentName)
      await createFolderViaUi(page, childName)
      await openFolderViaUi(page, childName)
      tempFile = await createSecureTempFile(fileName, 'even-drive breadcrumb drop fixture\n')
      await uploadFileViaUi(page, tempFile.filePath, fileName)

      // The file lands on the PARENT crumb while browsing the child folder.
      await dragRowToCrumb(page, resourceRow(page, fileName), breadcrumbButton(page, parentName))

      // Both files and folders dropped onto a crumb stop at ONE
      // confirmation with source-kind-accurate copy.
      const dialog = page.getByRole('dialog', {
        name: `Move file ${fileName} to ${parentName}`,
        exact: true,
      })
      await expect(dialog).toBeVisible({ timeout: 20_000 })
      await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(
        `Move “${fileName}” to “${parentName}”?`
      )
      await expect(
        dialog.getByText(/Inherited access to this file follows the new location/)
      ).toBeVisible()
      await dialog.getByRole('button', { name: 'Move', exact: true }).click()

      await expect(toast(page, `Moved "${fileName}" to "${parentName}".`)).toBeVisible()
      await expect(resourceRow(page, fileName)).toHaveCount(0)
      // Business signal: the file is now a child of the parent folder.
      const rootId = await driveRootId(page)
      const parentId = await findChildByName(page, rootId, parentName)
      expect(parentId).not.toBeNull()
      await expect
        .poll(async () => (await childNames(page, parentId as string)).includes(fileName), {
          timeout: 30_000,
          intervals: [250, 1_000],
        })
        .toBe(true)
      await screenshotAndLog(page, testInfo, 'gfs-dnd-breadcrumb-file-move')
    } finally {
      await tempFile?.cleanup().catch(() => {})
      await cleanupGfsDragDropFixtures(page, new Set([parentName, childName, fileName]))
    }
  })

  test('file drag onto the main drive-root crumb moves it to the root', async ({ page }) => {
    const parentName = fixtureName('parent')
    const childName = fixtureName('kid')
    const fileName = `${fixtureName('doc')}.txt`
    let tempFile: Awaited<ReturnType<typeof createSecureTempFile>> | undefined

    await beginJourney(page)
    try {
      await createFolderViaUi(page, parentName)
      await openFolderViaUi(page, parentName)
      await createFolderViaUi(page, childName)
      await openFolderViaUi(page, childName)
      tempFile = await createSecureTempFile(fileName, 'even-drive root crumb fixture\n')
      await uploadFileViaUi(page, tempFile.filePath, fileName)

      // The root crumb is an admin-plane destination with intrinsic
      // authority: the drop is admitted, never a fabricated permission deny.
      await dragRowToCrumb(page, resourceRow(page, fileName), breadcrumbButton(page, 'main'))

      const dialog = page.getByRole('dialog', {
        name: `Move file ${fileName} to main`,
        exact: true,
      })
      await expect(dialog).toBeVisible({ timeout: 20_000 })
      await dialog.getByRole('button', { name: 'Move', exact: true }).click()

      await expect(toast(page, `Moved "${fileName}" to "main".`)).toBeVisible()
      await expect(resourceRow(page, fileName)).toHaveCount(0)
      const rootId = await driveRootId(page)
      await expect
        .poll(async () => (await childNames(page, rootId)).includes(fileName), {
          timeout: 30_000,
          intervals: [250, 1_000],
        })
        .toBe(true)
    } finally {
      await tempFile?.cleanup().catch(() => {})
      await cleanupGfsDragDropFixtures(page, new Set([parentName, childName, fileName]))
    }
  })

  test('drop onto the active breadcrumb crumb explains it is already there', async ({
    page,
  }, testInfo) => {
    const parentName = fixtureName('parent')
    const childName = fixtureName('kid')
    const fileName = `${fixtureName('doc')}.txt`
    let tempFile: Awaited<ReturnType<typeof createSecureTempFile>> | undefined

    await beginJourney(page)
    try {
      await createFolderViaUi(page, parentName)
      await openFolderViaUi(page, parentName)
      await createFolderViaUi(page, childName)
      await openFolderViaUi(page, childName)
      tempFile = await createSecureTempFile(fileName, 'even-drive active crumb fixture\n')
      await uploadFileViaUi(page, tempFile.filePath, fileName)

      const rootId = await driveRootId(page)
      const parentId = await findChildByName(page, rootId, parentName)
      const childId = await findChildByName(page, parentId as string, childName)
      const namesBefore = await childNames(page, childId as string)

      // The ACTIVE crumb is the listing's physical parent: an info no-op,
      // never an error and never a PATCH.
      await dragRowToCrumb(
        page,
        resourceRow(page, fileName),
        breadcrumbButton(page, childName),
        'same-parent'
      )

      await expect(toast(page, `${fileName} is already in ${childName}.`)).toBeVisible()
      await expect(toast(page, `${fileName} is already in ${childName}.`)).toHaveClass(
        /cu-toast--info/
      )
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(resourceRow(page, fileName)).toBeVisible()
      const namesAfter = await childNames(page, childId as string)
      expect(namesAfter).toEqual(namesBefore)
      await screenshotAndLog(page, testInfo, 'gfs-dnd-breadcrumb-same-parent')
    } finally {
      await tempFile?.cleanup().catch(() => {})
      await cleanupGfsDragDropFixtures(page, new Set([parentName, childName, fileName]))
    }
  })

  test('folder drag onto an ancestor crumb above its parent commits after confirmation', async ({
    page,
  }) => {
    const outerName = fixtureName('outer')
    const midName = fixtureName('mid')
    const leafName = fixtureName('leaf')
    const folderName = fixtureName('arch')

    await beginJourney(page)
    try {
      await createFolderViaUi(page, outerName)
      await openFolderViaUi(page, outerName)
      await createFolderViaUi(page, midName)
      await openFolderViaUi(page, midName)
      await createFolderViaUi(page, leafName)
      await openFolderViaUi(page, leafName)
      await createFolderViaUi(page, folderName)

      // Drag the folder TWO levels up, onto a crumb above its own parent.
      await dragRowToCrumb(page, resourceRow(page, folderName), breadcrumbButton(page, outerName))

      const dialog = page.getByRole('dialog', {
        name: `Move folder ${folderName} to ${outerName}`,
        exact: true,
      })
      await expect(dialog).toBeVisible({ timeout: 20_000 })
      await expect(
        dialog.getByText(/Inherited access to this folder and its contents/)
      ).toBeVisible()
      await dialog.getByRole('button', { name: 'Move', exact: true }).click()

      await expect(toast(page, `Moved "${folderName}" to "${outerName}".`)).toBeVisible()
      await expect(toast(page, 'access now follows the new location')).toBeVisible()
      await expect(resourceRow(page, folderName)).toHaveCount(0)
      // Business signal: the folder is now a direct child of OUTER.
      const rootId = await driveRootId(page)
      const outerId = await findChildByName(page, rootId, outerName)
      await expect
        .poll(async () => (await childNames(page, outerId as string)).includes(folderName), {
          timeout: 30_000,
          intervals: [250, 1_000],
        })
        .toBe(true)
    } finally {
      await cleanupGfsDragDropFixtures(page, new Set([outerName, midName, leafName, folderName]))
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
      await cleanupGfsDragDropFixtures(page, new Set([parentName, fileName]))
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
        page,
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
      // The refusal is a visible outcome, so the expectation below waits for
      // it — no fixed sleep and no toast dump.
      await expect(
        toast(
          page,
          'An item with this name already exists. Choose another folder, or use Move to change its name.'
        )
      ).toBeVisible({ timeout: 30_000 })
      // The source folder did not move.
      await expect(resourceRow(page, sourceName)).toBeVisible({ timeout: 20_000 })
    } finally {
      await cleanupGfsDragDropFixtures(page, new Set([parentName, sourceName, destinationName]))
    }
  })
})
