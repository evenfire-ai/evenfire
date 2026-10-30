/**
 * Contract (#1043/#1044): a Codex or Grok subscription turn whose model step meets
 * provider_unavailable after a confirmed tool is kept by the Host as a resumable
 * checkpoint, and the Desktop offers **Retry model step** for it instead of
 * Resend. Every case here checks both sides: the deterministic upstream's
 * evidence (what the Host sent to the model, plus C1’s physical receipt execution
 * counter) and what the user sees and can do next (the message, which recovery
 * button is offered, and that the chat never ends in a dead end).
 *
 * Both providers run this file as its own `model-step-retry` lane suite
 * (`APPROVED_TOOLS_SUITE=model-step-retry`), with no dependency on
 * `codex-subscription-approved-tools.spec.ts`. The first test is the visible
 * setup: Codex creates the fixture grant (`prepareSubscriptionVisible`), both
 * providers bind the 83-tool agent to its subscription model in the Control UI,
 * and that same test attaches the receipt connector once. The suite's cases
 * depend on that one project, so setup runs once. Codex runs C1–C12, Grok runs
 * C1, C2 and C11.
 * Deterministic upstream only: a real provider cannot be made to fail on a chosen
 * model step.
 *
 * E2E_GUARDIAN_STRICT_NETWORK: no request is intercepted or fulfilled; the 503
 * comes from the isolated upstream behind the real proxy.
 * E2E_GUARDIAN_IPC_FLOW: Desktop uses real main-process login and chat IPC;
 * completed messages and upstream evidence replace renderer response waits.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { expectAgentConnectorRunning } from '../helpers/agent-connectors'
import {
  readAgentDeploymentGeneration,
  restartAgentPod,
  waitForAgentRollout,
} from '../helpers/agent-rollout'
import {
  newAgentResponses,
  openNewAgentChat,
  send,
  signInDesktop,
} from '../helpers/approved-tools-chat'
import {
  assertConfirmedToolNotReexecuted,
  toolExecutions,
} from '../helpers/approved-tools-execution'
import {
  type ModelStepRetryEvidence,
  type Scenario,
  approvedToolsProvider,
  browserApiPath,
  connectorApprovalLabel,
  modelStepRetryFields,
  readEvidence,
  readUpstreamEvidence,
  required,
  scenarios,
} from '../helpers/approved-tools-scenarios'
import { prepareSubscriptionVisible } from '../helpers/approved-tools-subscription'
import { attachDesktopBeforeTeardown, signOutDesktop } from '../helpers/desktop-session'
import { launchDesktopApp } from '../helpers/launch-desktop'
import { loginControlUiVisible } from '../helpers/visible-login'
import { AgentListPage, AgentModelPage, ControlUiShell } from '../pages/codex-subscription'

function scenario(): Scenario {
  return scenarios()[0]!
}
/** The bubble label of the provider failure; the suffix names the provider. */
function failureLabel(): string {
  return `Provider Unavailable · ${
    approvedToolsProvider() === 'grok' ? 'GROK-SUBSCRIPTION' : 'CODEX-SUBSCRIPTION'
  }`
}
// Every journey that ends on the resumable notice fails its model step four
// times: the Host's default CLERUM_MODEL_STEP_AUTO_RETRIES=3 retries that step
// three times by itself, so the first three 503s are absorbed and the fourth one
// stands. C2 injects a single outage before any tool: with no confirmed tool
// there is nothing to resume, so the Host never retries it and Resend is the only
// action. C11 injects exactly the three absorbed outages, and C12 holds its one
// retried call past the Host's 60 s cap.
const RESEND_LABEL = 'Retry last send'
const KEPT_TOOL_NOTICE = '1 tool call already completed and will not run again.'
const TURN_TIMEOUT = 120_000
const NOTICE_OUTAGES = 4
const ABSORBED_OUTAGES = 3
// The notice is measured from the send with this test's own clock: the cap ends
// the held retry 60 s after the step's first failure, and the search and the
// render add a few seconds. The window leaves room for both and nothing else.
const CAP_NOTICE_MIN_MS = 58_000
const CAP_NOTICE_MAX_MS = 75_000

/** `count` copies of one repeated stage name. */
function repeatedStage(count: number, stage: string): string[] {
  return Array.from({ length: count }, () => stage)
}

type Snapshot = { counts: ModelStepRetryEvidence; stages: string[]; rejected: number }
type Checkpoint = {
  checkpointId: string
  version: number
  status: 'resumable' | 'claimed' | 'blocked'
  retryAvailable: boolean
  tools: { confirmed: number }
}
type SessionRead = {
  chatId: string
  state?: string
  modelStepCheckpoint?: Checkpoint
  turns: Array<{ user_input: string; response?: string }>
}

/** Read-only Desktop IPC observation of the chat created through visible actions. */
async function readCurrentSession(desktop: Page, prompt: string): Promise<SessionRead> {
  const read = await desktop.evaluate(async agent => {
    const api = (
      window as unknown as {
        clerum: {
          chat: {
            getIndex: (agentRef: string) => Promise<{ lastActiveChatId: string | null }>
          }
          rpc: {
            loadSessionMessages: (
              hostRef: string,
              agentRef: string,
              chatId: string
            ) => Promise<Omit<SessionRead, 'chatId'>>
          }
        }
      }
    ).clerum
    const chatId = (await api.chat.getIndex(agent)).lastActiveChatId
    if (!chatId) throw new Error('Visible send has no active chat')
    const session = await api.rpc.loadSessionMessages(agent, agent, chatId)
    return { ...session, chatId }
  }, scenario().agentName)
  expect(read.chatId).toBeTruthy()
  // A healthy read with the message sent through Desktop is the positive
  // witness for a missing checkpoint and rules out a wrong or empty session.
  expect(read.turns.some(turn => turn.user_input === prompt)).toBe(true)
  return read
}

async function expectSessionState(desktop: Page, prompt: string, state: string) {
  await expect
    .poll(async () => (await readCurrentSession(desktop, prompt)).state, {
      timeout: TURN_TIMEOUT,
    })
    .toBe(state)
  return readCurrentSession(desktop, prompt)
}

async function snapshot(): Promise<Snapshot> {
  const evidence = await readUpstreamEvidence(scenario())
  return {
    counts: evidence.modelStepRetry,
    stages: evidence.requests.map(request => request.stage),
    rejected: evidence.rejected,
  }
}

/**
 * The exact change of every model-step counter between two snapshots, against
 * an expectation that names only the counters that move: every other counter,
 * `unexpectedRetries` included, must stay where it was.
 */
async function expectDelta(
  before: Snapshot,
  moved: Partial<ModelStepRetryEvidence>,
  stages: string[]
): Promise<Snapshot> {
  const after = await snapshot()
  const delta = Object.fromEntries(
    modelStepRetryFields.map(field => [field, after.counts[field] - before.counts[field]])
  )
  const expected = Object.fromEntries(modelStepRetryFields.map(field => [field, moved[field] ?? 0]))
  expect(delta).toEqual(expected)
  expect(after.stages.slice(before.stages.length)).toEqual(stages)
  expect(after.rejected).toBe(before.rejected)
  return after
}

function marker(label: string): string {
  return `${label}-${randomUUID()}`
}

function notice(desktop: Page): Locator {
  return desktop.getByTestId('model-step-retry-notice')
}

function resendButton(desktop: Page): Locator {
  return desktop.getByRole('button', { name: RESEND_LABEL, exact: true })
}

async function expectIdle(desktop: Page) {
  await expect(desktop.getByTestId('send-button')).toHaveAttribute('aria-label', 'Send message')
}

/** Sends `prompt` and waits for the turn to stop on the provider's 503. */
async function sendUntilUnavailable(desktop: Page, prompt: string) {
  const responses = await newAgentResponses(desktop)
  await send(desktop, prompt)
  await expect(responses.filter({ hasText: failureLabel() })).toHaveCount(1, {
    timeout: TURN_TIMEOUT,
  })
}

/** The resumable notice, with Retry model step offered and Resend not. */
async function expectResumable(desktop: Page, confirmed = 1): Promise<Locator> {
  await expect(notice(desktop)).toHaveAttribute('data-status', 'resumable', {
    timeout: TURN_TIMEOUT,
  })
  await expect(notice(desktop)).toContainText(
    confirmed === 1
      ? KEPT_TOOL_NOTICE
      : `${confirmed} tool calls already completed and will not run again.`
  )
  const retry = notice(desktop).getByTestId('model-step-retry-btn')
  await expect(retry).toBeEnabled()
  // Witness for the absence below: the notice above is on screen.
  await expect(resendButton(desktop)).toHaveCount(0)
  return retry
}

/** Waits for the continuation's answer and checks the chat settled on it. */
async function expectContinued(desktop: Page, responses: Locator, value: string) {
  const reply = responses.filter({ hasText: `continued ${value} toolResults=1` })
  await expect(reply).toHaveCount(1, { timeout: TURN_TIMEOUT })
  // The reply is the witness for both absences: no progress stepper is left in
  // it, and the notice is gone once the continuation finished.
  await expect(reply.getByTestId('progress-stepper')).toHaveCount(0)
  await expect(notice(desktop)).toHaveCount(0)
  await expect(resendButton(desktop)).toHaveCount(0)
  await expectIdle(desktop)
}

/** One signed-in Desktop chat with the scenario's agent, signed out on exit. */
async function withDesktopChat(
  run: (desktop: Page) => Promise<void>,
  options: { connector?: boolean } = {}
) {
  if (required('APPROVED_TOOLS_UPSTREAM_MODE') !== 'deterministic')
    throw new Error('The model-step retry cases need the deterministic upstream')
  if (process.env.PLAYWRIGHT_DESKTOP_BUILT !== 'true')
    throw new Error('Verified Desktop build is required; this lane never skips')
  const app = await launchDesktopApp()
  let journeyPassed = false
  try {
    const desktop = await app.firstWindow()
    await signInDesktop(desktop)
    // The connector witness opens its own page, so it runs before the chat.
    if (options.connector) await expectAgentConnectorRunning(desktop, scenario())
    await openNewAgentChat(desktop, scenario())
    await run(desktop)
    journeyPassed = true
  } finally {
    // The window state at the failure point, before sign-out replaces it with
    // the login form: a passing journey has nothing to capture.
    if (!journeyPassed) await attachDesktopBeforeTeardown(await app.firstWindow())
    // Sign out on every path, so the journey ends its session.
    let cleanupError: string | undefined
    try {
      await signOutDesktop(await app.firstWindow())
    } catch {
      cleanupError = 'Desktop sign-out failed'
    }
    try {
      await app.close()
    } catch {
      cleanupError = cleanupError
        ? `${cleanupError}; Desktop cleanup failed`
        : 'Desktop cleanup failed'
    }
    if (cleanupError && journeyPassed) throw new Error(cleanupError)
  }
}

/**
 * Attaches the receipt connector visibly, once, after the model binding was
 * rolled out. Both suites prepare their agent with an empty connector list
 * (`mcpServers: []`), so the empty state below is the fixture's own, not a
 * leftover from another journey. The attach itself needs no rollout: the Host
 * loads a Context `mcpServers` change through its own poll, and every case that
 * needs the connector witnesses its live status before its first send
 * (`expectAgentConnectorRunning`).
 */
async function attachReceiptConnector(page: Page) {
  const active = scenario()
  await page.getByRole('tab', { name: 'Connectors', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/agents/${active.agentName}/connectors$`))
  await expect(page.getByText('No connectors attached yet.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add connector', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add connectors' })
  // The picker is MultiSelectActionDialog: one checkbox per connector.
  await dialog.getByRole('checkbox', { name: active.connectorName, exact: true }).check()
  const savedResponse = page.waitForResponse(
    response =>
      new URL(response.url()).pathname ===
        browserApiPath(`/api/v1/admin/contexts/${active.contextName}`) &&
      response.request().method() === 'PUT'
  )
  await dialog.getByRole('button', { name: 'Add connector', exact: true }).click()
  const saved = await savedResponse
  expect(saved.ok()).toBe(true)
  const body = await saved.json()
  expect(body.metadata.name).toBe(active.contextName)
  expect(body.spec.mcpServers).toContain(active.connectorName)
  await expect(page.getByText('Connectors updated.', { exact: true })).toBeVisible()
}

// #1044: preparation creates the agent unbound (`connectionRef: 'unassigned'`)
// and without connectors. This setup test is the one source of the visible
// grant (Codex), of the model binding (both providers) and of the receipt
// connector (both providers); it is its own project, which the suite's cases
// depend on: a `beforeAll` would run again in every worker Playwright restarts
// after a case failure, and the second Codex grant capture refuses to open its
// journal entry.
// Only the model binding changes the runtime-token contract, so only its save
// rolls the Deployment and is awaited against a generation baseline. The Host
// learns a Context `mcpServers` change by polling (`mcp-host/src/main.ts`).
test('model step retry setup: the subscription grant and the model binding are visible', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const active = scenario()
  const provider = approvedToolsProvider()
  // E2E_GUARDIAN_ENTRY_POINT: Control UI root starts the visible admin journey.
  await page.goto('/')
  await loginControlUiVisible(page)
  if (provider === 'codex') {
    // The grant belongs to this run: no earlier journey created it.
    active.connectionKey = await prepareSubscriptionVisible(page, active)
    expect(active.connectionKey).not.toBe('unassigned')
  }
  await new ControlUiShell(page).openAgents()
  await new AgentListPage(page).openNamed(active.agentName)
  await expect(
    page.getByRole('heading', { name: `Agent: ${active.agentDisplayName}`, exact: true })
  ).toBeVisible()
  const generation = readAgentDeploymentGeneration(active.agentName)
  const model = new AgentModelPage(page)
  await model.openEditor()
  await model.chooseSubscription(active.subscriptionName)
  await page.getByLabel('Current model', { exact: true }).click()
  await page.getByRole('option', { name: active.modelName, exact: true }).click()
  const host = await model.saveHost(active.agentName)
  const savedPolicy = (host.spec as { llmPolicy?: { fallbacks: unknown[] } } | undefined)?.llmPolicy
  expect(savedPolicy?.fallbacks ?? [], 'the retry agent must not fall back').toEqual([])
  expect(host.spec?.model).toMatchObject({
    provider: provider === 'grok' ? 'grok-subscription' : 'codex-subscription',
    name: active.modelName,
  })
  if (provider === 'codex') {
    expect(host.spec?.model?.connectionRef).toBe(active.connectionKey)
  } else {
    // The connection key belongs to the user's connection, so only its binding is checked.
    expect(host.spec?.model?.connectionRef).toBeTruthy()
    expect(host.spec?.model?.connectionRef).not.toBe('unassigned')
  }
  await waitForAgentRollout(active.agentName, generation)
  await attachReceiptConnector(page)
})

// Vacuity mutations (Codex and Grok): drop the provider's `provider_unavailable`
// classification (Grok: `mcp-host/src/llm/grokSubscription.ts:357-365`) → no
// resumable checkpoint, no notice; or run with CLERUM_MODEL_STEP_AUTO_RETRIES=0 →
// one injected 503 instead of four, so `unavailableResponses: 4` fails.
test('model step retry C1: a 503 after a confirmed tool continues once without re-running the tool', async () => {
  await withDesktopChat(
    async desktop => {
      const value = marker('c1')
      const prompt = `model step retry receipt ${value}`
      const start = await snapshot()
      const physicalBefore = await readEvidence(scenario())
      await test.step('The receipt physically executes before the model step meets a 503', async () => {
        const responses = await newAgentResponses(desktop)
        await send(desktop, prompt)
        const pending = desktop.getByTestId('progress-stepper').filter({
          has: desktop.getByTestId('approval-approve-btn'),
        })
        // Both providers label the pending approval with the connector, not the
        // tool; the receipt this case approves is proven by the execution below.
        await expect(pending).toContainText(connectorApprovalLabel(scenario()), {
          timeout: TURN_TIMEOUT,
        })
        await expect(pending).toContainText('requires approval')
        expect(toolExecutions(await readEvidence(scenario()), 'workitem_read_receipt')).toBe(
          toolExecutions(physicalBefore, 'workitem_read_receipt')
        )
        await pending.getByTestId('approval-approve-btn').click()
        await expect(responses.filter({ hasText: failureLabel() })).toHaveCount(1, {
          timeout: TURN_TIMEOUT,
        })
        await expectResumable(desktop, 4)
      })
      const physicalKept = await readEvidence(scenario())
      expect(toolExecutions(physicalKept, 'workitem_read_receipt')).toBe(
        toolExecutions(physicalBefore, 'workitem_read_receipt') + 1
      )
      expect(physicalKept.calls.at(-1)).toMatchObject({
        runId: scenario().runId,
        tool: 'workitem_read_receipt',
        businessId: expect.any(String),
      })
      const kept = await readCurrentSession(desktop, prompt)
      expect(kept.modelStepCheckpoint).toMatchObject({
        status: 'resumable',
        retryAvailable: true,
        tools: { confirmed: 4 },
      })
      expect(kept.modelStepCheckpoint?.checkpointId).toBeTruthy()
      expect(kept.modelStepCheckpoint?.version).toBeGreaterThan(0)
      const failed = await expectDelta(
        start,
        { turns: 1, markerSearches: 1, unavailableResponses: NOTICE_OUTAGES },
        [
          'model_step_search',
          'model_step_receipt_tool',
          'model_step_receipt_tool',
          'model_step_receipt_tool',
          ...repeatedStage(NOTICE_OUTAGES, 'model_step_unavailable'),
        ]
      )
      await test.step('Retry model step continues from the kept tool result', async () => {
        const responses = await newAgentResponses(desktop)
        await notice(desktop).getByTestId('model-step-retry-btn').click()
        await expectContinued(desktop, responses, value)
      })
      const completed = await expectSessionState(desktop, prompt, 'idle')
      expect(completed.chatId).toBe(kept.chatId)
      expect(completed.modelStepCheckpoint).toBeUndefined()
      expect(completed.turns.some(turn => turn.response?.includes(`continued ${value}`))).toBe(true)
      assertConfirmedToolNotReexecuted(
        physicalBefore,
        physicalKept,
        await readEvidence(scenario()),
        'workitem_read_receipt'
      )
      // The continuation also carried the original marker search's one result.
      await expectDelta(failed, { continuations: 1, toolResults: 1 }, ['model_step_continued'])
    },
    { connector: true }
  )
})

// Vacuity mutation: drop both `this.currentFence !== null` and
// `this.confirmedResults > 0` from `canResume`
// (`mcp-host/src/core/orchestration/modelStepCheckpointRecorder.ts:319-325`) → the
// Host retries the zero-tool step, the upstream answers `unexpected_retry`, red.
// Dropping only the second term is not enough: a zero-tool turn never opens the
// fence. Disabling the automatic retry leaves this case green by design.
test('model step retry C2: a 503 before any tool offers only Resend, which answers the turn', async () => {
  await withDesktopChat(async desktop => {
    const value = marker('c2')
    const prompt = `model step retry zero ${value}`
    const start = await snapshot()
    let failedRead: SessionRead | undefined
    await test.step('The first model step meets a 503 before any tool runs', async () => {
      await sendUntilUnavailable(desktop, prompt)
      await expect(resendButton(desktop)).toBeEnabled()
      // Witness for the absence: Resend above is offered for this same turn.
      await expect(notice(desktop)).toHaveCount(0)
      await expect(desktop.getByTestId('model-step-retry-btn')).toHaveCount(0)
      // The Host kept no checkpoint either; the session read carries the
      // failed turn (readCurrentSession asserts it), which is the witness.
      failedRead = await readCurrentSession(desktop, prompt)
      expect(failedRead.modelStepCheckpoint).toBeUndefined()
    })
    const failed = await expectDelta(
      start,
      { turns: 1, unavailableResponses: 1, zeroToolUnavailable: 1 },
      ['model_step_zero_unavailable']
    )
    await test.step('Resend sends the message again and gets the answer', async () => {
      const responses = await newAgentResponses(desktop)
      await resendButton(desktop).click()
      await expect(responses.filter({ hasText: `resent ${value} answered` })).toHaveCount(1, {
        timeout: TURN_TIMEOUT,
      })
      await expect(resendButton(desktop)).toHaveCount(0)
      await expectIdle(desktop)
    })
    const answered = await readCurrentSession(desktop, prompt)
    expect(answered.chatId).toBe(failedRead?.chatId)
    expect(answered.modelStepCheckpoint).toBeUndefined()
    await expectDelta(failed, { resends: 1 }, ['model_step_resent'])
  })
})

// Vacuity mutation: stop retiring live checkpoints when a new message is admitted
// (`mcp-host/src/core/conversation/persistence/sqliteConversationStore.ts:791` →
// `retireLiveModelStepCheckpoints`, `mcp-host/src/db/worker/dispatcher.ts:775`) → the
// session still serves the checkpoint after the follow-up, red.
test('model step retry C3: a new message instead of the retry abandons the checkpoint', async () => {
  await withDesktopChat(async desktop => {
    const value = marker('c3')
    const probe = `model step retry probe ${value}`
    const followup = `model step retry followup ${value}`
    const start = await snapshot()
    await sendUntilUnavailable(desktop, probe)
    await expectResumable(desktop)
    // Positive witness for the absence asserted after the follow-up.
    const kept = await readCurrentSession(desktop, probe)
    expect(kept.modelStepCheckpoint).toMatchObject({ status: 'resumable', retryAvailable: true })
    const failed = await expectDelta(
      start,
      { turns: 1, markerSearches: 1, unavailableResponses: NOTICE_OUTAGES },
      ['model_step_search', ...repeatedStage(NOTICE_OUTAGES, 'model_step_unavailable')]
    )
    await test.step('The follow-up is answered and Retry model step is gone', async () => {
      const responses = await newAgentResponses(desktop)
      await send(desktop, followup)
      await expect(responses.filter({ hasText: `followup ${value} answered` })).toHaveCount(1, {
        timeout: TURN_TIMEOUT,
      })
      await expectIdle(desktop)
      // The answered follow-up is the witness for both absences.
      await expect(notice(desktop)).toHaveCount(0)
      await expect(desktop.getByTestId('model-step-retry-btn')).toHaveCount(0)
      // The abandoned turn falls back to the ordinary failed-send state.
      await expect(resendButton(desktop)).toBeEnabled()
    })
    // The Host retired the checkpoint: the session serves none, not a claimed or
    // blocked one (`docs/contracts/model-step-checkpoint.md:81-82`).
    const after = await readCurrentSession(desktop, followup)
    expect(after.chatId).toBe(kept.chatId)
    expect(after.modelStepCheckpoint).toBeUndefined()
    await expectDelta(failed, { followUps: 1 }, ['model_step_followup'])
  })
})

test('model step retry C4: a double click on Retry model step runs one continuation', async () => {
  await withDesktopChat(async desktop => {
    const value = marker('c4')
    const start = await snapshot()
    await sendUntilUnavailable(desktop, `model step retry probe ${value}`)
    const retry = await expectResumable(desktop)
    const failed = await expectDelta(
      start,
      { turns: 1, markerSearches: 1, unavailableResponses: NOTICE_OUTAGES },
      ['model_step_search', ...repeatedStage(NOTICE_OUTAGES, 'model_step_unavailable')]
    )
    await test.step('Both clicks land; only one continuation runs', async () => {
      const responses = await newAgentResponses(desktop)
      await retry.dblclick()
      await expectContinued(desktop, responses, value)
      // One new reply after the 503: the continuation's, and no second one.
      await expect(responses).toHaveCount(1)
      await expect(notice(desktop).getByRole('alert')).toHaveCount(0)
    })
    // Duplicate POST suppression is covered by useAgentChatController.modelStep.test.tsx.
    // The Host answers duplicates with contract row 3, so C4 cannot count POSTs.
    // A second continuation would be an unexpected retry in the upstream.
    await expectDelta(failed, { continuations: 1, toolResults: 1 }, ['model_step_continued'])
  })
})

test('model step retry C5: a continuation that meets a 503 again is offered for retry again', async () => {
  await withDesktopChat(async desktop => {
    const value = marker('c5')
    const prompt = `model step retry twice ${value}`
    const start = await snapshot()
    await sendUntilUnavailable(desktop, prompt)
    await expectResumable(desktop)
    const first = await readCurrentSession(desktop, prompt)
    expect(first.modelStepCheckpoint).toMatchObject({ status: 'resumable', retryAvailable: true })
    expect(first.modelStepCheckpoint?.checkpointId).toBeTruthy()
    const failed = await expectDelta(
      start,
      { turns: 1, markerSearches: 1, unavailableResponses: NOTICE_OUTAGES },
      ['model_step_search', ...repeatedStage(NOTICE_OUTAGES, 'model_step_unavailable')]
    )
    const failedAgain = await test.step('The first continuation meets a 503 too', async () => {
      const responses = await newAgentResponses(desktop)
      await notice(desktop).getByTestId('model-step-retry-btn').click()
      // The continuation's own error reply is the witness that the notice
      // below is the Host's new view, not the one shown before the click.
      await expect(responses.filter({ hasText: failureLabel() })).toHaveCount(1, {
        timeout: TURN_TIMEOUT,
      })
      await expectResumable(desktop)
      return expectDelta(
        failed,
        { unavailableResponses: NOTICE_OUTAGES, continuationUnavailable: NOTICE_OUTAGES },
        repeatedStage(NOTICE_OUTAGES, 'model_step_continuation_unavailable')
      )
    })
    const second = await readCurrentSession(desktop, prompt)
    expect(second.chatId).toBe(first.chatId)
    expect(second.modelStepCheckpoint?.checkpointId).toBe(first.modelStepCheckpoint?.checkpointId)
    expect(second.modelStepCheckpoint?.version).toBeGreaterThan(first.modelStepCheckpoint!.version)
    expect(second.modelStepCheckpoint).toMatchObject({ status: 'resumable', retryAvailable: true })
    await test.step('The second Retry model step completes the turn', async () => {
      const responses = await newAgentResponses(desktop)
      await notice(desktop).getByTestId('model-step-retry-btn').click()
      await expectContinued(desktop, responses, value)
    })
    const completed = await expectSessionState(desktop, prompt, 'idle')
    expect(completed.chatId).toBe(first.chatId)
    expect(completed.modelStepCheckpoint).toBeUndefined()
    expect(completed.turns.some(turn => turn.response?.includes(`continued ${value}`))).toBe(true)
    // Two retries, still one search.
    await expectDelta(failedAgain, { continuations: 1, toolResults: 1 }, ['model_step_continued'])
  })
})

test('model step retry C6: sending the same prompt starts a new turn instead of continuing', async () => {
  await withDesktopChat(async desktop => {
    const value = marker('c6')
    const prompt = `model step retry probe ${value}`
    const start = await snapshot()
    await sendUntilUnavailable(desktop, prompt)
    await expectResumable(desktop)
    const failed = await expectDelta(
      start,
      { turns: 1, markerSearches: 1, unavailableResponses: NOTICE_OUTAGES },
      ['model_step_search', ...repeatedStage(NOTICE_OUTAGES, 'model_step_unavailable')]
    )
    await test.step('The user sends the same text as a new message', async () => {
      const responses = await newAgentResponses(desktop)
      await send(desktop, prompt)
      await expect(responses.filter({ hasText: `resent ${value} answered` })).toHaveCount(1, {
        timeout: TURN_TIMEOUT,
      })
      await expect(notice(desktop)).toHaveCount(0)
      await expectIdle(desktop)
    })
    // Resend reaches the provider as a second user turn. Retry does not.
    await expectDelta(failed, { resends: 1 }, ['model_step_resent'])
  })
})

test('model step retry C7: approval inside a continuation executes the receipt once', async () => {
  await withDesktopChat(
    async desktop => {
      const value = marker('c7')
      const prompt = `model step retry approval ${value}`
      const start = await snapshot()
      const callsBefore = (await readEvidence(scenario())).calls
      await sendUntilUnavailable(desktop, prompt)
      await expectResumable(desktop)
      const failedRead = await readCurrentSession(desktop, prompt)
      expect(failedRead.modelStepCheckpoint).toMatchObject({
        status: 'resumable',
        retryAvailable: true,
      })
      const failed = await expectDelta(
        start,
        { turns: 1, markerSearches: 1, unavailableResponses: NOTICE_OUTAGES },
        ['model_step_search', ...repeatedStage(NOTICE_OUTAGES, 'model_step_unavailable')]
      )
      await test.step('Retry discovers the receipt and waits for the user decision', async () => {
        await notice(desktop).getByTestId('model-step-retry-btn').click()
        const pending = desktop.getByTestId('progress-stepper').filter({
          has: desktop.getByTestId('approval-approve-btn'),
        })
        // The connector label is the approval's own name; the receipt is proven
        // by the execution this case asserts after the decision.
        await expect(pending).toContainText(connectorApprovalLabel(scenario()), {
          timeout: TURN_TIMEOUT,
        })
        await expect(pending).toContainText('requires approval')
        const waiting = await expectSessionState(desktop, prompt, 'awaiting_approval')
        expect(waiting.chatId).toBe(failedRead.chatId)
        expect(waiting.modelStepCheckpoint?.checkpointId).toBe(
          failedRead.modelStepCheckpoint?.checkpointId
        )
        expect(waiting.modelStepCheckpoint?.version).toBeGreaterThan(
          failedRead.modelStepCheckpoint!.version
        )
        expect(waiting.modelStepCheckpoint).toMatchObject({
          status: 'claimed',
          retryAvailable: false,
        })
        expect((await readEvidence(scenario())).calls).toEqual(callsBefore)
        await pending.getByTestId('approval-approve-btn').click()
        await expect(pending).toHaveCount(0)
      })
      await test.step('The receipt is visible and the checkpoint is closed', async () => {
        await expect
          .poll(async () => (await readEvidence(scenario())).calls.length, {
            timeout: TURN_TIMEOUT,
          })
          .toBe(callsBefore.length + 1)
        const call = (await readEvidence(scenario())).calls.at(-1)!
        expect(call).toMatchObject({ runId: scenario().runId, tool: 'workitem_read_receipt' })
        await expect(
          desktop.getByTestId('agent-response').filter({
            hasText: `approved ${value} businessId=${call.businessId} toolResults=1`,
          })
        ).toBeVisible({ timeout: TURN_TIMEOUT })
        await expect(notice(desktop)).toHaveCount(0)
        await expectIdle(desktop)
        expect((await readEvidence(scenario())).calls).toHaveLength(callsBefore.length + 1)
        const completed = await expectSessionState(desktop, prompt, 'idle')
        expect(completed.chatId).toBe(failedRead.chatId)
        expect(completed.modelStepCheckpoint).toBeUndefined()
        expect(completed.turns.some(turn => turn.response?.includes(`approved ${value}`))).toBe(
          true
        )
      })
      await expectDelta(
        failed,
        { approvalRequests: 1, approvalFinals: 1, continuations: 1, toolResults: 1 },
        [
          'model_step_approval_tool',
          'model_step_approval_tool',
          'model_step_approval_tool',
          'model_step_approval_final',
        ]
      )
    },
    { connector: true }
  )
})

async function decisionJourney(decision: 'deny' | 'cancel') {
  await withDesktopChat(
    async desktop => {
      const value = marker(decision)
      const prompt = `model step retry approval ${value}`
      const start = await snapshot()
      const callsBefore = (await readEvidence(scenario())).calls
      await sendUntilUnavailable(desktop, prompt)
      await expectResumable(desktop)
      const failedRead = await readCurrentSession(desktop, prompt)
      expect(failedRead.modelStepCheckpoint).toMatchObject({
        status: 'resumable',
        retryAvailable: true,
      })
      const failed = await expectDelta(
        start,
        { turns: 1, markerSearches: 1, unavailableResponses: NOTICE_OUTAGES },
        ['model_step_search', ...repeatedStage(NOTICE_OUTAGES, 'model_step_unavailable')]
      )
      await notice(desktop).getByTestId('model-step-retry-btn').click()
      const pending = desktop.getByTestId('progress-stepper').filter({
        has: desktop.getByTestId(decision === 'deny' ? 'approval-deny-btn' : 'progress-cancel-btn'),
      })
      // Connector label, as for C1 and C7; the decision itself and the unchanged
      // execution count below are the witnesses, and no upstream request follows.
      await expect(pending).toContainText(connectorApprovalLabel(scenario()), {
        timeout: TURN_TIMEOUT,
      })
      await expect(pending).toContainText('requires approval')
      const waiting = await expectSessionState(desktop, prompt, 'awaiting_approval')
      expect(waiting.modelStepCheckpoint?.checkpointId).toBe(
        failedRead.modelStepCheckpoint?.checkpointId
      )
      expect(waiting.modelStepCheckpoint).toMatchObject({
        status: 'claimed',
        retryAvailable: false,
      })
      expect((await readEvidence(scenario())).calls).toEqual(callsBefore)
      await pending
        .getByTestId(decision === 'deny' ? 'approval-deny-btn' : 'progress-cancel-btn')
        .click()
      await expect(pending).toHaveCount(0)
      if (decision === 'deny') {
        await expect(
          desktop.getByTestId('agent-response').filter({
            hasText: 'was denied by the user. The operation was not performed.',
          })
        ).toBeVisible({ timeout: TURN_TIMEOUT })
      } else {
        await expect(
          desktop.getByTestId('progress-stepper').filter({ hasText: 'Cancelled' })
        ).toBeVisible({ timeout: TURN_TIMEOUT })
      }
      await expect(notice(desktop)).toHaveCount(0)
      await expectIdle(desktop)
      expect((await readEvidence(scenario())).calls).toEqual(callsBefore)
      const released = await expectSessionState(desktop, prompt, 'idle')
      expect(released.chatId).toBe(failedRead.chatId)
      expect(released.modelStepCheckpoint).toBeUndefined()
      const decided = await expectDelta(failed, { approvalRequests: 1 }, [
        'model_step_approval_tool',
        'model_step_approval_tool',
        'model_step_approval_tool',
      ])
      const responses = await newAgentResponses(desktop)
      await send(desktop, `model step retry followup ${value}`)
      await expect(responses.filter({ hasText: `followup ${value} answered` })).toHaveCount(1, {
        timeout: TURN_TIMEOUT,
      })
      await expectIdle(desktop)
      expect((await readEvidence(scenario())).calls).toEqual(callsBefore)
      const followUp = await expectSessionState(desktop, prompt, 'idle')
      expect(followUp.chatId).toBe(failedRead.chatId)
      expect(followUp.modelStepCheckpoint).toBeUndefined()
      expect(
        followUp.turns.some(turn => turn.response?.includes(`followup ${value} answered`))
      ).toBe(true)
      await expectDelta(decided, { followUps: 1 }, ['model_step_followup'])
    },
    { connector: true }
  )
}

test('model step retry C9: denying an approval inside a continuation releases the session', async () => {
  await decisionJourney('deny')
})

test('model step retry C10: cancelling an approval inside a continuation releases the session', async () => {
  await decisionJourney('cancel')
})

test('model step retry C8: the checkpoint survives a Host restart between the 503 and the retry', async () => {
  await withDesktopChat(async desktop => {
    const value = marker('c8')
    const prompt = `model step retry probe ${value}`
    const start = await snapshot()
    await sendUntilUnavailable(desktop, prompt)
    await expectResumable(desktop)
    const beforeRestart = await readCurrentSession(desktop, prompt)
    expect(beforeRestart.modelStepCheckpoint).toMatchObject({
      status: 'resumable',
      retryAvailable: true,
    })
    expect(beforeRestart.modelStepCheckpoint?.checkpointId).toBeTruthy()
    const failed = await expectDelta(
      start,
      { turns: 1, markerSearches: 1, unavailableResponses: NOTICE_OUTAGES },
      ['model_step_search', ...repeatedStage(NOTICE_OUTAGES, 'model_step_unavailable')]
    )
    await test.step('The Host pod is replaced while the turn waits for its retry', async () => {
      await restartAgentPod(scenario().agentName)
    })
    const afterRestart = await readCurrentSession(desktop, prompt)
    expect(afterRestart.chatId).toBe(beforeRestart.chatId)
    expect(afterRestart.modelStepCheckpoint?.checkpointId).toBe(
      beforeRestart.modelStepCheckpoint?.checkpointId
    )
    expect(afterRestart.modelStepCheckpoint?.version).toBeGreaterThanOrEqual(
      beforeRestart.modelStepCheckpoint!.version
    )
    expect(afterRestart.modelStepCheckpoint).toMatchObject({
      status: 'resumable',
      retryAvailable: true,
    })
    await test.step('Retry model step continues on the new Host process', async () => {
      const responses = await newAgentResponses(desktop)
      const retry = await expectResumable(desktop)
      await retry.click()
      await expectContinued(desktop, responses, value)
    })
    const completed = await expectSessionState(desktop, prompt, 'idle')
    expect(completed.chatId).toBe(beforeRestart.chatId)
    expect(completed.modelStepCheckpoint).toBeUndefined()
    expect(completed.turns.some(turn => turn.response?.includes(`continued ${value}`))).toBe(true)
    await expectDelta(failed, { continuations: 1, toolResults: 1 }, ['model_step_continued'])
  })
})

// Vacuity mutations (Codex and Grok): drop the provider's `provider_unavailable`
// classification, or run with CLERUM_MODEL_STEP_AUTO_RETRIES=2 → the third 503
// reaches the user as a failure and the absorbed answer never arrives, red.
test('model step retry C11: three 503s after a confirmed search are absorbed by the automatic retries', async () => {
  await withDesktopChat(async desktop => {
    const value = marker('c11')
    const prompt = `model step retry absorbed ${value}`
    const start = await snapshot()
    const responses = await newAgentResponses(desktop)
    await send(desktop, prompt)
    // The Host retried that step three times by itself; its answer is the witness
    // that the three outages never reached the user as a failure to recover from.
    await expect(responses.filter({ hasText: `absorbed ${value} toolResults=1` })).toHaveCount(1, {
      timeout: TURN_TIMEOUT,
    })
    await expect(responses.filter({ hasText: failureLabel() })).toHaveCount(0)
    await expect(notice(desktop)).toHaveCount(0)
    // Neither recovery action is offered: the turn never stopped.
    await expect(resendButton(desktop)).toHaveCount(0)
    await expectIdle(desktop)
    const completed = await expectSessionState(desktop, prompt, 'idle')
    expect(completed.modelStepCheckpoint).toBeUndefined()
    expect(completed.turns.some(turn => turn.response?.includes(`absorbed ${value}`))).toBe(true)
    // The turn ran its one search before the outages and the answer carried its
    // one result back, so the absorbed step neither re-ran the tool nor kept the
    // turn resumable. This kind's only tool is the search bridge, so the "called
    // once" witness is `markerSearches: 1`; a physical connector call would be a
    // different turn kind.
    await expectDelta(
      start,
      { turns: 1, markerSearches: 1, unavailableResponses: ABSORBED_OUTAGES, absorbed: 1 },
      [
        'model_step_search',
        ...repeatedStage(ABSORBED_OUTAGES, 'model_step_unavailable'),
        'model_step_absorbed_final',
      ]
    )
  })
})

// #1043 D5 / #1044 C12: the 60 s cap, end to end. The fixture answers the step's
// first 503 at once and then holds the retried call; the Host cancels that
// attempt 60 s after the step's first failure, the notice appears, and Retry
// model step answers from the kept search. Vacuity mutation (by hand): raise the
// cap to 600 s → the held call answers at 120 s, the next retry gets the final
// text and no notice ever appears, red.
test('model step retry C12: the 60 s cap ends a held retry and Retry model step completes the turn', async () => {
  // One send, the 60 s cap and the continuation: 150 s is the floor, and the
  // per-test default of 480 s stays above it.
  test.setTimeout(180_000)
  await withDesktopChat(async desktop => {
    const value = marker('c12')
    const prompt = `model step retry capped ${value}`
    const start = await snapshot()
    const responses = await newAgentResponses(desktop)
    const sentAt = Date.now()
    await send(desktop, prompt)
    // The test's own clock only: the cap ends the step 60 s after its first
    // failure, which follows the send, so the notice cannot appear before that
    // and must appear long before the held answer at 120 s.
    await expectResumable(desktop)
    const elapsed = Date.now() - sentAt
    expect(elapsed).toBeGreaterThanOrEqual(CAP_NOTICE_MIN_MS)
    expect(elapsed).toBeLessThanOrEqual(CAP_NOTICE_MAX_MS)
    const failedRead = await readCurrentSession(desktop, prompt)
    expect(failedRead.modelStepCheckpoint).toMatchObject({
      status: 'resumable',
      retryAvailable: true,
    })
    // Two outages: the immediate one and the held one, counted when it arrived.
    // The cap added no third call, which the stage list below also pins.
    const failed = await expectDelta(
      start,
      { turns: 1, markerSearches: 1, unavailableResponses: 2, cappedHeld: 1 },
      ['model_step_search', 'model_step_unavailable', 'model_step_capped_held']
    )
    await test.step('Retry model step answers from the kept search', async () => {
      await notice(desktop).getByTestId('model-step-retry-btn').click()
      await expectContinued(desktop, responses, value)
    })
    const completed = await expectSessionState(desktop, prompt, 'idle')
    expect(completed.chatId).toBe(failedRead.chatId)
    expect(completed.modelStepCheckpoint).toBeUndefined()
    expect(completed.turns.some(turn => turn.response?.includes(`continued ${value}`))).toBe(true)
    // The continuation's reply is `continued <marker> toolResults=1` and the turn
    // emitted one search in total (`markerSearches` above): the kept tool was not
    // run again.
    await expectDelta(failed, { continuations: 1, toolResults: 1 }, ['model_step_continued'])
  })
})
