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
 */
import { type Locator, type Page, expect, test } from '@playwright/test'
import {
  assertGfsFixtureCleaned,
  cleanupGfsFixture,
  seedGfsDirectoryFixture,
  seedGfsFileFixture,
  uniqueGfsFixtureName,
} from '../../../tests/e2e/gfsUiFixtures'
import { launchAndLogin } from './workflowUi'

function gridRow(page: Page, name: string): Locator {
  return page.getByRole('button', { name: `Open ${name}`, exact: true })
}

function toast(page: Page, text: string): Locator {
  return page.locator('[role="status"], [role="alert"]').filter({ hasText: text })
}

async function openFilesSharedRoot(page: Page): Promise<void> {
  const filesNav = page.getByRole('button', { name: /^Files$/, exact: true }).first()
  await expect(filesNav).toBeVisible({ timeout: 30_000 })
  await filesNav.click()
  const sharedWithMe = page
    .getByRole('navigation', { name: 'File location', exact: true })
    .getByRole('button', { name: 'Shared with me', exact: true })
  await expect(sharedWithMe).toBeVisible({ timeout: 30_000 })
  await expect(sharedWithMe).toHaveAttribute('aria-current', 'page')
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
    const fileFixtureName = uniqueGfsFixtureName('e2e-dnd-file')
    const dirFixtureName = uniqueGfsFixtureName('e2e-dnd-dir')
    const file = seedGfsFileFixture(fileFixtureName)
    const dir = seedGfsDirectoryFixture(dirFixtureName)
    const { app, page } = await launchAndLogin()
    try {
      await openFilesSharedRoot(page)
      const fileRow = gridRow(page, file.fileName)
      const dirRow = gridRow(page, dir.name)
      await fileRow.waitFor({ state: 'visible', timeout: 60_000 })
      await dirRow.waitFor({ state: 'visible', timeout: 60_000 })

      await dragRowOntoRow(page, fileRow, dirRow)

      await expect(toast(page, `Moved ${file.fileName} to ${dir.name}`)).toBeVisible({
        timeout: 30_000,
      })
      await expect(fileRow).toBeHidden({ timeout: 30_000 })
    } finally {
      await app.close().catch(() => undefined)
      cleanupGfsFixture(fileFixtureName)
      cleanupGfsFixture(dirFixtureName)
      assertGfsFixtureCleaned(fileFixtureName)
      assertGfsFixtureCleaned(dirFixtureName)
    }
  })

  test('folder drag stops at the one confirmation: Cancel is a no-op, Move commits with impact info', async () => {
    const sourceDirName = uniqueGfsFixtureName('e2e-dnd-src')
    const destinationDirName = uniqueGfsFixtureName('e2e-dnd-dst')
    const sourceDir = seedGfsDirectoryFixture(sourceDirName)
    const destinationDir = seedGfsDirectoryFixture(destinationDirName)
    const { app, page } = await launchAndLogin()
    try {
      await openFilesSharedRoot(page)
      const sourceRow = gridRow(page, sourceDir.name)
      const destinationRow = gridRow(page, destinationDir.name)
      await sourceRow.waitFor({ state: 'visible', timeout: 60_000 })
      await destinationRow.waitFor({ state: 'visible', timeout: 60_000 })

      await dragRowOntoRow(page, sourceRow, destinationRow)
      const confirmDialog = page.getByRole('dialog', {
        name: `Move folder ${sourceDir.name} to ${destinationDir.name}`,
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

      await dragRowOntoRow(page, sourceRow, destinationRow)
      await expect(confirmDialog).toBeVisible({ timeout: 30_000 })
      await confirmDialog.getByRole('button', { name: 'Move', exact: true }).click()

      await expect(toast(page, `Moved ${sourceDir.name} to ${destinationDir.name}`)).toBeVisible({
        timeout: 30_000,
      })
      await expect(
        toast(
          page,
          'Moving a folder changes who can access its contents — access now follows the new location.'
        )
      ).toBeVisible({ timeout: 30_000 })
      await expect(sourceRow).toBeHidden({ timeout: 30_000 })
    } finally {
      await app.close().catch(() => undefined)
      cleanupGfsFixture(sourceDirName)
      cleanupGfsFixture(destinationDirName)
      assertGfsFixtureCleaned(sourceDirName)
      assertGfsFixtureCleaned(destinationDirName)
    }
  })
})
