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
import { restartAgentPod } from '../helpers/agent-rollout'
import { newAgentResponses, openAgentChat, send } from '../helpers/approved-tools-chat'
import {
  type ModelStepRetryEvidence,
  type Scenario,
  modelStepRetryFields,
  readUpstreamEvidence,
  required,
  scenarios,
} from '../helpers/approved-tools-scenarios'
import { signOutDesktop } from '../helpers/desktop-session'
import { launchDesktopApp } from '../helpers/launch-desktop'

if (required('APPROVED_TOOLS_UPSTREAM_MODE') !== 'deterministic')
  throw new Error('The model-step retry cases need the deterministic upstream')
if (process.env.PLAYWRIGHT_DESKTOP_BUILT !== 'true')
  throw new Error('Verified Desktop build is required; this lane never skips')

const scenario: Scenario = scenarios()[0]!
const FAILURE_LABEL = 'Model Overloaded · CODEX-SUBSCRIPTION'
const RESEND_LABEL = 'Retry last send'
const KEPT_TOOL_NOTICE = '1 tool call already completed and will not run again.'
const TURN_TIMEOUT = 120_000

type Snapshot = { counts: ModelStepRetryEvidence; stages: string[]; rejected: number }

async function snapshot(): Promise<Snapshot> {
  const evidence = await readUpstreamEvidence(scenario)
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
  const app = await launchDesktopApp()
  let journeyPassed = false
  try {
    const desktop = await app.firstWindow()
    await openAgentChat(desktop, scenario)
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

test('model step retry C1: a 503 after a confirmed tool continues once without re-running the tool', async () => {
  await withDesktopChat(async desktop => {
    const value = marker('c1')
    const start = await snapshot()
    await test.step('The model step after the confirmed search meets a 503', async () => {
      await sendUntilUnavailable(desktop, `model step retry probe ${value}`)
      await expectResumable(desktop)
    })
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
    const start = await snapshot()
    await sendUntilUnavailable(desktop, `model step retry twice ${value}`)
    await expectResumable(desktop)
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
    await test.step('The second Retry model step completes the turn', async () => {
      const responses = await newAgentResponses(desktop)
      await notice(desktop).getByTestId('model-step-retry-btn').click()
      await expectContinued(desktop, responses, value)
    })
    // Two retries, still one search.
    await expectDelta(failedAgain, { continuations: 1, toolResults: 1 }, ['model_step_continued'])
  })
})

test('model step retry C8: the checkpoint survives a Host restart between the 503 and the retry', async () => {
  await withDesktopChat(async desktop => {
    const value = marker('c8')
    const start = await snapshot()
    await sendUntilUnavailable(desktop, `model step retry probe ${value}`)
    await expectResumable(desktop)
    const failed = await expectDelta(
      start,
      { turns: 1, markerSearches: 1, unavailableResponses: 1 },
      ['model_step_search', 'model_step_unavailable']
    )
    await test.step('The Host pod is replaced while the turn waits for its retry', async () => {
      await restartAgentPod(scenario.agentName)
    })
    await test.step('Retry model step continues on the new Host process', async () => {
      const responses = await newAgentResponses(desktop)
      const retry = await expectResumable(desktop)
      await retry.click()
      await expectContinued(desktop, responses, value)
    })
    await expectDelta(failed, { continuations: 1, toolResults: 1 }, ['model_step_continued'])
  })
})
