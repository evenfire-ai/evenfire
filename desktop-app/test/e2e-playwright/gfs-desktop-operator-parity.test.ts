import type { Locator, Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { UUID_RE } from '../../../tests/e2e/gfsFixtureCore'
import { GFS_OPERATOR_SETUP_PATH } from './gfsDesktopOperatorParityContract'
import {
  type GfsOperatorLifecycleEvent,
  type GfsResourceRow,
  expect,
  test,
} from './helpers/gfsDesktopOperatorParityFixtures'

async function expectToast(page: Page, message: string): Promise<void> {
  // ToastStack exposes the status role on the container, while its decorative
  // icon is intentionally aria-hidden. Match the user-visible message inside
  // that container instead of requiring an exact accessible-name calculation
  // that differs between Chromium and Electron.
  await expect(page.getByRole('status').filter({ hasText: message })).toBeVisible({
    timeout: 30_000,
  })
}

function resourceRow(page: Page, resource: GfsResourceRow): Locator {
  return page.getByTestId(`gfs-resource-row-${resource.resourceId}`)
}

async function openResourceManage(page: Page, resource: GfsResourceRow): Promise<Locator> {
  const row = resourceRow(page, resource)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.getByRole('button', { name: `Options for ${resource.name}` }).click()
  await page.getByRole('menuitem', { name: 'Manage', exact: true }).click()
  const dialog = page.getByRole('dialog', {
    name: `Manage ${resource.kind === 'directory' ? 'folder' : 'file'} ${resource.name}`,
  })
  await expect(dialog).toBeVisible()
  return dialog
}

async function closeManageDialog(page: Page): Promise<void> {
  const close = page.getByRole('button', { name: 'Close manage dialog' })
  if ((await close.count()) > 0) await close.click()
}

async function ensureOperatorRoot(page: Page): Promise<void> {
  const root = page.getByTestId('gfs-root-operator')
  await expect(root).toBeVisible({ timeout: 30_000 })
  if (!(await root.isDisabled())) await root.click()
  await expect(root).toBeDisabled({ timeout: 30_000 })
}

async function uploadVisibleFile(
  page: Page,
  trigger: Locator,
  file: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser')
  await trigger.click()
  const chooser = await chooserPromise
  await chooser.setFiles(file)
}

async function createRootFolder(
  page: Page,
  name: string,
  readResource: () => GfsResourceRow | null
): Promise<GfsResourceRow> {
  await page.getByTestId('gfs-create-folder-action').click()
  const form = page.getByRole('form', { name: 'Create folder' })
  await expect(form).toBeVisible()
  await form.getByLabel('Folder name').fill(name)
  await form.getByRole('button', { name: 'Create folder' }).click()
  await expectToast(page, `Folder ${name} created`)
  await expect.poll(readResource, { timeout: 30_000, intervals: [250, 500, 1_000] }).toMatchObject({
    name,
    kind: 'directory',
    deleted: false,
  })
  const resource = readResource()
  if (!resource) throw new Error(`folder ${name} was not persisted`)
  await closeManageDialog(page)
  await expect(resourceRow(page, resource)).toBeVisible({ timeout: 30_000 })
  return resource
}

async function selectOrdinarySubject(page: Page, ordinaryEmail: string): Promise<void> {
  const picker = page.getByRole('combobox', { name: 'Add people, teams, or agents' })
  await expect(picker).toBeVisible({ timeout: 30_000 })
  await picker.fill(ordinaryEmail)
  const listbox = page.getByRole('listbox', { name: 'Available people, teams, and agents' })
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option').filter({ hasText: ordinaryEmail }).click()
  await page.getByRole('heading', { name: 'Access', exact: true }).click()
  await expect(listbox).toBeHidden()
}

function lifecycleDetailFields(detailRef: string | null): Record<string, string> {
  if (!detailRef) throw new Error('GFS operator lifecycle audit is missing detail_ref')
  const fields: Record<string, string> = {}
  for (const field of detailRef.split(';')) {
    const [key, ...value] = field.split(':')
    if (!key || value.length === 0) {
      throw new Error(`malformed GFS operator lifecycle detail_ref: ${detailRef}`)
    }
    if (Object.hasOwn(fields, key)) {
      throw new Error(`duplicate GFS operator lifecycle detail field: ${key}`)
    }
    fields[key] = value.join(':')
  }
  return fields
}

function expectLifecycleAudit(
  event: GfsOperatorLifecycleEvent,
  link: { desktopUserId: string; controlAdminId: string; source: string },
  expected: {
    action: 'permission_grant' | 'permission_revoke'
    status: 'linked' | 'unlinked'
    lifecycle: 'link.created' | 'link.revoked' | 'link.reactivated'
    generation: number
    predecessorId?: string
    reason?: string
  }
): void {
  expect(event).toMatchObject({
    action: expected.action,
    outcome: 'committed',
    operatorSub: link.controlAdminId,
    targetRef: `gfs_desktop_operator_link:${link.desktopUserId}:${link.controlAdminId}`,
    sourceAuditRef: `gfs_desktop_operator_link_source:${link.source}`,
    status: expected.status,
  })
  const detail = lifecycleDetailFields(event.detailRef)
  expect(detail).toMatchObject({
    event: expected.lifecycle,
    desktop_user_id: link.desktopUserId,
    control_admin_id: link.controlAdminId,
    source: link.source,
    generation: String(expected.generation),
  })
  if (expected.predecessorId === undefined) {
    expect(detail.predecessor_id).toBeUndefined()
  } else {
    expect(detail.predecessor_id).toBe(expected.predecessorId)
  }
  if (expected.reason === undefined) {
    expect(detail.reason).toBeUndefined()
  } else {
    expect(detail.reason).toBe(expected.reason)
  }
}

test.describe.serial('GFS Desktop linked-operator parity', () => {
  test('@gfs-operator/setup-linked-operator setup creates the exact link before visible Desktop login', async ({
    operatorJourney,
  }) => {
    const setup = await operatorJourney.bootstrapInitialAdmin()
    await expect
      .poll(() => operatorJourney.readOperatorLink(), {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
        message: `waiting for ${GFS_OPERATOR_SETUP_PATH} to persist its exact Desktop operator link`,
      })
      .toMatchObject({ controlAdminId: setup.controlAdminId, source: 'initial_setup' })

    operatorJourney.operatorLink = operatorJourney.readOperatorLink()
    expect(operatorJourney.operatorLink).not.toBeNull()
    expect(operatorJourney.operatorLink?.controlAdminId).toBe(setup.controlAdminId)
    await expect
      .poll(() => operatorJourney.countActiveLinks(), {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(1)
    await expect
      .poll(() => operatorJourney.readLinkHistory().length, {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(1)
    const [initialGeneration] = operatorJourney.assertGenerationChain({
      activeCount: 1,
      revokedCount: 0,
    })
    expect(initialGeneration).toMatchObject({
      generation: 1,
      predecessorId: null,
      state: 'active',
      desktopUserId: operatorJourney.operatorLink!.desktopUserId,
      controlAdminId: setup.controlAdminId,
      source: 'initial_setup',
      createdByControlAdminId: setup.controlAdminId,
      rowVersion: 1,
    })
    await expect
      .poll(() => operatorJourney.readLinkLifecycleEvents().length, {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(1)
    const [createdEvent] = operatorJourney.readLinkLifecycleEvents()
    expect(createdEvent).toBeDefined()
    expectLifecycleAudit(createdEvent!, operatorJourney.operatorLink!, {
      action: 'permission_grant',
      status: 'linked',
      lifecycle: 'link.created',
      generation: 1,
    })
    operatorJourney.createOrdinaryUserFixture()
    const rootResourceId = operatorJourney.readRootResourceId()

    const controlPage = await operatorJourney.loginControlUi()
    await operatorJourney.openControlAdmins()
    const linkStatus = controlPage.getByTestId(`gfs-operator-link-${setup.controlAdminId}`)
    await expect(linkStatus).toContainText('Active')
    await expect(linkStatus).toContainText(operatorJourney.operatorLink!.desktopUserId)
    await expect(linkStatus).toContainText(setup.controlAdminId)
    await expect(linkStatus).toContainText('initial_setup')
    await expect(
      controlPage.getByRole('button', {
        name: `Revoke Desktop GFS operator access for ${operatorJourney.operatorUsername} (${operatorJourney.operatorEmail})`,
      })
    ).toBeVisible()

    const desktopPage = await operatorJourney.launchOperatorDesktop()
    await operatorJourney.openFiles(desktopPage)
    await ensureOperatorRoot(desktopPage)
    await expect(desktopPage.getByTestId('gfs-view-operator')).toBeVisible()
    const root = desktopPage.getByTestId('gfs-root-operator')
    await expect(root).toHaveText('Global File System')
    await expect(root).toHaveAttribute('data-resource-id', rootResourceId)
    await expect(desktopPage.getByTestId('gfs-manage-access-action')).toBeVisible()
  })

  test('@gfs-operator/operator-root-crud root create/upload and nested CRUD use visible Desktop actions', async ({
    operatorJourney,
  }, testInfo) => {
    const page = await operatorJourney.launchOperatorDesktop()
    await operatorJourney.openFiles(page)
    await ensureOperatorRoot(page)
    const rootId = operatorJourney.rootResourceId!
    expect(operatorJourney.operatorSubjectGrantCount()).toBe(0)
    await expect(page.getByTestId('gfs-view-operator')).toBeVisible()
    await expect(page.getByTestId('gfs-root-operator')).toHaveAttribute('data-resource-id', rootId)

    const crudFolder = await createRootFolder(page, operatorJourney.names.crudFolder, () =>
      operatorJourney.readResource(rootId, operatorJourney.names.crudFolder)
    )
    operatorJourney.resources.set('crudFolder', crudFolder)

    await uploadVisibleFile(page, page.getByTestId('gfs-upload-action'), {
      name: operatorJourney.names.rootFile,
      mimeType: 'text/markdown',
      buffer: Buffer.from('# root upload\n', 'utf8'),
    })
    await expectToast(page, `Uploaded ${operatorJourney.names.rootFile}`)
    await expect
      .poll(() => operatorJourney.readResource(rootId, operatorJourney.names.rootFile), {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toMatchObject({ kind: 'file', deleted: false })
    const rootFile = operatorJourney.readResource(rootId, operatorJourney.names.rootFile)!
    operatorJourney.resources.set('rootFile', rootFile)

    let dialog = await openResourceManage(page, crudFolder)
    await dialog.getByRole('button', { name: `Options for ${crudFolder.name}` }).click()
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const renameForm = dialog.getByRole('form', { name: 'Rename resource' })
    await renameForm.getByLabel('New name').fill(operatorJourney.names.renamedFolder)
    await renameForm.getByRole('button', { name: 'Save' }).click()
    await expectToast(page, `Renamed to ${operatorJourney.names.renamedFolder}`)
    await closeManageDialog(page)
    await expect
      .poll(() => operatorJourney.readResource(rootId, operatorJourney.names.renamedFolder), {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toMatchObject({ resourceId: crudFolder.resourceId, deleted: false })
    const renamedFolder = operatorJourney.readResource(rootId, operatorJourney.names.renamedFolder)!
    operatorJourney.resources.set('renamedFolder', renamedFolder)

    // openResourceManage() resolves a non-current resource through the
    // controller before opening the dialog, so the visible page is already
    // inside the renamed folder when the dialog closes.
    await expect(page.getByRole('navigation', { name: 'File location' })).toContainText(
      renamedFolder.name
    )
    await expect(page.getByTestId('gfs-root-operator')).toHaveAttribute('data-resource-id', rootId)

    await uploadVisibleFile(page, page.getByTestId('gfs-upload-action'), {
      name: operatorJourney.names.nestedFile,
      mimeType: 'text/markdown',
      buffer: Buffer.from('# nested version one\n', 'utf8'),
    })
    await expectToast(page, `Uploaded ${operatorJourney.names.nestedFile}`)
    await expect
      .poll(
        () =>
          operatorJourney.readResource(renamedFolder.resourceId, operatorJourney.names.nestedFile),
        { timeout: 30_000, intervals: [250, 500, 1_000] }
      )
      .toMatchObject({ kind: 'file', deleted: false })
    let nestedFile = operatorJourney.readResource(
      renamedFolder.resourceId,
      operatorJourney.names.nestedFile
    )!

    await resourceRow(page, nestedFile)
      .getByRole('button', { name: nestedFile.name, exact: true })
      .click()
    const preview = page.getByRole('dialog', { name: nestedFile.name })
    await expect(preview).toBeVisible()
    await expect(
      page.getByRole('article', { name: `Markdown preview of ${nestedFile.name}` })
    ).toContainText('nested version one')
    await page.getByRole('button', { name: 'Close Markdown preview' }).click()
    await expect(preview).toBeHidden({ timeout: 15_000 })

    dialog = await openResourceManage(page, nestedFile)
    await dialog.getByRole('button', { name: `Options for ${nestedFile.name}` }).click()
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    await dialog
      .getByRole('form', { name: 'Rename resource' })
      .getByLabel('New name')
      .fill(operatorJourney.names.renamedFile)
    await dialog
      .getByRole('form', { name: 'Rename resource' })
      .getByRole('button', { name: 'Save' })
      .click()
    await expectToast(page, `Renamed to ${operatorJourney.names.renamedFile}`)
    await expect
      .poll(
        () =>
          operatorJourney.readResource(renamedFolder.resourceId, operatorJourney.names.renamedFile),
        { timeout: 30_000, intervals: [250, 500, 1_000] }
      )
      .toMatchObject({ resourceId: nestedFile.resourceId, deleted: false })
    nestedFile = operatorJourney.readResource(
      renamedFolder.resourceId,
      operatorJourney.names.renamedFile
    )!
    dialog = page.getByRole('dialog', {
      name: `Manage file ${operatorJourney.names.renamedFile}`,
    })
    await expect(dialog).toBeVisible()

    await uploadVisibleFile(page, dialog.locator('button').filter({ hasText: 'Replace file' }), {
      name: operatorJourney.names.renamedFile,
      mimeType: 'text/markdown',
      buffer: Buffer.from('# nested version two\n', 'utf8'),
    })
    await expectToast(page, `Replaced ${operatorJourney.names.renamedFile}`)
    await expect
      .poll(
        () =>
          operatorJourney.readResource(renamedFolder.resourceId, operatorJourney.names.renamedFile),
        { timeout: 30_000, intervals: [250, 500, 1_000] }
      )
      .toMatchObject({ version: nestedFile.version + 1, deleted: false })

    await dialog
      .getByRole('button', { name: `Options for ${operatorJourney.names.renamedFile}` })
      .click()
    await page.getByRole('menuitem', { name: 'Download', exact: true }).click()
    await expectToast(page, `Downloaded ${operatorJourney.names.renamedFile}`)
    const expectedDownloadBytes = Buffer.from('# nested version two\n', 'utf8')
    const expectedDownloadHash = createHash('sha256').update(expectedDownloadBytes).digest('hex')
    await expect
      .poll(
        () =>
          operatorJourney.readDownloadedArtifact(
            operatorJourney.names.renamedFile,
            expectedDownloadBytes
          ),
        { timeout: 30_000, intervals: [250, 500, 1_000] }
      )
      .toMatchObject({
        filename: operatorJourney.names.renamedFile,
        size: expectedDownloadBytes.byteLength,
        sha256: expectedDownloadHash,
      })
    const downloadEvidence = operatorJourney.readDownloadedArtifact(
      operatorJourney.names.renamedFile,
      expectedDownloadBytes
    )
    if (!downloadEvidence) {
      throw new Error('[GFS-OPERATOR-E2E] downloaded artifact disappeared after verification')
    }
    await testInfo.attach('gfs-download-evidence', {
      body: JSON.stringify(downloadEvidence, null, 2),
      contentType: 'application/json',
    })

    await dialog
      .getByRole('button', { name: `Options for ${operatorJourney.names.renamedFile}` })
      .click()
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    const deleteDialog = page.getByRole('alertdialog', { name: 'Delete resource' })
    await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expectToast(page, `Deleted ${operatorJourney.names.renamedFile}`)
    await expect
      .poll(
        () =>
          operatorJourney.readResource(renamedFolder.resourceId, operatorJourney.names.renamedFile),
        { timeout: 30_000, intervals: [250, 500, 1_000] }
      )
      .toMatchObject({ deleted: true })

    // Deleting the current file returns the visible browser to the operator
    // root. The root breadcrumb is intentionally disabled because it is
    // already the active location; assert that state instead of clicking a
    // non-actionable control.
    await expect(page.getByTestId('gfs-root-operator')).toBeDisabled()
    await expect(page.getByTestId('gfs-view-operator')).toBeVisible()
    const renamedFolderAfterChildDelete = operatorJourney.readResource(
      rootId,
      operatorJourney.names.renamedFolder
    )!
    dialog = await openResourceManage(page, renamedFolderAfterChildDelete)
    await dialog
      .getByRole('button', { name: `Options for ${operatorJourney.names.renamedFolder}` })
      .click()
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    await page
      .getByRole('alertdialog', { name: 'Delete resource' })
      .getByRole('button', { name: 'Delete', exact: true })
      .click()
    await expectToast(page, `Deleted ${operatorJourney.names.renamedFolder}`)

    operatorJourney.successfulCreateAuditFloor = operatorJourney.auditFloor()
    for (const [key, name] of [
      ['grantFolder', operatorJourney.names.grantFolder],
      ['shareFolder', operatorJourney.names.shareFolder],
      ['ordinaryFolder', operatorJourney.names.ordinaryFolder],
    ] as const) {
      const folder = await createRootFolder(page, name, () =>
        operatorJourney.readResource(rootId, name)
      )
      operatorJourney.resources.set(key, folder)
    }
  })

  test('@gfs-operator/ordinary-unlinked-regression unlinked Desktop remains grant-scoped Shared with me', async ({
    operatorJourney,
  }, testInfo) => {
    const ordinaryFolder = operatorJourney.resources.get('ordinaryFolder')!
    const fixtureGrantId = operatorJourney.seedOrdinaryReadGrant(ordinaryFolder.resourceId)
    const ordinary = await operatorJourney.launchOrdinaryDesktop(testInfo)
    try {
      await operatorJourney.openFiles(ordinary.page)
      await expect(ordinary.page.getByTestId('gfs-view-shared')).toBeVisible()
      await expect(ordinary.page.getByTestId('gfs-root-shared')).toHaveText('Shared with me')
      await expect(resourceRow(ordinary.page, ordinaryFolder)).toBeVisible()
      await expect(ordinary.page.getByTestId('gfs-create-folder-action')).toHaveCount(0)
      await expect(ordinary.page.getByTestId('gfs-upload-action')).toHaveCount(0)
      await expect(ordinary.page.getByTestId('gfs-manage-access-action')).toHaveCount(0)
      expect(operatorJourney.findGrant(ordinaryFolder.resourceId)?.id).toBe(fixtureGrantId)
    } finally {
      await ordinary.close()
      operatorJourney.removeFixtureGrant(fixtureGrantId)
    }
    await expect.poll(() => operatorJourney.findGrant(ordinaryFolder.resourceId)).toBeNull()
  })

  test('@gfs-operator/grant-share-lifecycle visible Desktop grant/share create, list, revoke removes recipient access', async ({
    operatorJourney,
  }, testInfo) => {
    const page = await operatorJourney.launchOperatorDesktop()
    await operatorJourney.openFiles(page)
    await ensureOperatorRoot(page)
    const grantFolder = operatorJourney.resources.get('grantFolder')!
    const shareFolder = operatorJourney.resources.get('shareFolder')!
    const auditFloor = operatorJourney.auditFloor()

    let dialog = await openResourceManage(page, grantFolder)
    await selectOrdinarySubject(page, operatorJourney.ordinaryEmail)
    await dialog.getByRole('button', { name: 'Grant access', exact: true }).click()
    await expectToast(page, 'Access granted to 1 subject')
    await expect
      .poll(() => operatorJourney.findGrant(grantFolder.resourceId), {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .not.toBeNull()
    const grant = operatorJourney.findGrant(grantFolder.resourceId)!
    await expect(page.getByTestId(`gfs-access-row-grant-${grant.id}`)).toContainText(
      operatorJourney.ordinaryName
    )
    await closeManageDialog(page)
    // Opening Manage resolves the selected resource in the visible browser,
    // so closing the dialog leaves the operator inside grantFolder. Return to
    // the root through the user-visible breadcrumb before selecting the next
    // ACL target; otherwise shareFolder is not present in the current listing.
    await ensureOperatorRoot(page)

    dialog = await openResourceManage(page, shareFolder)
    await selectOrdinarySubject(page, operatorJourney.ordinaryEmail)
    await dialog.getByRole('button', { name: 'Create share', exact: true }).click()
    await expectToast(page, '1 share created')
    await expect
      .poll(() => operatorJourney.findShare(shareFolder.resourceId), {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .not.toBeNull()
    const share = operatorJourney.findShare(shareFolder.resourceId)!
    await expect(page.getByTestId(`gfs-access-row-share-${share.id}`)).toContainText(
      operatorJourney.ordinaryName
    )
    await closeManageDialog(page)

    const ordinary = await operatorJourney.launchOrdinaryDesktop(testInfo)
    try {
      await operatorJourney.openFiles(ordinary.page)
      await expect(ordinary.page.getByTestId('gfs-view-shared')).toBeVisible()
      await expect(resourceRow(ordinary.page, grantFolder)).toBeVisible()
      await expect(resourceRow(ordinary.page, shareFolder)).toBeVisible()

      await ensureOperatorRoot(page)
      await openResourceManage(page, grantFolder)
      await page.getByTestId(`gfs-revoke-grant-${grant.id}`).click()
      await expectToast(page, `Access revoked for ${operatorJourney.ordinaryName}`)
      await expect.poll(() => operatorJourney.findGrant(grantFolder.resourceId)).toBeNull()
      await closeManageDialog(page)

      await ensureOperatorRoot(page)
      await openResourceManage(page, shareFolder)
      await page.getByTestId(`gfs-revoke-share-${share.id}`).click()
      await expectToast(page, `Shared access revoked for ${operatorJourney.ordinaryName}`)
      await expect.poll(() => operatorJourney.findShare(shareFolder.resourceId)).toBeNull()
      await closeManageDialog(page)

      await ordinary.page.getByTestId('nav-chat').click()
      await operatorJourney.openFiles(ordinary.page)
      await expect(resourceRow(ordinary.page, grantFolder)).toHaveCount(0)
      await expect(resourceRow(ordinary.page, shareFolder)).toHaveCount(0)
      await expect(ordinary.page.getByTestId('gfs-empty-shared')).toBeVisible()
    } finally {
      await ordinary.close()
    }

    await expect
      .poll(
        () =>
          operatorJourney
            .auditRowsAfter(auditFloor, operatorJourney.operatorLink!.desktopUserId)
            .filter(
              row => row.authoritySource === 'linked-admin' && /^(grant|share)\./.test(row.op)
            )
            .map(row => row.op),
        { timeout: 30_000, intervals: [250, 500, 1_000] }
      )
      .toEqual(
        expect.arrayContaining([
          'grant.put[read]',
          'grant.delete',
          'share.create[read]',
          'share.delete',
        ])
      )
  })

  test('@gfs-operator/live-control-ui-unlink visible Control UI revoke immediately denies same Electron session', async ({
    operatorJourney,
  }) => {
    const controlPage = await operatorJourney.loginControlUi()
    await operatorJourney.openControlAdmins()
    const page = await operatorJourney.launchOperatorDesktop()
    await operatorJourney.openFiles(page)
    await ensureOperatorRoot(page)
    const link = operatorJourney.operatorLink!
    await expect(controlPage).toHaveURL(/\/users-and-teams\/admins(?:\?|$)/)
    const revoke = controlPage.getByRole('button', {
      name: `Revoke Desktop GFS operator access for ${operatorJourney.operatorUsername} (${operatorJourney.operatorEmail})`,
    })
    await expect(revoke).toBeVisible()
    await revoke.click()
    const confirm = controlPage.getByRole('alertdialog', {
      name: 'Revoke Desktop GFS operator access',
    })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Revoke access', exact: true }).click()
    await expect(
      controlPage.getByText('Desktop GFS operator access revoked.', { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      controlPage
        .getByTestId(`gfs-operator-link-${link.controlAdminId}`)
        .getByText('Revoked', { exact: true })
    ).toBeVisible()
    await expect
      .poll(() => operatorJourney.countActiveLinks(), {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(0)
    await expect
      .poll(() => operatorJourney.readLinkHistory().length, {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(1)
    const [firstTombstone] = operatorJourney.assertGenerationChain({
      activeCount: 0,
      revokedCount: 1,
    })
    expect(firstTombstone).toMatchObject({
      generation: 1,
      predecessorId: null,
      state: 'revoked',
      desktopUserId: link.desktopUserId,
      controlAdminId: link.controlAdminId,
      source: 'initial_setup',
      createdByControlAdminId: link.controlAdminId,
      revokedByType: 'control_admin',
      revokedById: link.controlAdminId,
      revokedByControlAdminId: link.controlAdminId,
      revokedByDesktopUserId: null,
      revocationReason: 'control_ui_revoke',
    })
    expect(firstTombstone?.revokedAt).toEqual(expect.any(String))
    await expect
      .poll(() => operatorJourney.readLinkLifecycleEvents().length, {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(2)
    const firstRevokeEvents = operatorJourney
      .readLinkLifecycleEvents()
      .filter(event => lifecycleDetailFields(event.detailRef).event === 'link.revoked')
    expect(firstRevokeEvents).toHaveLength(1)
    expectLifecycleAudit(firstRevokeEvents[0]!, link, {
      action: 'permission_revoke',
      status: 'unlinked',
      lifecycle: 'link.revoked',
      generation: 1,
      reason: 'control_ui_revoke',
    })
    expect(lifecycleDetailFields(firstRevokeEvents[0]!.detailRef).lineage_id).toBe(
      firstTombstone!.lineageId
    )

    operatorJourney.deniedAuditFloor = operatorJourney.auditFloor()
    // Keep the user-visible direct-access dialog open across the Control UI
    // action. Its resolve request is the next same-session Desktop request and
    // must close the dialog while clearing all stale operator controls.
    await page.getByRole('button', { name: 'Open GFS link' }).click()
    const linkDialog = page.getByRole('dialog', { name: 'Open GFS link' })
    await expect(linkDialog).toBeVisible()
    await linkDialog
      .getByLabel('gfs URI')
      .fill(`gfs://main/${operatorJourney.rootResourceId!.replace(/-/g, '')}`)
    await linkDialog.getByRole('button', { name: 'Open', exact: true }).click()

    const denial = page.getByTestId('gfs-error-unauthorized')
    await expect(denial).toBeVisible({ timeout: 30_000 })
    await expect(denial).toHaveAttribute('aria-label', 'File access is not authorized')
    await expect(denial).toContainText(
      'Your current Desktop session cannot access this location. Sign in again or contact an administrator.'
    )
    await expect(linkDialog).toHaveCount(0)
    await expect(page.getByTestId('gfs-create-folder-action')).toHaveCount(0)
    await expect(page.getByTestId('gfs-upload-action')).toHaveCount(0)
    await expect(page.getByTestId('gfs-manage-access-action')).toHaveCount(0)
    await expect
      .poll(() =>
        operatorJourney.readResource(
          operatorJourney.rootResourceId!,
          operatorJourney.names.deniedFolder
        )
      )
      .toBeNull()

    const reactivate = controlPage.getByRole('button', {
      name: `Reactivate Desktop GFS operator access for ${operatorJourney.operatorUsername} (${operatorJourney.operatorEmail})`,
    })
    await expect(reactivate).toBeVisible()
    await reactivate.click()
    const reactivateConfirm = controlPage.getByRole('alertdialog', {
      name: 'Reactivate Desktop GFS operator access',
    })
    await expect(reactivateConfirm).toBeVisible()
    await reactivateConfirm.getByRole('button', { name: 'Reactivate access', exact: true }).click()
    await expect(
      controlPage.getByText('Desktop GFS operator access reactivated.', { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      controlPage
        .getByTestId(`gfs-operator-link-${link.controlAdminId}`)
        .getByText('Active', { exact: true })
    ).toBeVisible()
    await expect
      .poll(() => operatorJourney.countActiveLinks(), {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(1)
    await expect
      .poll(() => operatorJourney.readLinkHistory().length, {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(2)
    const [revokedPredecessor, successor] = operatorJourney.assertGenerationChain({
      activeCount: 1,
      revokedCount: 1,
    })
    expect(successor).toMatchObject({
      generation: revokedPredecessor!.generation + 1,
      predecessorId: revokedPredecessor!.id,
      lineageId: revokedPredecessor!.lineageId,
      state: 'active',
      desktopUserId: link.desktopUserId,
      controlAdminId: link.controlAdminId,
      source: 'initial_setup',
      createdByControlAdminId: link.controlAdminId,
      rowVersion: 1,
    })
    await expect
      .poll(() => operatorJourney.readLinkLifecycleEvents().length, {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(3)
    const reactivationEvents = operatorJourney
      .readLinkLifecycleEvents()
      .filter(event => lifecycleDetailFields(event.detailRef).event === 'link.reactivated')
    expect(reactivationEvents).toHaveLength(1)
    expectLifecycleAudit(reactivationEvents[0]!, link, {
      action: 'permission_grant',
      status: 'linked',
      lifecycle: 'link.reactivated',
      generation: successor!.generation,
      predecessorId: revokedPredecessor!.id,
      reason: 'control_ui_reactivate',
    })

    // Retry is the user-visible next Desktop request. It cannot restore a
    // client capability; the reactivated server link must return the root.
    await page.getByTestId('gfs-retry-access-action').click()
    await expect(page.getByTestId('gfs-view-operator')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('gfs-root-operator')).toHaveAttribute(
      'data-resource-id',
      operatorJourney.rootResourceId!
    )
    await expect(page.getByTestId('gfs-create-folder-action')).toBeVisible()
    const restoredFolder = await createRootFolder(
      page,
      operatorJourney.names.auditDeniedFolder,
      () =>
        operatorJourney.readResource(
          operatorJourney.rootResourceId!,
          operatorJourney.names.auditDeniedFolder
        )
    )
    operatorJourney.resources.set('auditDeniedFolder', restoredFolder)

    const secondRevoke = controlPage.getByRole('button', {
      name: `Revoke Desktop GFS operator access for ${operatorJourney.operatorUsername} (${operatorJourney.operatorEmail})`,
    })
    await expect(secondRevoke).toBeVisible()
    await secondRevoke.click()
    await controlPage
      .getByRole('alertdialog', { name: 'Revoke Desktop GFS operator access' })
      .getByRole('button', { name: 'Revoke access', exact: true })
      .click()
    await expect(
      controlPage.getByText('Desktop GFS operator access revoked.', { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      controlPage
        .getByTestId(`gfs-operator-link-${link.controlAdminId}`)
        .getByText('Revoked', { exact: true })
    ).toBeVisible()
    await expect
      .poll(() => operatorJourney.countActiveLinks(), {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(0)
    await expect
      .poll(() => operatorJourney.readLinkHistory().length, {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(2)
    const [firstRevokedGeneration, secondTombstone] = operatorJourney.assertGenerationChain({
      activeCount: 0,
      revokedCount: 2,
    })
    expect(firstRevokedGeneration).toMatchObject({
      generation: 1,
      predecessorId: null,
      state: 'revoked',
    })
    expect(secondTombstone).toMatchObject({
      generation: firstRevokedGeneration!.generation + 1,
      predecessorId: firstRevokedGeneration!.id,
      lineageId: firstRevokedGeneration!.lineageId,
      state: 'revoked',
      desktopUserId: link.desktopUserId,
      controlAdminId: link.controlAdminId,
      source: 'initial_setup',
      createdByControlAdminId: link.controlAdminId,
      revokedByType: 'control_admin',
      revokedById: link.controlAdminId,
      revokedByControlAdminId: link.controlAdminId,
      revokedByDesktopUserId: null,
      revocationReason: 'control_ui_revoke',
    })
    expect(secondTombstone?.revokedAt).toEqual(expect.any(String))
    await expect
      .poll(() => operatorJourney.readLinkLifecycleEvents().length, {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(4)
    const secondRevokeEvents = operatorJourney
      .readLinkLifecycleEvents()
      .filter(event => lifecycleDetailFields(event.detailRef).event === 'link.revoked')
    expect(secondRevokeEvents).toHaveLength(2)
    expectLifecycleAudit(secondRevokeEvents[1]!, link, {
      action: 'permission_revoke',
      status: 'unlinked',
      lifecycle: 'link.revoked',
      generation: secondTombstone!.generation,
      predecessorId: firstRevokedGeneration!.id,
      reason: 'control_ui_revoke',
    })
  })

  test('@gfs-operator/audit-correlation successful and denied Desktop requests preserve exact actor and request IDs', async ({
    operatorJourney,
  }) => {
    const link = operatorJourney.operatorLink!
    const controlPage = await operatorJourney.loginControlUi()
    await operatorJourney.openControlAdmins()
    await expect(controlPage).toHaveURL(/\/users-and-teams\/admins(?:\?|$)/)
    await expect(
      controlPage
        .getByTestId(`gfs-operator-link-${link.controlAdminId}`)
        .getByText('Revoked', { exact: true })
    ).toBeVisible()

    await expect
      .poll(
        () => {
          const rows = operatorJourney.auditRowsAfter(
            operatorJourney.successfulCreateAuditFloor,
            link.desktopUserId
          )
          const decisions = rows.filter(
            row =>
              row.subject === link.controlAdminId &&
              row.actorOnBehalfOf === link.controlAdminId &&
              row.authoritySource === 'linked-admin' &&
              row.op === 'write' &&
              row.outcome === 'allow' &&
              row.recordType === 'authorization_decision' &&
              row.mutationOutcome === null &&
              UUID_RE.test(row.requestId ?? '')
          )
          return decisions.some(decision =>
            rows.some(
              mutation =>
                mutation.requestId === decision.requestId &&
                mutation.subject === link.controlAdminId &&
                mutation.actorOnBehalfOf === link.controlAdminId &&
                mutation.desktopUserId === link.desktopUserId &&
                mutation.authoritySource === 'linked-admin' &&
                mutation.op === 'create' &&
                mutation.outcome === 'allow' &&
                mutation.recordType === 'mutation_outcome' &&
                mutation.mutationOutcome === 'succeeded'
            )
          )
        },
        { timeout: 30_000, intervals: [250, 500, 1_000] }
      )
      .toBe(true)

    await expect
      .poll(
        () =>
          operatorJourney
            .auditRowsAfter(operatorJourney.deniedAuditFloor, link.desktopUserId)
            .some(
              row =>
                row.subject === link.desktopUserId &&
                row.actorOnBehalfOf === null &&
                row.desktopUserId === link.desktopUserId &&
                row.authoritySource === 'user-session' &&
                row.op === 'read' &&
                row.outcome === 'deny' &&
                row.recordType === 'authorization_decision' &&
                row.mutationOutcome === null &&
                UUID_RE.test(row.requestId ?? '')
            ),
        { timeout: 30_000, intervals: [250, 500, 1_000] }
      )
      .toBe(true)

    const deniedRows = operatorJourney.auditRowsAfter(
      operatorJourney.deniedAuditFloor,
      link.desktopUserId
    )
    expect(
      deniedRows.filter(row => row.requestId && row.op === 'create' && row.mutationOutcome)
    ).toHaveLength(0)
    const lifecycleEvents = operatorJourney.readLinkLifecycleEvents()
    expect(lifecycleEvents).toHaveLength(4)
    expect(new Set(lifecycleEvents.map(event => event.eventId)).size).toBe(4)
    const [firstGeneration, secondGeneration] = operatorJourney.assertGenerationChain({
      activeCount: 0,
      revokedCount: 2,
    })
    const [createdEvent, firstRevokeEvent, reactivatedEvent, secondRevokeEvent] = lifecycleEvents
    expect(createdEvent).toBeDefined()
    expect(firstRevokeEvent).toBeDefined()
    expect(reactivatedEvent).toBeDefined()
    expect(secondRevokeEvent).toBeDefined()

    expectLifecycleAudit(createdEvent!, link, {
      action: 'permission_grant',
      status: 'linked',
      lifecycle: 'link.created',
      generation: 1,
    })
    expectLifecycleAudit(firstRevokeEvent!, link, {
      action: 'permission_revoke',
      status: 'unlinked',
      lifecycle: 'link.revoked',
      generation: 1,
      reason: 'control_ui_revoke',
    })
    expectLifecycleAudit(reactivatedEvent!, link, {
      action: 'permission_grant',
      status: 'linked',
      lifecycle: 'link.reactivated',
      generation: 2,
      predecessorId: firstGeneration!.id,
      reason: 'control_ui_reactivate',
    })
    expectLifecycleAudit(secondRevokeEvent!, link, {
      action: 'permission_revoke',
      status: 'unlinked',
      lifecycle: 'link.revoked',
      generation: 2,
      predecessorId: firstGeneration!.id,
      reason: 'control_ui_revoke',
    })

    const reactivationDetail = lifecycleDetailFields(reactivatedEvent!.detailRef)
    const secondRevokeDetail = lifecycleDetailFields(secondRevokeEvent!.detailRef)
    expect(secondGeneration!.predecessorId).toBe(firstGeneration!.id)
    expect(reactivationDetail.predecessor_id).toBe(firstGeneration!.id)
    expect(secondRevokeDetail.predecessor_id).toBe(firstGeneration!.id)
  })
})
