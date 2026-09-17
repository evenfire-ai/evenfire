/**
 * #651: visible upload -> decoded preview -> fresh agent chat -> visual answer.
 * E2E_GUARDIAN_IPC_FLOW: Electron delegates GFS/chat to its main process; browser
 * HTTP waits would not observe these operations. UI state and completed tool
 * output are the synchronization/business signals. No product path is mocked.
 * Folder/grant/account seeding is a named precondition, never file upload.
 */
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  assertGfsFixtureCleaned,
  cleanupGfsFixture,
  getE2EUserId,
  getGfsChildResourceSummary,
  kubectlOut,
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

// A deadline is a failure bound, never a sleep used to advance UI state.
async function withDeadline<T>(operation: Promise<T>, ms: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`R12 ${phase} exceeded ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

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

/** Named precondition: choose an available model using existing runtime credentials.
 * Mutations re-enter T2's validated lease. No image, answer, or session is seeded.
 */
function visualModelFixture(agent: ReturnType<typeof discoverManagedGfsAgent>) {
  const provider = process.env.E2E_GFS_VISUAL_PROVIDER
  const model = process.env.E2E_GFS_VISUAL_MODEL
  if (!provider && !model) return undefined
  if (!provider || !model) throw new Error('Visual model fixture needs both provider and model')
  const read = () => {
    const [uid, currentProvider, currentModel] = kubectlOut([
      '-n',
      agent.namespace,
      'get',
      'host',
      agent.name,
      '-o',
      'jsonpath={.metadata.uid}{"\\t"}{.spec.model.provider}{"\\t"}{.spec.model.name}',
    ])
      .trim()
      .split('\t')
    if (!uid || !currentProvider || !currentModel)
      throw new Error('Host model fixture identity is incomplete')
    return { uid, provider: currentProvider, model: currentModel }
  }
  const original = read()
  const selected = { ...original, provider, model }
  const mutate = (from: typeof original, to: typeof original) => {
    const root = path.resolve(__dirname, '../../..')
    execFileSync(
      'bash',
      [
        path.join(root, 'scripts/minikube/with-t2-mutation-lock.sh'),
        '--',
        'kubectl',
        `--context=${process.env.E2E_K8S_CONTEXT}`,
        '--request-timeout=15s',
        '-n',
        agent.namespace,
        'patch',
        'host',
        agent.name,
        '--type=json',
        '-p',
        JSON.stringify([
          { op: 'test', path: '/metadata/uid', value: from.uid },
          { op: 'test', path: '/spec/model/provider', value: from.provider },
          { op: 'test', path: '/spec/model/name', value: from.model },
          { op: 'replace', path: '/spec/model/provider', value: to.provider },
          { op: 'replace', path: '/spec/model/name', value: to.model },
        ]),
      ],
      { cwd: root, timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  }
  return {
    apply: () => {
      mutate(original, selected)
      expect(read()).toEqual(selected)
      test.info().annotations.push({ type: 'visual-model', description: `${provider}/${model}` })
    },
    restore: () => {
      const current = read()
      if (
        current.uid === original.uid &&
        current.provider === original.provider &&
        current.model === original.model
      )
        return
      // The JSON tests refuse to overwrite a concurrent user's different choice.
      mutate(selected, original)
    },
  }
}

async function waitForAgentBinding(
  agent: ReturnType<typeof discoverManagedGfsAgent>
): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          return discoverManagedGfsAgent()
        } catch (error) {
          // During a model change HCC must rebind the same Host generation. Retry
          // only the missing-binding state; actual Kubernetes failures stay loud.
          if (
            error instanceof Error &&
            (error.message === `HCC agent "${agent.name}" is missing or ambiguous` ||
              error.message === 'GFS agent E2E requires one unambiguous HCC-managed agent name')
          )
            return null
          throw error
        }
      },
      { timeout: 120_000 }
    )
    .toEqual(agent)
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
  // Chromium exposes the visually-hidden file input as a second button with
  // the same accessible name. Visible text identifies the actual user action.
  const upload = browser.getByRole('button').filter({ hasText: /^Upload file$/ })
  await expect(upload).toBeVisible()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    upload.click(),
  ])
  await chooser.setFiles(filePath)
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
  await page.getByTestId('nav-new-chat').click()
  await expect(page.getByRole('heading', { name: 'New chat with', exact: true })).toBeVisible()
  await expect(page.getByTestId('agent-response')).toHaveCount(0)
  await expect(page.getByTestId('progress-expand-btn')).toHaveCount(0)
  const selector = page.getByRole('button', { name: 'Switch chat agent', exact: true })
  await expect(selector).toBeVisible()
  await selector.click()
  await page.getByRole('menuitem', { name: agentName, exact: true }).click()
  await expect(selector).toContainText(agentName)
  await expect(page.getByTestId('chat-input')).toBeVisible()
}

async function sendRead(page: Page, prompt: string, denied = false): Promise<void> {
  await page.getByTestId('chat-input').fill(prompt)
  await page.getByTestId('send-button').click()
  // This button is rendered only for a completed task with tool steps. A
  // visible streaming answer alone cannot satisfy the journey.
  const complete = page.getByTestId('progress-expand-btn')
  await expect(complete).toBeVisible({ timeout: 180_000 })
  await expect(page.getByTestId('agent-response')).toHaveCount(1)
  await complete.click()
  await expect(complete).toHaveAttribute('aria-expanded', 'true')
  const reads = page.getByTestId(/^step-row-/).filter({ hasText: 'gfs_read' })
  await expect(reads).not.toHaveCount(0)
  // The completed list no longer changes ordering. Open every matching call,
  // including legitimate retries, rather than selecting a positional last row.
  // Failed tool rows expand automatically. Clicking them in the negative guard
  // would hide the denial that the user already sees.
  if (!denied) for (const row of await reads.all()) await row.click()
  const outputs = page.getByTestId('step-output-panel')
  await expect(outputs).not.toHaveCount(0)
  // Keep the actual read result visible, including in failure screenshots.
  for (const output of await outputs.all()) await output.scrollIntoViewIfNeeded()
}

async function visualAnswer(page: Page) {
  // The response article also contains the stepper. Read its single visible
  // message body, not the tool metadata and timings that follow it.
  const body = page.getByTestId('agent-response').locator('.message-block')
  await expect(body).toHaveCount(1)
  const raw = await body.innerText()
  // The business oracle is the JSON's visual facts, independent of a rendered
  // code block's language label or copy control.
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('The visible answer contains no JSON object')
  return JSON.parse(raw.slice(start, end + 1)) as unknown
}

test('GFS image bytes reach vision after visible upload; a host without a grant cannot read another image', async () => {
  test.setTimeout(600_000)
  requireOwnedRuntime()
  assertGfsInfraHealthy()
  const agent = discoverManagedGfsAgent()
  // UI labels use spec.host; authorization and fixture grants use the stable id.
  const agentLabel =
    kubectlOut([
      '-n',
      agent.namespace,
      'get',
      'host',
      agent.name,
      '-o',
      'jsonpath={.spec.host}',
    ]).trim() || agent.name
  // Only identity/grants/password are prepared out of band; both image files
  // below are created in GFS through the visible product upload control.
  seedPasswordForEmail(E2E_EMAIL)
  const owner = getE2EUserId(E2E_EMAIL)
  const seeded: string[] = []
  const local = await mkdtemp(path.join(os.tmpdir(), 'evenfire-gfs-visual-'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  let modelFixture: ReturnType<typeof visualModelFixture>
  let journeyFailure: unknown
  try {
    modelFixture = visualModelFixture(agent)
    modelFixture?.apply()
    if (modelFixture) await waitForAgentBinding(agent)
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
    console.info('[R12] phase=launch-isolated-electron')
    app = await electron.launch({
      timeout: 30_000,
      args: [
        '--no-os-protocol-registration',
        `--user-data-dir=${path.join(local, 'desktop')}`,
        path.resolve(__dirname, '../../dist/main.js'),
      ],
      env: {
        ...process.env,
        EVENFIRE_RENDERER_URL: '',
        CLERUM_DESKTOP_CONFIG_PATH: path.join(local, 'runtime-config.json'),
      },
    })
    // This is process identity verification, not a login or product-state shortcut.
    console.info('[R12] phase=verify-process-identity')
    const identity = await withDeadline(
      app.evaluate(({ app }) => ({
        userData: app.getPath('userData'),
        packaged: app.isPackaged,
        argv: process.argv,
      })),
      10_000,
      'process identity'
    )
    expect(identity.packaged).toBe(false)
    expect(await realpath(identity.userData)).toBe(await realpath(path.join(local, 'desktop')))
    expect(identity.argv).toContain('--no-os-protocol-registration')
    expect(identity.argv).toContain(path.resolve(__dirname, '../../dist/main.js'))
    console.info('[R12] phase=first-window')
    const page = await app.firstWindow({ timeout: 30_000 })
    page.setDefaultTimeout(15_000)
    page.setDefaultNavigationTimeout(30_000)
    console.info('[R12] phase=visible-journey')
    await test.step('login visibly into the isolated development environment', () =>
      visibleLogin(page))
    await test.step('upload and decode the image in Files', () =>
      uploadAndPreview(page, granted, filePath, fileName, visual.width, visual.height))
    await test.step('read the named file through a fresh agent conversation', async () => {
      // Read-only business evidence after the real UI upload. This id is never
      // provided to the model in the positive journey.
      const uploaded = getGfsChildResourceSummary({
        parentResourceId: granted.resourceId,
        name: fileName,
      })
      expect(uploaded).toMatchObject({ kind: 'file', bytes: visual.bytes.length, deleted: false })
      await freshChat(page, agentLabel)
      await sendRead(
        page,
        `Use your GFS tools to read the image at path "/${granted.name}/${fileName}" in drive main. ` +
          'Inspect its pixels. Return only JSON with left and right objects, each containing color and shape, ' +
          'Use color names red, green, blue, yellow, orange or purple, and shape names circle, square or triangle. ' +
          'Do not infer contents from the filename. Do not use other tools.'
      )
      // Progress previews truncate each line at 200 chars. The resource id is
      // visible; the trailing delivery field is not. Exact visual facts below
      // are the E2E oracle; typed delivery and serialized bytes are integration
      // contracts, not claims inferred from a truncated preview.
      await expect(
        page
          .getByTestId('step-output-panel')
          .filter({ hasText: uploaded!.resourceId.replace(/-/g, '') })
      ).not.toHaveCount(0)
      await expect(
        page
          .getByRole('navigation', { name: 'Chat breadcrumb' })
          .getByText(agentLabel, { exact: true })
      ).toBeVisible()
      const response = page.getByTestId('agent-response')
      await expect(response).toBeVisible()
      expect(await visualAnswer(page)).toEqual(visual.expected)
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
      await freshChat(page, agentLabel)
      await sendRead(
        page,
        `Call clerum__gfs_read with drive main and resourceId ${record!.resourceId}. ` +
          'Attempt this read even if discovery does not list it. Then return only JSON ' +
          'with status "denied" if access was denied. Do not claim to see an image you cannot read.',
        true
      )
      await expect(
        page.getByTestId('step-output-panel').filter({ hasText: /gfsc 403: forbidden/ })
      ).not.toHaveCount(0)
      // The 403 contract's zero-image assertion lives in the integration suite;
      // absence of a field from a truncated UI preview cannot prove that fact.
      expect(await visualAnswer(page)).toEqual({
        status: 'denied',
      })
    })
  } catch (error) {
    journeyFailure = error
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    try {
      if (app) {
        try {
          await withDeadline(app.close(), 15_000, 'Electron cleanup')
        } catch (error) {
          // Only this test's ChildProcess is eligible for termination. A timed-out
          // close must not strand the subsequent model/grant cleanup indefinitely.
          const child = app.process()
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          throw error
        }
      }
    } catch (error) {
      cleanupErrors.push(error)
    }
    for (const name of seeded) {
      try {
        cleanupGfsFixture(name)
        assertGfsFixtureCleaned(name)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await rm(local, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      modelFixture?.restore()
      if (modelFixture) await waitForAgentBinding(agent)
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length)
      throw new Error(`GFS visual fixture cleanup failed in ${cleanupErrors.length} operations`, {
        cause: journeyFailure,
      })
  }
})
