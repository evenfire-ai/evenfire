/**
 * E2E_GUARDIAN_IPC_FLOW: visible login -> Agents -> owned Host -> model picker
 * -> chooser -> preview -> Send -> settled UI -> one durable completed task.
 * Electron has no renderer HTTP request for these IPC transitions. The only
 * deterministic peer is the external Grok/Codex vendor; all core paths stay real.
 * Real mode is G8 evidence only after actual execution. Static/unit checks are separate.
 */
import type { Page, TestInfo } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { challengeImage, challengeImageAt, paddedChallengeImage } from './codexImageChallenge.js'
import { tileChallengeImage } from './subscriptionImageChallenge.js'
import {
  expect,
  readVendorAttempts,
  subscriptionImageRun as run,
  sha256,
  test,
} from './subscriptionImageFixtures.js'
import type { ProviderBinding } from './subscriptionImageRunContract.js'

const MIB = 1024 * 1024
const pad = createRequire(__filename)(
  '../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs'
) as {
  padPngToSize: (bytes: Buffer, size: number) => Buffer
  padJpegToSize: (bytes: Buffer, size: number) => Buffer
}
type Image = { code: string; bytes: Buffer }
type Upload = { name: string; mimeType: 'image/png' | 'image/jpeg'; buffer: Buffer }
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function image(format: 'png' | 'jpeg', bytes?: number): Image {
  if (run.mode === 'real')
    return bytes
      ? paddedChallengeImage(format, bytes, { requirePixels: true })
      : challengeImage(format, { requirePixels: true })
  const challenge = tileChallengeImage(format, { requirePixels: true })
  return bytes
    ? {
        code: challenge.code,
        bytes:
          format === 'png'
            ? pad.padPngToSize(challenge.bytes, bytes)
            : pad.padJpegToSize(challenge.bytes, bytes),
      }
    : challenge
}
function upload(input: Image, format: 'png' | 'jpeg'): Upload {
  return {
    name: `visual-${randomUUID()}.${format}`,
    mimeType: `image/${format}`,
    buffer: input.bytes,
  }
}

async function selectModel(
  page: Page,
  binding: ProviderBinding,
  unsupported = false
): Promise<void> {
  const selector = page.getByTestId('model-selector-up')
  await expect(selector).toHaveAttribute('data-host-ref', binding.hostRef)
  await expect(selector).toHaveAttribute('data-provider', binding.provider)
  await selector.getByRole('button', { name: /^Model — / }).click()
  const menu = selector.getByRole('menu', { name: 'Select model', exact: true })
  await expect(menu).toBeVisible()
  const label = unsupported ? binding.unsupportedModelLabel : binding.modelLabel
  await menu
    .getByRole('menuitemradio', { name: new RegExp(`^${escapeRegex(label)}(?:\\s*default)?$`) })
    .click()
  await expect(menu).toHaveCount(0)
  await expect(selector).toHaveAttribute(
    'data-model',
    unsupported ? binding.unsupportedModelId : binding.modelId
  )
}
async function startOwnedChat(page: Page, binding: ProviderBinding): Promise<void> {
  await test.step('open the exact owned Host from the visible Agents entry', async () => {
    // A snapshot chooses only the responsive navigation layout; assertions retry.
    const agents = page.getByTestId('nav-agents')
    if (!(await agents.isVisible())) {
      const settings = page.getByTestId('nav-settings-menu')
      await expect(settings).toBeVisible()
      if ((await settings.getAttribute('aria-expanded')) !== 'true') await settings.click()
      await expect(settings).toHaveAttribute('aria-expanded', 'true')
    }
    await expect(agents).toBeVisible()
    await agents.click()
    const actions = page.getByRole('button', {
      name: `More actions for ${binding.hostLabel}`,
      exact: true,
    })
    await expect(actions).toBeVisible({ timeout: 30_000 })
    await actions.click()
    await expect(actions).toHaveAttribute('aria-expanded', 'true')
    const menu = page
      .getByRole('menu')
      .filter({ has: page.getByRole('button', { name: 'New chat', exact: true }) })
    await expect(menu).toBeVisible()
    await menu.getByRole('button', { name: 'New chat', exact: true }).click()
    await expect(page.getByTestId('chat-input')).toBeVisible()
    await expect(page.locator('[data-chat-message-id]')).toHaveCount(0)
    await expect(page.getByTestId('model-selector-up')).toHaveAttribute(
      'data-host-ref',
      binding.hostRef,
      { timeout: 30_000 }
    )
    await selectModel(page, binding)
  })
}
async function attachAndPreview(page: Page, files: Upload[]): Promise<void> {
  await test.step('attach through the visible file chooser and inspect every preview', async () => {
    await page.getByRole('button', { name: 'Add context', exact: true }).click()
    const menuItem = page.getByRole('menuitem', { name: 'Upload Files', exact: true })
    await expect(menuItem).toBeVisible()
    const chooserReady = page.waitForEvent('filechooser')
    await menuItem.click()
    await (await chooserReady).setFiles(files)
    for (const file of files) {
      const chip = page.getByRole('button', { name: file.name, exact: true })
      await expect(chip).toBeVisible()
      await chip.click()
      const preview = page.getByRole('dialog', { name: file.name, exact: true })
      await expect(preview).toBeVisible()
      await expect(preview.getByRole('img', { name: file.name, exact: true })).toBeVisible()
      await preview.getByRole('button', { name: 'Close image preview', exact: true }).click()
      await expect(preview).toHaveCount(0)
    }
    // DOM order is read-only evidence of the user-visible composer input order.
    const orderedNames = await page.locator('.composer-attachment-chip strong').allTextContents()
    expect(orderedNames).toEqual(files.map(file => file.name))
  })
}

async function observeCompletedTask(
  page: Page,
  binding: ProviderBinding,
  expected: RegExp
): Promise<string> {
  await expect(page.locator('[data-chat-message-id]')).toHaveCount(2)
  const ids = await page
    .locator('[data-chat-message-id]')
    .evaluateAll(elements => elements.map(element => element.getAttribute('data-chat-message-id')))
  let taskId: string | null = null
  // Reads occur only AFTER visible submit/result. They never create a chat,
  // select a model, authenticate, send, approve, or alter product state.
  await expect
    .poll(
      async () => {
        const observed = await page.evaluate(
          async ({ hostRef, messageIds }) => {
            const chats = await window.clerum.chat.list(hostRef)
            for (const chat of chats.slice(0, 20)) {
              const messages = await window.clerum.chat.loadMessages(hostRef, chat.id)
              const pair = messageIds.map(id => messages.find(message => message.id === id))
              const candidate = pair[0]?.task_id
              if (!candidate || pair[1]?.task_id !== candidate) continue
              const result = await window.clerum.rpc.getTaskResult(hostRef, candidate)
              return {
                taskId: candidate,
                status: result.status,
                success: result.success,
                response: result.response,
              }
            }
            return null
          },
          { hostRef: binding.hostRef, messageIds: ids }
        )
        if (
          !observed ||
          observed.status !== 'completed' ||
          observed.success !== true ||
          !expected.test(observed.response ?? '')
        )
          return false
        taskId = observed.taskId
        return true
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  expect(taskId).toMatch(/\S+/)
  return taskId!
}
async function sendAndVerify(
  page: Page,
  binding: ProviderBinding,
  files: Upload[],
  codes: string[],
  testInfo: TestInfo,
  textOnly = false
): Promise<void> {
  await test.step('send visibly and correlate the settled result with one physical task and ordered wire digests', async () => {
    const receiptId = randomUUID()
    const prompt = textOnly
      ? `Reply with TEXT_RECEIPT:${receiptId} only. Receipt: ${receiptId}`
      : `Read the hexadecimal code in each attached image, in file order. Reply with codes only, one per line. Receipt: ${receiptId}`
    for (const code of codes) expect(prompt).not.toContain(code)
    const expectedOutput = textOnly ? `TEXT_RECEIPT:${receiptId}` : codes.join('\n')
    const expected = new RegExp(
      `^\\s*${escapeRegex(expectedOutput).replaceAll('\n', '\\s+')}\\s*$`,
      'i'
    )
    const composer = page.getByTestId('chat-input')
    await composer.fill(prompt)
    const send = page.getByTestId('send-button')
    await expect(send).toBeEnabled()
    await send.click()
    await expect(composer).toHaveValue('')
    const thread = page.getByTestId('message-list')
    await expect(thread.getByText(prompt, { exact: true })).toBeVisible()
    for (const file of files)
      await expect(
        thread.locator('.message-attachment-label').filter({ hasText: file.name })
      ).toBeVisible()
    const answer = page.getByTestId('agent-response')
    await expect(answer).toHaveCount(1, { timeout: 180_000 })
    await expect(answer).toHaveText(expected, { timeout: 180_000 })
    await expect(answer).not.toHaveClass(/chat-bubble--error/)
    await expect(thread.getByTestId('progress-stepper')).toHaveCount(0)
    await expect(thread.locator('.chat-message--in-flight')).toHaveCount(0)
    await expect(send).toHaveAttribute('aria-label', 'Send message')
    await expect(page.getByRole('status', { name: /^Running on fallback:/ })).toHaveCount(0)
    const selector = page.getByTestId('model-selector-up')
    await expect(selector).toHaveAttribute('data-host-ref', binding.hostRef)
    await expect(selector).toHaveAttribute('data-provider', binding.provider)
    await expect(selector).toHaveAttribute('data-model', binding.modelId)
    const taskId = await observeCompletedTask(page, binding, expected)
    const orderedDigests = files.map(file => sha256(file.buffer))
    if (run.mode === 'fixture') {
      await expect
        .poll(() => readVendorAttempts(run, binding).filter(row => row.receiptId === receiptId), {
          timeout: 20_000,
        })
        .toHaveLength(1)
      const attempt = readVendorAttempts(run, binding).find(row => row.receiptId === receiptId)!
      expect(attempt.model).toBe(binding.modelId)
      expect(attempt.imageSha256).toEqual(orderedDigests)
      expect(attempt.mimeTypes).toEqual(files.map(file => file.mimeType))
      expect(attempt.responseKind).toBe(textOnly ? 'text' : 'pixels')
      expect(attempt.outputSha256).toBe(sha256(expectedOutput))
      for (const other of run.bindings.filter(item => item.provider !== binding.provider)) {
        expect(
          readVendorAttempts(run, other).filter(row => row.receiptId === receiptId)
        ).toHaveLength(0)
      }
    }
    await testInfo.attach('subscription-image-business-evidence', {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          runId: run.runId,
          mode: run.mode,
          provider: binding.provider,
          hostRef: binding.hostRef,
          model: binding.modelId,
          receiptId,
          taskId,
          orderedImageSha256: orderedDigests,
        })
      ),
    })
  })
}

for (const binding of run.bindings) {
  test.describe(binding.provider, () => {
    for (const format of ['png', 'jpeg'] as const) {
      test(`${format} pixels reach the selected owned Host and model`, async ({
        appPage,
      }, testInfo) => {
        const input = image(format)
        const file = upload(input, format)
        await startOwnedChat(appPage, binding)
        await attachAndPreview(appPage, [file])
        await sendAndVerify(appPage, binding, [file], [input.code], testInfo)
      })
    }
    test('mixed PNG/JPEG preserve attachment and wire order', async ({ appPage }, testInfo) => {
      const images = [image('png'), image('jpeg')]
      const files = [upload(images[0]!, 'png'), upload(images[1]!, 'jpeg')]
      await startOwnedChat(appPage, binding)
      await attachAndPreview(appPage, files)
      await sendAndVerify(
        appPage,
        binding,
        files,
        images.map(input => input.code),
        testInfo
      )
    })
    test('near 16 MiB composer image carries real pixels', async ({ appPage }, testInfo) => {
      const input = image('png', 16 * MIB - 4096)
      const file = upload(input, 'png')
      await startOwnedChat(appPage, binding)
      await attachAndPreview(appPage, [file])
      await sendAndVerify(appPage, binding, [file], [input.code], testInfo)
    })
    test('twenty ordered images complete without a dropped or repeated code', async ({
      appPage,
    }, testInfo) => {
      const images = Array.from({ length: 20 }, (_, index) => image(index % 2 ? 'jpeg' : 'png'))
      const files = images.map((input, index) => upload(input, index % 2 ? 'jpeg' : 'png'))
      await startOwnedChat(appPage, binding)
      await attachAndPreview(appPage, files)
      await sendAndVerify(
        appPage,
        binding,
        files,
        images.map(input => input.code),
        testInfo
      )
    })
    test('over-budget refusal leaves no task or dispatch and permits a subsequent text turn', async ({
      appPage,
    }, testInfo) => {
      await startOwnedChat(appPage, binding)
      const baseline = run.mode === 'fixture' ? readVendorAttempts(run, binding).length : undefined
      const file = upload(image('png', 17 * MIB), 'png')
      await appPage.getByRole('button', { name: 'Add context', exact: true }).click()
      const chooserReady = appPage.waitForEvent('filechooser')
      await appPage.getByRole('menuitem', { name: 'Upload Files', exact: true }).click()
      await (await chooserReady).setFiles([file])
      await expect(appPage.getByRole('alert')).toContainText(
        `${file.name} is too large. Max size is 16 MiB.`
      )
      await expect(appPage.getByRole('button', { name: file.name, exact: true })).toHaveCount(0)
      await expect(appPage.locator('[data-chat-message-id]')).toHaveCount(0)
      if (run.mode === 'fixture') expect(readVendorAttempts(run, binding)).toHaveLength(baseline!)
      await sendAndVerify(appPage, binding, [], [], testInfo, true)
    })
    test('unsupported model blocks image send, then visible removal and primary selection recover', async ({
      appPage,
    }, testInfo) => {
      await startOwnedChat(appPage, binding)
      const input = image('png'),
        file = upload(input, 'png')
      await attachAndPreview(appPage, [file])
      const baseline = run.mode === 'fixture' ? readVendorAttempts(run, binding).length : undefined
      await selectModel(appPage, binding, true)
      await appPage.getByTestId('chat-input').fill('Read the attached image.')
      await expect(appPage.getByTestId('composer-image-capability-notice')).toBeVisible()
      await expect(appPage.getByTestId('send-button')).toBeDisabled()
      await expect(appPage.locator('[data-chat-message-id]')).toHaveCount(0)
      if (run.mode === 'fixture') expect(readVendorAttempts(run, binding)).toHaveLength(baseline!)
      await appPage.getByRole('button', { name: `Remove ${file.name}`, exact: true }).click()
      await expect(appPage.getByRole('button', { name: file.name, exact: true })).toHaveCount(0)
      await expect(appPage.getByTestId('composer-image-capability-notice')).toHaveCount(0)
      await selectModel(appPage, binding)
      await sendAndVerify(appPage, binding, [], [], testInfo, true)
    })
  })
}

if (run.mode === 'real') {
  test('G8 Grok reads pixels in a 9000 px PNG through the owned Host', async ({
    appPage,
  }, testInfo) => {
    const binding = run.bindings.find(item => item.provider === 'grok-subscription')!
    const input = challengeImageAt('png', 9000, 128, { requirePixels: true }),
      file = upload(input, 'png')
    await startOwnedChat(appPage, binding)
    await attachAndPreview(appPage, [file])
    await sendAndVerify(appPage, binding, [file], [input.code], testInfo)
  })
}
