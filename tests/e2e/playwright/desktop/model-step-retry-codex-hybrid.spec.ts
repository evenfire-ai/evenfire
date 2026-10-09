/**
 * Real Codex subscription with one test-image 503 after a confirmed tool.
 * E2E_GUARDIAN_STRICT_NETWORK: no browser request is intercepted or fulfilled.
 * E2E_GUARDIAN_IPC_FLOW: Desktop login and chat use the real main-process IPC;
 * read-only IPC and external fixture counters observe the resulting business state.
 */
import { type Page, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { newAgentResponses, openAgentChat, send } from '../helpers/approved-tools-chat'
import {
  type Scenario,
  localUrl,
  readEvidence,
  required,
  scenarios,
} from '../helpers/approved-tools-scenarios'
import { signOutDesktop } from '../helpers/desktop-session'
import { launchDesktopApp } from '../helpers/launch-desktop'

const TIMEOUT = 180_000
const scenario = (): Scenario => scenarios()[0]!
type Session = {
  chatId: string
  state?: string
  modelStepCheckpoint?: {
    checkpointId: string
    version: number
    status: string
    retryAvailable: boolean
    tools: { confirmed: number }
  }
  turns: Array<{
    user_input: string
    response?: string
    tool_steps?: Array<{ toolName: string; state: string }>
  }>
}
type HybridEvidence = {
  forwarded: number
  injected503: number
  r1: number
  r2: number
  r1DistinctToolResults: number
  r2DistinctToolResults: number
}

async function evidence(): Promise<HybridEvidence> {
  const response = await fetch(
    new URL('/approved-tools/evidence', localUrl(scenario().upstreamEvidenceUrl)),
    { signal: AbortSignal.timeout(10_000) }
  )
  expect(response.ok).toBe(true)
  const value = (await response.json()) as HybridEvidence
  for (const count of Object.values(value))
    expect(Number.isSafeInteger(count) && count >= 0).toBe(true)
  return value
}

async function session(desktop: Page, prompt: string): Promise<Session> {
  const value = await desktop.evaluate(async agent => {
    const api = (
      window as unknown as {
        clerum: {
          chat: { getIndex: (ref: string) => Promise<{ lastActiveChatId: string | null }> }
          rpc: {
            loadSessionMessages: (
              host: string,
              ref: string,
              id: string
            ) => Promise<Omit<Session, 'chatId'>>
          }
        }
      }
    ).clerum
    const chatId = (await api.chat.getIndex(agent)).lastActiveChatId
    if (!chatId) throw new Error('Visible send has no active chat')
    return { ...(await api.rpc.loadSessionMessages(agent, agent, chatId)), chatId }
  }, scenario().agentName)
  expect(value.turns.some(turn => turn.user_input === prompt)).toBe(true)
  return value
}

async function settled(desktop: Page, prompt: string): Promise<Session> {
  await expect
    .poll(async () => (await session(desktop, prompt)).state, { timeout: TIMEOUT })
    .toBe('idle')
  return session(desktop, prompt)
}

async function withDesktopChat(run: (desktop: Page) => Promise<void>): Promise<void> {
  if (
    required('APPROVED_TOOLS_UPSTREAM_MODE') !== 'real-hybrid' ||
    process.env.CODEX_REAL_UPSTREAM_CONFIRM !== '1'
  )
    throw new Error('Real hybrid requires its explicit subscription confirmation')
  if (process.env.PLAYWRIGHT_DESKTOP_BUILT !== 'true')
    throw new Error('Verified Desktop build is required')
  const app = await launchDesktopApp()
  let passed = false
  let cleanupError: string | undefined
  try {
    const desktop = await app.firstWindow()
    await openAgentChat(desktop, scenario())
    await run(desktop)
    passed = true
  } finally {
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
  }
  if (cleanupError && passed) throw new Error(cleanupError)
}

async function unavailable(desktop: Page, prompt: string) {
  const responses = await newAgentResponses(desktop)
  await send(desktop, prompt)
  await expect(responses.filter({ hasText: /Model Overloaded/ })).toHaveCount(1, {
    timeout: TIMEOUT,
  })
  const notice = desktop.getByTestId('model-step-retry-notice')
  await expect(notice).toHaveAttribute('data-status', 'resumable')
  await expect(notice.getByTestId('model-step-retry-btn')).toBeEnabled()
  await expect(desktop.getByRole('button', { name: 'Retry last send', exact: true })).toHaveCount(0)
  return notice
}

test('real hybrid R1: a confirmed search survives one injected 503 and Retry completes', async () => {
  await withDesktopChat(async desktop => {
    const prompt = `model step retry hybrid r1 r1-${randomUUID()}. Use tool search once to find workitem_read_receipt, then answer without calling another tool.`
    const before = await evidence()
    const businessBefore = (await readEvidence(scenario())).calls.length
    await test.step('The confirmed search is checkpointed after the injected 503', async () => {
      await unavailable(desktop, prompt)
    })
    const kept = await session(desktop, prompt)
    expect(kept.modelStepCheckpoint).toMatchObject({
      status: 'resumable',
      retryAvailable: true,
      tools: { confirmed: 1 },
    })
    expect(kept.modelStepCheckpoint?.checkpointId).toBeTruthy()
    expect(kept.modelStepCheckpoint?.version).toBeGreaterThan(0)
    await expect.poll(async () => (await evidence()).r1, { timeout: TIMEOUT }).toBe(before.r1 + 1)
    await test.step('Retry produces a real model answer from the kept result', async () => {
      const responses = await newAgentResponses(desktop)
      await desktop.getByTestId('model-step-retry-btn').click()
      await expect
        .poll(async () => (await session(desktop, prompt)).modelStepCheckpoint?.status, {
          timeout: TIMEOUT,
        })
        .toBe('claimed')
      const claimed = await session(desktop, prompt)
      expect(claimed.modelStepCheckpoint?.checkpointId).toBe(kept.modelStepCheckpoint?.checkpointId)
      expect(claimed.modelStepCheckpoint?.version).toBeGreaterThan(
        kept.modelStepCheckpoint!.version
      )
      await expect(responses).toHaveCount(1, { timeout: TIMEOUT })
      await expect(responses).toContainText(/\S/)
      await expect(responses).not.toContainText(/Model Overloaded/)
      await expect(desktop.getByTestId('model-step-retry-notice')).toHaveCount(0)
    })
    const done = await settled(desktop, prompt)
    expect(done.chatId).toBe(kept.chatId)
    expect(done.modelStepCheckpoint).toBeUndefined()
    const completedTurn = done.turns.find(turn => turn.user_input === prompt)
    expect(completedTurn?.tool_steps).toEqual([
      expect.objectContaining({ toolName: 'clerum__tool_search', state: 'completed' }),
    ])
    expect(
      done.turns.some(
        turn =>
          turn.user_input === prompt &&
          Boolean(turn.response?.trim()) &&
          !turn.response?.includes('Model Overloaded')
      )
    ).toBe(true)
    const after = await evidence()
    expect(after.r1).toBe(before.r1 + 1)
    expect(after.injected503).toBe(before.injected503 + 1)
    expect(after.r1DistinctToolResults).toBe(before.r1DistinctToolResults + 1)
    expect(after.forwarded).toBeGreaterThan(before.forwarded)
    expect((await readEvidence(scenario())).calls).toHaveLength(businessBefore)
  })
})

test('real hybrid R2: approval inside the continuation executes the receipt once', async () => {
  await withDesktopChat(async desktop => {
    const prompt = `model step retry hybrid r2 r2-${randomUUID()}. Search for workitem_read_receipt first. Then call that receipt tool once with empty arguments, wait for my approval, and explain the result.`
    const before = await evidence()
    const callsBefore = (await readEvidence(scenario())).calls
    await unavailable(desktop, prompt)
    const kept = await session(desktop, prompt)
    expect(kept.modelStepCheckpoint).toMatchObject({ status: 'resumable', retryAvailable: true })
    const responses = await newAgentResponses(desktop)
    await test.step('Retry reaches the real approval prompt', async () => {
      await desktop.getByTestId('model-step-retry-btn').click()
      const pending = desktop.getByTestId('progress-stepper').filter({
        has: desktop.getByTestId('approval-approve-btn'),
      })
      await expect(pending).toContainText('workitem_read_receipt', { timeout: TIMEOUT })
      await expect(pending).toContainText('requires approval')
      await expect
        .poll(async () => (await session(desktop, prompt)).state, { timeout: TIMEOUT })
        .toBe('awaiting_approval')
      const waiting = await session(desktop, prompt)
      expect(waiting.modelStepCheckpoint?.checkpointId).toBe(kept.modelStepCheckpoint?.checkpointId)
      expect(waiting.modelStepCheckpoint?.version).toBeGreaterThan(
        kept.modelStepCheckpoint!.version
      )
      expect((await readEvidence(scenario())).calls).toEqual(callsBefore)
      await pending.getByTestId('approval-approve-btn').click()
      await expect(pending).toHaveCount(0)
    })
    await expect
      .poll(async () => (await readEvidence(scenario())).calls.length, {
        timeout: TIMEOUT,
      })
      .toBe(callsBefore.length + 1)
    const call = (await readEvidence(scenario())).calls.at(-1)!
    expect(call).toMatchObject({ runId: scenario().runId, tool: 'workitem_read_receipt' })
    const done = await settled(desktop, prompt)
    expect(done.chatId).toBe(kept.chatId)
    expect(done.modelStepCheckpoint).toBeUndefined()
    expect(
      done.turns.some(
        turn =>
          turn.user_input === prompt &&
          Boolean(turn.response?.trim()) &&
          !turn.response?.includes('Model Overloaded')
      )
    ).toBe(true)
    await expect(responses).toHaveCount(1, { timeout: TIMEOUT })
    await expect(responses).toContainText(/\S/)
    await expect(responses).not.toContainText(/Model Overloaded/)
    await expect(desktop.getByTestId('model-step-retry-notice')).toHaveCount(0)
    expect((await readEvidence(scenario())).calls).toHaveLength(callsBefore.length + 1)
    const after = await evidence()
    expect(after.r2).toBe(before.r2 + 1)
    expect(after.injected503).toBe(before.injected503 + 1)
    expect(after.forwarded).toBeGreaterThan(before.forwarded)
  })
})
