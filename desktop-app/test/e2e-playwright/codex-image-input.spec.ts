/**
 * E2E_GUARDIAN_IPC_FLOW: Desktop sends through main-process IPC. Observe the
 * real chooser, preview, user message, settled composer and visual-only answer.
 * Real upstream lane, never evidence when only statically checked.
 * Login fixtures provision the test identity and sign in through the UI. Their
 * existing stored-session reset needs explicit opt-in before fixtures run.
 */
import { randomUUID } from 'node:crypto'
import { challengeImage, paddedChallengeImage } from './codexImageChallenge.js'
import { expect, test } from './fixtures.js'

const hostRef = process.env.E2E_HOST_REF ?? ''
const hostLabel = process.env.E2E_CODEX_HOST_LABEL ?? ''
const modelId = process.env.E2E_CODEX_IMAGE_MODEL ?? ''
const modelLabel = process.env.E2E_CODEX_IMAGE_MODEL_LABEL ?? ''
const mode = process.env.E2E_CODEX_IMAGE_MODE ?? ''
const MIB = 1024 * 1024
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type UploadFile = {
  name: string
  mimeType: 'image/png' | 'image/jpeg'
  buffer: Buffer
}

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

async function uploadThroughChooser(
  page: import('@playwright/test').Page,
  files: UploadFile[]
): Promise<void> {
  await page.getByRole('button', { name: 'Add context', exact: true }).click()
  const upload = page.getByRole('menuitem', { name: 'Upload Files', exact: true })
  await expect(upload).toBeVisible()
  const chooserReady = page.waitForEvent('filechooser')
  await upload.click()
  const chooser = await chooserReady
  await chooser.setFiles(files)
}

async function assertPreview(
  page: import('@playwright/test').Page,
  filename: string
): Promise<void> {
  const chip = page.getByRole('button', { name: filename, exact: true })
  await expect(chip).toBeVisible()
  await chip.click()
  const preview = page.getByRole('dialog', { name: filename, exact: true })
  await expect(preview).toBeVisible()
  await expect(preview.getByRole('img', { name: filename, exact: true })).toBeVisible()
  await preview.getByRole('button', { name: 'Close image preview', exact: true }).click()
  await expect(preview).toHaveCount(0)
}

async function sendVisualTurn(
  page: import('@playwright/test').Page,
  input: { prompt: string; filenames: string[]; codes: string[] }
): Promise<void> {
  const composer = page.getByTestId('chat-input')
  await composer.fill(input.prompt)
  const send = page.getByTestId('send-button')
  await expect(send).toBeEnabled()
  await send.click()
  await expect(composer).toHaveValue('')
  const thread = page.getByTestId('message-list')
  await expect(thread.getByText(input.prompt, { exact: true })).toBeVisible()
  for (const filename of input.filenames) {
    await expect(
      thread.locator('.message-attachment-label').filter({ hasText: filename })
    ).toBeVisible()
  }
  const answer = page.getByTestId('agent-response')
  if (mode === 'enabled') {
    for (const code of input.codes) {
      await expect(answer).toContainText(new RegExp(`\\b${code}\\b`, 'i'), { timeout: 180_000 })
    }
    await expect(answer).not.toHaveClass(/chat-bubble--error/)
    await expect(thread.getByTestId('progress-stepper')).toHaveCount(0)
  } else {
    await expect(answer.locator('.error-bubble-message')).toContainText(
      'Image input is not enabled for this Codex model',
      { timeout: 180_000 }
    )
    await expect(answer).toHaveClass(/chat-bubble--error/)
    for (const code of input.codes) {
      await expect(answer).not.toContainText(new RegExp(`\\b${code}\\b`, 'i'))
    }
  }
  await expect(answer).toHaveCount(1)
  await expect(send).toHaveAttribute('aria-label', 'Send message')
  await expect(thread.locator('.chat-message--in-flight')).toHaveCount(0)
  await expect(page.getByRole('status', { name: /^Running on fallback:/ })).toHaveCount(0)
  const selector = page.getByTestId('model-selector-up')
  await expect(selector).toHaveAttribute('data-host-ref', hostRef)
  await expect(selector).toHaveAttribute('data-provider', 'codex-subscription')
  await expect(selector).toHaveAttribute('data-model', modelId)
}

function visualPrompt(count: number): string {
  if (count === 1) {
    return 'Read the hexadecimal code in the attached image. Reply with that code only.'
  }
  return 'Read the hexadecimal code in each attached image, in the order the files were attached. Reply with those codes only, one per line.'
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
    await test.step('select the owned Codex Host and model through UI', async () => {
      await startOwnedChat(appPage)
    })
    await test.step('upload through the chooser and verify the rendered preview', async () => {
      await uploadThroughChooser(appPage, [
        { name: filename, mimeType: `image/${format}`, buffer: image.bytes },
      ])
      await assertPreview(appPage, filename)
    })
    await test.step('submit and assert the correlated terminal result', async () => {
      await sendVisualTurn(appPage, {
        prompt: visualPrompt(1),
        filenames: [filename],
        codes: [image.code],
      })
    })
  })
}

test('5 MiB JPEG follows the same capability lane as a small image', async ({ appPage }) => {
  test.setTimeout(360_000)
  const image = paddedChallengeImage('jpeg', 5 * MIB)
  const filename = `visual-${randomUUID()}.jpeg`
  await startOwnedChat(appPage)
  await uploadThroughChooser(appPage, [
    { name: filename, mimeType: 'image/jpeg', buffer: image.bytes },
  ])
  await assertPreview(appPage, filename)
  await sendVisualTurn(appPage, {
    prompt: visualPrompt(1),
    filenames: [filename],
    codes: [image.code],
  })
})

test('10 MiB PNG + 5 MiB JPEG follow the 15 MiB combined budget', async ({ appPage }) => {
  test.setTimeout(360_000)
  const ten = paddedChallengeImage('png', 10 * MIB)
  const five = paddedChallengeImage('jpeg', 5 * MIB)
  const tenName = `visual-${randomUUID()}.png`
  const fiveName = `visual-${randomUUID()}.jpeg`
  await startOwnedChat(appPage)
  await uploadThroughChooser(appPage, [
    { name: tenName, mimeType: 'image/png', buffer: ten.bytes },
    { name: fiveName, mimeType: 'image/jpeg', buffer: five.bytes },
  ])
  await assertPreview(appPage, tenName)
  await assertPreview(appPage, fiveName)
  await sendVisualTurn(appPage, {
    prompt: visualPrompt(2),
    filenames: [tenName, fiveName],
    codes: [ten.code, five.code],
  })
})

test('three 5 MiB images follow the combined budget', async ({ appPage }) => {
  test.setTimeout(360_000)
  const first = paddedChallengeImage('png', 5 * MIB)
  const second = paddedChallengeImage('jpeg', 5 * MIB)
  const third = paddedChallengeImage('png', 5 * MIB)
  const files: UploadFile[] = [
    { name: `visual-${randomUUID()}.png`, mimeType: 'image/png', buffer: first.bytes },
    { name: `visual-${randomUUID()}.jpeg`, mimeType: 'image/jpeg', buffer: second.bytes },
    { name: `visual-${randomUUID()}.png`, mimeType: 'image/png', buffer: third.bytes },
  ]
  await startOwnedChat(appPage)
  await uploadThroughChooser(appPage, files)
  for (const file of files) await assertPreview(appPage, file.name)
  await sendVisualTurn(appPage, {
    prompt: visualPrompt(3),
    filenames: files.map(file => file.name),
    codes: [first.code, second.code, third.code],
  })
})

test('refuses a single image over the 10 MiB limit before send', async ({ appPage }) => {
  const image = paddedChallengeImage('png', 11 * MIB)
  const filename = `over-${randomUUID()}.png`
  await startOwnedChat(appPage)
  await uploadThroughChooser(appPage, [
    { name: filename, mimeType: 'image/png', buffer: image.bytes },
  ])
  await expect(appPage.getByRole('alert')).toContainText(
    `${filename} is too large. Max size is 10 MiB.`
  )
  await expect(appPage.getByRole('button', { name: filename, exact: true })).toHaveCount(0)
  await expect(appPage.getByTestId('agent-response')).toHaveCount(0)
})

test('refuses the file that would pass the 15 MiB total and keeps the one that fits', async ({
  appPage,
}) => {
  const fits = paddedChallengeImage('png', 10 * MIB)
  const over = paddedChallengeImage('jpeg', 6 * MIB)
  const fitsName = `fits-${randomUUID()}.png`
  const overName = `over-total-${randomUUID()}.jpeg`
  await startOwnedChat(appPage)
  await uploadThroughChooser(appPage, [
    { name: fitsName, mimeType: 'image/png', buffer: fits.bytes },
    { name: overName, mimeType: 'image/jpeg', buffer: over.bytes },
  ])
  await expect(appPage.getByRole('alert')).toContainText(
    `${overName} was not added. Attachments can total at most 15 MiB per message.`
  )
  await expect(appPage.getByRole('button', { name: fitsName, exact: true })).toBeVisible()
  await expect(appPage.getByRole('button', { name: overName, exact: true })).toHaveCount(0)
  await expect(appPage.getByTestId('agent-response')).toHaveCount(0)
})

test('explains a fourth image instead of dropping it silently', async ({ appPage }) => {
  const files = [0, 1, 2].map(index => {
    const image = challengeImage(index === 1 ? 'jpeg' : 'png')
    const format = index === 1 ? 'jpeg' : 'png'
    return {
      name: `visual-${randomUUID()}.${format}`,
      mimeType: `image/${format}` as const,
      buffer: image.bytes,
    }
  })
  const extra = challengeImage('png')
  const extraName = `visual-${randomUUID()}.png`
  await startOwnedChat(appPage)
  await uploadThroughChooser(appPage, files)
  for (const file of files) {
    await expect(appPage.getByRole('button', { name: file.name, exact: true })).toBeVisible()
  }
  await uploadThroughChooser(appPage, [
    { name: extraName, mimeType: 'image/png', buffer: extra.bytes },
  ])
  await expect(appPage.getByRole('alert')).toContainText(
    'You can attach up to 3 images per message.'
  )
  await expect(appPage.getByRole('button', { name: extraName, exact: true })).toHaveCount(0)
  await expect(appPage.getByTestId('agent-response')).toHaveCount(0)
})

test('refuses an unsupported image type before send', async ({ appPage }) => {
  const filename = `visual-${randomUUID()}.gif`
  await startOwnedChat(appPage)
  await appPage.getByRole('button', { name: 'Add context', exact: true }).click()
  const upload = appPage.getByRole('menuitem', { name: 'Upload Files', exact: true })
  await expect(upload).toBeVisible()
  const chooserReady = appPage.waitForEvent('filechooser')
  await upload.click()
  const chooser = await chooserReady
  await chooser.setFiles({
    name: filename,
    mimeType: 'image/gif',
    buffer: Buffer.from('GIF89a'),
  })
  await expect(appPage.getByRole('alert')).toContainText(
    `${filename} is not supported. Use PNG or JPEG.`
  )
  await expect(appPage.getByRole('button', { name: filename, exact: true })).toHaveCount(0)
  await expect(appPage.getByTestId('agent-response')).toHaveCount(0)
})
