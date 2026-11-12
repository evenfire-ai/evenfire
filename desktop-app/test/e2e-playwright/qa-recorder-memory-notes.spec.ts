import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import {
  FIXTURE_RESPONSE_KIND,
  IMAGE_CAPABILITY_FIXTURE_MODELS,
  type ImageCapabilitiesFixtureEnv,
  appendedAttempts,
  readImageCapabilityEvidence,
  requireImageCapabilitiesFixtureEnv,
  resolveImageCapabilitiesMode,
} from './helpers/imageCapabilityEvidence'
import {
  findUserFilesWithMarker,
  hostPathExists,
  latestUserMemoryWrite,
  readHostFile,
  userFilePath,
  userKeyOfPath,
} from './helpers/memoryNotesPodEvidence'
import {
  EXTERNAL_REST_API_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
} from './qa-recorder-helpers'

/*
 * E2E_GUARDIAN_IPC_FLOW: Desktop chat, the model catalog, the agent list and
 * the composer travel over Electron IPC, so the renderer has no HTTP request to
 * await for any transition in this journey. The visible oracles are the sent
 * message and the fixture's answer; the business oracles are the files the
 * Host's memory tools wrote in the pod, the `memory_writes` row of `state.db`,
 * and the provider-boundary ledger of the derived fixture.
 *
 * "Remember X" and "save this in your memory as a note" are saved by the real
 * Host memory tools; a new conversation then recalls both through
 * `memory_search` and `memory_read`. Only the external provider peer is
 * simulated: the fixed `MEMORY_NOTES` directive stands in for the model's
 * reading of the request and carries only the journey, the run token and the
 * note name. The nonces the recall must return are typed only in the first two
 * conversations, so the answer can carry them only through the Host's tools.
 */

const MODE = resolveImageCapabilitiesMode()

/** The fixture's answers, without underscores so Markdown keeps them whole. */
const MEMORY_SAVED_ANSWER = 'MEMORY-ANSWER saved'
const MEMORY_RECALL_ANSWER_PREFIX = 'MEMORY-ANSWER recall'

const NOTE_NAME = 'release-checklist'
const NOTE_PATH = `memory/${NOTE_NAME}.md`

function composer(page: Page) {
  return page.getByRole('textbox', { name: 'Agent message composer' })
}

function sendButton(page: Page) {
  return page.getByTestId('send-button')
}

function modelChip(page: Page) {
  return page.getByTestId('selected-chat-model')
}

/** Start a blank chat and prove the thread is empty before anything is sent. */
async function startBlankChat(page: Page) {
  await page.getByTestId('nav-new-chat').click()
  await expect(composer(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-chat-message-id]')).toHaveCount(0, { timeout: 20_000 })
}

/** Land on the configured agent through the visible Switch chat agent menu. */
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

/** Type one message in a fresh chat on the fixture model and send it. */
async function sendInBlankChat(page: Page, text: string) {
  await startBlankChat(page)
  await selectSupportedModel(page, IMAGE_CAPABILITY_FIXTURE_MODELS.supported)
  await composer(page).fill(text)
  await sendButton(page).click()
}

function sha256Utf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The single user folder that holds `marker`, found by content, never computed. */
function onlyUserFileWith(profile: string, marker: string): { path: string; userKey: string } {
  const files = findUserFilesWithMarker(profile, marker)
  expect(files, `exactly one file under users/ holds ${marker}`).toHaveLength(1)
  const [path] = files as [string]
  return { path, userKey: userKeyOfPath(path) }
}

test.describe('memory-notes fixture', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(
    MODE !== 'fixture',
    'Set IMAGE_CAPABILITIES_RUN_ID=image-capabilities-<12 hex> (the runner does) to run the ' +
      'derived-provider fixture journey.'
  )

  let app: ElectronApplication | undefined
  let page!: Page
  let env!: ImageCapabilitiesFixtureEnv
  /** Run token every saved text carries; the recall searches by it. */
  let run!: string
  /** Typed only in journey 1 (private MEMORY.md). */
  const deployNonce = `memnonce${randomBytes(6).toString('hex')}`
  /** Typed only in journey 2 (the named note). */
  const checklistNonce = `memnonce${randomBytes(6).toString('hex')}`
  /** The user folder journey 1 found; journeys 2 and 3 must use the same one. */
  let userKey: string | undefined

  test.beforeAll(async ({}, testInfo) => {
    env = requireImageCapabilitiesFixtureEnv()
    await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', env.externalRestApiBaseUrl)
    await assertAllowedTarget('RPC_PROXY_BASE_URL', env.rpcProxyBaseUrl)
    // One run token per lane run, so a reused profile's earlier notes never
    // answer this run's search.
    run = env.runId.slice(-12)

    const baseline = readImageCapabilityEvidence(env)
    expect(baseline.runId).toBe(env.runId)
    expect(baseline.profile).toBe(env.profile)

    // One launch and one sign-in for the whole lane: the password admission
    // limit is five attempts per identity in fifteen minutes.
    const launched = await launchDesktopApp(
      testInfo,
      `memory-notes-minikube${new URL(EXTERNAL_REST_API_BASE_URL).port}`
    )
    app = launched.app
    page = launched.page
    await signIn(page)
    await openConfiguredAgentChat(page, env.hostRef)
  })

  test.afterAll(async () => {
    await finalizeRecording(app, page)
  })

  test('memory-notes fixture: remembers a fact in private memory', async () => {
    const text = `Remember that my deploy window is Tuesday 14:00. memnote${run} ${deployNonce}`
    const before = readImageCapabilityEvidence(env)

    await test.step('ask the agent to remember the fact', async () => {
      await sendInBlankChat(page, `${text} MEMORY_NOTES remember run=${run}`)
      await expect(page.getByText(MEMORY_SAVED_ANSWER)).toBeVisible({ timeout: 60_000 })
    })
    await test.step('ledger: one private write and the Host result', async () => {
      const appended = appendedAttempts(before, readImageCapabilityEvidence(env))
      expect(appended.map(row => row.responseKind)).toEqual([
        FIXTURE_RESPONSE_KIND.memoryWriteRequested,
        FIXTURE_RESPONSE_KIND.memoryWriteAnswer,
      ])
      expect(appended.every(row => row.memoryJourney === 'remember')).toBe(true)
      expect(appended[1]?.memoryToolResult).toBe('Written to private memory (append)')
    })
    await test.step('business signal: the private MEMORY.md of one user holds it', async () => {
      const found = onlyUserFileWith(env.profile, deployNonce)
      expect(found.path).toBe(userFilePath(found.userKey, 'MEMORY.md'))
      expect(readHostFile(env.profile, found.path)).toContain(text)
      userKey = found.userKey
    })
  })

  test('memory-notes fixture: saves a named note in the memory folder', async () => {
    expect(userKey, 'journey 1 found the user folder').toBeDefined()
    const key = userKey!
    const text = `Save this in your memory as a note called ${NOTE_NAME}: memnote${run} ${checklistNonce} ship the build after the smoke tests`
    const before = readImageCapabilityEvidence(env)

    await test.step('ask the agent to save the note by name, without an extension', async () => {
      await sendInBlankChat(page, `${text} MEMORY_NOTES note run=${run} name=${NOTE_NAME}`)
      await expect(page.getByText(MEMORY_SAVED_ANSWER)).toBeVisible({ timeout: 60_000 })
    })
    await test.step('ledger: the Host wrote memory/<name>.md', async () => {
      const appended = appendedAttempts(before, readImageCapabilityEvidence(env))
      expect(appended.map(row => row.responseKind)).toEqual([
        FIXTURE_RESPONSE_KIND.memoryWriteRequested,
        FIXTURE_RESPONSE_KIND.memoryWriteAnswer,
      ])
      expect(appended[1]?.memoryToolResult).toBe(`Written to ${NOTE_PATH} (append)`)
    })
    await test.step('business signal: the note is in memory/ and not at the top level', async () => {
      const found = onlyUserFileWith(env.profile, checklistNonce)
      expect(found.userKey).toBe(key)
      expect(found.path).toBe(userFilePath(key, NOTE_PATH))
      const bytes = readHostFile(env.profile, found.path)
      expect(bytes).toContain(text)
      // Witness: the memory/ file was just read, so the folder is the right one.
      expect(hostPathExists(env.profile, userFilePath(key, `${NOTE_NAME}.md`))).toBe(false)

      const row = latestUserMemoryWrite(env.profile, key, NOTE_PATH)
      expect(row).toMatchObject({ user_key: key, scope: 'user', relative_path: NOTE_PATH })
      expect(row?.mode).toBe('append')
      expect(row?.content_sha256).toBe(sha256Utf8(bytes))
    })
  })

  test('memory-notes fixture: a new conversation recalls both', async () => {
    expect(userKey, 'journeys 1 and 2 found the user folder').toBeDefined()
    const before = readImageCapabilityEvidence(env)
    const question = 'What is on my release checklist, and when is my deploy window?'
    // The recall prompt carries neither nonce: they can only come back through the tools.
    expect(question).not.toContain(deployNonce)
    expect(question).not.toContain(checklistNonce)

    await test.step('ask in a new conversation', async () => {
      await sendInBlankChat(page, `${question} MEMORY_NOTES recall run=${run} name=${NOTE_NAME}`)
      const answer = page.getByText(MEMORY_RECALL_ANSWER_PREFIX)
      await expect(answer).toBeVisible({ timeout: 60_000 })
      await expect(answer).toContainText(deployNonce)
      await expect(answer).toContainText(checklistNonce)
    })
    await test.step('ledger: search, read, answer, in one fresh conversation', async () => {
      const appended = appendedAttempts(before, readImageCapabilityEvidence(env))
      expect(appended.map(row => row.responseKind)).toEqual([
        FIXTURE_RESPONSE_KIND.memorySearchRequested,
        FIXTURE_RESPONSE_KIND.memoryReadRequested,
        FIXTURE_RESPONSE_KIND.memoryRecallAnswer,
      ])
      // The provider's request held one user message, the new one: the row
      // exists because the fixture parsed the directive of that message.
      expect(appended.map(row => row.userMessages)).toEqual([1, 1, 1])
      expect(appended[1]?.searchHitNotePath).toBe(true)
      expect(appended[2]?.readFoundNote).toBe(true)
      expect(appended.filter(row => row.responseKind === FIXTURE_RESPONSE_KIND.rejected)).toEqual(
        []
      )
    })
  })
})
