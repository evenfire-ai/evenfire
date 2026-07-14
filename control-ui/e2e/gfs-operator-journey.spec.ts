/**
 * E2E - GFS operator journey
 *
 * The setup creates only an isolated GFS fixture. The grant behavior under test
 * is performed through the Control UI: visible login, sidebar navigation,
 * resource selection, confirmation, and persisted grant proof.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'
import {
  cleanupE2EUserTeam,
  cleanupGfsFixture,
  cleanupGfsWorkflowRecipeFixture,
  getE2EUserId,
  getGfsChildResourceSummary,
  getGfsGrantSummary,
  seedE2EUserTeam,
  seedGfsDirectoryFixture,
  seedGfsWorkflowRecipeFixture,
  uniqueGfsFixtureName,
} from '../../tests/e2e/gfsUiFixtures'
import { E2E_TEST_EMAIL } from '../../tests/e2e/testUser'
import { GFS_RESOURCE_NAME_MAX_LENGTH, normalizeGfsResourceName } from '../lib/gfsResourceName'

const BASE_UI = process.env.CONTROL_UI_URL || 'http://localhost:3000'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'

async function loginControlUi(page: Page): Promise<void> {
  await page.goto(BASE_UI)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 })
  await page.getByLabel('Username or email').fill(ADMIN_USER)
  await page.getByLabel('Password').fill(ADMIN_PASS)
  await page.getByRole('button', { name: 'Sign in' }).last().click()
  await expect(page.getByRole('navigation', { name: 'Main sections' })).toBeVisible({
    timeout: 20_000,
  })
  await dismissAccountAlert(page)
}

async function dismissAccountAlert(page: Page): Promise<void> {
  const remindLater = page.getByRole('button', { name: 'Remind me later' })
  if (await remindLater.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await remindLater.click()
    await expect(remindLater).toBeHidden({ timeout: 10_000 })
  }
}

async function expectCopyButtonWritesClipboard(
  page: Page,
  button: Locator,
  expectedUri: string
): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(BASE_UI).origin,
  })
  await expect(button).toHaveAttribute('title', expectedUri)
  await button.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedUri)
}

test.describe('GFS operator journey', () => {
  test.setTimeout(180_000)

  test('authenticated operator reaches Global Files without a 401 logout redirect', async ({
    page,
  }) => {
    const fixture = seedGfsDirectoryFixture(uniqueGfsFixtureName('e2e-gfs-auth'))

    try {
      await test.step('operator logs in through the visible Control UI form', async () => {
        await loginControlUi(page)
      })

      await test.step('operator opens Global Files from the sidebar and the GFS tree request is authorized', async () => {
        const treeResponsePromise = page.waitForResponse(
          response =>
            response.request().method() === 'GET' &&
            response.url().includes('/control-api/api/v1/gfs/tree')
        )

        await page.getByRole('link', { name: /Global Files/i }).click()
        const treeResponse = await treeResponsePromise
        expect(treeResponse.status(), `${treeResponse.url()} ${await treeResponse.text()}`).toBe(
          200
        )
      })

      await test.step('operator remains on the GFS page with the seeded folder visible', async () => {
        await expect(page).toHaveURL(/\/gfs(?:$|\?)/, { timeout: 15_000 })
        await expect(page).not.toHaveURL(/\?next=%2Fgfs/)
        await expect(page.getByRole('heading', { name: 'Global File System' })).toBeVisible()
        await expect(
          page
            .getByRole('list', { name: 'Current folder resources' })
            .getByRole('button', { name: fixture.name, exact: true })
        ).toBeVisible({ timeout: 20_000 })
        await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0)
      })
    } finally {
      cleanupGfsFixture(fixture.name)
    }
  })

  test('operator grants folder access from Control UI using the cluster subject picker', async ({
    browserName,
    page,
  }) => {
    test.skip(
      browserName === 'firefox',
      'Full CRUD and delegation coverage runs in Chromium; Firefox runs the focused GFS auth-boundary journey.'
    )

    const fixture = seedGfsDirectoryFixture(uniqueGfsFixtureName('e2e-gfs-operator'))
    const targetUserId = getE2EUserId()
    const targetTeam = seedE2EUserTeam(E2E_TEST_EMAIL, uniqueGfsFixtureName('e2e-gfs-team'))
    const workflowRecipe = seedGfsWorkflowRecipeFixture(uniqueGfsFixtureName('e2e-gfs-workflow'))
    const grantPanel = () =>
      page.locator('.cu-form-section').filter({
        has: page.getByRole('heading', {
          name: `Manage access \u2014 ${fixture.name}`,
          exact: true,
        }),
      })
    const folderRow = (name: string) =>
      page
        .getByRole('list', { name: 'Current folder resources' })
        .getByRole('listitem')
        .filter({ has: page.getByRole('button', { name, exact: true }) })
        .first()

    try {
      await test.step('operator logs in and navigates to Global Files through the sidebar', async () => {
        await loginControlUi(page)
        await page.getByRole('link', { name: /Global Files/i }).click()
        await expect(page).toHaveURL(/\/gfs(?:$|\?)/, { timeout: 15_000 })
        await expect(page.getByRole('heading', { name: 'Global File System' })).toBeVisible()
        await expect(page.getByRole('region', { name: 'Global File System browser' })).toBeVisible()
      })

      await test.step('operator opens the grant panel for the seeded folder', async () => {
        const row = folderRow(fixture.name)
        await expect(row).toBeVisible({ timeout: 20_000 })
        await expectCopyButtonWritesClipboard(
          page,
          row.getByRole('button', { name: `Copy GFS link for ${fixture.name}` }),
          fixture.uri
        )
        await row.getByRole('button', { name: 'Manage access' }).click()
        await expect(
          page.getByRole('heading', { name: `Manage access \u2014 ${fixture.name}`, exact: true })
        ).toBeVisible()
      })

      await test.step('operator creates, uploads, renames, replaces, and deletes resources from the folder UI', async () => {
        await page.getByRole('button', { name: 'Close' }).click()
        await folderRow(fixture.name)
          .getByRole('button', { name: fixture.name, exact: true })
          .click()
        const currentResources = page.getByRole('list', { name: 'Current folder resources' })
        await expect(
          currentResources.getByRole('button', { name: fixture.childName, exact: true })
        ).toBeVisible({ timeout: 20_000 })

        const createdFolderRaw = `${uniqueGfsFixtureName('e2e-gfs-operator-created')}-${'very-long-'.repeat(24)}child`
        const createdFolder = await normalizeGfsResourceName(createdFolderRaw)
        expect(createdFolderRaw.length).toBeGreaterThan(GFS_RESOURCE_NAME_MAX_LENGTH)
        expect(createdFolder).toHaveLength(GFS_RESOURCE_NAME_MAX_LENGTH)
        const createResponsePromise = page.waitForResponse(
          response =>
            response.request().method() === 'POST' &&
            response.url().includes('/gfs/proxy/v1/resources/') &&
            response.url().includes('/children')
        )
        page.once('dialog', dialog => dialog.accept(createdFolderRaw))
        await page.getByRole('button', { name: 'New folder' }).click()
        const createResponse = await createResponsePromise
        expect(
          createResponse.status(),
          `${createResponse.url()} ${await createResponse.text()}`
        ).toBe(201)
        await expect(page.getByText('Folder created.').last()).toBeVisible({ timeout: 15_000 })
        await expect
          .poll(
            () =>
              getGfsChildResourceSummary({
                parentResourceId: fixture.resourceId,
                name: createdFolder,
              }),
            {
              timeout: 15_000,
              intervals: [250, 500, 1_000],
            }
          )
          .toMatchObject({ name: createdFolder, kind: 'directory', deleted: false })
        await expect(
          currentResources.getByRole('button', { name: createdFolder, exact: true })
        ).toBeVisible({ timeout: 15_000 })

        const uploadRawName = `${uniqueGfsFixtureName('e2e-gfs-operator-upload')}-${'very-long-'.repeat(24)}report.txt`
        const uploadName = await normalizeGfsResourceName(uploadRawName)
        expect(uploadRawName.length).toBeGreaterThan(GFS_RESOURCE_NAME_MAX_LENGTH)
        expect(uploadName).toHaveLength(GFS_RESOURCE_NAME_MAX_LENGTH)
        await page.locator('label:has-text("Upload file") input[type="file"]').setInputFiles({
          name: uploadRawName,
          mimeType: 'text/plain',
          buffer: Buffer.from('operator upload v1', 'utf8'),
        })
        await expect(page.getByText('File uploaded.').last()).toBeVisible({ timeout: 15_000 })
        await expect
          .poll(
            () =>
              getGfsChildResourceSummary({
                parentResourceId: fixture.resourceId,
                name: uploadName,
              }),
            {
              timeout: 15_000,
              intervals: [250, 500, 1_000],
            }
          )
          .toMatchObject({ name: uploadName, kind: 'file', bytes: 18, deleted: false })

        const rawRenamedName = uploadName.replace('.txt', '-renamed.txt')
        const renamedName = await normalizeGfsResourceName(rawRenamedName)
        const uploadRow = currentResources
          .getByRole('listitem')
          .filter({ hasText: uploadName })
          .first()
        await expect(uploadRow).toBeVisible({ timeout: 15_000 })
        page.once('dialog', dialog => dialog.accept(rawRenamedName))
        await uploadRow.getByRole('button', { name: 'Rename' }).click()
        await expect(page.getByText('Resource renamed.').last()).toBeVisible({ timeout: 15_000 })
        await expect
          .poll(
            () =>
              getGfsChildResourceSummary({
                parentResourceId: fixture.resourceId,
                name: renamedName,
              }),
            {
              timeout: 15_000,
              intervals: [250, 500, 1_000],
            }
          )
          .toMatchObject({ name: renamedName, kind: 'file', deleted: false })

        const renamedRow = currentResources
          .getByRole('listitem')
          .filter({ hasText: renamedName })
          .first()
        await renamedRow.locator('label:has-text("Replace") input[type="file"]').setInputFiles({
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
            {
              timeout: 15_000,
              intervals: [250, 500, 1_000],
            }
          )
          .toMatchObject({ bytes: 27, deleted: false })

        page.once('dialog', dialog => dialog.accept())
        await currentResources
          .getByRole('listitem')
          .filter({ hasText: renamedName })
          .first()
          .getByRole('button', { name: 'Delete' })
          .click()
        await expect(page.getByText('Resource deleted.').last()).toBeVisible({ timeout: 15_000 })
        await expect
          .poll(
            () =>
              getGfsChildResourceSummary({
                parentResourceId: fixture.resourceId,
                name: renamedName,
              }),
            {
              timeout: 15_000,
              intervals: [250, 500, 1_000],
            }
          )
          .toMatchObject({ deleted: true })
        await expect(
          currentResources.getByRole('listitem').filter({ hasText: renamedName })
        ).toHaveCount(0)

        await page.getByRole('button', { name: 'Back' }).click()
        await expect(folderRow(fixture.name)).toBeVisible({
          timeout: 20_000,
        })
        await folderRow(fixture.name).getByRole('button', { name: 'Manage access' }).click()
        await expect(
          page.getByRole('heading', { name: `Manage access \u2014 ${fixture.name}`, exact: true })
        ).toBeVisible()
      })

      await test.step('operator grants read/manage_acl to the seeded user through the form', async () => {
        const panel = grantPanel()
        await expect(panel).toBeVisible()
        await expect(panel.getByLabel('Subject ID')).toHaveCount(0)
        const subjectType = panel.getByLabel('Subject type')
        await expect(subjectType).toBeVisible()
        await subjectType.selectOption('user')
        await expect(panel.getByRole('checkbox', { name: 'Include descendants' })).toBeChecked()
        const subjectPicker = panel.getByRole('button', { name: 'User', exact: true })
        await expect(subjectPicker).toContainText('Choose a user')
        await subjectPicker.click()
        await page.getByLabel('Search users...').fill(E2E_TEST_EMAIL)
        const seededUserOption = page
          .locator('.cu-selection-dropdown__option')
          .filter({ hasText: E2E_TEST_EMAIL })
          .first()
        await expect(seededUserOption).toBeVisible({ timeout: 15_000 })
        await seededUserOption.click()
        await panel.getByRole('checkbox', { name: 'read' }).check()
        await panel.getByRole('checkbox', { name: 'manage_acl' }).check()
        await panel.getByRole('button', { name: 'Grant', exact: true }).click()
        const dialog = page.getByRole('alertdialog')
        await expect(dialog).toContainText('Grant access?')
        await dialog.getByRole('button', { name: 'Grant' }).click()
        await expect(page.getByText('Grant saved.').last()).toBeVisible({ timeout: 15_000 })

        await expect
          .poll(
            () =>
              getGfsGrantSummary({
                resourceId: fixture.resourceId,
                subjectType: 'user',
                subjectId: targetUserId,
              }),
            { timeout: 15_000, intervals: [250, 500, 1_000] }
          )
          .toMatchObject({
            permissions: ['read', 'manage_acl'],
            inherit: true,
            grantedBy: 'operator:',
          })
      })

      await test.step('operator grants read access to a team subject through the same picker', async () => {
        const panel = grantPanel()
        const subjectType = panel.getByLabel('Subject type')
        await subjectType.selectOption('team')
        const subjectPicker = panel.getByRole('button', { name: 'Team', exact: true })
        await expect(subjectPicker).toContainText('Choose a team')
        await subjectPicker.click()
        await page.getByLabel('Search teams...').fill(targetTeam.name)
        const seededTeamOption = page
          .locator('.cu-selection-dropdown__option')
          .filter({ hasText: targetTeam.name })
          .first()
        await expect(seededTeamOption).toBeVisible({ timeout: 15_000 })
        await seededTeamOption.click()
        await expect(subjectPicker).toContainText(targetTeam.name)
        await panel.getByRole('checkbox', { name: 'read' }).check()
        await panel.getByRole('button', { name: 'Grant', exact: true }).click()
        const dialog = page.getByRole('alertdialog')
        await expect(dialog).toContainText('Grant access?')
        await dialog.getByRole('button', { name: 'Grant' }).click()
        await expect(page.getByText('Grant saved.').last()).toBeVisible({ timeout: 15_000 })

        await expect
          .poll(
            () =>
              getGfsGrantSummary({
                resourceId: fixture.resourceId,
                subjectType: 'team',
                subjectId: targetTeam.id,
              }),
            { timeout: 15_000, intervals: [250, 500, 1_000] }
          )
          .toMatchObject({
            permissions: ['read'],
            inherit: true,
            grantedBy: 'operator:',
          })
      })

      await test.step('operator can seed the intrinsic operator subject from Control UI only', async () => {
        const panel = grantPanel()
        const subjectType = panel.getByLabel('Subject type')
        await subjectType.selectOption('operator')
        await expect(panel.getByText('The intrinsic cluster operator subject')).toBeVisible()
        await expect(panel.getByRole('button', { name: 'User', exact: true })).toHaveCount(0)
        await panel.getByRole('checkbox', { name: 'read' }).check()
        await panel.getByRole('button', { name: 'Grant', exact: true }).click()
        const dialog = page.getByRole('alertdialog')
        await expect(dialog).toContainText('Grant access?')
        await dialog.getByRole('button', { name: 'Grant' }).click()
        await expect(page.getByText('Grant saved.').last()).toBeVisible({ timeout: 15_000 })

        await expect
          .poll(
            () =>
              getGfsGrantSummary({
                resourceId: fixture.resourceId,
                subjectType: 'operator',
              }),
            { timeout: 15_000, intervals: [250, 500, 1_000] }
          )
          .toMatchObject({
            permissions: ['read'],
            inherit: true,
            grantedBy: 'operator:',
          })
      })

      await test.step('operator grants first-party agent runtime access without free-form host ids', async () => {
        const panel = grantPanel()
        const subjectType = panel.getByLabel('Subject type')
        await subjectType.selectOption('firstPartyAgent')
        const subjectPicker = panel.getByRole('button', { name: 'First-party agent', exact: true })
        await expect(subjectPicker).toContainText('Choose a first-party agent')
        await subjectPicker.click()
        const option = page
          .locator('.cu-selection-dropdown__option')
          .filter({ hasText: 'First-party agent runtime' })
          .first()
        await expect(option).toBeVisible({ timeout: 15_000 })
        await option.click()
        await expect(subjectPicker).toContainText('First-party agent runtime')
        await expect(
          panel.getByRole('button', { name: 'Create share', exact: true })
        ).toBeDisabled()
        await panel.getByRole('checkbox', { name: 'read' }).check()
        await panel.getByRole('checkbox', { name: 'write' }).check()
        await panel.getByRole('button', { name: 'Grant', exact: true }).click()
        const dialog = page.getByRole('alertdialog')
        await expect(dialog).toContainText('Grant access?')
        await dialog.getByRole('button', { name: 'Grant' }).click()
        await expect(page.getByText('Grant saved.').last()).toBeVisible({ timeout: 15_000 })

        await expect
          .poll(
            () =>
              getGfsGrantSummary({
                resourceId: fixture.resourceId,
                subjectType: 'host',
                subjectId: '1st:mcp-host/standalone',
              }),
            { timeout: 15_000, intervals: [250, 500, 1_000] }
          )
          .toMatchObject({
            permissions: ['read', 'write'],
            inherit: true,
            grantedBy: 'operator:',
          })
      })

      await test.step('operator grants workflow/plugin access from the recipe dropdown', async () => {
        const panel = grantPanel()
        const subjectType = panel.getByLabel('Subject type')
        await subjectType.selectOption('workflowPlugin')
        const subjectPicker = panel.getByRole('button', { name: 'Workflow / plugin', exact: true })
        await expect(subjectPicker).toContainText('Choose a workflow / plugin')
        await subjectPicker.click()
        await page.getByLabel('Search workflows or plugins...').fill(workflowRecipe.name)
        const option = page
          .locator('.cu-selection-dropdown__option')
          .filter({ hasText: workflowRecipe.name })
          .first()
        await expect(option).toBeVisible({ timeout: 20_000 })
        await option.click()
        await expect(subjectPicker).toContainText(workflowRecipe.name)
        await expect(
          panel.getByRole('button', { name: 'Create share', exact: true })
        ).toBeDisabled()
        await panel.getByRole('checkbox', { name: 'read' }).check()
        await panel.getByRole('checkbox', { name: 'write' }).check()
        await panel.getByRole('button', { name: 'Grant', exact: true }).click()
        const dialog = page.getByRole('alertdialog')
        await expect(dialog).toContainText('Grant access?')
        await dialog.getByRole('button', { name: 'Grant' }).click()
        await expect(page.getByText('Grant saved.').last()).toBeVisible({ timeout: 15_000 })

        await expect
          .poll(
            () =>
              getGfsGrantSummary({
                resourceId: fixture.resourceId,
                subjectType: 'host',
                subjectId: workflowRecipe.subjectId,
              }),
            { timeout: 15_000, intervals: [250, 500, 1_000] }
          )
          .toMatchObject({
            permissions: ['read', 'write'],
            inherit: true,
            grantedBy: 'operator:',
          })
      })

      await test.step('operator cannot submit without visible subject and permissions', async () => {
        const panel = grantPanel()
        await expect(panel.getByLabel('Subject ID')).toHaveCount(0)
        const subjectType = panel.getByLabel('Subject type')
        await expect(subjectType).toBeVisible()
        await subjectType.selectOption('user')
        await expect(panel.getByRole('button', { name: 'Grant', exact: true })).toBeDisabled()
        const subjectPicker = panel.getByRole('button', { name: 'User', exact: true })
        await expect(subjectPicker).toContainText('Choose a user')
        await subjectPicker.click()
        await page.getByLabel('Search users...').fill('not-a-uuid')
        await expect(page.getByText('No matching user options.')).toBeVisible()
        await expect(panel.getByRole('button', { name: 'Grant', exact: true })).toBeDisabled()
      })
    } finally {
      cleanupGfsWorkflowRecipeFixture(workflowRecipe.name)
      cleanupGfsFixture(fixture.name)
      cleanupE2EUserTeam(targetTeam.id)
    }
  })
})
