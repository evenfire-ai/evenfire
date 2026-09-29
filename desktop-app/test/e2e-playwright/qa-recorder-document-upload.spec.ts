import { type ElectronApplication, type Page, type TestInfo, expect, test } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  FIXTURE_DOCUMENT_ANSWER_DIGEST_CHARS,
  FIXTURE_DOCUMENT_ANSWER_PREFIX,
  FIXTURE_RESPONSE_KIND,
  IMAGE_CAPABILITY_FIXTURE_MODELS,
  appendedAttempts,
  readImageCapabilityEvidence,
  requireImageCapabilitiesFixtureEnv,
  resolveImageCapabilitiesMode,
  sha256Hex,
} from './helpers/imageCapabilityEvidence'
import {
  DESKTOP_APP_ROOT,
  EXTERNAL_REST_API_BASE_URL,
  MAIN_ENTRY,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  screenshotAndLog,
} from './qa-recorder-helpers'

/*
 * E2E_GUARDIAN_IPC_FLOW: Desktop chat, the model catalog, the agent list and the
 * composer all travel over Electron IPC (main-process handlers in desktop-app/src),
 * so the renderer has no HTTP request to await for any transition in this
 * journey. The visible/business oracles are the composer's own DOM contracts,
 * the persisted thread, and the provider-boundary ledger of the derived in-cluster
 * fixture.
 *
 * Issue #678: any document attached from the composer travels inline to the Host
 * as a `kind:'file'` attachment. The Host never puts its text in the prompt: it
 * announces the file in the turn context and the model reads it through the
 * `clerum__attachment_read` tool. The provider fixture asks for that tool call,
 * then answers with a digest of the text it received in the tool result. So the
 * answer on screen can only be produced if the exact bytes attached here crossed
 * the composer, IPC, the Host admission, the read tool and the provider wire.
 *
 * Only the external provider peer is simulated. The run is selected by the
 * fixture lane's own run id and never reaches a real provider.
 */

const MODE = resolveImageCapabilitiesMode()

/**
 * The prompt names neither the file content nor its digest: the answer cannot be
 * derived from it.
 */
const DOCUMENT_PROMPT = 'Summarize the attached file.'

function instanceBindingCheck(app: ElectronApplication, page: Page, testInfo: TestInfo) {
  const expectedRun = path.resolve(testInfo.outputPath('electron-isolation'))
  const expectedData = path.join(expectedRun, 'user-data')
  const expectedConfig = path.join(expectedRun, 'runtime-config.json')
  const expectedExecutable = createRequire(path.join(DESKTOP_APP_ROOT, 'package.json'))(
    'electron'
  ) as string
  const restOrigin = new URL(EXTERNAL_REST_API_BASE_URL).origin
  const rpcOrigin = new URL(RPC_PROXY_BASE_URL).origin
  const slug = `${restOrigin}_${rpcOrigin}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  const expectedEnvKey = `${slug}-${sha256Hex(Buffer.from(`${restOrigin}|rpc=${rpcOrigin}`)).slice(0, 12)}`
  return async () => {
    // Observe the running processes and IPC configuration, rather than trusting
    // launch environment variables. This never changes selection or auth state.
    const identity = await app.evaluate(({ app: electronApp }) => ({
      pid: process.pid,
      argv: process.argv,
      executable: electronApp.getPath('exe'),
      userData: electronApp.getPath('userData'),
    }))
    const runtime = await page.evaluate(async () => {
      const state = await window.clerum.auth.getRuntimeConfigState()
      return { storagePath: state.storagePath, envKey: state.envKey }
    })
    expect(identity.pid).toBe(app.process().pid)
    expect(identity.argv.includes(MAIN_ENTRY)).toBe(true)
    expect(fs.realpathSync(identity.executable)).toBe(fs.realpathSync(expectedExecutable))
    expect(path.resolve(identity.userData)).toBe(expectedData)
    expect(path.resolve(runtime.storagePath)).toBe(expectedConfig)
    expect(runtime.envKey).toBe(expectedEnvKey)
  }
}

/**
 * Correlates the two rendered messages with one durable Host task and returns
 * its id once the task result matches the expected answer. Read-only IPC reads
 * after the visible send; they log in, select and send nothing.
 */
async function observeCompletedTask(
  page: Page,
  host: string,
  expectedAnswer: RegExp
): Promise<string> {
  const visibleIds = await page
    .locator('[data-chat-message-id]')
    .evaluateAll(elements => elements.map(element => element.getAttribute('data-chat-message-id')))
  expect(visibleIds).toHaveLength(2)
  let observed: { taskId: string; result: string } | null = null
  await expect
    .poll(
      async () => {
        observed = await page.evaluate(
          async ({ hostRef, ids }) => {
            const chats = await window.clerum.chat.list(hostRef)
            for (const chat of chats.slice(0, 20)) {
              const messages = await window.clerum.chat.loadMessages(hostRef, chat.id)
              const pair = ids.map(id => messages.find(message => message.id === id))
              const taskId = pair[0]?.task_id
              if (!taskId || pair[1]?.task_id !== taskId) continue
              const result = await window.clerum.rpc.getTaskResult(hostRef, taskId)
              return { taskId, result: JSON.stringify(result) }
            }
            return null
          },
          { hostRef: host, ids: visibleIds }
        )
        return observed?.result ?? ''
      },
      { timeout: 30_000 }
    )
    .toMatch(expectedAnswer)
  expect(observed).not.toBeNull()
  return observed!.taskId
}

function composer(page: Page) {
  return page.getByRole('textbox', { name: 'Agent message composer' })
}

function sendButton(page: Page) {
  return page.getByTestId('send-button')
}

function modelChip(page: Page) {
  return page.getByTestId('selected-chat-model')
}

function fileChips(page: Page) {
  return page.getByTestId('composer-file-chip')
}

/** The attachment list a sent user message renders (`MessageAttachmentList`). */
function sentMessageAttachments(page: Page) {
  return page.getByLabel('Message attachments')
}

/** Per-file ceiling the composer enforces; it mirrors the Host default (3 MiB). */
const COMPOSER_FILE_LIMIT_BYTES = 3 * 1024 * 1024

/** Start a blank chat and prove the thread is empty before anything is sent. */
async function startBlankChat(page: Page) {
  await page.getByTestId('nav-new-chat').click()
  await expect(composer(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-chat-message-id]')).toHaveCount(0, { timeout: 20_000 })
}

/**
 * Land on the exact configured agent through the visible Switch chat agent
 * menu, and trust the composer only once the switch control reports it.
 */
async function openConfiguredAgentChat(page: Page, hostRef: string) {
  const escaped = hostRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await page.getByTestId('nav-chat').click()
  const switchAgent = page.getByRole('button', { name: 'Switch chat agent' })
  await expect(switchAgent).toBeVisible({ timeout: 30_000 })
  await switchAgent.click()
  const agentMenuItem = page.getByRole('menuitem', { name: new RegExp(`^${escaped}$`, 'i') })
  await expect(agentMenuItem).toHaveCount(1)
  await agentMenuItem.click()
  await expect(switchAgent).toContainText(new RegExp(escaped, 'i'))
}

/** Selects the model through the visible popover and asserts the chip reports it. */
async function selectSupportedModel(page: Page, model: string) {
  await expect(modelChip(page)).toBeVisible({ timeout: 30_000 })
  await modelChip(page).click()
  const menu = page.getByRole('menu', { name: 'Select model' })
  await expect(menu).toBeVisible({ timeout: 20_000 })
  const row = page.getByTestId(`model-option-${model}`)
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(modelChip(page)).toHaveAttribute('data-model-id', model)
}

/**
 * Reach the authenticated shell through the real form. While the form is still
 * unsent, the authenticated surface must not be mounted, otherwise the journey
 * could pass without a real sign-in.
 */
async function signIn(page: Page) {
  await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })

  const emailInput = page.locator('#email-input')
  const settingsMenu = page.getByTestId('nav-settings-menu')
  await expect(emailInput.or(settingsMenu)).toBeVisible({ timeout: 30_000 })
  if (await settingsMenu.isVisible()) {
    if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
      await settingsMenu.click()
    }
    await expect(settingsMenu).toHaveAttribute('aria-expanded', 'true')
    await page.getByTestId('logout-btn').click()
  }

  await expect(emailInput).toBeVisible({ timeout: 20_000 })
  await expect(composer(page)).toHaveCount(0)
  await expect(sendButton(page)).toHaveCount(0)
  await expect(page.getByTestId('nav-chat')).toHaveCount(0)

  await login(page, desktopCredentials())
  await expect(page.getByTestId('nav-chat')).toBeVisible({ timeout: 30_000 })
}

/** Attach a document the way a user does: Add context -> Upload Files -> native picker. */
async function attachDocument(
  page: Page,
  document: { fileName: string; mimeType: string; buffer: Buffer }
) {
  const attachButton = page.getByRole('button', { name: 'Add context' })
  await expect(attachButton).toBeEnabled()
  await attachButton.click()
  const uploadItem = page.getByRole('menuitem', { name: 'Upload Files' })
  await expect(uploadItem).toBeEnabled({ timeout: 15_000 })

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    uploadItem.click(),
  ])
  await fileChooser.setFiles({
    name: document.fileName,
    mimeType: document.mimeType,
    buffer: document.buffer,
  })
}

/**
 * The fixture's document answer, matched from the exported marker. The
 * underscores are optional in the pattern because the bubble renders Markdown,
 * which may treat intraword underscores as emphasis; the ledger below pins the
 * exact digest regardless.
 */
function documentAnswerRegex(documentSha: string): RegExp {
  const prefix = FIXTURE_DOCUMENT_ANSWER_PREFIX.replace(/_/g, '[_-]?')
  return new RegExp(`${prefix}${documentSha.slice(0, FIXTURE_DOCUMENT_ANSWER_DIGEST_CHARS)}`, 'i')
}

test('document-upload fixture: an attached text file reaches the model through the read tool', async ({}, testInfo) => {
  test.skip(
    MODE !== 'fixture',
    'Set IMAGE_CAPABILITIES_RUN_ID=image-capabilities-<12 hex> (the runner does) to run the ' +
      'derived-provider fixture journey.'
  )

  const env = requireImageCapabilitiesFixtureEnv()
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', env.externalRestApiBaseUrl)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', env.rpcProxyBaseUrl)

  // Precondition read before anything is sent: the derived fixture must be live
  // in the deployment that serves this host, for this run and this profile.
  const baseline = readImageCapabilityEvidence(env)
  expect(baseline.runId).toBe(env.runId)
  expect(baseline.profile).toBe(env.profile)

  // A random token the prompt never mentions: the digest of these exact bytes is
  // the only thing that can appear in the answer.
  const document = {
    fileName: `notes-${randomBytes(3).toString('hex')}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`document-upload ${randomBytes(6).toString('hex')}\nsecond line\n`, 'utf8'),
  }
  const documentSha = sha256Hex(document.buffer)
  fs.mkdirSync(testInfo.outputPath(), { recursive: true })
  fs.writeFileSync(testInfo.outputPath(document.fileName), document.buffer)

  let app: ElectronApplication | undefined
  let recordedPage: Page | undefined

  try {
    const launched = await launchDesktopApp(
      testInfo,
      `issue678-minikube${new URL(EXTERNAL_REST_API_BASE_URL).port}`
    )
    app = launched.app
    recordedPage = launched.page
    const page = launched.page

    const assertBinding = instanceBindingCheck(app, page, testInfo)
    await assertBinding()
    await signIn(page)
    await assertBinding()
    await openConfiguredAgentChat(page, env.hostRef)

    await test.step('a blank chat is ready on the supported model', async () => {
      await startBlankChat(page)
      await selectSupportedModel(page, IMAGE_CAPABILITY_FIXTURE_MODELS.supported)
    })

    await test.step('a file one byte over the limit is refused with its reason and leaves no chip', async () => {
      const oversized = {
        fileName: `too-big-${randomBytes(3).toString('hex')}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.alloc(COMPOSER_FILE_LIMIT_BYTES + 1, 0x61),
      }
      await attachDocument(page, oversized)
      // Liveness witness: the refusal the composer had to produce is on screen.
      const refusal = page.getByRole('alert').filter({ hasText: oversized.fileName })
      await expect(refusal).toHaveCount(1, { timeout: 15_000 })
      await expect(refusal).toContainText(/a file can be at most 3\.0 MiB/)
      await expect(fileChips(page)).toHaveCount(0)
    })

    await test.step('a ready chip can be removed before sending', async () => {
      const throwaway = {
        fileName: `remove-me-${randomBytes(3).toString('hex')}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from(`discarded ${randomBytes(6).toString('hex')}\n`, 'utf8'),
      }
      await attachDocument(page, throwaway)
      const chip = fileChips(page).filter({ hasText: throwaway.fileName })
      await expect(chip).toHaveCount(1, { timeout: 20_000 })
      await expect(chip).toHaveAttribute('data-file-status', 'ready', { timeout: 20_000 })
      await page.getByRole('button', { name: `Remove ${throwaway.fileName}` }).click()
      await expect(fileChips(page)).toHaveCount(0, { timeout: 15_000 })
    })

    await test.step('the document is admitted as a ready file chip and the send is enabled', async () => {
      await attachDocument(page, document)
      const chip = fileChips(page).filter({ hasText: document.fileName })
      await expect(chip).toHaveCount(1, { timeout: 20_000 })
      await expect(chip).toHaveAttribute('data-file-status', 'ready', { timeout: 20_000 })

      await composer(page).fill(DOCUMENT_PROMPT)
      await expect(sendButton(page)).toBeEnabled({ timeout: 20_000 })
    })

    await test.step('the answer carries the digest of the delivered text and the ledger shows both provider turns', async () => {
      const before = readImageCapabilityEvidence(env)
      await assertBinding()
      await sendButton(page).click()
      await expect(fileChips(page)).toHaveCount(0, { timeout: 30_000 })

      await expect(page.getByTestId('message-list')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-chat-message-id]')).toHaveCount(2, { timeout: 120_000 })
      // The sent bubble shows the attachment the user picked, not only the model's answer.
      await expect(sentMessageAttachments(page)).toHaveCount(1, { timeout: 20_000 })
      await expect(sentMessageAttachments(page)).toContainText(document.fileName)
      const response = page.getByTestId('agent-response').locator('.message-block.markdown-content')
      await expect(response).toHaveCount(1, { timeout: 120_000 })
      await expect(response).toContainText(documentAnswerRegex(documentSha), { timeout: 120_000 })
      await observeCompletedTask(page, env.hostRef, documentAnswerRegex(documentSha))

      const after = readImageCapabilityEvidence(env)
      const appended = appendedAttempts(before, after)
      const readRows = appended.filter(
        row => row.responseKind === FIXTURE_RESPONSE_KIND.documentReadRequested
      )
      const answerRows = appended.filter(
        row => row.responseKind === FIXTURE_RESPONSE_KIND.documentAnswer
      )

      // Turn 1: the model asked for the read tool. The prompt alone produced no answer.
      expect(readRows).toHaveLength(1)
      expect(readRows[0]?.model).toBe(IMAGE_CAPABILITY_FIXTURE_MODELS.supported)
      expect(readRows[0]?.documentSha256).toBeNull()
      // Turn 2: the tool result reached the wire carrying exactly the attached bytes.
      expect(answerRows).toHaveLength(1)
      expect(answerRows[0]?.model).toBe(IMAGE_CAPABILITY_FIXTURE_MODELS.supported)
      expect(answerRows[0]?.documentSha256).toBe(documentSha)

      // A document is never an image: no pixels moved, and the fixture refused nothing.
      expect(appended.filter(row => row.imageSha256 !== null)).toHaveLength(0)
      expect(after.counters.imageAttempts - before.counters.imageAttempts).toBe(0)
      expect(after.counters.documentReadRequests - before.counters.documentReadRequests).toBe(1)
      expect(after.counters.documentAnswers - before.counters.documentAnswers).toBe(1)
      expect(after.counters.documentFailures - before.counters.documentFailures).toBe(0)
    })

    await screenshotAndLog(page, testInfo, 'desktop-document-upload-fixture')
  } catch (error) {
    if (recordedPage && !recordedPage.isClosed()) {
      await recordedPage
        .screenshot({ path: testInfo.outputPath('failure.png') })
        .catch(() => undefined)
    }
    throw error
  } finally {
    await finalizeRecording(app, recordedPage)
  }
})
