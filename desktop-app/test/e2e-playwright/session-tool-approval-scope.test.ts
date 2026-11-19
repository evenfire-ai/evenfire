/**
 * E2E_GUARDIAN_IPC_FLOW: Desktop sends through main-process IPC. The end user
 * signs in through the visible login fixture, opens the chatllm Agent Chat and
 * decides every tool approval card in the owned Desktop window. Each journey
 * step is checked three ways: approval cards that appeared in the UI (a DOM
 * ledger), the owned Host's own `Tool requires approval` log events for the
 * same window, and the completed tool steps in the response stepper.
 *
 * Contract under test (mcp-host per-task approval scope for session-scoped
 * native tools shell_exec, http_request and cron_manage):
 *   T1 a plain approval of shell_exec covers later shell_exec calls in the same
 *      task: one card, two completed shell steps.
 *   T2 the next user message is a new task: shell_exec asks again.
 *   T3 a shell_exec approval does not cover http_request: it gets its own card.
 *   T4 a shell_exec approval does not cover cron_manage (action "list"): it gets
 *      its own card. cron_manage create/enable on stateless Hosts always asks,
 *      which is a separate fix and out of scope here.
 *   T5 (opt-in) an MCP tool approval does not cover a later shell_exec.
 * "Always approve" is covered by mcp-host unit tests, not by this lane.
 *
 * Approval modes (session approval mode, capped by Host.spec.approval.modeCeiling):
 *   CMD in auto, the shell card offers "Allow this command"; it runs that
 *       command, and the identical command in the next task runs with no card
 *       (the per-chat grant is stored).
 *   ALL in allow_all, shell_exec runs with no card and cron_manage create still
 *       shows a card.
 * The canonical minikube Host sets no modeCeiling, so every chat is manual.
 * Each mode row raises the ceiling on the chatllm Host for itself, waits until
 * mcp-host reports it in a session read, and restores it afterwards. The patch runs under the T2
 * mutation lease and tests the live `spec.approval`, so it never overwrites a
 * concurrent change. No classifier-APPROVE row: the branch profile allowlists
 * only gpt-5.4 family models, on which the shell classifier never runs.
 *
 * Dedicated, explicitly opted-in lane against a real chatllm Host and its
 * configured LLM; nothing is mocked. Run from desktop-app/ with the branch
 * profile's port-forwards held (Control API, Profiles, Desktop gateway):
 *
 *   npm run build
 *   E2E_SESSION_TOOL_APPROVAL=1 E2E_K8S_CONTEXT=<branch-profile> \
 *     MINIKUBE_PROFILE=<branch-profile> \
 *     npx playwright test --config test/e2e-playwright/playwright.session-tool-approval.config.ts
 *
 * Add E2E_SESSION_TOOL_APPROVAL_MCP=1 to also run T5; it needs the MongoDB MCP
 * server attached to the chatllm Host (same prerequisite as chat.test.ts test 5).
 */
import type { Locator, Page, TestInfo } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { expect, test } from './fixtures.js'
import {
  CHATLLM_HOST_REF,
  enterChatllmChat,
  expandResponseToolDetails,
  humanClick,
  kubectl,
  sendChatPrompt,
  startFreshThread,
} from './workflowAgentChatTools.js'

// The Host default gpt-5.4-mini skipped requested tool calls (it answered a second shell
// request from earlier outputs and ran the shell but never the requested http_request), so
// no approval card could appear. The composer menu lists only the Host provider's allowlisted
// models (openai on the branch profile), so the lane selects the larger gpt-5.4 from it.
const CHAT_MODEL = 'gpt-5.4'
const RUN_ID = randomUUID().replace(/-/g, '').slice(0, 8)
const TURN_TIMEOUT = 300_000
const CARD_TIMEOUT = 180_000
const RUN_MCP_STEP = process.env.E2E_SESSION_TOOL_APPROVAL_MCP === '1'

type ApprovalMode = 'manual' | 'auto' | 'allow_all'
type ApprovalCard = { label: string; preview: string }
type Decision = 'approve' | 'deny' | 'command'
type ExpectedCard = { label: RegExp; preview?: string; decision: Decision }
type HostLogEvent = Record<string, unknown> & { msg?: string }
type LedgerWindow = Window & { __staCards?: ApprovalCard[]; __staObserver?: MutationObserver }

function markerFor(testInfo: TestInfo, step: string): string {
  const testId = testInfo.testId.replace(/[^A-Za-z0-9]/g, '').slice(0, 16)
  return `STA_${RUN_ID}_${testId}_${step}`
}

// `date` makes the output unpredictable: with a bare `printf <marker>` the model answered the
// second task from the first task's outputs without calling shell_exec, so no approval card
// could appear. Reading /proc/sys/kernel/random/uuid instead made the model refuse the tool.
function shellCommand(marker: string): string {
  return `echo ${marker}; date`
}

// Same visible path as qa-recorder-image-capabilities.spec.ts: model chip -> menu -> row.
async function selectChatModel(page: Page, model: string): Promise<void> {
  const chip = page.getByTestId('selected-chat-model')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await chip.click()
  await expect(page.getByRole('menu', { name: 'Select model' })).toBeVisible({ timeout: 20_000 })
  const row = page.getByTestId(`model-option-${model}`)
  await expect(row, `${model} must be offered by the chatllm catalog`).toHaveCount(1)
  await row.click()
  await expect(chip).toHaveAttribute('data-model-id', model)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hostEventsSince(since: string): HostLogEvent[] {
  const output = kubectl([
    '-n',
    'mcp-host',
    'logs',
    `deploy/${CHATLLM_HOST_REF}`,
    `--since-time=${since}`,
  ])
  return output
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as HostLogEvent)
}

function approvalToolNamesSince(since: string): string[] {
  return hostEventsSince(since)
    .filter(event => event.msg === 'Tool requires approval')
    .map(event => String(event.toolName))
}

function selectedToolNamesSince(since: string): string[] {
  return hostEventsSince(since)
    .filter(event => event.msg === 'Tool calls selected')
    .flatMap(event => (event.toolNames as string[] | undefined) ?? [])
}

/**
 * Records every approval card that is ever rendered, keyed by DOM identity, so a
 * card that appears and is decided between two polls is still counted.
 */
async function installCardLedger(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as LedgerWindow
    if (w.__staObserver) return
    const cards: ApprovalCard[] = []
    const seen = new WeakSet<Element>()
    const record = (): void => {
      for (const button of Array.from(
        document.querySelectorAll('[data-testid="approval-approve-btn"]')
      )) {
        if (seen.has(button)) continue
        seen.add(button)
        const stepper = button.closest('[data-testid="progress-stepper"]')
        cards.push({
          label: stepper?.querySelector('.stepper-suspended-label')?.textContent?.trim() ?? '',
          preview:
            stepper
              ?.querySelector('[data-testid="approval-input-preview"] pre')
              ?.textContent?.trim() ?? '',
        })
      }
    }
    w.__staCards = cards
    w.__staObserver = new MutationObserver(record)
    w.__staObserver.observe(document.body, { childList: true, subtree: true })
    record()
  })
}

async function readCardLedger(page: Page): Promise<ApprovalCard[]> {
  const cards = await page.evaluate(() => {
    const w = window as LedgerWindow
    return w.__staObserver && w.__staCards ? [...w.__staCards] : null
  })
  if (!cards) throw new Error('The approval card ledger is not installed in the Desktop window')
  return cards
}

function matchesCard(card: ApprovalCard, expected: ExpectedCard): boolean {
  return (
    expected.label.test(card.label) &&
    (expected.preview === undefined || card.preview.includes(expected.preview))
  )
}

/** Locates the suspended stepper that renders this specific card. */
function suspendedCard(page: Page, expected: ExpectedCard): Locator {
  let stepper = page
    .locator('[data-testid="progress-stepper"].status-suspended')
    .filter({ has: page.locator('.stepper-suspended-label', { hasText: expected.label }) })
  if (expected.preview !== undefined) {
    stepper = stepper.filter({
      has: page.getByTestId('approval-input-preview').filter({ hasText: expected.preview }),
    })
  }
  return stepper
}

type TurnResult = {
  response: Locator
  cards: ApprovalCard[]
  approvalLog: string[]
  selectedTools: string[]
}

/**
 * Sends one user message, decides exactly the expected cards in order, and
 * fails as soon as any further card appears before the turn settles.
 */
async function runTurn(
  page: Page,
  testInfo: TestInfo,
  name: string,
  prompt: string,
  expectedCards: ExpectedCard[],
  settled: RegExp[]
): Promise<TurnResult> {
  const since = new Date().toISOString()
  const ledgerBefore = (await readCardLedger(page)).length
  const responseIndex = await sendChatPrompt(page, prompt)
  const response = page.getByTestId('agent-response').nth(responseIndex)

  for (const [index, expected] of expectedCards.entries()) {
    await expect
      .poll(async () => (await readCardLedger(page)).length - ledgerBefore, {
        message: `${name}: approval card ${index + 1} (${expected.label}) must appear`,
        timeout: CARD_TIMEOUT,
        intervals: [500, 1_000],
      })
      .toBeGreaterThanOrEqual(index + 1)
    const card = (await readCardLedger(page))[ledgerBefore + index]
    expect(
      matchesCard(card, expected),
      `${name}: card ${index + 1} was ${JSON.stringify(card)}, expected ${expected.label}${
        expected.preview ? ` with ${expected.preview}` : ''
      }`
    ).toBe(true)

    const stepper = suspendedCard(page, expected)
    await expect(stepper).toHaveCount(1, { timeout: CARD_TIMEOUT })
    const button = stepper.getByTestId(
      expected.decision === 'command'
        ? 'approval-shell-command-btn'
        : expected.decision === 'approve'
          ? 'approval-approve-btn'
          : 'approval-deny-btn'
    )
    await expect(button).toBeVisible()
    await humanClick(button, { beforeMs: [700, 1_200], afterMs: [700, 1_200] })
    await expect(stepper).toHaveCount(0, { timeout: 60_000 })
  }

  // Either the turn settles with its business signals or an unexpected card
  // appears; the second outcome fails immediately with the card it showed.
  const outcome = async (): Promise<'extra-card' | 'settled' | 'waiting'> => {
    if ((await readCardLedger(page)).length - ledgerBefore > expectedCards.length) {
      return 'extra-card'
    }
    if (!(await response.isVisible())) return 'waiting'
    const text = (await response.textContent()) ?? ''
    return settled.every(pattern => pattern.test(text)) ? 'settled' : 'waiting'
  }
  await expect
    .poll(outcome, {
      message: `${name}: the turn must settle or show an unexpected card`,
      timeout: TURN_TIMEOUT,
      intervals: [1_000],
    })
    .not.toBe('waiting')
  const cards = (await readCardLedger(page)).slice(ledgerBefore)
  expect(cards, `${name}: approval cards rendered in this turn`).toHaveLength(expectedCards.length)
  expect(await outcome()).toBe('settled')

  const expectedLogLength = expectedCards.length
  await expect
    .poll(() => approvalToolNamesSince(since).length, {
      message: `${name}: Host approval events for this turn`,
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(expectedLogLength)
  const approvalLog = approvalToolNamesSince(since)
  const selectedTools = selectedToolNamesSince(since)
  await testInfo.attach(`${name}-evidence`, {
    body: JSON.stringify({ since, cards, approvalLog, selectedTools }, null, 2),
    contentType: 'application/json',
  })
  return { response, cards, approvalLog, selectedTools }
}

/** Completed Shell rows of the response, with their command and visible output. */
async function completedShellSteps(
  response: Locator
): Promise<Array<{ input: string; output: string }>> {
  await expandResponseToolDetails(response)
  const stepper = response.getByTestId('progress-stepper').last()
  await expect(stepper).toHaveClass(/status-completed/)
  const rows = stepper
    .locator('.stepper-step:has(.stepper-step-icon.state-completed)')
    .filter({ hasText: /Shell.*shell_exec/i })
  const count = await rows.count()
  const steps: Array<{ input: string; output: string }> = []
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index)
    const input = row.locator('xpath=following-sibling::*[1][@data-testid="step-input-preview"]')
    await expect(input).toBeVisible()
    await humanClick(row, { afterMs: [300, 600] })
    const output = row.locator(
      'xpath=following-sibling::*[position()<=2][@data-testid="step-output-panel"]'
    )
    await expect(output).toBeVisible()
    steps.push({
      input: (await input.textContent())?.trim() ?? '',
      output: (await output.textContent())?.trim() ?? '',
    })
  }
  return steps
}

function expectShellStep(
  steps: Array<{ input: string; output: string }>,
  marker: string,
  context: string
): void {
  const step = steps.find(candidate => candidate.input === shellCommand(marker))
  expect(step, `${context}: completed Shell step for ${marker}`).toBeDefined()
  expect(step?.output, `${context}: Shell output for ${marker}`).toContain(marker)
}

type HostApproval = { uid: string; approval: Record<string, unknown> }

function readHostApproval(): HostApproval {
  const host = JSON.parse(
    kubectl(['-n', 'mcp-host', 'get', 'host', CHATLLM_HOST_REF, '-o', 'json'])
  ) as { metadata?: { uid?: string }; spec?: { approval?: Record<string, unknown> } }
  const uid = host.metadata?.uid
  const approval = host.spec?.approval
  if (!uid) throw new Error(`Host ${CHATLLM_HOST_REF} has no metadata.uid`)
  if (!approval) {
    throw new Error(`Host ${CHATLLM_HOST_REF} has no spec.approval; the minikube overlay sets one`)
  }
  return { uid, approval }
}

/** One JSON patch of the chatllm Host, under the branch profile's T2 mutation lease. */
function patchHost(operations: unknown[]): void {
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
      'mcp-host',
      'patch',
      'host',
      CHATLLM_HOST_REF,
      '--type=json',
      '-p',
      JSON.stringify(operations),
    ],
    { cwd: root, timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

/**
 * Named precondition: raises `spec.approval.modeCeiling` on the chatllm Host
 * for one row. Both patches test the Host uid and the whole live
 * `spec.approval`, so a concurrent edit fails the patch instead of being
 * overwritten. `restore` puts back the value read before `apply` (absent on
 * the canonical overlay) and refuses to overwrite a different value.
 */
function modeCeilingFixture(ceiling: ApprovalMode) {
  const context = process.env.E2E_K8S_CONTEXT
  if (!context || process.env.MINIKUBE_PROFILE !== context) {
    throw new Error(
      'Raising modeCeiling needs the branch-owned profile lease: set MINIKUBE_PROFILE to the E2E_K8S_CONTEXT value'
    )
  }
  const original = readHostApproval()
  const originalCeiling = original.approval.modeCeiling
  const raised = { ...original.approval, modeCeiling: ceiling }
  return {
    /** The ceiling mcp-host reports once `restore` has run: absent reads manual. */
    restoredCeiling: (originalCeiling ?? 'manual') as ApprovalMode,
    apply: () => {
      patchHost([
        { op: 'test', path: '/metadata/uid', value: original.uid },
        { op: 'test', path: '/spec/approval', value: original.approval },
        { op: 'add', path: '/spec/approval/modeCeiling', value: ceiling },
      ])
      expect(readHostApproval().approval).toEqual(raised)
      test.info().annotations.push({ type: 'mode-ceiling', description: ceiling })
    },
    restore: () => {
      const current = readHostApproval()
      if (current.uid === original.uid && isDeepStrictEqual(current.approval, original.approval)) {
        return
      }
      // The JSON tests refuse to overwrite a concurrent change.
      patchHost([
        { op: 'test', path: '/metadata/uid', value: original.uid },
        { op: 'test', path: '/spec/approval', value: raised },
        originalCeiling === undefined
          ? { op: 'remove', path: '/spec/approval/modeCeiling' }
          : { op: 'replace', path: '/spec/approval/modeCeiling', value: originalCeiling },
      ])
      expect(readHostApproval().approval).toEqual(original.approval)
    },
  }
}

/**
 * mcp-host publishes its approval policy on each Host watch event, and every
 * session read carries the live `modeCeiling`. Polls the session catalog
 * through the Desktop's own IPC until the Host reports `ceiling`. Needs one
 * chatllm session for this user; the first test of this serial describe
 * creates it.
 */
async function waitForHostModeCeiling(page: Page, ceiling: ApprovalMode): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async hostRef => {
          try {
            const catalog = await window.clerum.rpc.listSessions(hostRef, undefined, {
              agent: hostRef,
              limit: 1,
            })
            return catalog.items[0]?.modeCeiling ?? 'no chatllm session to read the ceiling from'
          } catch (error) {
            // A waking Host can fail a read. Returned, not thrown, so the poll
            // retries and a timeout shows the last error as the received value.
            return `catalog read failed: ${error instanceof Error ? error.message : String(error)}`
          }
        }, CHATLLM_HOST_REF),
      {
        message: `mcp-host must report modeCeiling ${ceiling}`,
        timeout: 60_000,
        intervals: [500, 1_000],
      }
    )
    .toBe(ceiling)
}

/** The active chatllm chat's approval fields, read from the Host. */
async function activeSessionApproval(
  page: Page
): Promise<{ approvalMode?: string; modeCeiling?: string; effectiveApprovalMode?: string }> {
  return page.evaluate(async hostRef => {
    const chatId = await window.clerum.chat.getLastActive(hostRef)
    if (!chatId) throw new Error(`No active ${hostRef} chat`)
    const session = await window.clerum.rpc.loadSessionMessages(
      hostRef,
      hostRef,
      chatId,
      undefined,
      { limit: 1 }
    )
    return {
      approvalMode: session.approvalMode,
      modeCeiling: session.modeCeiling,
      effectiveApprovalMode: session.effectiveApprovalMode,
    }
  }, CHATLLM_HOST_REF)
}

test.beforeAll(() => {
  expect(process.env.E2E_SESSION_TOOL_APPROVAL, 'Use the dedicated, opted-in lane').toBe('1')
  // Host log evidence is read from deploy/<host>; with several replicas it could
  // come from a pod that did not serve the turn.
  const replicas = kubectl([
    '-n',
    'mcp-host',
    'get',
    'deploy',
    CHATLLM_HOST_REF,
    '-o',
    'jsonpath={.status.replicas}',
  ]).trim()
  expect(replicas, `deploy/${CHATLLM_HOST_REF} must run exactly one replica`).toBe('1')
})

test.describe.serial('per-task tool approval scope', () => {
  test('a plain approval covers one task and one session-scoped tool only', async ({
    appPage,
  }, testInfo) => {
    const markerA = markerFor(testInfo, 'T1A')
    const markerB = markerFor(testInfo, 'T1B')
    const markerC = markerFor(testInfo, 'T2C')
    const markerD = markerFor(testInfo, 'T3D')
    const markerE = markerFor(testInfo, 'T4E')
    const shellCard = (marker: string, decision: Decision): ExpectedCard => ({
      label: /^Shell requires approval$/,
      preview: shellCommand(marker),
      decision,
    })

    await test.step('end user opens a fresh chatllm thread', async () => {
      await enterChatllmChat(appPage)
      await startFreshThread(appPage)
      await selectChatModel(appPage, CHAT_MODEL)
      await installCardLedger(appPage)
      expect(await readCardLedger(appPage)).toEqual([])
    })

    await test.step('T1: one task with two shell_exec calls shows one Shell card', async () => {
      const prompt = [
        `Use the native shell_exec tool to run exactly this command: ${shellCommand(markerA)}`,
        `After you see its output, call shell_exec again, as a separate call, to run exactly: ${shellCommand(markerB)}`,
        'Do not combine the commands and do not use any other tool.',
        'Then reply with both outputs verbatim.',
      ].join(' ')
      const turn = await runTurn(
        appPage,
        testInfo,
        'T1',
        prompt,
        [shellCard(markerA, 'approve')],
        [new RegExp(escapeRegExp(markerA)), new RegExp(escapeRegExp(markerB))]
      )
      // Liveness witness for "no second card": the second call was selected and
      // completed in this same task.
      expect(
        turn.selectedTools.filter(tool => tool === 'shell_exec').length
      ).toBeGreaterThanOrEqual(2)
      const steps = await completedShellSteps(turn.response)
      expect(steps.length).toBeGreaterThanOrEqual(2)
      expectShellStep(steps, markerA, 'T1')
      expectShellStep(steps, markerB, 'T1')
      expect(turn.approvalLog).toEqual(['shell_exec'])
    })

    await test.step('T2: the next user message asks for shell_exec again', async () => {
      const prompt = [
        `Use the native shell_exec tool once to run exactly: ${shellCommand(markerC)}`,
        'Do not use any other tool, then reply with its output verbatim.',
      ].join(' ')
      const turn = await runTurn(
        appPage,
        testInfo,
        'T2',
        prompt,
        [shellCard(markerC, 'approve')],
        [new RegExp(escapeRegExp(markerC))]
      )
      // Same thread: the T1 task is still on screen.
      await expect(appPage.getByTestId('message-list')).toContainText(shellCommand(markerA))
      const steps = await completedShellSteps(turn.response)
      expectShellStep(steps, markerC, 'T2')
      expect(turn.approvalLog).toEqual(['shell_exec'])
    })

    await test.step('T3: an approved shell_exec does not cover http_request', async () => {
      const prompt = [
        `First use the native shell_exec tool to run exactly: ${shellCommand(markerD)}`,
        'After you see its output, use the native http_request tool exactly once to make a GET request to https://example.com/.',
        'Do not use any other tool and wait for me to decide each approval request in this app.',
        'Then reply with the shell output verbatim and the outcome of the HTTP request.',
      ].join(' ')
      const turn = await runTurn(
        appPage,
        testInfo,
        'T3',
        prompt,
        [shellCard(markerD, 'approve'), { label: /^HTTP requires approval$/, decision: 'deny' }],
        [/http_request.*denied by the user/i]
      )
      const steps = await completedShellSteps(turn.response)
      expectShellStep(steps, markerD, 'T3')
      expect(turn.approvalLog).toEqual(['shell_exec', 'http_request'])
    })

    await test.step('T4: an approved shell_exec does not cover cron_manage list', async () => {
      const prompt = [
        `First use the native shell_exec tool to run exactly: ${shellCommand(markerE)}`,
        'After you see its output, use the native cron_manage tool exactly once with action "list".',
        'Do not create, enable or change any job, do not use any other tool, and wait for me to decide each approval request in this app.',
        'Then reply with the shell output verbatim and the outcome of the cron_manage call.',
      ].join(' ')
      const turn = await runTurn(
        appPage,
        testInfo,
        'T4',
        prompt,
        [
          shellCard(markerE, 'approve'),
          { label: /^cron_manage requires approval$/, decision: 'deny' },
        ],
        [/cron_manage.*denied by the user/i]
      )
      const steps = await completedShellSteps(turn.response)
      expectShellStep(steps, markerE, 'T4')
      expect(turn.approvalLog).toEqual(['shell_exec', 'cron_manage'])
    })
  })

  test('the picker stores auto and Allow this command answers the shell card', async ({
    appPage,
  }, testInfo) => {
    const marker = markerFor(testInfo, 'CMD')
    const ceiling = modeCeilingFixture('auto')
    // Restore always runs; the wait for mcp-host to drop the ceiling again runs
    // only after a passing body, so it cannot replace the body's failure.
    let bodyPassed = false
    try {
      await test.step('an admin raises the Host ceiling to auto', async () => {
        ceiling.apply()
      })

      await test.step('end user opens a fresh chatllm thread and sets auto', async () => {
        await enterChatllmChat(appPage)
        await waitForHostModeCeiling(appPage, 'auto')
        await startFreshThread(appPage)
        await selectChatModel(appPage, CHAT_MODEL)
        await installCardLedger(appPage)
        expect(await readCardLedger(appPage)).toEqual([])

        await humanClick(appPage.getByTestId('approval-mode-picker'))
        await humanClick(appPage.getByTestId('approval-mode-option-auto'))
        await expect(appPage.getByTestId('approval-mode-label')).toHaveText('Auto-approve')
        await expect(appPage.getByTestId('approval-mode-write-error')).toHaveCount(0)
      })

      await test.step('Allow this command runs that shell command', async () => {
        const prompt = [
          `Use the native shell_exec tool once to run exactly: ${shellCommand(marker)}`,
          'Do not use any other tool, then reply with its output verbatim.',
        ].join(' ')
        const turn = await runTurn(
          appPage,
          testInfo,
          'CMD',
          prompt,
          [
            {
              label: /^Shell requires approval$/,
              preview: shellCommand(marker),
              decision: 'command',
            },
          ],
          [new RegExp(escapeRegExp(marker))]
        )
        const steps = await completedShellSteps(turn.response)
        expectShellStep(steps, marker, 'CMD')
        expect(turn.approvalLog).toEqual(['shell_exec'])
        expect(await activeSessionApproval(appPage)).toEqual({
          approvalMode: 'auto',
          modeCeiling: 'auto',
          effectiveApprovalMode: 'auto',
        })
      })

      await test.step('the stored grant runs the identical command with no card', async () => {
        const prompt = [
          `Use the native shell_exec tool once to run exactly: ${shellCommand(marker)}`,
          'Run it again even though you ran it before: its date output has changed.',
          'Do not use any other tool, then reply with its new output verbatim.',
        ].join(' ')
        const turn = await runTurn(
          appPage,
          testInfo,
          'CMD-GRANT',
          prompt,
          [],
          [new RegExp(escapeRegExp(marker))]
        )
        // Liveness witness for "no card": this task selected shell_exec and the
        // command completed in this response.
        expect(turn.selectedTools).toContain('shell_exec')
        const steps = await completedShellSteps(turn.response)
        expectShellStep(steps, marker, 'CMD-GRANT')
        expect(turn.approvalLog).toEqual([])
      })
      bodyPassed = true
    } finally {
      ceiling.restore()
      if (bodyPassed) await waitForHostModeCeiling(appPage, ceiling.restoredCeiling)
    }
  })

  test('Allow all runs shell with no card and cron_manage create still asks', async ({
    appPage,
  }, testInfo) => {
    const marker = markerFor(testInfo, 'ALL')
    const ceiling = modeCeilingFixture('allow_all')
    let bodyPassed = false
    try {
      await test.step('an admin raises the Host ceiling to allow_all', async () => {
        ceiling.apply()
      })

      await test.step('end user opens a fresh chatllm thread and confirms Allow all', async () => {
        await enterChatllmChat(appPage)
        await waitForHostModeCeiling(appPage, 'allow_all')
        await startFreshThread(appPage)
        await selectChatModel(appPage, CHAT_MODEL)
        await installCardLedger(appPage)
        expect(await readCardLedger(appPage)).toEqual([])

        await humanClick(appPage.getByTestId('approval-mode-picker'))
        await humanClick(appPage.getByTestId('approval-mode-option-allow-all'))
        // Allow all asks before it writes.
        await expect(appPage.getByRole('dialog', { name: 'Confirm allow all' })).toBeVisible()
        await humanClick(appPage.getByTestId('approval-mode-confirm-allow-all'))
        await expect(appPage.getByTestId('approval-mode-label')).toHaveText('Allow all')
        await expect(appPage.getByTestId('approval-mode-write-error')).toHaveCount(0)
      })

      await test.step('shell_exec runs with no card', async () => {
        const prompt = [
          `Use the native shell_exec tool once to run exactly: ${shellCommand(marker)}`,
          'Do not use any other tool, then reply with its output verbatim.',
        ].join(' ')
        const turn = await runTurn(
          appPage,
          testInfo,
          'ALL-SHELL',
          prompt,
          [],
          [new RegExp(escapeRegExp(marker))]
        )
        // Liveness witness for "no card": this task selected shell_exec and the
        // command completed in this response.
        expect(turn.selectedTools).toContain('shell_exec')
        const steps = await completedShellSteps(turn.response)
        expectShellStep(steps, marker, 'ALL-SHELL')
        expect(turn.approvalLog).toEqual([])
        expect(await activeSessionApproval(appPage)).toEqual({
          approvalMode: 'allow_all',
          modeCeiling: 'allow_all',
          effectiveApprovalMode: 'allow_all',
        })
      })

      await test.step('cron_manage create still shows a card in allow_all', async () => {
        const prompt = [
          `Use the native cron_manage tool exactly once with action "create" to create a job named ${marker.toLowerCase()} that runs every day at 03:00 and replies "noop".`,
          'Do not use any other tool and wait for me to decide the approval request in this app.',
          'Then reply with the outcome of the cron_manage call.',
        ].join(' ')
        const turn = await runTurn(
          appPage,
          testInfo,
          'ALL-CRON',
          prompt,
          [{ label: /^cron_manage requires approval$/, decision: 'deny' }],
          [/cron_manage.*denied by the user/i]
        )
        expect(turn.approvalLog).toEqual(['cron_manage'])
      })
      bodyPassed = true
    } finally {
      ceiling.restore()
      if (bodyPassed) await waitForHostModeCeiling(appPage, ceiling.restoredCeiling)
    }
  })

  test('an MCP tool approval does not cover a later shell_exec', async ({ appPage }, testInfo) => {
    test.skip(
      !RUN_MCP_STEP,
      'Set E2E_SESSION_TOOL_APPROVAL_MCP=1 when the MongoDB MCP server is attached to chatllm.'
    )
    const markerF = markerFor(testInfo, 'T5F')

    await test.step('end user opens a fresh chatllm thread', async () => {
      await enterChatllmChat(appPage)
      await startFreshThread(appPage)
      await selectChatModel(appPage, CHAT_MODEL)
      await installCardLedger(appPage)
      expect(await readCardLedger(appPage)).toEqual([])
    })

    await test.step('T5: the Shell card still appears after an MCP approval', async () => {
      const prompt = [
        'First list all MongoDB databases available using the mongodb tools.',
        `After you see the result, use the native shell_exec tool once to run exactly: ${shellCommand(markerF)}`,
        'Do not use any other tool and wait for me to decide each approval request in this app.',
        'Then reply with the database names and the shell output verbatim.',
      ].join(' ')
      const turn = await runTurn(
        appPage,
        testInfo,
        'T5',
        prompt,
        [
          { label: /^(?!Shell requires approval$).+ requires approval$/, decision: 'approve' },
          {
            label: /^Shell requires approval$/,
            preview: shellCommand(markerF),
            decision: 'approve',
          },
        ],
        [new RegExp(escapeRegExp(markerF))]
      )
      const steps = await completedShellSteps(turn.response)
      expectShellStep(steps, markerF, 'T5')
      expect(turn.approvalLog).toHaveLength(2)
      expect(turn.approvalLog[0]).toContain('__')
      expect(turn.approvalLog[1]).toBe('shell_exec')
    })
  })
})
