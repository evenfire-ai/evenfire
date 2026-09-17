import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import fs from 'node:fs'
import { buildImageFixture, orderedColorListRegex } from './helpers/qaRecorderImageFixture'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  configuredHostRef,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  requireRecorderConfirm,
  screenshotAndLog,
} from './qa-recorder-helpers'

/*
 * E2E_GUARDIAN_IPC_FLOW: Desktop chat, the model catalog, and the agent list all
 * travel over Electron IPC (main-process handlers in desktop-app/src), so the
 * renderer has no HTTP request to await for any transition in this journey. The
 * visible/business oracles are the composer's own DOM contracts plus the
 * persisted thread:
 *
 *   - model chip `aria-label` reflects the catalog-projected model name;
 *   - each catalog row carries its host-projected image hint ("no images");
 *   - a sent image is cleared from the composer only on an accepted send;
 *   - the thread renders exactly one user bubble and exactly one
 *     [data-testid='agent-response'];
 *   - the answer must name the fixture's ordered tile colors, which are never
 *     present in the prompt or the file name.
 *
 * Issue #654 regression guard: the image-input capability comes from the real
 * host/catalog projection, never from a provider name or a local default. The
 * journey signs in, navigates to the exact configured agent, starts a blank
 * chat, attaches a real PNG through the composer's Upload Files flow, switches
 * to a model the catalog marks text-only, proves the composer keeps the pending
 * attachment and refuses both Enter and the send button, switches back to an
 * image-capable model, and finally requires an answer that depends on the image.
 */

/** Model names exactly as the host catalog projects them. No invented defaults. */
const SUPPORTED_MODEL = (process.env.QA_RECORDER_IMAGE_MODEL_SUPPORTED ?? '').trim()
const UNSUPPORTED_MODEL = (process.env.QA_RECORDER_IMAGE_MODEL_UNSUPPORTED ?? '').trim()

/** Sending a real message costs model tokens; keep the recorder opt-in explicit. */

/**
 * Fail loud when the journey DID start but the model configuration is unusable.
 * There is deliberately no default: a guessed model name would silently test the
 * wrong capability, which is exactly the false confidence issue #654 guards.
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
 * one hint tag ("no images", "images not verified"), so an anchored prefix plus
 * an optional tag suffix identifies exactly one row without positional selectors.
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

function attachContextMenu(page: Page) {
  return page
    .getByRole('menu')
    .filter({ has: page.getByRole('menuitem', { name: 'Upload Files' }) })
}

/**
 * Reach the authenticated shell through the real form. The shared `login`
 * helper picks between the form and an already-authenticated shell using a
 * first-match locator plus a visibility snapshot; this journey needs
 * deterministic visible controls, so the two states are handled explicitly and
 * any other outcome fails loudly.
 */
async function signIn(page: Page, account: ReturnType<typeof desktopCredentials>) {
  await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })

  const emailInput = page.locator('#email-input')
  const secretInput = page.locator('#password-input')
  const settingsMenu = page.getByTestId('nav-settings-menu')
  const submit = page.getByRole('button', { name: /^Sign in$/ })

  // A persisted session can outlive the recorder's isolated user-data-dir, so
  // the authenticated shell may render first. Leave through the app to reach the
  // form again.
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
  await emailInput.fill(account.email)
  await secretInput.fill(account.password)
  await submit.click()

  await expect(page.getByTestId('nav-chat')).toBeVisible({ timeout: 30_000 })
}

/**
 * Selects a model through the visible popover and returns its catalog row so the
 * caller can assert the host-projected image capability hint for that model.
 */
async function selectModel(page: Page, model: string, imageState: 'supported' | 'unsupported') {
  await expect(modelChip(page)).toBeVisible({ timeout: 30_000 })
  await modelChip(page).click()

  const menu = modelMenu(page)
  await expect(menu).toBeVisible({ timeout: 20_000 })
  const row = catalogModelRow(page, model)
  await expect(row).toHaveCount(1)
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('role', 'menuitemradio')
  if (imageState === 'unsupported')
    await expect(row.getByText('no images', { exact: true })).toBeVisible()
  else {
    await expect(row.getByText('no images', { exact: true })).toHaveCount(0)
    await expect(row.getByText('images not verified', { exact: true })).toHaveCount(0)
  }
  await row.click()

  // State oracle: the chip now reports the model the catalog selected.
  await expect(modelChip(page)).toHaveAttribute('data-model-id', model)
}

test('optional QA recorder: Desktop image capability — blocked on text-only model, answered from the image', async ({}, testInfo) => {
  requireRecorderConfirm(
    'QA_RECORDER_CONFIRM_CHAT',
    'This journey sends a real chat message and may incur model cost.'
  )
  const { supportedModel, unsupportedModel } = requireModelNames()

  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  const hostRef = configuredHostRef()
  const fixture = buildImageFixture()
  const fixturePath = testInfo.outputPath(fixture.fileName)
  fs.mkdirSync(testInfo.outputPath(), { recursive: true })
  fs.writeFileSync(fixturePath, fixture.png)

  // The prompt names neither the colors nor the tile order: the only way to
  // answer is to have received the pixels.
  const prompt =
    'This image is a grid of two columns and three rows of solid color tiles. ' +
    'Reply with the colors in reading order, left to right then top to bottom, ' +
    'as a single comma-separated list on one line.'

  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page

    await signIn(page, credentials)

    // Land on the exact configured agent through the visible Switch chat agent
    // menu. The composer is only trusted after the switch control reports the
    // configured host reference, so an auto-selected agent cannot satisfy this.
    await page.getByTestId('nav-chat').click()
    const switchAgent = page.getByRole('button', { name: 'Switch chat agent' })
    await expect(switchAgent).toBeVisible({ timeout: 30_000 })
    await switchAgent.click()
    const agentMenuItem = page.getByRole('menuitem', { name: hostRef, exact: true })
    await expect(agentMenuItem).toHaveCount(1)
    await agentMenuItem.click()
    await expect(switchAgent).toContainText(hostRef)

    // Start a blank chat so a stale response from a previous thread cannot be
    // mistaken for this journey's answer.
    await page.getByTestId('nav-new-chat').click()
    await expect(composer(page)).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-chat-message-id]')).toHaveCount(0, { timeout: 20_000 })

    // The catalog row itself carries the host-projected image capability. When a
    // model is not image-capable, the selector renders the "no images" tag.
    await selectModel(page, supportedModel, 'supported')

    await selectModel(page, unsupportedModel, 'unsupported')

    // Back to the image-capable model, then attach a real PNG exactly the way a
    // user does: Add context -> Upload Files -> native picker.
    await selectModel(page, supportedModel, 'supported')

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

    const attachmentChip = page
      .locator('.composer-attachment-chip')
      .filter({ hasText: fixture.fileName })
    await expect(attachmentChip).toHaveCount(1, { timeout: 20_000 })
    await expect(attachmentChip).toBeVisible()
    // Baseline: with no attachment the picker is refused, so a chip here proves
    // the image-capable model actually accepted the upload.
    await expect(composer(page)).toBeEnabled()

    // A draft rides along with the pending image so the blocked-send assertions
    // can prove the draft is preserved too. The instruction is deliberately
    // neutral: it names neither the colors nor the tile order, so only the
    // delivered pixels can produce a correct answer.
    const draftText = prompt
    await composer(page).fill(draftText)

    // Switch to the text-only model. The attachment must stay pending and the
    // composer must refuse to send it, by button and by Enter.
    await selectModel(page, unsupportedModel, 'unsupported')
    await expect(modelChip(page)).toHaveAttribute('data-model-id', unsupportedModel)
    await expect(attachmentChip).toBeVisible()
    await expect(composer(page)).toHaveValue(draftText)

    const sendButton = page.getByTestId('send-button')
    await expect(sendButton).toBeDisabled({ timeout: 20_000 })
    const capabilityNotice = page.getByTestId('composer-image-capability-notice')
    await expect(capabilityNotice).toBeVisible()
    await expect(capabilityNotice).toContainText(unsupportedModel)
    await expect(capabilityNotice).toContainText(/not supported|not verified/i)

    await composer(page).press('Enter')
    // Nothing was delivered: no new bubble, no cleared draft, no cleared chip.
    await expect(page.locator('[data-chat-message-id]')).toHaveCount(0)
    await expect(composer(page)).toHaveValue(draftText)
    await expect(attachmentChip).toBeVisible()
    await expect(sendButton).toBeDisabled()

    // Switch back to the image-capable model and send the pending image.
    await selectModel(page, supportedModel, 'supported')
    await expect(attachmentChip).toBeVisible()
    await expect(sendButton).toBeEnabled({ timeout: 20_000 })
    await expect(capabilityNotice).toHaveCount(0)
    await sendButton.click()

    // The composer leaves its pending state; this alone is not proof of delivery.
    // The correlated new exchange and visual answer below supply that proof.
    await expect(page.locator('.composer-attachment-chip')).toHaveCount(0, { timeout: 30_000 })

    // Exactly one exchange in this brand-new chat.
    await expect(page.getByTestId('message-list')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-chat-message-id]')).toHaveCount(2, { timeout: 120_000 })
    const response = page.getByTestId('agent-response')
    await expect(response).toHaveCount(1, { timeout: 120_000 })
    await expect(response).not.toHaveText('', { timeout: 120_000 })
    await expect(response).toContainText(orderedColorListRegex(fixture.orderedColors), {
      timeout: 120_000,
    })

    await screenshotAndLog(page, testInfo, 'desktop-image-capabilities')
  } finally {
    await finalizeRecording(app, page)
  }
})
