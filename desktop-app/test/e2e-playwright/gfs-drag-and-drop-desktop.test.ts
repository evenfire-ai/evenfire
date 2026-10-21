/**
 * E2E - EvenDrive drag-and-drop (Desktop)
 *
 * Proves the real HTML5 gesture chain on the Files grid: mouse-driven row
 * drags land in the renderer's drop adjudication, dispatch the move through
 * the IPC bridge, and surface the operator-facing toasts. Folder drops stop
 * at the ONE confirmation (cancel no-op, commit with impact info) per rev-2.
 *
 * Fixtures are seeded through the shared gfsUiFixtures (isolated names,
 * database-seeded grants for the E2E persona) and removed in finally. The
 * sidebar explorer tree variant of the same flows is covered by the
 * FileExplorerTree vitest suite (including the dragend-race regressions);
 * this journey covers the visible grid surface end to end.
 *
 * FIXTURE AND AUTHORITY MODEL (why the journey is shaped the way it is).
 * - Fixture names must satisfy the shared harness' E2E namespace guard
 *   (`e2e-gfs-*`); the shared-with-me listing is driven by DIRECT grants.
 * - A move is parent-relative (control-api `applyResourcePatch`): it needs
 *   write+delete on the OLD parent and write on the destination. The
 *   persona therefore holds read/write/delete on the fixture folder, which
 *   covers every fixture child.
 * - The shared-with-me listing shows resources with a direct grant, and the
 *   Desktop suppresses a FILE that lives inside a listed folder. A file
 *   drag therefore happens INSIDE the fixture folder (where the file and
 *   the destination folder are siblings), while the folder drag happens at
 *   the shared root between two directly granted folders.
 * - Both helpers accept the SAME name and return the SAME fixture folder
 *   row, so one fixture name yields a folder that holds both a file and a
 *   child folder.
 */
import { type ElectronApplication, type Locator, type Page, expect, test } from '@playwright/test'
import {
  assertGfsFixtureCleaned,
  cleanupGfsFixture,
  countGfsLiveChildrenByName,
  getE2EUserId,
  getGfsChildResourceSummary,
  seedGfsDirectoryFixture,
  seedGfsFileFixture,
  seedGfsGrant,
  uniqueGfsFixtureName,
} from '../../../tests/e2e/gfsUiFixtures'
import { withTransportRetry } from './gfsTransportRetry'
import { launchAndLogin } from './workflowUi'

function gridRow(page: Page, name: string): Locator {
  return page.getByRole('button', { name: `Open ${name}`, exact: true })
}

function toast(page: Page, text: string): Locator {
  return page.locator('[role="status"], [role="alert"]').filter({ hasText: text })
}

/**
 * Grant the fixture to the seeded E2E persona: read/write/delete, inherited
 * by the fixture subtree. Without this the fixtures exist but the persona
 * cannot read them, cannot move them, and the shared-with-me listing does
 * not carry them at all.
 */
async function grantFixtureToE2eUser(resourceId: string): Promise<void> {
  await withTransportRetry('seedGfsGrant', () =>
    seedGfsGrant({
      resourceId,
      subjectType: 'user',
      subjectId: getE2EUserId(),
      permissions: ['read', 'write', 'delete'],
      inherit: true,
      grantedBy: 'e2e:gfs-drag-and-drop',
    })
  )
}

/** Seed a fixture folder (and its child) with one bounded transport retry. */
async function seedFixtureDirectory(name: string) {
  return withTransportRetry('seedGfsDirectoryFixture', () => seedGfsDirectoryFixture(name))
}

/** Seed a fixture file (and its folder) with one bounded transport retry. */
async function seedFixtureFile(name: string) {
  return withTransportRetry('seedGfsFileFixture', () => seedGfsFileFixture(name))
}

/**
 * Remove a fixture and prove it is gone, with one bounded transport retry.
 *
 * The cleanup is part of the lane's contract, and the shared harness reaches
 * the cluster through one `kubectl exec` per call — a dropped stream there
 * aborts the cleanup BEFORE it writes the tombstone, which leaves the seeded
 * rows live. A retry is the difference between a transport hiccup and a
 * dirty shared drive; a second failure still fails the journey.
 */
async function removeFixture(name: string): Promise<void> {
  await withTransportRetry('cleanupGfsFixture', () => cleanupGfsFixture(name))
  await withTransportRetry('assertGfsFixtureCleaned', () => assertGfsFixtureCleaned(name))
}

/**
 * Open the Files surface at the shared root.
 *
 * The Files surface renders NO aria-current on its breadcrumb, so the old
 * `aria-current="page"` assertion could never pass and both journeys died
 * before they reached a gesture. The signals the UI really renders at the
 * shared root are used instead: the root-only resource menu ("Options for
 * Shared with me" is rendered only when no folder is open) and the
 * breadcrumb's own state — at the root there is no parent to return to, so
 * "Shared with me" is not navigable.
 */
async function openFilesSharedRoot(page: Page): Promise<void> {
  const filesNav = page.getByRole('button', { name: /^Files$/, exact: true }).first()
  await expect(filesNav).toBeVisible({ timeout: 30_000 })
  await filesNav.click()
  const sharedWithMe = page
    .getByRole('navigation', { name: 'File location', exact: true })
    .getByRole('button', { name: 'Shared with me', exact: true })
  await expect(sharedWithMe).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByRole('button', { name: 'Options for Shared with me', exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(sharedWithMe).toBeDisabled()
}

/** Descend into a fixture folder from the shared root. */
async function openFixtureFolder(page: Page, folderName: string): Promise<void> {
  await openFilesSharedRoot(page)
  const row = gridRow(page, folderName)
  await row.waitFor({ state: 'visible', timeout: 60_000 })
  await row.click()
  // The folder is open: its crumb is in the location trail and the root-only
  // resource menu is gone.
  await expect(
    page
      .getByRole('navigation', { name: 'File location', exact: true })
      .getByRole('button', { name: folderName, exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByRole('button', { name: 'Options for Shared with me', exact: true })
  ).toHaveCount(0)
}

/**
 * Mouse-driven HTML5 drag between grid rows: press the source row (never its
 * nested action buttons), move toward the target in steps so Chromium runs
 * the dragstart/dragover sequence for the draggable rows, wait until the
 * target advertises an accepting drop state, then release.
 */
async function dragRowOntoRow(page: Page, sourceRow: Locator, targetRow: Locator): Promise<void> {
  await sourceRow.scrollIntoViewIfNeeded()
  await targetRow.scrollIntoViewIfNeeded()
  const sourceBox = await sourceRow.boundingBox()
  const targetBox = await targetRow.boundingBox()
  if (!sourceBox || !targetBox) {
    throw new Error('drag source or target row is not visible; cannot compute drag coordinates')
  }
  const start = { x: sourceBox.x + sourceBox.width * 0.2, y: sourceBox.y + sourceBox.height / 2 }
  const end = { x: targetBox.x + targetBox.width * 0.3, y: targetBox.y + targetBox.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 6 })
  await page.mouse.move(end.x, end.y, { steps: 6 })
  // Folder ancestry can remain unknown during hover even with warm permissions.
  // Release a checking target so drop-time priority adjudication can run.
  await expect(targetRow).toHaveAttribute('data-drop-state', /^(allowed|checking)$/, {
    timeout: 15_000,
  })
  await page.mouse.up()
}

test.describe('EvenDrive drag and drop (desktop grid)', () => {
  test.setTimeout(300_000)

  test('file drag into a folder moves it without a confirmation', async () => {
    // ONE fixture name: the file helper and the directory helper reuse the
    // same fixture folder row, so the folder ends up holding BOTH the file
    // and the destination folder as siblings.
    const fixtureName = uniqueGfsFixtureName('e2e-gfs-dnd-file')
    // The setup runs INSIDE the cleanup scope: a failed seed, grant or
    // login must not leave seeded rows behind.
    let app: ElectronApplication | undefined
    try {
      const file = await seedFixtureFile(fixtureName)
      const dir = await seedFixtureDirectory(fixtureName)
      await grantFixtureToE2eUser(dir.resourceId)
      const launched = await launchAndLogin()
      app = launched.app
      const page = launched.page
      await openFixtureFolder(page, fixtureName)
      const fileRow = gridRow(page, file.fileName)
      const dirRow = gridRow(page, dir.childName)
      await fileRow.waitFor({ state: 'visible', timeout: 60_000 })
      await dirRow.waitFor({ state: 'visible', timeout: 60_000 })

      await dragRowOntoRow(page, fileRow, dirRow)

      await expect(toast(page, `Moved ${file.fileName} to ${dir.childName}`)).toBeVisible({
        timeout: 30_000,
      })
      // Persisted location: the file is a live child of the destination
      // folder, and it left the folder it started in.
      await expect
        .poll(
          () =>
            countGfsLiveChildrenByName({
              parentResourceId: dir.childResourceId,
              name: file.fileName,
            }),
          { timeout: 30_000, intervals: [250, 1_000] }
        )
        .toBe(1)
      expect(
        getGfsChildResourceSummary({ parentResourceId: dir.resourceId, name: file.fileName })
      ).toBeNull()
      // The moved file is gone from the folder listing it was dragged out of.
      await expect(fileRow).toBeHidden({ timeout: 30_000 })
    } finally {
      await app?.close().catch(() => undefined)
      await removeFixture(fixtureName)
    }
  })

  test('folder drag stops at the one confirmation: Cancel is a no-op, Move commits with impact info', async () => {
    const sourceName = uniqueGfsFixtureName('e2e-gfs-dnd-src')
    const destinationName = uniqueGfsFixtureName('e2e-gfs-dnd-dst')
    let app: ElectronApplication | undefined
    try {
      const sourceDir = await seedFixtureDirectory(sourceName)
      const destinationDir = await seedFixtureDirectory(destinationName)
      // The moved folder is the fixture's CHILD, so its old parent is the
      // fixture folder: the persona holds write+delete there and the move
      // never needs authority on the drive root.
      await grantFixtureToE2eUser(sourceDir.resourceId)
      await grantFixtureToE2eUser(sourceDir.childResourceId)
      await grantFixtureToE2eUser(destinationDir.resourceId)
      const launched = await launchAndLogin()
      app = launched.app
      const page = launched.page
      await openFilesSharedRoot(page)
      const sourceRow = gridRow(page, sourceDir.childName)
      const destinationRow = gridRow(page, destinationDir.name)
      await sourceRow.waitFor({ state: 'visible', timeout: 60_000 })
      await destinationRow.waitFor({ state: 'visible', timeout: 60_000 })

      await dragRowOntoRow(page, sourceRow, destinationRow)
      const confirmDialog = page.getByRole('dialog', {
        name: `Move folder ${sourceDir.childName} to ${destinationDir.name}`,
        exact: true,
      })
      await expect(confirmDialog).toBeVisible({ timeout: 30_000 })
      await expect(confirmDialog).toContainText(
        'Inherited access to this folder and its contents follows the new location'
      )
      await confirmDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(confirmDialog).toBeHidden({ timeout: 15_000 })
      // Cancel committed nothing: the source row is still listed.
      await expect(sourceRow).toBeVisible({ timeout: 30_000 })
      expect(
        countGfsLiveChildrenByName({
          parentResourceId: destinationDir.resourceId,
          name: sourceDir.childName,
        })
      ).toBe(0)

      await dragRowOntoRow(page, sourceRow, destinationRow)
      await expect(confirmDialog).toBeVisible({ timeout: 30_000 })
      await confirmDialog.getByRole('button', { name: 'Move', exact: true }).click()

      await expect(
        toast(page, `Moved ${sourceDir.childName} to ${destinationDir.name}`)
      ).toBeVisible({
        timeout: 30_000,
      })
      await expect(
        toast(
          page,
          'Moving a folder changes who can access its contents — access now follows the new location.'
        )
      ).toBeVisible({ timeout: 30_000 })
      // Persisted location: the folder is a live child of the destination
      // and it left the fixture folder it started in. (The shared-with-me
      // listing keeps a directly granted FOLDER visible after the move, so
      // the persisted location — not the row count — is the proof.)
      await expect
        .poll(
          () =>
            countGfsLiveChildrenByName({
              parentResourceId: destinationDir.resourceId,
              name: sourceDir.childName,
            }),
          { timeout: 30_000, intervals: [250, 1_000] }
        )
        .toBe(1)
      expect(
        getGfsChildResourceSummary({
          parentResourceId: sourceDir.resourceId,
          name: sourceDir.childName,
        })
      ).toBeNull()
    } finally {
      await app?.close().catch(() => undefined)
      await removeFixture(sourceName)
      await removeFixture(destinationName)
    }
  })
})
