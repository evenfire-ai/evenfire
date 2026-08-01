import { type Locator, type Page, expect, test } from '@playwright/test'
import { getGfsChildResourceSummary, uniqueGfsFixtureName } from '../../../tests/e2e/gfsUiFixtures'
import { GFS_RESOURCE_NAME_MAX_LENGTH, normalizeGfsResourceName } from '../../lib/gfsResourceName'

type GfsCrudFixture = {
  childName: string
  name: string
  resourceId: string
  uri: string
}

type GfsResourceCrudJourneyInput = {
  baseUi: string
  fixture: GfsCrudFixture
  folderRow: (name: string) => Locator
  page: Page
}

export async function exerciseGfsResourceCrudJourney({
  baseUi,
  fixture,
  folderRow,
  page,
}: GfsResourceCrudJourneyInput): Promise<void> {
  await test.step('operator opens the grant panel for the seeded folder', async () => {
    const row = folderRow(fixture.name)
    await expect(row).toBeVisible({ timeout: 20_000 })
    const actionsButton = row.getByRole('button', { name: `Actions for ${fixture.name}` })
    await actionsButton.click()
    const copyButton = page.getByRole('menuitem', { name: 'Copy GFS link' })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(baseUi).origin,
    })
    await expect(copyButton).toHaveAttribute('title', fixture.uri)
    await copyButton.click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fixture.uri)
    await actionsButton.click()
    await page.getByRole('menuitem', { name: 'Manage access' }).click()
    await expect(
      page.getByRole('dialog', { name: `Manage folder ${fixture.name}`, exact: true })
    ).toBeVisible()
  })

  await test.step('operator creates, uploads, renames, replaces, and deletes resources from the folder UI', async () => {
    await page.getByRole('button', { name: 'Close manage dialog' }).click()
    await folderRow(fixture.name).getByRole('button', { name: fixture.name, exact: true }).click()
    const currentResources = page.getByRole('list', { name: 'Current folder resources' })
    await expect(
      currentResources.getByRole('button', { name: fixture.childName, exact: true })
    ).toBeVisible({ timeout: 20_000 })

    const createdFolderRaw =
      `${uniqueGfsFixtureName('e2e-gfs-operator-created')}-` + `${'very-long-'.repeat(24)}child`
    const createdFolder = await normalizeGfsResourceName(createdFolderRaw)
    expect(createdFolderRaw.length).toBeGreaterThan(GFS_RESOURCE_NAME_MAX_LENGTH)
    expect(createdFolder).toHaveLength(GFS_RESOURCE_NAME_MAX_LENGTH)
    const createResponsePromise = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().includes('/gfs/proxy/v1/resources/') &&
        response.url().includes('/children')
    )
    await page.getByRole('button', { name: 'New folder' }).click()
    const newFolderDialog = page.getByRole('dialog', { name: 'New folder' })
    await newFolderDialog.getByLabel('Folder name').fill(createdFolderRaw)
    await newFolderDialog.getByRole('button', { name: 'Create folder' }).click()
    const createResponse = await createResponsePromise
    expect(createResponse.status(), `${createResponse.url()} ${await createResponse.text()}`).toBe(
      201
    )
    await expect(page.getByText('Folder created.').last()).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(
        () =>
          getGfsChildResourceSummary({
            parentResourceId: fixture.resourceId,
            name: createdFolder,
          }),
        { timeout: 15_000, intervals: [250, 500, 1_000] }
      )
      .toMatchObject({ name: createdFolder, kind: 'directory', deleted: false })
    await expect(
      currentResources.getByRole('button', { name: createdFolder, exact: true })
    ).toBeVisible({ timeout: 15_000 })

    const uploadName = `${uniqueGfsFixtureName('e2e-gfs-operator-upload')}-report.txt`
    await page.getByRole('button', { name: 'Upload file' }).click()
    const uploadDialog = page.getByRole('dialog', { name: 'Upload file' })
    await uploadDialog.getByLabel('Choose file to upload').setInputFiles({
      name: uploadName,
      mimeType: 'text/plain',
      buffer: Buffer.from('operator upload v1', 'utf8'),
    })
    await uploadDialog.getByRole('button', { name: 'Upload', exact: true }).click()
    await expect(page.getByText('File uploaded.').last()).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(
        () =>
          getGfsChildResourceSummary({
            parentResourceId: fixture.resourceId,
            name: uploadName,
          }),
        { timeout: 15_000, intervals: [250, 500, 1_000] }
      )
      .toMatchObject({ name: uploadName, kind: 'file', bytes: 18, deleted: false })

    const renamedName = uploadName.replace('.txt', '-renamed.txt')
    const uploadRow = currentResources.getByRole('listitem').filter({ hasText: uploadName }).first()
    await expect(uploadRow).toBeVisible({ timeout: 15_000 })
    await uploadRow.getByRole('button', { name: `Actions for ${uploadName}` }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const renameForm = page.getByRole('form', { name: 'Rename resource' })
    await renameForm.getByLabel('New name').fill(renamedName)
    await renameForm.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Resource renamed.').last()).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(
        () =>
          getGfsChildResourceSummary({
            parentResourceId: fixture.resourceId,
            name: renamedName,
          }),
        { timeout: 15_000, intervals: [250, 500, 1_000] }
      )
      .toMatchObject({ name: renamedName, kind: 'file', deleted: false })

    const renamedRow = currentResources
      .getByRole('listitem')
      .filter({ hasText: renamedName })
      .first()
    await renamedRow.getByRole('button', { name: `Actions for ${renamedName}` }).click()
    await page.getByLabel(`Replace ${renamedName}`).setInputFiles({
      name: renamedName,
      mimeType: 'text/plain',
      buffer: Buffer.from('operator upload v2 extended', 'utf8'),
    })
    await expect(page.getByText('File replaced.').last()).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(
        () =>
          getGfsChildResourceSummary({
            parentResourceId: fixture.resourceId,
            name: renamedName,
          }),
        { timeout: 15_000, intervals: [250, 500, 1_000] }
      )
      .toMatchObject({ bytes: 27, deleted: false })

    const deleteRow = currentResources
      .getByRole('listitem')
      .filter({ hasText: renamedName })
      .first()
    await deleteRow.getByRole('button', { name: `Actions for ${renamedName}` }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await page
      .getByRole('alertdialog', { name: 'Delete resource' })
      .getByRole('button', {
        name: 'Delete',
        exact: true,
      })
      .click()
    await expect(page.getByText('Resource deleted.').last()).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(
        () =>
          getGfsChildResourceSummary({
            parentResourceId: fixture.resourceId,
            name: renamedName,
          }),
        { timeout: 15_000, intervals: [250, 500, 1_000] }
      )
      .toMatchObject({ deleted: true })
    await expect(
      currentResources.getByRole('listitem').filter({ hasText: renamedName })
    ).toHaveCount(0)

    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('button', { name: 'Drive main', exact: true })
      .click()
    await expect(folderRow(fixture.name)).toBeVisible({ timeout: 20_000 })
    await folderRow(fixture.name)
      .getByRole('button', { name: `Actions for ${fixture.name}` })
      .click()
    await page.getByRole('menuitem', { name: 'Manage access' }).click()
    await expect(
      page.getByRole('dialog', { name: `Manage folder ${fixture.name}`, exact: true })
    ).toBeVisible()
  })
}
