/**
 * #651: visible upload -> decoded preview -> fresh agent chat -> visual answer.
 * E2E_GUARDIAN_IPC_FLOW: Electron delegates GFS/chat to its main process; browser
 * HTTP waits would not observe these operations. UI state and completed tool
 * output are the synchronization/business signals. No product path is mocked.
 * Folder/grant/account seeding is a named precondition, never file upload.
 */
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupGfsFixture,
  getE2EUserId,
  getGfsChildResourceSummary,
  seedGfsDirectoryFixture,
  seedGfsGrant,
  uniqueGfsFixtureName,
} from '../../../tests/e2e/gfsUiFixtures'
import { createGfsVisualImageFixture } from '../../../tests/e2e/gfsVisualImageFixture.ts'
import { assertGfsInfraHealthy, discoverManagedGfsAgent } from './helpers/gfsFixtures'
import { openResourcesNavItem } from './navigationHelpers'
import { E2E_DESKTOP_PASSWORD, E2E_EMAIL, seedPasswordForEmail } from './workflowUi'

test.describe.configure({ mode: 'serial' })
// Login uses real local test credentials. Do not persist credential-bearing
// automatic traces; failures still retain screenshots through the project config.
test.use({ trace: 'off', video: 'off' })

function requireOwnedRuntime(): void {
  const context = process.env.E2E_K8S_CONTEXT
  if (!context || !process.env.MINIKUBE_PROFILE || context !== process.env.MINIKUBE_PROFILE)
    throw new Error(
      'This journey requires the verified branch-owned profile and matching explicit E2E_K8S_CONTEXT'
    )
  for (const key of ['EXTERNAL_REST_API_BASE_URL', 'RPC_PROXY_BASE_URL']) {
    const raw = process.env[key]
    if (!raw) throw new Error(`This journey requires profile-owned ${key}`)
    const endpoint = new URL(raw)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))
      throw new Error('This journey is restricted to the owned local development runtime')
  }
}

async function visibleLogin(page: Page): Promise<void> {
  const email = page.locator('#email-input')
  const settings = page.getByTestId('nav-settings-menu')
  await expect
    .poll(async () => (await email.isVisible()) || (await settings.isVisible()), {
      timeout: 60_000,
    })
    .toBe(true)
  if (await settings.isVisible()) {
    // A rerun may restore this same owned environment's session. Log out through
    // the UI; never delete the user's global keychain or rewrite browser storage.
    await settings.click()
    await expect(page.getByLabel('Signed in account')).toContainText(E2E_EMAIL)
    await page.getByTestId('logout-btn').click()
  }
  await expect(email).toBeVisible()
  await email.fill(E2E_EMAIL)
  await page.locator('#password-input').fill(E2E_DESKTOP_PASSWORD)
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await expect(settings).toBeVisible({ timeout: 60_000 })
  await settings.click()
  await expect(page.getByLabel('Signed in account')).toContainText(E2E_EMAIL)
  await settings.click()
}

async function uploadAndPreview(
  page: Page,
  folder: ReturnType<typeof seedGfsDirectoryFixture>,
  filePath: string,
  fileName: string,
  width: number,
  height: number
): Promise<void> {
  await openResourcesNavItem(page, 'nav-files')
  await expect(page.getByRole('heading', { name: 'Files', exact: true })).toBeVisible()
  const browser = page.getByRole('region', { name: 'Global File System browser' })
  const root = browser
    .getByRole('navigation', { name: 'File location' })
    .getByRole('button', { name: 'Shared with me', exact: true })
  if (await root.isEnabled()) await root.click()
  await browser.getByRole('button', { name: `Open ${folder.name}`, exact: true }).click()
  await expect(
    browser.getByRole('button', { name: `Open ${folder.childName}`, exact: true })
  ).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await browser.getByRole('button', { name: 'Upload file', exact: true }).click()
  await (await chooser).setFiles(filePath)
  await expect(page.getByText(`Uploaded ${fileName}`, { exact: true })).toBeVisible({
    timeout: 60_000,
  })
  const row = browser.getByRole('button', { name: `Open ${fileName}`, exact: true })
  await expect(row).toBeVisible()
  await row.click()
  const preview = page.getByRole('dialog', { name: fileName, exact: true })
  await expect(preview).toBeVisible()
  const picture = preview.getByRole('img', { name: `Preview of ${fileName}`, exact: true })
  await expect(picture).toBeVisible()
  await expect
    .poll(() =>
      picture.evaluate(async element => {
        const image = element as HTMLImageElement
        try {
          await image.decode()
          return { width: image.naturalWidth, height: image.naturalHeight }
        } catch {
          return null
        }
      })
    )
    .toEqual({ width, height })
  await preview.getByRole('button', { name: 'Close image preview' }).click()
  await expect(preview).toBeHidden()
}

async function freshChat(page: Page, agentName: string): Promise<void> {
  await page.getByTestId('nav-chat').click()
  const newThread = page.getByRole('button', { name: /new thread/i })
  if (await newThread.isVisible()) await newThread.click()
  await expect(page.getByTestId('agent-response')).toHaveCount(0)
  await expect(page.getByTestId('progress-expand-btn')).toHaveCount(0)
  const selector = page.getByRole('button', { name: 'Switch chat agent', exact: true })
  await expect(selector).toBeVisible()
  await selector.click()
  await page.getByRole('menuitem', { name: agentName, exact: true }).click()
  await expect(selector).toContainText(agentName)
  await expect(page.getByTestId('chat-input')).toBeVisible()
}

async function sendRead(page: Page, prompt: string): Promise<void> {
  await page.getByTestId('chat-input').fill(prompt)
  await page.getByTestId('send-button').click()
  // This button is rendered only for a completed task with tool steps. A
  // visible streaming answer alone cannot satisfy the journey.
  const complete = page.getByTestId('progress-expand-btn')
  await expect(complete).toBeVisible({ timeout: 180_000 })
  await expect(page.getByTestId('agent-response')).toHaveCount(1)
  await complete.click()
  await expect(complete).toHaveAttribute('aria-expanded', 'true')
  const reads = page.getByTestId(/^step-row-/).filter({ hasText: /\bgfs_read\b/ })
  await expect(reads).not.toHaveCount(0)
  // The completed list no longer changes ordering. Open every matching call,
  // including legitimate retries, rather than selecting a positional last row.
  for (const row of await reads.all()) await row.click()
}

function parseVisualAnswer(raw: string) {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  return JSON.parse(text) as unknown
}

test('GFS image bytes reach vision after visible upload; a host without a grant cannot read another image', async () => {
  requireOwnedRuntime()
  assertGfsInfraHealthy()
  const agent = discoverManagedGfsAgent()
  // Only identity/grants/password are prepared out of band; both image files
  // below are created in GFS through the visible product upload control.
  seedPasswordForEmail(E2E_EMAIL)
  const owner = getE2EUserId(E2E_EMAIL)
  const seeded: string[] = []
  const local = await mkdtemp(path.join(os.tmpdir(), 'evenfire-gfs-visual-'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    const granted = seedGfsDirectoryFixture(uniqueGfsFixtureName('e2e-gfs-visual'))
    seeded.push(granted.name)
    const denied = seedGfsDirectoryFixture(uniqueGfsFixtureName('e2e-gfs-visual-denied'))
    seeded.push(denied.name)
    for (const folder of [granted, denied])
      seedGfsGrant({
        resourceId: folder.resourceId,
        subjectType: 'user',
        subjectId: owner,
        permissions: ['read', 'write', 'delete'],
        inherit: true,
        grantedBy: 'e2e:gfs-visual',
      })
    seedGfsGrant({
      resourceId: granted.resourceId,
      subjectType: 'host',
      subjectId: agent.subjectId,
      permissions: ['read'],
      inherit: true,
      grantedBy: 'e2e:gfs-visual',
    })
    const visual = createGfsVisualImageFixture()
    const fileName = `${randomUUID()}.png`
    const filePath = path.join(local, fileName)
    await writeFile(filePath, visual.bytes)
    app = await electron.launch({
      args: [
        `--user-data-dir=${path.join(local, 'desktop')}`,
        path.resolve(__dirname, '../../dist/main.js'),
      ],
      env: {
        ...process.env,
        EVENFIRE_RENDERER_URL: '',
        CLERUM_DESKTOP_CONFIG_PATH: path.join(local, 'runtime-config.json'),
      },
    })
    const page = await app.firstWindow()
    await test.step('login visibly into the isolated development environment', () =>
      visibleLogin(page))
    await test.step('upload and decode the image in Files', () =>
      uploadAndPreview(page, granted, filePath, fileName, visual.width, visual.height))
    await test.step('read the named file through a fresh agent conversation', async () => {
      await freshChat(page, agent.name)
      await sendRead(
        page,
        `Use your GFS tools to read the image at path "/${granted.name}/${fileName}" in drive main. ` +
          'Inspect its pixels. Return only JSON with left and right objects, each containing color and shape, ' +
          'Use color names red, green, blue, yellow, orange or purple, and shape names circle, square or triangle. ' +
          'Do not infer contents from the filename. Do not use other tools.'
      )
      const visualOutputs = page
        .getByTestId('step-output-panel')
        .filter({ hasText: fileName })
        .filter({ hasText: /"delivery"\s*:\s*"image_input"/ })
      await expect(visualOutputs).not.toHaveCount(0)
      await expect(
        page
          .getByRole('navigation', { name: 'Chat breadcrumb' })
          .getByText(agent.name, { exact: true })
      ).toBeVisible()
      const response = page.getByTestId('agent-response')
      await expect(response).toBeVisible()
      expect(parseVisualAnswer(await response.innerText())).toEqual(visual.expected)
    })
    await test.step('direct-resource negative guard does not disclose an ungranted image', async () => {
      const deniedVisual = createGfsVisualImageFixture()
      const deniedName = `${randomUUID()}.png`
      const deniedPath = path.join(local, deniedName)
      await writeFile(deniedPath, deniedVisual.bytes)
      await uploadAndPreview(
        page,
        denied,
        deniedPath,
        deniedName,
        deniedVisual.width,
        deniedVisual.height
      )
      // Only this explicit negative guard uses a harness-known resource id.
      // It neither uploads by API nor advances the happy-path UI by hidden state.
      const record = getGfsChildResourceSummary({
        parentResourceId: denied.resourceId,
        name: deniedName,
      })
      expect(record).toMatchObject({
        kind: 'file',
        bytes: deniedVisual.bytes.length,
        deleted: false,
      })
      await freshChat(page, agent.name)
      await sendRead(
        page,
        `Call clerum__gfs_read with drive main and resourceId ${record!.resourceId}. ` +
          'Attempt this read even if discovery does not list it. Then return only JSON ' +
          'with status "denied" if access was denied. Do not claim to see an image you cannot read.'
      )
      await expect(
        page.getByTestId('step-output-panel').filter({ hasText: /gfsc 403: forbidden/ })
      ).not.toHaveCount(0)
      await expect(
        page.getByTestId('step-output-panel').filter({ hasText: /"delivery"\s*:\s*"image_input"/ })
      ).toHaveCount(0)
      expect(parseVisualAnswer(await page.getByTestId('agent-response').innerText())).toEqual({
        status: 'denied',
      })
    })
  } finally {
    const cleanupErrors: unknown[] = []
    try {
      await app?.close()
    } catch (error) {
      cleanupErrors.push(error)
    }
    for (const name of seeded) {
      try {
        cleanupGfsFixture(name)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await rm(local, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length)
      throw new Error(`GFS visual fixture cleanup failed in ${cleanupErrors.length} operations`)
  }
})
