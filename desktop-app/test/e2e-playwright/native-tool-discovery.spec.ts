/**
 * E2E_GUARDIAN_IPC_FLOW: Desktop sends through main-process IPC. Observe the
 * user message, the visible answer, generated files and inline approval, and
 * pair each turn with the owned Host's own log events for the same window.
 * Real upstream lane (Codex or Grok subscription), opt-in only. Run it once per
 * native presentation mode; the expected mode is checked on the running pod.
 * Login fixtures provision the test identity and sign in through the UI. Their
 * existing stored-session reset needs explicit opt-in before fixtures run.
 */
import type { Page, TestInfo } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.js'

const kubeContext = process.env.E2E_K8S_CONTEXT ?? ''
const hostRef = process.env.E2E_HOST_REF ?? ''
const hostLabel = process.env.E2E_NATIVE_DISCOVERY_HOST_LABEL ?? ''
const provider = process.env.E2E_NATIVE_DISCOVERY_PROVIDER ?? ''
const modelId = process.env.E2E_NATIVE_DISCOVERY_MODEL ?? ''
const expectedMode = process.env.E2E_EXPECTED_NATIVE_TOOL_PRESENTATION ?? ''
const ANSWER_TIMEOUT = 420_000

const BRIDGE_TOOLS = ['clerum__tool_search', 'clerum__tool_describe', 'clerum__tool_call']
// The natives larger than the default 2048-byte budget (mcp-host selectDeferredNatives).
const DEFERRED_GENERATORS = [
  'clerum__generate_chart',
  'clerum__generate_dashboard',
  'clerum__generate_pdf',
  'clerum__generate_pptx',
  'clerum__generate_xlsx',
]

type HostLogEvent = Record<string, unknown> & { msg?: string; component?: string }

test.beforeAll(() => {
  expect(process.env.E2E_NATIVE_DISCOVERY, 'Use the dedicated, explicitly opted-in lane').toBe('1')
  expect(
    process.env.E2E_NATIVE_DISCOVERY_ALLOW_SESSION_RESET,
    'The existing login fixture resets its stored session'
  ).toBe('1')
  expect(['codex-subscription', 'grok-subscription']).toContain(provider)
  expect(kubeContext, 'Name the owned profile context explicitly').not.toBe('')
  expect(hostRef, 'Name the owned Host explicitly').not.toBe('')
  expect(hostLabel, 'Name its visible chat-agent label explicitly').not.toBe('')
  expect(modelId, 'Name the actual model explicitly').not.toBe('')
  expect(['direct', 'auto']).toContain(expectedMode)
})

function kubectl(args: string[]): string {
  return execFileSync('kubectl', ['--context', kubeContext, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** The native mode the running Host process actually received (unset means `direct`). */
function effectiveNativeMode(): string {
  const value = kubectl([
    '-n',
    'mcp-host',
    'exec',
    `deploy/${hostRef}`,
    '--',
    'sh',
    '-c',
    'printf %s "${CLERUM_NATIVE_TOOL_PRESENTATION-}"',
  ]).trim()
  return value === '' ? 'direct' : value
}

function hostEventsSince(since: string): HostLogEvent[] {
  const output = kubectl(['-n', 'mcp-host', 'logs', `deploy/${hostRef}`, `--since-time=${since}`])
  return output
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as HostLogEvent)
}

function selectedToolNames(events: HostLogEvent[]): string[] {
  return events
    .filter(event => event.msg === 'Tool calls selected')
    .flatMap(event => (event.toolNames as string[] | undefined) ?? [])
}

function eventsOf(events: HostLogEvent[], component: string): HostLogEvent[] {
  return events.filter(event => event.component === component)
}

async function attachEvidence(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  })
}

/** Checks the presentation events of one turn against the expected native mode. */
function expectPresentation(events: HostLogEvent[], selected: string[]): void {
  const toolPresentation = eventsOf(events, 'tool-presentation')
  expect(toolPresentation.length, 'MCP presentation was decided for this turn').toBeGreaterThan(0)
  const native = eventsOf(events, 'native-tool-presentation')
  if (expectedMode === 'auto') {
    expect(native.length, 'native presentation was decided for this turn').toBeGreaterThan(0)
    for (const event of native) {
      expect(event.mode).toBe('auto')
      expect(event.hiddenNames).toEqual(DEFERRED_GENERATORS)
    }
  } else {
    // Witness: the turn's MCP presentation event above proves the window holds this turn.
    expect(native).toEqual([])
    expect(selected.filter(name => BRIDGE_TOOLS.includes(name))).toEqual([])
  }
}

async function startChat(page: Page): Promise<void> {
  await page.getByTestId('nav-new-chat').click()
  await expect(
    page.getByRole('heading', { name: 'Start a new conversation with:', exact: true })
  ).toBeVisible()
  await expect(page.getByTestId('agent-response')).toHaveCount(0)
  const agentSwitcher = page.getByRole('button', { name: 'Switch chat agent', exact: true })
  await expect(agentSwitcher).toBeVisible()
  await agentSwitcher.click()
  await page.getByRole('menuitem', { name: hostLabel, exact: true }).click()
  await expect(agentSwitcher).toContainText(hostLabel)
  await expect(page.getByTestId('chat-input')).toBeVisible()
  const selector = page.getByTestId('model-selector-up')
  await expect(selector).toHaveAttribute('data-host-ref', hostRef, { timeout: 30_000 })
  await expect(selector).toHaveAttribute('data-provider', provider)
  await selector.getByTestId('selected-chat-model').click()
  const models = selector.getByRole('menu', { name: 'Select model', exact: true })
  await expect(models).toBeVisible()
  await models.getByTestId(`model-option-${modelId}`).click()
  await expect(models).toHaveCount(0)
  await expect(selector).toHaveAttribute('data-model', modelId)
  await expect(page.getByRole('status', { name: /^Running on fallback:/ })).toHaveCount(0)
}

async function send(page: Page, prompt: string): Promise<void> {
  const composer = page.getByTestId('chat-input')
  await composer.fill(prompt)
  const sendButton = page.getByTestId('send-button')
  await expect(sendButton).toBeEnabled()
  await sendButton.click()
  await expect(composer).toHaveValue('')
  await expect(page.getByTestId('message-list').getByText(prompt, { exact: true })).toBeVisible()
}

async function expectSettledAnswer(page: Page): Promise<void> {
  const thread = page.getByTestId('message-list')
  const answer = page.getByTestId('agent-response')
  await expect(answer).toHaveCount(1, { timeout: ANSWER_TIMEOUT })
  await expect(thread.locator('.chat-message--in-flight')).toHaveCount(0, {
    timeout: ANSWER_TIMEOUT,
  })
  // A settled turn keeps its collapsed stepper ("More details · N tool"), never a pending approval.
  await expect(thread.getByTestId('approval-approve-btn')).toHaveCount(0)
  await expect(answer).not.toHaveClass(/chat-bubble--error/)
  await expect(page.getByRole('status', { name: /^Running on fallback:/ })).toHaveCount(0)
  await expect(page.getByTestId('send-button')).toHaveAttribute('aria-label', 'Send message')
}

async function expectGeneratedFile(page: Page, extension: string): Promise<string> {
  const files = page.getByTestId('agent-response').getByLabel('Message attachments')
  await expect(files).toBeVisible({ timeout: ANSWER_TIMEOUT })
  const item = files.locator('.message-attachment-chip--response-file').filter({
    has: page.locator('.message-attachment-label', { hasText: new RegExp(`\\.${extension}$`) }),
  })
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('Generated file')
  const name = (await item.locator('.message-attachment-label').textContent())?.trim() ?? ''
  expect(name).toMatch(new RegExp(`\\.${extension}$`))
  await expect(item.getByRole('button', { name: 'Download', exact: true })).toBeEnabled()
  return name
}

test('the running Host has the expected native presentation mode', () => {
  expect(effectiveNativeMode()).toBe(expectedMode)
})

test('a large generator is reached the way the native mode prescribes', async ({
  appPage: page,
}, testInfo) => {
  expect(effectiveNativeMode()).toBe(expectedMode)
  const runId = randomUUID().slice(0, 8)
  await startChat(page)
  const since = new Date().toISOString()
  await send(
    page,
    `Create a 3-slide PowerPoint (pptx) presentation about the benefits of exercise, file name r2-${runId}.pptx. Use the pptx generation tool and attach the file.`
  )
  await expectSettledAnswer(page)
  const fileName = await expectGeneratedFile(page, 'pptx')

  const events = hostEventsSince(since)
  const selected = selectedToolNames(events)
  await attachEvidence(testInfo, 'pptx-turn', { fileName, selected, events })
  expectPresentation(events, selected)
  if (expectedMode === 'auto') {
    // The generator is hidden, so the model reaches it only through the bridge.
    expect(selected).toContain('clerum__tool_call')
    expect(selected).not.toContain('clerum__generate_pptx')
  } else {
    expect(selected).toContain('clerum__generate_pptx')
  }
})

test('a small generator stays directly listed in both modes', async ({
  appPage: page,
}, testInfo) => {
  expect(effectiveNativeMode()).toBe(expectedMode)
  const runId = randomUUID().slice(0, 8)
  await startChat(page)
  const since = new Date().toISOString()
  await send(
    page,
    `Create a short Word (docx) document with one paragraph about water, file name r2-${runId}.docx. Use the docx generation tool directly and attach the file.`
  )
  await expectSettledAnswer(page)
  const fileName = await expectGeneratedFile(page, 'docx')

  const events = hostEventsSince(since)
  const selected = selectedToolNames(events)
  await attachEvidence(testInfo, 'docx-turn', { fileName, selected, events })
  expectPresentation(events, selected)
  expect(selected).toContain('clerum__generate_docx')
  expect(selected).not.toContain('clerum__tool_call')
})

test('an approval-requiring native suspends on its real name and runs once approved', async ({
  appPage: page,
}, testInfo) => {
  expect(effectiveNativeMode()).toBe(expectedMode)
  const runId = randomUUID().slice(0, 8)
  const marker = `r2-${runId}`
  await startChat(page)
  const since = new Date().toISOString()
  await send(page, `Run the shell command \`echo ${marker}\` and reply with its exact output.`)

  const stepper = page.getByTestId('progress-stepper').filter({
    has: page.getByTestId('approval-approve-btn'),
  })
  await expect(stepper).toBeVisible({ timeout: ANSWER_TIMEOUT })
  const label = stepper.locator('.stepper-suspended-label')
  await expect(label).toContainText('requires approval')
  await expect(label).not.toContainText(/tool[_ ]call/i)
  const suspended = hostEventsSince(since).filter(event => event.msg === 'Tool requires approval')
  expect(suspended.map(event => event.toolName)).toEqual(['shell_exec'])

  await stepper.getByTestId('approval-approve-btn').click()
  await expect(page.getByText(`Approved request for ${hostRef}.`)).toBeVisible()
  await expectSettledAnswer(page)
  await expect(page.getByTestId('agent-response')).toContainText(marker)

  const events = hostEventsSince(since)
  const selected = selectedToolNames(events)
  await attachEvidence(testInfo, 'approval-turn', { selected, events })
  expectPresentation(events, selected)
  // One suspension: the approved call ran without asking again.
  expect(events.filter(event => event.msg === 'Tool requires approval')).toHaveLength(1)
})
