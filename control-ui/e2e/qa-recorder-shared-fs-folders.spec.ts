// UI owns setup. API calls are limited to cleanup and negative authorization.
import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  requireRecorderConfirm,
  screenshotAndLog,
  uniqueE2EName,
} from './qa-recorder-helpers'

const collectionPath = '/api/v1/admin/shared-filesystems'
type Filesystem = {
  metadata?: { name?: string; uid?: string }
  spec?: { size?: string; accessModes?: string[]; retainOnDelete?: boolean }
}
function isApiPath(rawUrl: string, path: string): boolean {
  const url = new URL(rawUrl)
  return url.origin === new URL(CONTROL_UI_URL).origin && url.pathname === `/control-api${path}`
}

test.describe('optional QA recorder: Control UI SharedFileSystem folders', () => {
  test('SharedFileSystem — visible creation, folder rename and persistence', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates a SharedFileSystem and renames a folder.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)
    const name = uniqueE2EName('qa-recorder-shared-fs')
    const detailPath = `/agent-files/${encodeURIComponent(name)}`
    const apiPath = `${collectionPath}/${encodeURIComponent(name)}`
    const filesPath = `${apiPath}/proxy/v1/files`
    const folder = 'qa-recorder-folder'
    const renamed = 'qa-recorder-folder-renamed'
    let createdUid: string | undefined
    try {
      await test.step('sign in and navigate to Agent Files', async () => {
        await loginThroughUi(page, adminCredentials())
        const nav = page.getByRole('navigation', { name: 'Main sections' })
        await expect(nav).toBeVisible()
        await nav.getByRole('link', { name: 'Files', exact: true }).click()
        await expect(page).toHaveURL(`${CONTROL_UI_URL}/agent-files`)
        await expect(page.getByRole('heading', { name: /^Agent Files/ })).toBeVisible()
        await expect(page.getByRole('button', { name: 'New', exact: true })).toBeEnabled()
      })
      await test.step('complete each wizard step and verify retained values', async () => {
        await page.getByRole('button', { name: 'New', exact: true }).click()
        await expect(page).toHaveURL(`${CONTROL_UI_URL}/agent-files/new`)
        await expect(
          page.getByRole('heading', {
            name: 'Create SharedFileSystem',
            exact: true,
          })
        ).toBeVisible()
        await expect(page.getByRole('region', { name: 'Storage request' })).toBeVisible()
        await page.getByLabel('Name', { exact: true }).fill(name)
        await page.getByLabel('Shared filesystem size', { exact: true }).fill('5')
        await page.getByLabel('Shared filesystem size unit').selectOption('Gi')
        await page.getByRole('button', { name: 'Continue', exact: true }).click()
        await expect(page.getByRole('region', { name: 'Access and retention' })).toBeVisible()
        await page.getByLabel('Access mode').selectOption('ReadWriteOnce')
        await page.getByLabel('Keep storage after deletion').uncheck()
        await expect(page.getByLabel('Access mode')).toHaveValue('ReadWriteOnce')
        await expect(page.getByLabel('Keep storage after deletion')).not.toBeChecked()
        await page.getByRole('button', { name: 'Back', exact: true }).click()
        await expect(page.getByRole('region', { name: 'Storage request' })).toBeVisible()
        await expect(page.getByLabel('Name', { exact: true })).toHaveValue(name)
        await expect(page.getByLabel('Shared filesystem size', { exact: true })).toHaveValue('5')
        await expect(page.getByLabel('Shared filesystem size unit')).toHaveValue('Gi')
        await page.getByRole('button', { name: 'Continue', exact: true }).click()
        await expect(page.getByRole('region', { name: 'Access and retention' })).toBeVisible()
        await expect(page.getByLabel('Keep storage after deletion')).not.toBeChecked()
        await page.getByRole('button', { name: 'Continue', exact: true }).click()
        await expect(page.getByRole('region', { name: 'Initial folders' })).toBeVisible()
        await expect(page.getByLabel('Directory name')).toBeVisible()
        await expect(page.getByText('No folders added.', { exact: true })).toBeVisible()
        await expect(page).toHaveURL(`${CONTROL_UI_URL}/agent-files/new`)
      })
      await test.step('submit and observe the real transition to the list', async () => {
        const creation = page.waitForResponse(
          r =>
            isApiPath(r.url(), collectionPath) &&
            r.request().method() === 'POST' &&
            r.request().postDataJSON()?.name === name
        )
        await page.getByRole('button', { name: 'Create', exact: true }).click()
        const response = await creation
        expect(response.status()).toBe(201)
        const resource = (await response.json()) as Filesystem
        expect(resource.metadata?.name).toBe(name)
        expect(resource.metadata?.uid).toEqual(expect.any(String))
        createdUid = resource.metadata!.uid
        expect(createdUid).not.toBe('')
        expect(resource.spec).toMatchObject({
          size: '5Gi',
          accessModes: ['ReadWriteOnce'],
          retainOnDelete: false,
        })
        await expect(page).toHaveURL(`${CONTROL_UI_URL}/agent-files`)
        await expect(page.getByRole('heading', { name: /^Agent Files/ })).toBeVisible()
        const row = page.getByRole('link', {
          name: `Open shared filesystem ${name}`,
          exact: true,
        })
        await expect(row).toBeVisible()
        await expect(row).toContainText('5Gi')
      })
      await test.step('refresh until Ready and open the recorded row', async () => {
        const row = page.getByRole('link', {
          name: `Open shared filesystem ${name}`,
          exact: true,
        })
        // The list has no auto-poll: exercise its visible Refresh action.
        await expect(async () => {
          await page.getByRole('button', { name: 'Refresh agent files', exact: true }).click()
          await expect(row.getByText('Ready', { exact: true })).toBeVisible({
            timeout: 1000,
          })
        }).toPass({ timeout: 180_000, intervals: [1000, 2000, 5000] })
        const listing = page.waitForResponse(
          r => isApiPath(r.url(), filesPath) && r.request().method() === 'GET'
        )
        await row.click()
        await expect(page).toHaveURL(`${CONTROL_UI_URL}${detailPath}`)
        await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
        expect((await listing).status()).toBe(200)
        await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeEnabled()
      })
      await test.step('create and rename a folder with visible controls', async () => {
        await page.getByRole('button', { name: 'New folder', exact: true }).click()
        const dialog = page.getByRole('dialog', {
          name: 'New folder',
          exact: true,
        })
        await expect(dialog).toBeVisible()
        await dialog.getByLabel('Folder name').fill(folder)
        const mkdir = page.waitForResponse(
          r => isApiPath(r.url(), `${filesPath}/mkdir`) && r.request().method() === 'POST'
        )
        await dialog.getByRole('button', { name: 'Create', exact: true }).click()
        expect((await mkdir).ok()).toBe(true)
        await expect(dialog).toBeHidden()
        await expect(page.getByRole('button', { name: folder, exact: true })).toBeVisible()
        await page.getByRole('button', { name: `Actions for ${folder}`, exact: true }).click()
        await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
        const rename = page.getByRole('dialog', {
          name: `Rename ${folder}`,
          exact: true,
        })
        await expect(rename).toBeVisible()
        await expect(rename.getByLabel('New name')).toHaveValue(folder)
        await rename.getByLabel('New name').fill(renamed)
        const move = page.waitForResponse(
          r => isApiPath(r.url(), `${filesPath}/move`) && r.request().method() === 'POST'
        )
        await rename.getByRole('button', { name: 'Rename', exact: true }).click()
        expect((await move).ok()).toBe(true)
        await expect(rename).toBeHidden()
        await expect(page.getByRole('button', { name: renamed, exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: folder, exact: true })).toBeHidden()
      })
      await test.step('reopen through the list and verify persisted folder state', async () => {
        await page.getByRole('button', { name: 'Back to Agent Files', exact: true }).click()
        await expect(page).toHaveURL(`${CONTROL_UI_URL}/agent-files`)
        const row = page.getByRole('link', {
          name: `Open shared filesystem ${name}`,
          exact: true,
        })
        await expect(row).toBeVisible()
        const listing = page.waitForResponse(
          r => isApiPath(r.url(), filesPath) && r.request().method() === 'GET'
        )
        await row.click()
        await expect(page).toHaveURL(`${CONTROL_UI_URL}${detailPath}`)
        await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
        const response = await listing
        expect(response.status()).toBe(200)
        const files = (await response.json()) as {
          data: { entries: Array<{ name: string; kind: string }> }
        }
        expect(files.data.entries).toContainEqual(
          expect.objectContaining({ name: renamed, kind: 'directory' })
        )
        expect(files.data.entries.some(entry => entry.name === folder)).toBe(false)
        await expect(page.getByRole('button', { name: renamed, exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: folder, exact: true })).toBeHidden()
        await screenshotAndLog(page, testInfo, 'control-ui-shared-fs-folders')
      })
    } finally {
      if (createdUid) {
        // Cleanup only. DELETE has no atomic UID precondition; require an isolated lane.
        const current = await api<Filesystem>(page.request, 'GET', apiPath)
        if (current.status !== 404) {
          expect(current.status).toBe(200)
          expect(current.data.metadata?.name).toBe(name)
          expect(current.data.metadata?.uid).toBe(createdUid)
          expect(current.data.spec?.retainOnDelete).toBe(false)
          expect((await api(page.request, 'DELETE', apiPath)).status).toBe(204)
          await expect
            .poll(async () => (await api(page.request, 'GET', apiPath)).status, { timeout: 60_000 })
            .toBe(404)
        }
      }
    }
  })
  test('unauthenticated guard rejects the creation route and protected API', async ({ page }) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    // Explicit negative guard: this fresh test context has never signed in.
    await page.goto(`${CONTROL_UI_URL}/agent-files/new`)
    await expect(page).toHaveURL(
      url => url.pathname === '/' && url.searchParams.get('next') === '/agent-files/new'
    )
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(page.getByLabel('Username or email')).toBeVisible()
    await expect(
      page.getByRole('heading', {
        name: 'Create SharedFileSystem',
        exact: true,
      })
    ).toBeHidden()
    // Negative authorization probe only; cannot advance the happy path.
    const denied = await api(page.request, 'GET', collectionPath)
    expect(denied.status).toBe(401)
    expect(denied.data).not.toHaveProperty('items')
  })
})
