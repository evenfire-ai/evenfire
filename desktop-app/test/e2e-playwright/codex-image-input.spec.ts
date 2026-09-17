/**
 * E2E_GUARDIAN_IPC_FLOW: Desktop sends through main-process IPC. Observe the
 * real chooser, preview, user message, settled composer and visual-only answer.
 * Real upstream lane, never evidence when only statically checked.
 * Login fixtures provision the test identity and sign in through the UI. Their
 * existing stored-session reset needs explicit opt-in before fixtures run.
 */
import { randomUUID } from 'node:crypto'
import { challengeImage } from './codexImageChallenge.js'
import { expect, test } from './fixtures.js'

const hostRef = process.env.E2E_HOST_REF ?? ''
const hostLabel = process.env.E2E_CODEX_HOST_LABEL ?? ''
const modelId = process.env.E2E_CODEX_IMAGE_MODEL ?? ''
const modelLabel = process.env.E2E_CODEX_IMAGE_MODEL_LABEL ?? ''
const mode = process.env.E2E_CODEX_IMAGE_MODE ?? ''
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test.beforeAll(() => {
  expect(
    process.env.E2E_CODEX_IMAGE_INPUT,
    'Use the dedicated, explicitly authorized image lane'
  ).toBe('1')
  expect(process.env.CODEX_REAL_UPSTREAM_CONFIRM, 'Explicit upstream authorization required').toBe(
    '1'
  )
  expect(
    process.env.E2E_CODEX_ALLOW_SESSION_RESET,
    'The existing login fixture resets its stored session'
  ).toBe('1')
  expect(hostRef, 'Name the owned Host explicitly').not.toBe('')
  expect(hostLabel, 'Name its visible Agents-list label explicitly').not.toBe('')
  expect(modelId, 'Name the actual Codex model explicitly').not.toBe('')
  expect(modelLabel, 'Name its visible model-picker label explicitly').not.toBe('')
  expect(['enabled', 'disabled'], 'Select a provisioned capability lane explicitly').toContain(mode)
})

async function startOwnedChat(page: import('@playwright/test').Page): Promise<void> {
  const agents = page.getByTestId('nav-agents')
  // Snapshot only chooses the navigation layout; subsequent assertions retry.
  if (!(await agents.isVisible())) {
    const settings = page.getByTestId('nav-settings-menu')
    await expect(settings).toBeVisible()
    if ((await settings.getAttribute('aria-expanded')) !== 'true') await settings.click()
    await expect(settings).toHaveAttribute('aria-expanded', 'true')
  }
  await expect(agents).toBeVisible()
  await agents.click()
  const actions = page.getByRole('button', { name: `More actions for ${hostLabel}`, exact: true })
  await expect(actions).toBeVisible({ timeout: 30_000 })
  await actions.click()
  await expect(actions).toHaveAttribute('aria-expanded', 'true')
  const actionsMenu = page.getByRole('menu').filter({
    has: page.getByRole('button', { name: 'New chat', exact: true }),
  })
  await expect(actionsMenu).toBeVisible()
  const newChat = actionsMenu.getByRole('button', { name: 'New chat', exact: true })
  await expect(newChat).toBeVisible()
  await newChat.click()
  await expect(page.getByTestId('chat-input')).toBeVisible()
  await expect(page.getByTestId('agent-response')).toHaveCount(0)
  const selector = page.getByTestId('model-selector-up')
  await expect(selector).toHaveAttribute('data-host-ref', hostRef, { timeout: 30_000 })
  await expect(selector).toHaveAttribute('data-provider', 'codex-subscription')
  await selector.getByRole('button', { name: /^Model — / }).click()
  const menu = selector.getByRole('menu', { name: 'Select model', exact: true })
  await expect(menu).toBeVisible()
  await menu
    .getByRole('menuitemradio', {
      name: new RegExp(`^${escapeRegex(modelLabel)}(?:\\s*default)?$`),
    })
    .click()
  await expect(selector).toHaveAttribute('data-model', modelId, { timeout: 30_000 })
}

for (const format of ['png', 'jpeg'] as const) {
  test(`${format} visual input follows the explicitly provisioned capability lane`, async ({
    appPage,
  }) => {
    test.setTimeout(240_000)
    // The random answer exists only in pixels, never the filename or prompt.
    // A generic response or discarded image cannot satisfy this 64-bit challenge.
    const image = challengeImage(format)
    const filename = `visual-${randomUUID()}.${format}`
    const prompt = 'Read the hexadecimal code in the attached image. Reply with that code only.'
    await test.step('select the owned Codex Host and model through UI', async () => {
      await startOwnedChat(appPage)
    })
    await test.step('upload through the chooser and verify the rendered preview', async () => {
      await appPage.getByRole('button', { name: 'Add context', exact: true }).click()
      const upload = appPage.getByRole('menuitem', { name: 'Upload Files', exact: true })
      await expect(upload).toBeVisible()
      const chooserReady = appPage.waitForEvent('filechooser')
      await upload.click()
      const chooser = await chooserReady
      await chooser.setFiles({ name: filename, mimeType: `image/${format}`, buffer: image.bytes })
      const chip = appPage.getByRole('button', { name: filename, exact: true })
      await expect(chip).toBeVisible()
      await chip.click()
      const preview = appPage.getByRole('dialog', { name: filename, exact: true })
      await expect(preview).toBeVisible()
      await expect(preview.getByRole('img', { name: filename, exact: true })).toBeVisible()
      await preview.getByRole('button', { name: 'Close image preview', exact: true }).click()
      await expect(preview).toHaveCount(0)
    })
    await test.step('submit and assert the correlated terminal result', async () => {
      const composer = appPage.getByTestId('chat-input')
      await composer.fill(prompt)
      const send = appPage.getByTestId('send-button')
      await expect(send).toBeEnabled()
      await send.click()
      await expect(composer).toHaveValue('')
      const thread = appPage.getByTestId('message-list')
      await expect(thread.getByText(prompt, { exact: true })).toBeVisible()
      await expect(
        thread.locator('.message-attachment-label').filter({ hasText: filename })
      ).toBeVisible()
      const answer = appPage.getByTestId('agent-response')
      const expectedCode = new RegExp(`\\b${image.code}\\b`, 'i')
      if (mode === 'enabled') {
        // One terminal wait, not separate 180-second waits for creation and text.
        await expect(answer).toContainText(expectedCode, { timeout: 180_000 })
        await expect(answer).not.toHaveClass(/chat-bubble--error/)
        // Do not let tool-based attachment loading/OCR substitute for the
        // direct model-input behavior this lane must prove.
        await expect(thread.getByTestId('progress-stepper')).toHaveCount(0)
      } else {
        await expect(answer.locator('.error-bubble-message')).toContainText(
          'Image input is not enabled for this Codex model',
          { timeout: 180_000 }
        )
        await expect(answer).toHaveClass(/chat-bubble--error/)
        await expect(answer).not.toContainText(expectedCode)
      }
      await expect(answer).toHaveCount(1)
      await expect(send).toHaveAttribute('aria-label', 'Send message')
      await expect(thread.locator('.chat-message--in-flight')).toHaveCount(0)
      await expect(appPage.getByRole('status', { name: /^Running on fallback:/ })).toHaveCount(0)
      const selector = appPage.getByTestId('model-selector-up')
      await expect(selector).toHaveAttribute('data-host-ref', hostRef)
      await expect(selector).toHaveAttribute('data-provider', 'codex-subscription')
      await expect(selector).toHaveAttribute('data-model', modelId)
    })
  })
}
