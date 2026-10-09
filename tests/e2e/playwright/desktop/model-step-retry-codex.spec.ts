/**
 * Contract (#1043/#1044): a Codex turn whose model step meets provider_unavailable
 * after a confirmed tool is kept by the Host as a resumable checkpoint, and the
 * Desktop offers **Retry model step** for it instead of Resend. Every case here
 * checks both sides: the deterministic upstream's evidence (what the Host sent
 * to the model, and that the confirmed search never ran twice) and what the user
 * sees and can do next (the message, which recovery button is offered, and that
 * the chat never ends in a dead end).
 *
 * Runs after `codex-subscription-approved-tools.spec.ts` (a Playwright project
 * dependency), which binds the 83-tool scenario's agent to the subscription
 * model. Deterministic upstream only: a real provider cannot be made to fail on
 * a chosen model step.
 *
 * E2E_GUARDIAN_STRICT_NETWORK: no request is intercepted or fulfilled; the 503
 * comes from the isolated upstream behind the real proxy.
 * E2E_GUARDIAN_IPC_FLOW: Desktop uses real main-process login and chat IPC;
 * completed messages and upstream evidence replace renderer response waits.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  readAgentDeploymentGeneration,
  restartAgentPod,
  waitForAgentRollout,
} from '../helpers/agent-rollout'
import { newAgentResponses, openAgentChat, send } from '../helpers/approved-tools-chat'
import {
  type ModelStepRetryEvidence,
  type Scenario,
  browserApiPath,
  modelStepRetryFields,
  readEvidence,
  readUpstreamEvidence,
  required,
  scenarios,
} from '../helpers/approved-tools-scenarios'
import { signOutDesktop } from '../helpers/desktop-session'
import { launchDesktopApp } from '../helpers/launch-desktop'
import { loginControlUiVisible } from '../helpers/visible-login'
import { AgentListPage, ControlUiShell } from '../pages/codex-subscription'

function scenario(): Scenario {
  return scenarios()[0]!
}
const FAILURE_LABEL = 'Model Overloaded · CODEX-SUBSCRIPTION'
const RESEND_LABEL = 'Retry last send'
const KEPT_TOOL_NOTICE = '1 tool call already completed and will not run again.'
const TURN_TIMEOUT = 120_000

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
  await expect(responses.filter({ hasText: FAILURE_LABEL })).toHaveCount(1, {
    timeout: TURN_TIMEOUT,
  })
}

/** The resumable notice, with Retry model step offered and Resend not. */
async function expectResumable(desktop: Page): Promise<Locator> {
  await expect(notice(desktop)).toHaveAttribute('data-status', 'resumable', {
    timeout: TURN_TIMEOUT,
  })
  await expect(notice(desktop)).toContainText(KEPT_TOOL_NOTICE)
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
async function withDesktopChat(run: (desktop: Page) => Promise<void>) {
  if (required('APPROVED_TOOLS_UPSTREAM_MODE') !== 'deterministic')
    throw new Error('The model-step retry cases need the deterministic upstream')
  if (process.env.PLAYWRIGHT_DESKTOP_BUILT !== 'true')
    throw new Error('Verified Desktop build is required; this lane never skips')
  const app = await launchDesktopApp()
  let journeyPassed = false
  try {
    const desktop = await app.firstWindow()
    await openAgentChat(desktop, scenario())
    await run(desktop)
    journeyPassed = true
  } finally {
    // The session token lives in the macOS Keychain and would sign the next
    // launch in (see `helpers/desktop-session.ts`), so sign out on every path.
    let cleanupError: string | undefined
    try {
      await signOutDesktop(await app.firstWindow())
    } catch {
      cleanupError = 'Desktop sign-out failed; the session stays in the Keychain'
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

/** The prerequisite journey ends by revoking this connector; restore it visibly. */
async function restoreReceiptConnector(page: Page) {
  const active = scenario()
  // E2E_GUARDIAN_ENTRY_POINT: Control UI root starts the visible admin journey.
  await page.goto('/')
  await loginControlUiVisible(page)
  await new ControlUiShell(page).openAgents()
  await new AgentListPage(page).openNamed(active.agentName)
  await page.getByRole('tab', { name: 'Connectors', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/agents/${active.agentName}/connectors$`))
  await expect(page.getByText('No connectors attached yet.', { exact: true })).toBeVisible()
  const generation = readAgentDeploymentGeneration(active.agentName)
  await page.getByRole('button', { name: 'Add connector', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add connectors' })
  await dialog.getByRole('option', { name: active.connectorName, exact: true }).click()
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
  await waitForAgentRollout(active.agentName, generation)
}

test('model step retry C1: a 503 after a confirmed tool continues once without re-running the tool', async () => {
  await withDesktopChat(async desktop => {
    const value = marker('c1')
    const prompt = `model step retry probe ${value}`
    const start = await snapshot()
    await test.step('The model step after the confirmed search meets a 503', async () => {
      await sendUntilUnavailable(desktop, prompt)
      await expectResumable(desktop)
    })
    const kept = await readCurrentSession(desktop, prompt)
    expect(kept.modelStepCheckpoint).toMatchObject({
      status: 'resumable',
      retryAvailable: true,
      tools: { confirmed: 1 },
    })
    expect(kept.modelStepCheckpoint?.checkpointId).toBeTruthy()
    expect(kept.modelStepCheckpoint?.version).toBeGreaterThan(0)
    const failed = await expectDelta(
      start,
      { turns: 1, markerSearches: 1, unavailableResponses: 1 },
      ['model_step_search', 'model_step_unavailable']
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
    // The search is not repeated, and the continuation carried its one result.
    await expectDelta(failed, { continuations: 1, toolResults: 1 }, ['model_step_continued'])
  })
})

test('model step retry C2: a 503 before any tool offers only Resend, which answers the turn', async () => {
  await withDesktopChat(async desktop => {
    const value = marker('c2')
    const prompt = `model step retry zero ${value}`
    const start = await snapshot()
    await test.step('The first model step meets a 503 before any tool runs', async () => {
      await sendUntilUnavailable(desktop, prompt)
      await expect(resendButton(desktop)).toBeEnabled()
      // Witness for the absence: Resend above is offered for this same turn.
      await expect(notice(desktop)).toHaveCount(0)
      await expect(desktop.getByTestId('model-step-retry-btn')).toHaveCount(0)
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
    await expectDelta(failed, { resends: 1 }, ['model_step_resent'])
  })
})

test('model step retry C3: a new message instead of the retry abandons the checkpoint', async () => {
  await withDesktopChat(async desktop => {
    const value = marker('c3')
    const start = await snapshot()
    await sendUntilUnavailable(desktop, `model step retry probe ${value}`)
    await expectResumable(desktop)
    const failed = await expectDelta(
      start,
      { turns: 1, markerSearches: 1, unavailableResponses: 1 },
      ['model_step_search', 'model_step_unavailable']
    )
    await test.step('The follow-up is answered and Retry model step is gone', async () => {
      const responses = await newAgentResponses(desktop)
      await send(desktop, `model step retry followup ${value}`)
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
      { turns: 1, markerSearches: 1, unavailableResponses: 1 },
      ['model_step_search', 'model_step_unavailable']
    )
    await test.step('Both clicks land; only one continuation runs', async () => {
      const responses = await newAgentResponses(desktop)
      await retry.dblclick()
      await expectContinued(desktop, responses, value)
      // One new reply after the 503: the continuation's, and no second one.
      await expect(responses).toHaveCount(1)
      await expect(notice(desktop).getByRole('alert')).toHaveCount(0)
    })
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
      { turns: 1, markerSearches: 1, unavailableResponses: 1 },
      ['model_step_search', 'model_step_unavailable']
    )
    const failedAgain = await test.step('The first continuation meets a 503 too', async () => {
      const responses = await newAgentResponses(desktop)
      await notice(desktop).getByTestId('model-step-retry-btn').click()
      // The continuation's own error reply is the witness that the notice
      // below is the Host's new view, not the one shown before the click.
      await expect(responses.filter({ hasText: FAILURE_LABEL })).toHaveCount(1, {
        timeout: TURN_TIMEOUT,
      })
      await expectResumable(desktop)
      return expectDelta(failed, { unavailableResponses: 1, continuationUnavailable: 1 }, [
        'model_step_continuation_unavailable',
      ])
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
      { turns: 1, markerSearches: 1, unavailableResponses: 1 },
      ['model_step_search', 'model_step_unavailable']
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

test('model step retry C7: approval inside a continuation executes the receipt once', async ({
  page,
}) => {
  await restoreReceiptConnector(page)
  await withDesktopChat(async desktop => {
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
      { turns: 1, markerSearches: 1, unavailableResponses: 1 },
      ['model_step_search', 'model_step_unavailable']
    )
    await test.step('Retry discovers the receipt and waits for the user decision', async () => {
      await notice(desktop).getByTestId('model-step-retry-btn').click()
      const pending = desktop.getByTestId('progress-stepper').filter({
        has: desktop.getByTestId('approval-approve-btn'),
      })
      await expect(pending).toContainText('workitem_read_receipt', { timeout: TURN_TIMEOUT })
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
      expect(completed.turns.some(turn => turn.response?.includes(`approved ${value}`))).toBe(true)
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
  })
})

async function decisionJourney(decision: 'deny' | 'cancel') {
  await withDesktopChat(async desktop => {
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
      { turns: 1, markerSearches: 1, unavailableResponses: 1 },
      ['model_step_search', 'model_step_unavailable']
    )
    await notice(desktop).getByTestId('model-step-retry-btn').click()
    const pending = desktop.getByTestId('progress-stepper').filter({
      has: desktop.getByTestId(decision === 'deny' ? 'approval-deny-btn' : 'progress-cancel-btn'),
    })
    await expect(pending).toContainText('workitem_read_receipt', { timeout: TURN_TIMEOUT })
    await expect(pending).toContainText('requires approval')
    const waiting = await expectSessionState(desktop, prompt, 'awaiting_approval')
    expect(waiting.modelStepCheckpoint?.checkpointId).toBe(
      failedRead.modelStepCheckpoint?.checkpointId
    )
    expect(waiting.modelStepCheckpoint).toMatchObject({ status: 'claimed', retryAvailable: false })
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
    expect(followUp.turns.some(turn => turn.response?.includes(`followup ${value} answered`))).toBe(
      true
    )
    await expectDelta(decided, { followUps: 1 }, ['model_step_followup'])
  })
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
      { turns: 1, markerSearches: 1, unavailableResponses: 1 },
      ['model_step_search', 'model_step_unavailable']
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
