import { type ElectronApplication, type Page, type TestInfo, expect, test } from '@playwright/test'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  FIXTURE_RESPONSE_KIND,
  FIXTURE_TEXT_ONLY_CONTENT,
  IMAGE_CAPABILITY_FIXTURE_MODELS,
  appendedAttempts,
  readImageCapabilityEvidence,
  requireImageCapabilitiesFixtureEnv,
  resolveImageCapabilitiesMode,
  sha256Hex,
} from './helpers/imageCapabilityEvidence'
import { buildImageFixture, orderedColorListRegex } from './helpers/qaRecorderImageFixture'
import {
  DESKTOP_APP_ROOT,
  EXTERNAL_REST_API_BASE_URL,
  MAIN_ENTRY,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  configuredHostRef,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  requireRecorderConfirm,
  screenshotAndLog,
} from './qa-recorder-helpers'

function instanceBindingCheck(app: ElectronApplication, page: Page, testInfo: TestInfo) {
  const expectedRun = path.resolve(testInfo.outputPath('electron-isolation'))
  const expectedData = path.join(expectedRun, 'user-data')
  const expectedConfig = path.join(expectedRun, 'runtime-config.json')
  const expectedExecutable = createRequire(path.join(DESKTOP_APP_ROOT, 'package.json'))(
    'electron'
  ) as string
  // Public environment identity contract: both effective origins contribute.
  // An env-only launch does not necessarily have a saved selector option.
  const restOrigin = new URL(EXTERNAL_REST_API_BASE_URL).origin
  const rpcOrigin = new URL(RPC_PROXY_BASE_URL).origin
  const slug = `${restOrigin}_${rpcOrigin}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  const expectedEnvKey = `${slug}-${sha256Hex(Buffer.from(`${restOrigin}|rpc=${rpcOrigin}`)).slice(0, 12)}`
  let firstEnvKey: string | undefined
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
      return {
        storagePath: state.storagePath,
        envKey: state.envKey,
      }
    })
    expect(identity.pid).toBe(app.process().pid)
    expect(identity.argv.includes(MAIN_ENTRY)).toBe(true)
    expect(fs.realpathSync(identity.executable)).toBe(fs.realpathSync(expectedExecutable))
    expect(path.resolve(identity.userData)).toBe(expectedData)
    expect(path.resolve(runtime.storagePath)).toBe(expectedConfig)
    expect(runtime.envKey).toBe(expectedEnvKey)
    if (firstEnvKey !== undefined) expect(runtime.envKey).toBe(firstEnvKey)
    firstEnvKey = runtime.envKey
    fs.writeFileSync(
      testInfo.outputPath('instance-binding.json'),
      JSON.stringify(
        {
          issue: 654,
          pid: identity.pid,
          mainEntry: MAIN_ENTRY,
          executable: identity.executable,
          userData: expectedData,
          config: expectedConfig,
          envKey: runtime.envKey,
          expectedRest: EXTERNAL_REST_API_BASE_URL,
          expectedRpc: RPC_PROXY_BASE_URL,
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
  }
}

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
  // Read-only business oracle AFTER the visible send and response. These IPC
  // reads do not log in, create a chat, select a model, send or mutate state.
  // They correlate the two rendered messages with one durable Host task.
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

/*
 * E2E_GUARDIAN_IPC_FLOW: Desktop chat, the model catalog, the agent list and the
 * composer all travel over Electron IPC (main-process handlers in desktop-app/src),
 * so the renderer has no HTTP request to await for any transition in this
 * journey. The visible/business oracles are the composer's own DOM contracts,
 * the persisted thread, and — in fixture mode — the provider-boundary ledger of
 * the derived in-cluster fixture.
 *
 * Issue #654 regression guard: the image-input capability comes from the real
 * host/catalog projection, never from a provider name or a local default.
 *
 * Two lanes share this file:
 *
 *   1. the real-provider smoke (no IMAGE_CAPABILITIES_RUN_ID), which is opt-in
 *      via QA_RECORDER_CONFIRM_CHAT because it spends provider tokens;
 *   2. the fixture lane (IMAGE_CAPABILITIES_RUN_ID=image-capabilities-<12 hex>),
 *      which answers the external ZAI origin from a derived in-cluster fixture,
 *      so it is deterministic and free, and it is gated by its own run id plus
 *      the fixture ledger it reads before the first send.
 *
 * Both lanes drive the same real application, sign-in form, IPC, host and
 * database. Only the external provider peer is simulated, in fixture mode only.
 */

/** The lane is selected by the environment alone; see the helper. */
const MODE = resolveImageCapabilitiesMode()

/** Model names exactly as the host catalog projects them. No invented defaults. */
const SUPPORTED_MODEL = (process.env.QA_RECORDER_IMAGE_MODEL_SUPPORTED ?? '').trim()
const UNSUPPORTED_MODEL = (process.env.QA_RECORDER_IMAGE_MODEL_UNSUPPORTED ?? '').trim()

/**
 * The prompt names neither the colors nor the tile order: the only way to
 * answer it is to have received the pixels.
 */
const VISUAL_PROMPT =
  'This image is a grid of two columns and three rows of solid color tiles. ' +
  'Reply with the colors in reading order, left to right then top to bottom, ' +
  'as a single comma-separated list on one line.'

/**
 * Fail loud when the real-provider smoke DID start but the model configuration
 * is unusable. There is deliberately no default: a guessed model name would
 * silently test the wrong capability, which is exactly the false confidence
 * issue #654 guards.
 */
function requireModelNames(): { supportedModel: string; unsupportedModel: string } {
  if (!SUPPORTED_MODEL || !UNSUPPORTED_MODEL) {
    throw new Error(
      'QA_RECORDER_IMAGE_MODEL_SUPPORTED and QA_RECORDER_IMAGE_MODEL_UNSUPPORTED are required: ' +
        'name the exact image-capable and text-only models from the real host catalog. This ' +
        'journey has no default model and must never guess one.'
    )
  }
  if (SUPPORTED_MODEL === UNSUPPORTED_MODEL) {
    throw new Error(
      'QA_RECORDER_IMAGE_MODEL_SUPPORTED and QA_RECORDER_IMAGE_MODEL_UNSUPPORTED must differ.'
    )
  }
  return { supportedModel: SUPPORTED_MODEL, unsupportedModel: UNSUPPORTED_MODEL }
}

/**
 * Match a catalog row by model name. The row's accessible name appends at most
 * one hint tag ("no images", "images not verified"), so the row test id
 * identifies exactly one row without a positional selector.
 */
function catalogModelRow(page: Page, model: string) {
  return page.getByTestId(`model-option-${model}`)
}

function modelChip(page: Page) {
  return page.getByTestId('selected-chat-model')
}

function modelMenu(page: Page) {
  return page.getByRole('menu', { name: 'Select model' })
}

function composer(page: Page) {
  return page.getByRole('textbox', { name: 'Agent message composer' })
}

function sendButton(page: Page) {
  return page.getByTestId('send-button')
}

function capabilityNotice(page: Page) {
  return page.getByTestId('composer-image-capability-notice')
}

function attachmentChips(page: Page) {
  return page.locator('.composer-attachment-chip')
}

function attachContextMenu(page: Page) {
  return page
    .getByRole('menu')
    .filter({ has: page.getByRole('menuitem', { name: 'Upload Files' }) })
}

/** Start a blank chat and prove the thread is empty before anything is sent. */
async function startBlankChat(page: Page) {
  await page.getByTestId('nav-new-chat').click()
  await expect(composer(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-chat-message-id]')).toHaveCount(0, { timeout: 20_000 })
}

/**
 * Land on the exact configured agent through the visible Switch chat agent
 * menu. The composer is only trusted once the switch control reports the
 * configured host reference, so an auto-selected agent cannot satisfy this.
 */
async function openConfiguredAgentChat(page: Page, hostRef: string) {
  await page.getByTestId('nav-chat').click()
  const switchAgent = page.getByRole('button', { name: 'Switch chat agent' })
  await expect(switchAgent).toBeVisible({ timeout: 30_000 })
  await switchAgent.click()
  const visibleName = new RegExp(`^${hostRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
  const agentMenuItem = page.getByRole('menuitem', { name: visibleName })
  await expect(agentMenuItem).toHaveCount(1)
  await agentMenuItem.click()
  await expect(switchAgent).toContainText(
    new RegExp(hostRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  )
}

/** The model options menu, opened from the composer's own chip. */
async function openModelMenu(page: Page) {
  await expect(modelChip(page)).toBeVisible({ timeout: 30_000 })
  await modelChip(page).click()
  const menu = modelMenu(page)
  await expect(menu).toBeVisible({ timeout: 20_000 })
  return menu
}

/**
 * Selects a model through the visible popover, asserting the host-projected
 * image capability hint for that model before the click.
 */
async function selectModel(
  page: Page,
  model: string,
  imageState: 'supported' | 'unsupported' | 'unknown'
) {
  await openModelMenu(page)

  const row = catalogModelRow(page, model)
  await expect(row).toHaveCount(1)
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('role', 'menuitemradio')
  if (imageState === 'unsupported') {
    await expect(row.getByText('no images', { exact: true })).toBeVisible()
  } else if (imageState === 'unknown') {
    // No evidence is not the same claim as "known to be text-only".
    await expect(row.getByText('images not verified', { exact: true })).toBeVisible()
    await expect(row.getByText('no images', { exact: true })).toHaveCount(0)
  } else {
    await expect(row.getByText('no images', { exact: true })).toHaveCount(0)
    await expect(row.getByText('images not verified', { exact: true })).toHaveCount(0)
  }
  await row.click()

  // State oracle: the chip now reports the model the catalog selected.
  await expect(modelChip(page)).toHaveAttribute('data-model-id', model)
  // Selection identity can render before capability refresh settles. Assert
  // the selected model's visible capability before attempting the next action.
  if (imageState === 'supported') {
    await expect(modelChip(page)).not.toHaveAttribute('title', /cannot receive|not verified/i)
  } else {
    await expect(modelChip(page)).toHaveAttribute(
      'title',
      imageState === 'unsupported' ? /cannot receive images/i : /not verified/i
    )
  }
}

/**
 * Attach a real PNG exactly the way a user does: Add context -> Upload Files ->
 * native picker. No storage write, no IPC mock, no forced event.
 */
async function attachFixturePng(
  page: Page,
  fixture: { png: Buffer; fileName: string }
): Promise<void> {
  const attachButton = page.getByRole('button', { name: 'Add context' })
  await expect(attachButton).toBeEnabled()
  await attachButton.click()
  await expect(attachContextMenu(page)).toBeVisible({ timeout: 15_000 })
  const uploadItem = page.getByRole('menuitem', { name: 'Upload Files' })
  await expect(uploadItem).toBeEnabled()

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    uploadItem.click(),
  ])
  await fileChooser.setFiles({
    name: fixture.fileName,
    mimeType: 'image/png',
    buffer: fixture.png,
  })

  const attachmentChip = attachmentChips(page).filter({ hasText: fixture.fileName })
  await expect(attachmentChip).toHaveCount(1, { timeout: 20_000 })
  await expect(attachmentChip).toBeVisible()
}

/**
 * The blocked-send contract for a pending image on a model that cannot take
 * one: the chip and the draft survive, the button is refused, Enter is refused,
 * and the notice names the blocking model.
 */
async function expectImageSendBlocked(
  page: Page,
  model: string,
  draft: string,
  attachmentName: string,
  messagePattern: RegExp
) {
  await expect(modelChip(page)).toHaveAttribute('data-model-id', model)
  await expect(attachmentChips(page).filter({ hasText: attachmentName })).toBeVisible()
  await expect(composer(page)).toHaveValue(draft)

  await expect(sendButton(page)).toBeDisabled({ timeout: 20_000 })
  const notice = capabilityNotice(page)
  await expect(notice).toBeVisible()
  await expect(notice).toContainText(model)
  await expect(notice).toContainText(messagePattern)

  // Enter must not reach the controller either: nothing is delivered, the draft
  // survives, and the chip is still pending.
  await composer(page).press('Enter')
  await expect(page.locator('[data-chat-message-id]')).toHaveCount(0)
  await expect(composer(page)).toHaveValue(draft)
  await expect(attachmentChips(page).filter({ hasText: attachmentName })).toBeVisible()
  await expect(sendButton(page)).toBeDisabled()
}

/**
 * A model with no image evidence must refuse the picker itself: the native file
 * chooser must never open, and the composer must say why.
 *
 * The bounded `waitForEvent('filechooser')` is a race against the product's own
 * signal, not a sleep used as readiness: if the picker opened, the event fires
 * within milliseconds and the assertion below fails.
 */
async function expectUploadRefused(page: Page, model: string, messagePattern: RegExp) {
  const attachButton = page.getByRole('button', { name: 'Add context' })
  await expect(attachButton).toBeEnabled()
  await attachButton.click()
  const uploadItem = page.getByRole('menuitem', { name: 'Upload Files' })
  await expect(uploadItem).toBeVisible({ timeout: 15_000 })

  let chooserOpened = false
  const chooserProbe = page.waitForEvent('filechooser', { timeout: 2_000 }).then(
    () => {
      chooserOpened = true
    },
    () => undefined
  )

  await uploadItem.click()
  const notice = page.getByRole('alert').filter({ hasText: messagePattern })
  await expect(notice).toBeVisible()
  await expect(notice).toContainText(model)
  await expect(notice).toContainText(messagePattern)

  await chooserProbe
  expect(chooserOpened, `${model} must not open the native file picker`).toBe(false)
  await expect(attachmentChips(page)).toHaveCount(0)

  // Close the composer menu again through an ordinary click, the same way a
  // user dismisses it, so the next step starts from a clean composer.
  await composer(page).click()
  await expect(uploadItem).toHaveCount(0)
}

/** Exactly one exchange in this chat, and the answer is not empty. */
async function expectSingleExchange(page: Page) {
  await expect(page.getByTestId('message-list')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-chat-message-id]')).toHaveCount(2, { timeout: 120_000 })
  const response = page.getByTestId('agent-response')
  await expect(response).toHaveCount(1, { timeout: 120_000 })
  // The article also contains the timestamp; assert the answer body itself.
  const body = response.locator('.message-block.markdown-content')
  await expect(body).toHaveCount(1, { timeout: 120_000 })
  await expect(body).not.toHaveText('', { timeout: 120_000 })
  return body
}

/** Case-insensitive matcher for "any of these tile colors". */
function anyColorRegex(colors: string[]): RegExp {
  return new RegExp(colors.join('|'), 'i')
}

/**
 * The fixture's text-only answer, matched from the exported marker rather than
 * a retyped literal. The underscores are optional in the pattern because the
 * bubble renders Markdown, which may treat the intraword underscores as
 * emphasis; the provider ledger below pins the exact response kind regardless.
 */
function fixtureTextAnswerRegex(): RegExp {
  return new RegExp(FIXTURE_TEXT_ONLY_CONTENT.replace(/_/g, '[_-]?'), 'i')
}

/**
 * Reach the authenticated shell through the real form.
 *
 * The credential fields themselves are driven by the shared `login` helper: it
 * already owns that form, and this journey only needs a deterministic decision
 * between the two legitimate entry states (form vs. an already-authenticated
 * shell left behind by a persisted session).
 *
 * The negative assertion in the middle is the point: while the form is still
 * unsent, the authenticated surface must not be mounted at all. Otherwise the
 * "authenticated" DOM of every later step would be indistinguishable from the
 * pre-login DOM, and the whole journey could pass without a real sign-in.
 */
async function signIn(page: Page) {
  await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })

  const emailInput = page.locator('#email-input')
  const settingsMenu = page.getByTestId('nav-settings-menu')

  const reached = await expect(emailInput.or(settingsMenu))
    .toBeVisible({ timeout: 30_000 })
    .then(
      () => true,
      () => false
    )
  if (!reached) {
    throw new Error(
      'Desktop rendered neither #email-input nor nav-settings-menu after the boot overlay cleared.'
    )
  }
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
  await expect(page.getByTestId('nav-new-chat')).toHaveCount(0)

  await login(page, desktopCredentials())
  await expect(page.getByTestId('nav-chat')).toBeVisible({ timeout: 30_000 })
}

test('optional QA recorder: Desktop image capability — blocked on text-only model, answered from the image', async ({}, testInfo) => {
  test.skip(
    MODE === 'fixture',
    'IMAGE_CAPABILITIES_RUN_ID selects the derived-provider fixture lane; the real-provider ' +
      'smoke runs with it unset.'
  )
  requireRecorderConfirm(
    'QA_RECORDER_CONFIRM_CHAT',
    'This journey sends a real chat message and may incur model cost.'
  )
  const { supportedModel, unsupportedModel } = requireModelNames()

  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const hostRef = configuredHostRef()
  const fixture = buildImageFixture()
  fs.mkdirSync(testInfo.outputPath(), { recursive: true })
  fs.writeFileSync(testInfo.outputPath(fixture.fileName), fixture.png)

  let app: ElectronApplication | undefined
  let recordedPage: Page | undefined

  try {
    const launched = await launchDesktopApp(
      testInfo,
      `issue654-minikube${new URL(EXTERNAL_REST_API_BASE_URL).port}`
    )
    app = launched.app
    recordedPage = launched.page
    // A `const` alias keeps the non-optional type inside `test.step` closures,
    // where a captured `let` would widen back to `Page | undefined`.
    const page = launched.page

    await signIn(page)

    // Land on the exact configured agent through the visible Switch chat agent
    // menu. The composer is only trusted after the switch control reports the
    // configured host reference, so an auto-selected agent cannot satisfy this.
    await openConfiguredAgentChat(page, hostRef)

    // Start a blank chat so a stale response from a previous thread cannot be
    // mistaken for this journey's answer.
    await startBlankChat(page)

    // The catalog row itself carries the host-projected image capability. When a
    // model is not image-capable, the selector renders the "no images" tag.
    await selectModel(page, supportedModel, 'supported')
    await selectModel(page, unsupportedModel, 'unsupported')
    await selectModel(page, supportedModel, 'supported')

    // Attach a real PNG exactly the way a user does: Add context -> Upload
    // Files -> native picker.
    await attachFixturePng(page, fixture)
    await expect(composer(page)).toBeEnabled()

    // A draft rides along with the pending image so the blocked-send assertions
    // can prove the draft is preserved too.
    await composer(page).fill(VISUAL_PROMPT)

    // Switch to the text-only model. The attachment must stay pending and the
    // composer must refuse to send it, by button and by Enter.
    await selectModel(page, unsupportedModel, 'unsupported')
    await expectImageSendBlocked(
      page,
      unsupportedModel,
      VISUAL_PROMPT,
      fixture.fileName,
      /not supported/i
    )

    // Switch back to the image-capable model and send the pending image.
    await selectModel(page, supportedModel, 'supported')
    await expect(attachmentChips(page).filter({ hasText: fixture.fileName })).toBeVisible()
    await expect(sendButton(page)).toBeEnabled({ timeout: 20_000 })
    await expect(capabilityNotice(page)).toHaveCount(0)
    await sendButton(page).click()

    // The composer leaves its pending state; this alone is not proof of
    // delivery. The correlated exchange and the visual answer below supply that
    // proof.
    await expect(attachmentChips(page)).toHaveCount(0, { timeout: 30_000 })

    const response = await expectSingleExchange(page)
    await expect(response).toContainText(orderedColorListRegex(fixture.orderedColors), {
      timeout: 120_000,
    })

    await screenshotAndLog(page, testInfo, 'desktop-image-capabilities')
  } finally {
    await finalizeRecording(app, recordedPage)
  }
})

test('image-capabilities fixture: image capability gates the composer and the provider answers from the delivered pixels', async ({}, testInfo) => {
  test.skip(
    MODE !== 'fixture',
    'Set IMAGE_CAPABILITIES_RUN_ID=image-capabilities-<12 hex> to run the derived-provider ' +
      'fixture journey.'
  )

  const env = requireImageCapabilitiesFixtureEnv()

  // Loopback-only, and the shared helper also probes both health endpoints so a
  // missing port-forward fails here instead of inside Electron. `env` already
  // proves both URLs are loopback, so no remote path is reachable from this lane.
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', env.externalRestApiBaseUrl)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', env.rpcProxyBaseUrl)

  // Precondition read, before anything is sent: the derived fixture must already
  // be live in the deployment that serves this host, and its ledger must belong
  // to this run and this profile. If it does not, this fails before the first
  // send, so a journey can never quietly reach the real provider.
  const baseline = readImageCapabilityEvidence(env)
  expect(baseline.runId).toBe(env.runId)
  expect(baseline.profile).toBe(env.profile)

  // In fixture mode the shared helper reads the same two bindings the validator
  // above already required, so its local fallbacks cannot apply and this journey
  // always runs as the identity the runner seeded.
  const visualFixture = buildImageFixture()
  const textFixture = buildImageFixture()
  for (const [name, fixture] of [
    ['visual-chat', visualFixture],
    ['text-chat', textFixture],
  ] as const) {
    fs.mkdirSync(testInfo.outputPath(name), { recursive: true })
    fs.writeFileSync(testInfo.outputPath(name, fixture.fileName), fixture.png)
  }
  const visualSha = sha256Hex(visualFixture.png)
  const textSha = sha256Hex(textFixture.png)
  let visualTaskId = ''

  let app: ElectronApplication | undefined
  let recordedPage: Page | undefined

  try {
    const launched = await launchDesktopApp(
      testInfo,
      `issue654-minikube${new URL(EXTERNAL_REST_API_BASE_URL).port}`
    )
    app = launched.app
    recordedPage = launched.page
    // A `const` alias keeps the non-optional type inside the `test.step`
    // closures below, where a captured `let` would widen back to `| undefined`.
    const page = launched.page

    const assertBinding = instanceBindingCheck(app, page, testInfo)
    await assertBinding()
    await signIn(page)
    await assertBinding()
    await openConfiguredAgentChat(page, env.hostRef)

    await test.step('a model with no image evidence refuses the picker and sends nothing', async () => {
      await startBlankChat(page)
      await selectModel(page, env.unknownModel, 'unknown')
      // The chip carries the same projection as the row hint.
      await expect(modelChip(page)).toHaveAttribute('title', /not verified/i)

      await expectUploadRefused(page, env.unknownModel, /not verified/i)
      await expect(page.locator('[data-chat-message-id]')).toHaveCount(0)

      // The refused picker must not have produced any provider attempt carrying
      // pixels, and nothing at all may have carried an image during launch,
      // sign-in or navigation.
      const afterUnknown = readImageCapabilityEvidence(env)
      const appended = appendedAttempts(baseline, afterUnknown)
      expect(appended.filter(row => row.imageSha256 !== null)).toHaveLength(0)
      expect(afterUnknown.counters.imageAttempts - baseline.counters.imageAttempts).toBe(0)
    })

    await test.step('an image-capable model accepts the PNG while a text-only model refuses to send it', async () => {
      await startBlankChat(page)

      await selectModel(page, env.supportedModel, 'supported')
      await attachFixturePng(page, visualFixture)
      await composer(page).fill(VISUAL_PROMPT)

      // The attachment and the draft must both survive the switch to a model
      // that cannot take an image, and neither Enter nor the button may send it.
      await selectModel(page, env.unsupportedModel, 'unsupported')
      await expectImageSendBlocked(
        page,
        env.unsupportedModel,
        VISUAL_PROMPT,
        visualFixture.fileName,
        /not supported/i
      )

      await selectModel(page, env.supportedModel, 'supported')
      await expect(attachmentChips(page).filter({ hasText: visualFixture.fileName })).toBeVisible()
      await expect(capabilityNotice(page)).toHaveCount(0)
      await expect(sendButton(page)).toBeEnabled({ timeout: 20_000 })
    })

    await test.step('the accepted send is answered from the delivered pixels and reaches the provider once', async () => {
      const before = readImageCapabilityEvidence(env)

      await assertBinding()
      await sendButton(page).click()
      await expect(attachmentChips(page)).toHaveCount(0, { timeout: 30_000 })

      const response = await expectSingleExchange(page)
      await expect(response).toContainText(orderedColorListRegex(visualFixture.orderedColors), {
        timeout: 120_000,
      })
      visualTaskId = await observeCompletedTask(
        page,
        env.hostRef,
        orderedColorListRegex(visualFixture.orderedColors)
      )

      const after = readImageCapabilityEvidence(env)
      const appended = appendedAttempts(before, after)
      const tileRows = appended.filter(row => row.responseKind === FIXTURE_RESPONSE_KIND.tileColors)

      // Exactly one pixel-derived answer, produced by the image model, from the
      // exact bytes this journey attached.
      expect(tileRows).toHaveLength(1)
      expect(tileRows[0]?.model).toBe(IMAGE_CAPABILITY_FIXTURE_MODELS.supported)
      expect(tileRows[0]?.imageSha256).toBe(visualSha)
      // No other attempt carried these pixels, so the text-only model never saw
      // them and neither did any other model.
      expect(appended.filter(row => row.imageSha256 === visualSha)).toHaveLength(1)
      expect(after.counters.tileColorResponses - before.counters.tileColorResponses).toBe(1)
    })

    await test.step('removing the pending image lifts the block and the text-only model answers in text', async () => {
      await startBlankChat(page)

      await selectModel(page, env.supportedModel, 'supported')
      await attachFixturePng(page, textFixture)
      await composer(page).fill('Reply with the fixture text marker.')

      await selectModel(page, env.unsupportedModel, 'unsupported')
      await expectImageSendBlocked(
        page,
        env.unsupportedModel,
        'Reply with the fixture text marker.',
        textFixture.fileName,
        /not supported/i
      )

      // The real chip remove action must lift the block without touching the
      // draft: this is the user-visible way out of the refusal.
      const removeButton = page.getByRole('button', { name: `Remove ${textFixture.fileName}` })
      await expect(removeButton).toBeVisible()
      await removeButton.click()
      await expect(attachmentChips(page)).toHaveCount(0)
      await expect(capabilityNotice(page)).toHaveCount(0)
      await expect(composer(page)).toHaveValue('Reply with the fixture text marker.')
      await expect(sendButton(page)).toBeEnabled({ timeout: 20_000 })

      const before = readImageCapabilityEvidence(env)
      await assertBinding()
      await sendButton(page).click()

      const response = await expectSingleExchange(page)
      // The marker is the fixture's text-only answer.
      await expect(response).toContainText(fixtureTextAnswerRegex(), { timeout: 120_000 })
      // A request without pixels can never produce a color list.
      await expect(response).not.toContainText(anyColorRegex(textFixture.orderedColors))
      const textTaskId = await observeCompletedTask(page, env.hostRef, fixtureTextAnswerRegex())
      expect(textTaskId).not.toBe(visualTaskId)

      const after = readImageCapabilityEvidence(env)
      const appended = appendedAttempts(before, after)

      // The removed image never reached the wire at all.
      expect(appended.filter(row => row.imageSha256 !== null)).toHaveLength(0)
      expect(appended.filter(row => row.imageSha256 === textSha)).toHaveLength(0)
      // A delivered-but-undecodable image is recorded with `imageSha256: null` and
      // `responseKind: 'rejected'`, so the row checks above cannot see it. The
      // fixture still counts that attempt, so the image-attempt counter must not
      // move either.
      expect(after.counters.imageAttempts - before.counters.imageAttempts).toBe(0)

      const textRows = appended.filter(
        row =>
          row.responseKind === FIXTURE_RESPONSE_KIND.textOnly && row.model === env.unsupportedModel
      )
      expect(textRows.length).toBeGreaterThanOrEqual(1)
      // The fixture never had to refuse an image on the text model, because the
      // composer's own guard stopped it: this proves the client-side block, not
      // the fixture's refusal.
      expect(after.counters.textModelImageRefusals - before.counters.textModelImageRefusals).toBe(0)
    })

    await screenshotAndLog(page, testInfo, 'desktop-image-capabilities-fixture')
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
