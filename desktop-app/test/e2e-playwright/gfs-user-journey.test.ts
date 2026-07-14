/**
 * E2E - GFS user journey
 *
 * The setup seeds only isolated GFS resources. The operator access changes are
 * performed through Control UI, then Desktop App validates automatic discovery
 * and affordances for both seeded end users.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'
import {
  type E2EDelegateVisibility,
  addE2EUserToTeam,
  cleanupE2EDelegateVisibility,
  cleanupE2EUserTeam,
  cleanupGfsFixture,
  ensureE2EDelegateVisibleToOwner,
  getE2EUserId,
  getGfsChildResourceSummary,
  getGfsGrantSummary,
  getGfsShareSummary,
  seedE2EUserTeam,
  seedGfsDirectoryFixture,
  seedGfsFileFixture,
  uniqueGfsFixtureName,
} from '../../../tests/e2e/gfsUiFixtures'
import { openResourcesNavItem } from './navigationHelpers'
import { launchAndLogin } from './workflowUi'

const OWNER_EMAIL = 'test@clerum.io'
const DELEGATE_EMAIL = 'test2@clerum.io'
const CONTROL_UI =
  process.env.CONTROL_UI_URL || process.env.CONTROL_UI_BASE_URL || 'http://localhost:3000'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'
const GFS_RESOURCE_NAME_MAX_LENGTH = 255
const GFS_RESOURCE_NAME_HASH_LENGTH = 12
const GFS_RESOURCE_EXTENSION_MAX_LENGTH = 48

async function expectedShortGfsResourceName(name: string): Promise<string> {
  const normalized = name.normalize('NFC')
  if (normalized.length <= GFS_RESOURCE_NAME_MAX_LENGTH) return normalized

  const lastDot = normalized.lastIndexOf('.')
  const extension =
    lastDot > 0 && lastDot !== normalized.length - 1 ? normalized.slice(lastDot) : ''
  const safeExtension = extension.length <= GFS_RESOURCE_EXTENSION_MAX_LENGTH ? extension : ''
  const base = safeExtension ? normalized.slice(0, -safeExtension.length) : normalized
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, GFS_RESOURCE_NAME_HASH_LENGTH)
  const suffix = `-${hash}${safeExtension}`
  const maxBaseLength = GFS_RESOURCE_NAME_MAX_LENGTH - suffix.length
  const truncatedBase = base.slice(0, maxBaseLength).replace(/[\s._-]+$/g, '')
  const safeBase = truncatedBase || base.slice(0, maxBaseLength)

  return `${safeBase}${suffix}`
}

async function loginControlUi(page: Page): Promise<void> {
  await page.goto(CONTROL_UI)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 })
  await page.getByLabel('Username or email').fill(ADMIN_USER)
  await page.getByLabel(/password/i).fill(ADMIN_PASS)
  await page.getByRole('button', { name: 'Sign in' }).last().click()
  await expect(page.getByRole('navigation', { name: 'Main sections' })).toBeVisible({
    timeout: 20_000,
  })
  const remindLater = page.getByRole('button', { name: 'Remind me later' })
  if (await remindLater.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await remindLater.click()
    await expect(remindLater).toBeHidden({ timeout: 10_000 })
  }
}

async function openControlGfs(page: Page): Promise<void> {
  await loginControlUi(page)
  await page.getByRole('link', { name: /Global Files/i }).click()
  await expect(page).toHaveURL(/\/gfs(?:$|\?)/, { timeout: 15_000 })
  await expect(page.getByRole('region', { name: 'Global File System browser' })).toBeVisible()
}

async function expectCopyButtonWritesClipboard(
  page: Page,
  button: Locator,
  expectedUri: string
): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await expect(button).toHaveAttribute('title', expectedUri)
  await button.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedUri)
}

function controlResourceRow(page: Page, name: string) {
  return page
    .getByRole('list', { name: 'Current folder resources' })
    .getByRole('listitem')
    .filter({ hasText: name })
    .first()
}

async function openManageAccess(page: Page, name: string): Promise<void> {
  const row = controlResourceRow(page, name)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.getByRole('button', { name: 'Manage access' }).click()
  await expect(page.getByRole('heading', { name: `Manage access — ${name}` })).toBeVisible()
  await expect(page.getByLabel('Subject ID')).toHaveCount(0)
}

async function chooseUserSubject(page: Page, email: string): Promise<void> {
  const subjectType = page.getByLabel('Subject type')
  await expect(subjectType).toBeVisible()
  await subjectType.selectOption('user')
  const subjectPicker = page.getByRole('button', { name: 'User', exact: true })
  await expect(subjectPicker).toContainText('Choose a user')
  await subjectPicker.click()
  await page.getByLabel('Search users...').fill(email)
  const option = page.locator('.cu-selection-dropdown__option').filter({ hasText: email }).first()
  await expect(option).toBeVisible({ timeout: 15_000 })
  await option.click()
}

async function chooseTeamSubject(page: Page, teamName: string): Promise<void> {
  const subjectType = page.getByLabel('Subject type')
  await expect(subjectType).toBeVisible()
  await subjectType.selectOption('team')
  const subjectPicker = page.getByRole('button', { name: 'Team', exact: true })
  await expect(subjectPicker).toContainText('Choose a team')
  await subjectPicker.click()
  await page.getByLabel('Search teams...').fill(teamName)
  const option = page
    .locator('.cu-selection-dropdown__option')
    .filter({ hasText: teamName })
    .first()
  await expect(option).toBeVisible({ timeout: 15_000 })
  await option.click()
}

async function setDescendantScope(page: Page, enabled: boolean): Promise<void> {
  const scope = page.getByRole('checkbox', { name: 'Include descendants' })
  if ((await scope.count()) === 0) {
    expect(enabled).toBe(false)
    return
  }
  if (enabled) await expect(scope).toBeChecked()
  else await scope.uncheck()
}

async function choosePermissions(page: Page, bits: string[]): Promise<void> {
  for (const bit of bits) {
    await page.getByRole('checkbox', { name: bit, exact: true }).check()
  }
}

async function submitAccessMutation(page: Page, action: 'Grant' | 'Create share'): Promise<void> {
  await page.getByRole('button', { name: action, exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText(action === 'Grant' ? 'Grant access?' : 'Create share?')
  await dialog.getByRole('button', { name: action }).click()
  await expect(
    page.getByText(action === 'Grant' ? 'Grant saved.' : 'Share created.').last()
  ).toBeVisible({
    timeout: 15_000,
  })
  await page.getByRole('button', { name: 'Close', exact: true }).click()
}

async function expectDesktopToast(page: Page, text: string): Promise<void> {
  try {
    await expect(page.getByText(text)).toBeVisible({ timeout: 20_000 })
  } catch (error) {
    const alerts = await page
      .getByRole('alert')
      .allTextContents()
      .catch(() => [])
    const visibleText = await page
      .locator('body')
      .innerText()
      .catch(() => '')
    throw new Error(
      [
        `Expected Desktop toast "${text}" was not visible.`,
        alerts.length ? `Visible alerts: ${alerts.join(' | ')}` : 'Visible alerts: <none>',
        `Page text excerpt: ${visibleText.slice(0, 1200)}`,
        error instanceof Error ? error.message : String(error),
      ].join('\n')
    )
  }
}

test.describe('GFS Desktop user journey', () => {
  test.setTimeout(180_000)

  test('operator grants two users different GFS scopes and Desktop shows the correct resources', async ({
    page: controlPage,
  }) => {
    const fixture = seedGfsDirectoryFixture(uniqueGfsFixtureName('e2e-gfs-desktop'))
    const teamFixture = seedGfsDirectoryFixture(uniqueGfsFixtureName('e2e-gfs-desktop-team'))
    const fileFixture = seedGfsFileFixture(uniqueGfsFixtureName('e2e-gfs-desktop-file'))
    const delegateFileFixture = seedGfsFileFixture(
      uniqueGfsFixtureName('e2e-gfs-desktop-delegate-file')
    )
    const shareChainFixture = seedGfsDirectoryFixture(
      uniqueGfsFixtureName('e2e-gfs-desktop-share-chain')
    )
    const ownerUserId = getE2EUserId(OWNER_EMAIL)
    const delegateUserId = getE2EUserId(DELEGATE_EMAIL)
    const ownerTeam = seedE2EUserTeam(OWNER_EMAIL, uniqueGfsFixtureName('e2e-gfs-owner-team'))
    addE2EUserToTeam(DELEGATE_EMAIL, ownerTeam.id)
    let delegateVisibility: E2EDelegateVisibility | null = null

    try {
      delegateVisibility = ensureE2EDelegateVisibleToOwner({
        ownerEmail: OWNER_EMAIL,
        delegateEmail: DELEGATE_EMAIL,
      })
      await test.step('operator grants folder tree and direct file access through Control UI', async () => {
        await openControlGfs(controlPage)

        await openManageAccess(controlPage, fixture.name)
        await setDescendantScope(controlPage, true)
        await chooseUserSubject(controlPage, OWNER_EMAIL)
        await choosePermissions(controlPage, ['read', 'write', 'delete', 'manage_acl'])
        await submitAccessMutation(controlPage, 'Grant')
        await expect
          .poll(
            () =>
              getGfsGrantSummary({
                resourceId: fixture.resourceId,
                subjectType: 'user',
                subjectId: ownerUserId,
              }),
            { timeout: 15_000, intervals: [250, 500, 1_000] }
          )
          .toMatchObject({
            permissions: ['read', 'write', 'delete', 'manage_acl'],
            inherit: true,
            grantedBy: 'operator:',
          })

        await openManageAccess(controlPage, teamFixture.name)
        await setDescendantScope(controlPage, true)
        await chooseTeamSubject(controlPage, ownerTeam.name)
        await choosePermissions(controlPage, ['read', 'manage_acl'])
        await submitAccessMutation(controlPage, 'Grant')
        await expect
          .poll(
            () =>
              getGfsGrantSummary({
                resourceId: teamFixture.resourceId,
                subjectType: 'team',
                subjectId: ownerTeam.id,
              }),
            { timeout: 15_000, intervals: [250, 500, 1_000] }
          )
          .toMatchObject({
            permissions: ['read', 'manage_acl'],
            inherit: true,
            grantedBy: 'operator:',
          })

        await openManageAccess(controlPage, shareChainFixture.name)
        await setDescendantScope(controlPage, true)
        await chooseUserSubject(controlPage, OWNER_EMAIL)
        await choosePermissions(controlPage, ['read', 'manage_acl', 'share'])
        await submitAccessMutation(controlPage, 'Grant')
        await expect
          .poll(
            () =>
              getGfsGrantSummary({
                resourceId: shareChainFixture.resourceId,
                subjectType: 'user',
                subjectId: ownerUserId,
              }),
            { timeout: 15_000, intervals: [250, 500, 1_000] }
          )
          .toMatchObject({
            permissions: ['read', 'manage_acl', 'share'],
            inherit: true,
            grantedBy: 'operator:',
          })

        await controlResourceRow(controlPage, fixture.name)
          .getByRole('button', { name: fixture.name, exact: true })
          .click()
        await openManageAccess(controlPage, fixture.childName)
        await setDescendantScope(controlPage, true)
        await chooseUserSubject(controlPage, DELEGATE_EMAIL)
        await choosePermissions(controlPage, ['read', 'share'])
        await submitAccessMutation(controlPage, 'Create share')
        await expect
          .poll(
            () =>
              getGfsShareSummary({
                resourceId: fixture.childResourceId,
                subjectType: 'user',
                subjectId: delegateUserId,
              }),
            { timeout: 15_000, intervals: [250, 500, 1_000] }
          )
          .toMatchObject({
            permissions: ['read', 'share'],
            includeDescendants: true,
            createdBy: 'operator:',
          })

        await controlPage.getByRole('button', { name: 'Back' }).click()
        await controlResourceRow(controlPage, fileFixture.name)
          .getByRole('button', { name: fileFixture.name, exact: true })
          .click()
        await openManageAccess(controlPage, fileFixture.fileName)
        await setDescendantScope(controlPage, false)
        await chooseUserSubject(controlPage, OWNER_EMAIL)
        await choosePermissions(controlPage, ['read'])
        await submitAccessMutation(controlPage, 'Grant')
        await expect
          .poll(
            () =>
              getGfsGrantSummary({
                resourceId: fileFixture.fileResourceId,
                subjectType: 'user',
                subjectId: ownerUserId,
              }),
            { timeout: 15_000, intervals: [250, 500, 1_000] }
          )
          .toMatchObject({
            permissions: ['read'],
            inherit: false,
            grantedBy: 'operator:',
          })

        await controlPage.getByRole('button', { name: 'Back' }).click()
        await controlResourceRow(controlPage, delegateFileFixture.name)
          .getByRole('button', { name: delegateFileFixture.name, exact: true })
          .click()
        await openManageAccess(controlPage, delegateFileFixture.fileName)
        await setDescendantScope(controlPage, false)
        await chooseUserSubject(controlPage, DELEGATE_EMAIL)
        await choosePermissions(controlPage, ['read'])
        await submitAccessMutation(controlPage, 'Grant')
        await expect
          .poll(
            () =>
              getGfsGrantSummary({
                resourceId: delegateFileFixture.fileResourceId,
                subjectType: 'user',
                subjectId: delegateUserId,
              }),
            { timeout: 15_000, intervals: [250, 500, 1_000] }
          )
          .toMatchObject({
            permissions: ['read'],
            inherit: false,
            grantedBy: 'operator:',
          })
      })

      const ownerSession = await launchAndLogin(OWNER_EMAIL)
      try {
        await test.step('user navigates to Files through Desktop navigation', async () => {
          await openResourcesNavItem(ownerSession.page, 'nav-files')
          await expect(
            ownerSession.page.getByRole('heading', { name: 'Files', exact: true })
          ).toBeVisible({ timeout: 20_000 })
          await expect(
            ownerSession.page.getByRole('region', { name: 'GFS resources shared with you' })
          ).toBeVisible()
          await expect(ownerSession.page.getByLabel('gfs URI')).toBeVisible()
          await expect(
            ownerSession.page.getByText(/Automatic GFS discovery is not available/i)
          ).toHaveCount(0)
        })

        await test.step('user sees team folder trees and direct files without pasting a link', async () => {
          const shared = ownerSession.page.getByRole('region', {
            name: 'GFS resources shared with you',
          })
          await expect(shared).toContainText(fixture.name, { timeout: 30_000 })
          await expect(shared).toContainText('Folder tree')
          await expect(shared).toContainText(teamFixture.name)
          await expect(shared).toContainText(shareChainFixture.name)
          await expect(shared).toContainText(fileFixture.fileName)
          await expect(shared).toContainText('File')
          await expectCopyButtonWritesClipboard(
            ownerSession.page,
            shared.getByRole('button', { name: `Copy GFS link for ${fileFixture.fileName}` }),
            fileFixture.fileUri
          )
        })

        await test.step('user opens the delegated team folder tree and sees its children', async () => {
          const shared = ownerSession.page.getByRole('region', {
            name: 'GFS resources shared with you',
          })
          await shared.getByRole('button', { name: fixture.name, exact: true }).click()
          const browser = ownerSession.page.getByRole('region', {
            name: 'Global File System browser',
          })
          await expect(browser).toBeVisible({ timeout: 30_000 })
          await expect(
            browser.getByRole('button', { name: fixture.name, exact: true })
          ).toBeVisible()
          await expect(browser).toContainText(fixture.childName, { timeout: 30_000 })
          const childRow = browser
            .getByRole('listitem')
            .filter({ hasText: fixture.childName })
            .first()
          await expectCopyButtonWritesClipboard(
            ownerSession.page,
            childRow.getByRole('button', { name: `Copy GFS link for ${fixture.childName}` }),
            fixture.childUri
          )
        })

        await test.step('user can still open a direct gfs:// link manually', async () => {
          await ownerSession.page.getByLabel('gfs URI').fill(fixture.uri)
          await ownerSession.page.getByRole('button', { name: 'Open', exact: true }).click()
          const browser = ownerSession.page.getByRole('region', {
            name: 'Global File System browser',
          })
          await expect(browser).toContainText(fixture.childName, { timeout: 30_000 })
        })

        await test.step('user sees no-escalation affordances before delegating', async () => {
          const delegation = ownerSession.page.getByRole('region', { name: 'Delegate access' })
          await expect(delegation).toBeVisible({ timeout: 20_000 })
          const permissions = delegation.getByRole('group', { name: 'permissions' })
          await expect(permissions.getByRole('button', { name: 'read' })).toBeVisible()
          await expect(permissions.getByRole('button', { name: 'write' })).toBeVisible()
          await expect(permissions.getByRole('button', { name: 'delete' })).toBeVisible()
          await expect(permissions.getByRole('button', { name: 'manage_acl' })).toBeVisible()
          await expect(permissions.getByRole('button', { name: 'share' })).toHaveCount(0)
          await expect(delegation.getByRole('button', { name: 'Create share' })).toHaveCount(0)
        })

        await test.step('user creates, uploads, renames, replaces, and deletes with their own GFS permissions', async () => {
          const browser = ownerSession.page.getByRole('region', {
            name: 'Global File System browser',
          })
          await expect(browser.getByRole('button', { name: 'New folder' })).toBeVisible()
          await expect(browser.locator('label:has-text("Upload file")')).toBeVisible()
          await expect(browser.getByRole('button', { name: 'Rename' })).toBeVisible()
          await expect(browser.getByRole('button', { name: 'Delete' })).toBeVisible()

          const createdFolder = uniqueGfsFixtureName('e2e-gfs-desktop-created')
          await browser.getByRole('button', { name: 'New folder' }).click()
          const createFolderForm = browser.getByRole('form', { name: 'Create folder' })
          await expect(createFolderForm).toBeVisible()
          await createFolderForm.getByLabel('Folder name').fill(createdFolder)
          await createFolderForm.getByRole('button', { name: 'Create folder' }).click()
          await expectDesktopToast(ownerSession.page, `Folder ${createdFolder} created`)
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
            browser.getByRole('button', { name: createdFolder, exact: true })
          ).toBeVisible({
            timeout: 20_000,
          })

          const uploadRawName = `${uniqueGfsFixtureName('e2e-gfs-desktop-upload')}-${'very-long-'.repeat(24)}report.txt`
          const uploadName = await expectedShortGfsResourceName(uploadRawName)
          expect(uploadRawName.length).toBeGreaterThan(GFS_RESOURCE_NAME_MAX_LENGTH)
          expect(uploadName).toHaveLength(GFS_RESOURCE_NAME_MAX_LENGTH)
          const uploadContent = 'desktop upload v1'
          await browser.locator('label:has-text("Upload file") input[type="file"]').setInputFiles({
            name: uploadRawName,
            mimeType: 'text/plain',
            buffer: Buffer.from(uploadContent, 'utf8'),
          })
          await expectDesktopToast(ownerSession.page, `Uploaded ${uploadName}`)
          await expect
            .poll(
              () =>
                getGfsChildResourceSummary({
                  parentResourceId: fixture.resourceId,
                  name: uploadName,
                }),
              { timeout: 15_000, intervals: [250, 500, 1_000] }
            )
            .toMatchObject({
              name: uploadName,
              kind: 'file',
              bytes: Buffer.byteLength(uploadContent, 'utf8'),
              deleted: false,
            })
          await expect(browser.getByRole('button', { name: uploadName, exact: true })).toBeVisible({
            timeout: 20_000,
          })

          await browser.getByRole('button', { name: uploadName, exact: true }).click()
          await expect(browser.getByRole('heading', { name: uploadName })).toBeVisible({
            timeout: 20_000,
          })
          await expect(browser.locator('label:has-text("Replace")')).toBeVisible()
          await expect(browser.getByRole('button', { name: 'New folder' })).toHaveCount(0)

          const rawRenamedName = uploadName.replace('.txt', '-renamed.txt')
          const renamedName = await expectedShortGfsResourceName(rawRenamedName)
          await browser.getByRole('button', { name: 'Rename' }).click()
          const renameForm = browser.getByRole('form', { name: 'Rename resource' })
          await expect(renameForm).toBeVisible()
          await renameForm.getByLabel('New name').fill(rawRenamedName)
          await renameForm.getByRole('button', { name: 'Save name' }).click()
          await expectDesktopToast(ownerSession.page, `Renamed to ${renamedName}`)
          await expect(browser.getByRole('heading', { name: renamedName })).toBeVisible({
            timeout: 20_000,
          })
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

          const replaceContent = 'desktop upload v2 extended'
          await browser.locator('label:has-text("Replace") input[type="file"]').setInputFiles({
            name: renamedName,
            mimeType: 'text/plain',
            buffer: Buffer.from(replaceContent, 'utf8'),
          })
          await expectDesktopToast(ownerSession.page, `Replaced ${renamedName}`)
          await expect
            .poll(
              () =>
                getGfsChildResourceSummary({
                  parentResourceId: fixture.resourceId,
                  name: renamedName,
                }),
              { timeout: 15_000, intervals: [250, 500, 1_000] }
            )
            .toMatchObject({ bytes: Buffer.byteLength(replaceContent, 'utf8'), deleted: false })

          await browser.getByRole('button', { name: 'Delete' }).click()
          const deleteDialog = browser.getByRole('alertdialog', { name: 'Delete resource' })
          await expect(deleteDialog).toBeVisible()
          await deleteDialog.getByRole('button', { name: 'Delete' }).click()
          await expectDesktopToast(ownerSession.page, `Deleted ${renamedName}`)
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
          await expect(browser.getByRole('heading', { name: renamedName })).toHaveCount(0)

          await ownerSession.page.getByLabel('gfs URI').fill(fixture.uri)
          await ownerSession.page.getByRole('button', { name: 'Open', exact: true }).click()
          await expect(browser).toContainText(fixture.childName, { timeout: 30_000 })
        })

        await test.step('user delegates read access to test2 through Desktop UI', async () => {
          const delegation = ownerSession.page.getByRole('region', { name: 'Delegate access' })
          await expect(delegation.getByLabel('Subject type')).toHaveValue('user')
          await delegation.getByLabel('subject', { exact: true }).selectOption(delegateUserId)
          await delegation.getByRole('button', { name: 'read' }).click()
          await delegation.getByRole('button', { name: 'Grant' }).click()
          await expect(ownerSession.page.getByText('Access granted')).toBeVisible({
            timeout: 20_000,
          })

          await expect
            .poll(
              () =>
                getGfsGrantSummary({
                  resourceId: fixture.resourceId,
                  subjectType: 'user',
                  subjectId: delegateUserId,
                }),
              { timeout: 15_000, intervals: [250, 500, 1_000] }
            )
            .toMatchObject({
              permissions: ['read'],
              inherit: false,
              grantedBy: `user:${ownerUserId}`,
            })
        })

        await test.step('user with the share bit creates a read share through Desktop UI', async () => {
          const shared = ownerSession.page.getByRole('region', {
            name: 'GFS resources shared with you',
          })
          await shared.getByRole('button', { name: shareChainFixture.name, exact: true }).click()
          const browser = ownerSession.page.getByRole('region', {
            name: 'Global File System browser',
          })
          await expect(browser).toContainText(shareChainFixture.childName, { timeout: 30_000 })

          const delegation = ownerSession.page.getByRole('region', { name: 'Delegate access' })
          await expect(delegation.getByRole('button', { name: 'Create share' })).toBeVisible()
          await expect(
            delegation.getByRole('group', { name: 'permissions' }).getByRole('button', {
              name: 'share',
            })
          ).toBeVisible()
          await delegation.getByLabel('Subject type').selectOption('user')
          await delegation.getByLabel('subject', { exact: true }).selectOption(delegateUserId)
          await delegation.getByRole('button', { name: 'Create share' }).click()
          await expect(ownerSession.page.getByText('Share created')).toBeVisible({
            timeout: 20_000,
          })

          await expect
            .poll(
              () =>
                getGfsShareSummary({
                  resourceId: shareChainFixture.resourceId,
                  subjectType: 'user',
                  subjectId: delegateUserId,
                }),
              { timeout: 15_000, intervals: [250, 500, 1_000] }
            )
            .toMatchObject({
              permissions: ['read'],
              includeDescendants: true,
              createdBy: `user:${ownerUserId}`,
            })
        })

        await test.step('user delegates read access to a visible team through Desktop UI', async () => {
          const shared = ownerSession.page.getByRole('region', {
            name: 'GFS resources shared with you',
          })
          await shared.getByRole('button', { name: teamFixture.name, exact: true }).click()
          const browser = ownerSession.page.getByRole('region', {
            name: 'Global File System browser',
          })
          await expect(browser).toContainText(teamFixture.childName, { timeout: 30_000 })

          const delegation = ownerSession.page.getByRole('region', { name: 'Delegate access' })
          await delegation.getByLabel('Subject type').selectOption('team')
          await delegation.getByLabel('subject', { exact: true }).selectOption(ownerTeam.id)
          await delegation.getByRole('button', { name: 'read' }).click()
          await delegation.getByRole('button', { name: 'Grant' }).click()
          await expect(ownerSession.page.getByText('Access granted')).toBeVisible({
            timeout: 20_000,
          })

          await expect
            .poll(
              () =>
                getGfsGrantSummary({
                  resourceId: teamFixture.resourceId,
                  subjectType: 'team',
                  subjectId: ownerTeam.id,
                }),
              { timeout: 15_000, intervals: [250, 500, 1_000] }
            )
            .toMatchObject({
              permissions: ['read'],
              inherit: false,
              grantedBy: `user:${ownerUserId}`,
            })
        })

        await test.step('user cannot target the intrinsic operator subject from Desktop UI', async () => {
          const delegation = ownerSession.page.getByRole('region', { name: 'Delegate access' })
          await expect(delegation.getByLabel('Subject type')).not.toContainText('Operator')
          await expect(delegation.getByLabel('Subject type')).not.toContainText('Host')
          await expect(delegation.getByLabel('Subject type')).not.toContainText('Context')
          await expect(delegation.getByLabel('subject', { exact: true })).not.toContainText(
            'operator'
          )
        })
      } finally {
        await ownerSession.app.close().catch(() => undefined)
      }

      const delegateSession = await launchAndLogin(DELEGATE_EMAIL)
      try {
        await test.step('second user sees delegated and shared folders but not unrelated files', async () => {
          await openResourcesNavItem(delegateSession.page, 'nav-files')
          await expect(
            delegateSession.page.getByRole('heading', { name: 'Files', exact: true })
          ).toBeVisible({ timeout: 20_000 })
          await expect(
            delegateSession.page.getByText(/Automatic GFS discovery is not available/i)
          ).toHaveCount(0)
          const shared = delegateSession.page.getByRole('region', {
            name: 'GFS resources shared with you',
          })
          await expect(shared).toContainText(fixture.name, { timeout: 30_000 })
          await expect(shared).toContainText('grant')
          await expect(shared).toContainText(fixture.childName, { timeout: 30_000 })
          await expect(shared).toContainText('Folder tree')
          await expect(shared).toContainText('share')
          await expect(shared).toContainText(shareChainFixture.name, { timeout: 30_000 })
          await expect(shared).toContainText(delegateFileFixture.fileName, { timeout: 30_000 })
          await expect(shared).toContainText(teamFixture.name)
          await expect(shared).not.toContainText(fileFixture.fileName)
        })

        await test.step('second user opens the share but cannot manage ACLs', async () => {
          const shared = delegateSession.page.getByRole('region', {
            name: 'GFS resources shared with you',
          })
          await shared.getByRole('button', { name: fixture.childName, exact: true }).click()
          const browser = delegateSession.page.getByRole('region', {
            name: 'Global File System browser',
          })
          await expect(browser).toBeVisible({ timeout: 30_000 })
          await expect(browser).toContainText(fixture.childName)
          await expect(browser.getByRole('button', { name: 'New folder' })).toHaveCount(0)
          await expect(browser.locator('label:has-text("Upload file")')).toHaveCount(0)
          await expect(browser.locator('label:has-text("Replace")')).toHaveCount(0)
          await expect(browser.getByRole('button', { name: 'Rename' })).toHaveCount(0)
          await expect(browser.getByRole('button', { name: 'Delete' })).toHaveCount(0)
          const delegation = delegateSession.page.getByRole('region', { name: 'Delegate access' })
          await expect(delegation).toContainText('Read-only access', { timeout: 20_000 })
          await expect(delegation.getByRole('button', { name: 'Grant' })).toHaveCount(0)
          await expect(delegation.getByRole('button', { name: 'Create share' })).toHaveCount(0)
        })

        await test.step('second user opens an authorized share from a direct gfs:// URI', async () => {
          await delegateSession.page.getByLabel('gfs URI').fill(fixture.childUri)
          await delegateSession.page.getByRole('button', { name: 'Open', exact: true }).click()
          const browser = delegateSession.page.getByRole('region', {
            name: 'Global File System browser',
          })
          await expect(browser).toContainText(fixture.childName, { timeout: 30_000 })
          const delegation = delegateSession.page.getByRole('region', { name: 'Delegate access' })
          await expect(delegation).toContainText('Read-only access', { timeout: 20_000 })
        })

        await test.step('second user downloads an authorized direct file grant', async () => {
          const shared = delegateSession.page.getByRole('region', {
            name: 'GFS resources shared with you',
          })
          const fileRow = shared
            .getByRole('listitem')
            .filter({ hasText: delegateFileFixture.fileName })
            .first()
          await expect(fileRow).toBeVisible({ timeout: 30_000 })
          await fileRow.getByRole('button', { name: 'Download' }).click()
          await expect(
            delegateSession.page.getByText(`Downloaded ${delegateFileFixture.fileName}`)
          ).toBeVisible({
            timeout: 20_000,
          })
        })

        await test.step('second user cannot open an unrelated direct file link', async () => {
          await delegateSession.page.getByLabel('gfs URI').fill(fileFixture.fileUri)
          await delegateSession.page.getByRole('button', { name: 'Open', exact: true }).click()
          await expect(delegateSession.page.getByText(/forbidden|denied|403/i)).toBeVisible({
            timeout: 20_000,
          })
        })
      } finally {
        await delegateSession.app.close().catch(() => undefined)
      }
    } finally {
      cleanupE2EDelegateVisibility(delegateVisibility)
      cleanupGfsFixture(fixture.name)
      cleanupGfsFixture(teamFixture.name)
      cleanupGfsFixture(fileFixture.name)
      cleanupGfsFixture(delegateFileFixture.name)
      cleanupGfsFixture(shareChainFixture.name)
      cleanupE2EUserTeam(ownerTeam.id)
    }
  })
})
