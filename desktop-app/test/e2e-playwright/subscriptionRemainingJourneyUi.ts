/** E2E_GUARDIAN_IPC_FLOW: all business transitions use visible Desktop controls; reads correlate only after the UI turn. */
import type { Page, TestInfo } from '@playwright/test'
import { openResourcesNavItem } from './navigationHelpers.js'
import { expect, readVendorAttempts, sha256, test } from './subscriptionImageFixtures.js'
import type { ProviderBinding, SubscriptionImageRun } from './subscriptionImageRunContract.js'

export const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const outputPattern = (codes: string[]): RegExp =>
  new RegExp(`^\\s*${codes.map(escapePattern).join('\\s+')}\\s*$`, 'i')
export function primarySelector(page: Page) {
  return page.getByTestId('model-selector-up')
}
export async function assertPrimary(page: Page, binding: ProviderBinding): Promise<void> {
  const selector = primarySelector(page)
  await expect(selector).toHaveAttribute('data-host-ref', binding.hostRef)
  await expect(selector).toHaveAttribute('data-provider', binding.provider)
  await expect(selector).toHaveAttribute('data-model', binding.modelId)
  await expect(page.getByRole('status', { name: /^Running on fallback:/ })).toHaveCount(0)
}
export async function openOwnedChat(page: Page, binding: ProviderBinding): Promise<void> {
  await test.step('choose the owned Host and its primary model visibly', async () => {
    await openResourcesNavItem(page, 'nav-agents')
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
    const selector = primarySelector(page)
    await expect(selector).toHaveAttribute('data-host-ref', binding.hostRef)
    await expect(selector).toHaveAttribute('data-provider', binding.provider)
    await selector.getByRole('button', { name: /^Model — / }).click()
    const models = selector.getByRole('menu', { name: 'Select model', exact: true })
    await expect(models).toBeVisible()
    await models
      .getByRole('menuitemradio', {
        name: new RegExp(`^${escapePattern(binding.modelLabel)}(?:\\s*default)?$`),
      })
      .click()
    await expect(models).toHaveCount(0)
    await assertPrimary(page, binding)
  })
}
export async function submitVisibly(
  page: Page,
  binding: ProviderBinding,
  prompt: string
): Promise<void> {
  const composer = page.getByTestId('chat-input')
  await composer.fill(prompt)
  const send = page.getByTestId('send-button')
  await expect(send).toBeEnabled()
  await send.click()
  await expect(composer).toHaveValue('')
  await expect(page.getByTestId('message-list').getByText(prompt, { exact: true })).toBeVisible()
  await expect(page.locator('[data-chat-message-id]')).toHaveCount(2)
  await expect(primarySelector(page)).toHaveAttribute('data-host-ref', binding.hostRef)
}
export async function settledVisibleAnswer(
  page: Page,
  binding: ProviderBinding,
  expected: RegExp
): Promise<void> {
  const response = page.getByTestId('agent-response')
  await expect(response).toHaveCount(1, { timeout: 180_000 })
  await expect(response.locator('.message-block')).toHaveText(expected, { timeout: 180_000 })
  await expect(response).not.toHaveClass(/chat-bubble--error/)
  await expect(page.locator('.chat-message--in-flight')).toHaveCount(0)
  await expect(page.getByTestId('send-button')).toHaveAttribute('aria-label', 'Send message')
  await expect(page.getByTestId('approval-approve-btn')).toHaveCount(0)
  await assertPrimary(page, binding)
}

export type DurableTurn = {
  chatId: string
  taskId: string
  status: unknown
  success: unknown
  response: string
  error: unknown
  userAttachments: Array<{ id: string; type: string; label: string }>
  toolSteps: Array<{ toolName: string; state: string }>
  acceptedFileReferenceIds: unknown
}
export async function observeDurableTurn(
  page: Page,
  binding: ProviderBinding,
  expected: { status: 'completed' | 'failed'; response?: RegExp }
): Promise<DurableTurn> {
  await expect(page.locator('[data-chat-message-id]')).toHaveCount(2)
  const messageIds = await page
    .locator('[data-chat-message-id]')
    .evaluateAll(elements => elements.map(element => element.getAttribute('data-chat-message-id')))
  let matched: DurableTurn | null = null
  // Read-only IPC is permitted AFTER visible submit/terminal; it never advances business state.
  await expect
    .poll(
      async () => {
        const candidate = await page.evaluate(
          async ({ hostRef, ids }) => {
            for (const chat of (await window.clerum.chat.list(hostRef)).slice(0, 20)) {
              const messages = await window.clerum.chat.loadMessages(hostRef, chat.id)
              const pair = ids.map(id => messages.find(message => message.id === id))
              const taskId = pair[0]?.task_id
              if (
                !taskId ||
                pair[1]?.task_id !== taskId ||
                pair[0]?.role !== 'user' ||
                pair[1]?.role !== 'assistant'
              )
                continue
              const result = await window.clerum.rpc.getTaskResult(hostRef, taskId)
              return {
                chatId: chat.id,
                taskId,
                status: result.status,
                success: result.success,
                response: result.response ?? '',
                error: result.error,
                userAttachments: (pair[0]?.attachments ?? []).map(({ id, type, label }) => ({
                  id,
                  type,
                  label,
                })),
                toolSteps: (pair[1]?.toolSteps ?? []).map(({ toolName, state }) => ({
                  toolName,
                  state,
                })),
                acceptedFileReferenceIds: result.acceptedFileReferenceIds,
              }
            }
            return null
          },
          { hostRef: binding.hostRef, ids: messageIds }
        )
        if (
          !candidate ||
          candidate.status !== expected.status ||
          (expected.status === 'completed' && candidate.success !== true) ||
          (expected.status === 'failed' && candidate.success !== false) ||
          (expected.response && !expected.response.test(candidate.response))
        )
          return false
        matched = candidate
        return true
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  if (!matched) throw new Error('Visible two-message turn has no correlated durable terminal task')
  return matched
}

export async function showCompletedTools(page: Page, toolNames: string[]): Promise<void> {
  const expand = page.getByTestId('progress-expand-btn')
  await expect(expand).toHaveCount(1)
  await expect(expand).toBeVisible()
  if ((await expand.getAttribute('aria-expanded')) !== 'true') await expand.click()
  await expect(expand).toHaveAttribute('aria-expanded', 'true')
  const counts = new Map<string, number>()
  for (const name of toolNames) counts.set(name, (counts.get(name) ?? 0) + 1)
  for (const [name, count] of counts) {
    const row = page.getByTestId(/^step-row-/).filter({ hasText: name })
    await expect(row).toHaveCount(count)
    for (const completed of await row.all()) {
      await expect(completed).toBeVisible()
      await expect(completed.locator('.state-completed')).not.toHaveCount(0)
    }
  }
}

export async function observeVisibleApprovalTask(
  page: Page,
  binding: ProviderBinding
): Promise<string> {
  const ids = await page
    .locator('[data-chat-message-id]')
    .evaluateAll(elements => elements.map(element => element.getAttribute('data-chat-message-id')))
  let taskId: string | null = null
  // This observes the task only after its real approval UI is visible.
  await expect
    .poll(
      async () => {
        const candidate = await page.evaluate(
          async ({ hostRef, messageIds }) => {
            for (const chat of (await window.clerum.chat.list(hostRef)).slice(0, 20)) {
              const messages = await window.clerum.chat.loadMessages(hostRef, chat.id)
              const user = messages.find(
                message => message.role === 'user' && messageIds.includes(message.id)
              )
              if (!user?.task_id) continue
              const result = await window.clerum.rpc.getTaskResult(hostRef, user.task_id)
              return { taskId: user.task_id, status: result.status, approval: result.approval }
            }
            return null
          },
          { hostRef: binding.hostRef, messageIds: ids }
        )
        if (
          !candidate ||
          candidate.status !== 'waiting_approval' ||
          candidate.approval?.taskId !== candidate.taskId ||
          !candidate.approval.requestId
        )
          return false
        taskId = candidate.taskId
        return true
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  if (!taskId) throw new Error('Visible approval is not linked to an actual suspended task')
  return taskId
}

export async function assertPixelVendorEvidence(
  run: SubscriptionImageRun,
  binding: ProviderBinding,
  receiptId: string,
  expected: {
    journey: 'tool-screenshot' | 'gfs-image'
    stages: string[]
    imageSha256?: string[]
    mimeTypes: string[]
    output: string
    calls: Array<{ name: string; argumentsSha256: string }>
    sources?: unknown[]
    referencedFiles?: unknown[]
  },
  turn: DurableTurn,
  testInfo: TestInfo
): Promise<void> {
  if (run.mode === 'fixture') {
    await expect
      .poll(() => readVendorAttempts(run, binding).filter(row => row.receiptId === receiptId), {
        timeout: 20_000,
      })
      .toHaveLength(expected.stages.length)
    const attempts = readVendorAttempts(run, binding).filter(
      row => row.receiptId === receiptId
    ) as Array<
      ReturnType<typeof readVendorAttempts>[number] & {
        journey?: string
        stage?: string
        toolCalls?: Array<{ id: string; name: string; argumentsSha256: string }>
        toolOutputs?: Array<{ id: string; outputSha256: string; resource?: unknown }>
        referencedFiles?: unknown[]
      }
    >
    expect(attempts.map(row => row.journey)).toEqual(expected.stages.map(() => expected.journey))
    expect(attempts.map(row => row.stage)).toEqual(expected.stages)
    expect(attempts.every(row => row.model === binding.modelId)).toBe(true)
    if (expected.referencedFiles)
      expect(attempts[0]?.referencedFiles).toEqual(expected.referencedFiles)
    const calls = attempts.flatMap(row => row.toolCalls ?? [])
    expect(calls.map(({ name, argumentsSha256 }) => ({ name, argumentsSha256 }))).toEqual(
      expected.calls
    )
    expect(new Set(calls.map(row => row.id)).size).toBe(expected.calls.length)
    const final = attempts[attempts.length - 1]!
    expect(final.responseKind).toBe('pixels')
    expect(final.outputSha256).toBe(sha256(expected.output))
    expect(final.mimeTypes).toEqual(expected.mimeTypes)
    expect(final.imageSha256).toHaveLength(expected.mimeTypes.length)
    expect(final.toolOutputs?.map(row => row.id)).toEqual(calls.map(row => row.id))
    if (expected.sources)
      expect(final.toolOutputs?.map(row => row.resource)).toEqual(expected.sources)
    if (expected.imageSha256) expect(final.imageSha256).toEqual(expected.imageSha256)
    for (const other of run.bindings.filter(item => item.provider !== binding.provider)) {
      expect(
        readVendorAttempts(run, other).filter(row => row.receiptId === receiptId)
      ).toHaveLength(0)
    }
    await testInfo.attach(`${expected.journey}-wire-evidence`, {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          runId: run.runId,
          mode: run.mode,
          hostRef: binding.hostRef,
          provider: binding.provider,
          model: binding.modelId,
          receiptId,
          taskId: turn.taskId,
          attempts: attempts.map(
            ({
              sequence,
              requestSha256,
              imageSha256,
              mimeTypes,
              responseKind,
              outputSha256,
              stage,
              toolCalls,
              toolOutputs,
              referencedFiles,
            }) => ({
              sequence,
              requestSha256,
              imageSha256,
              mimeTypes,
              responseKind,
              outputSha256,
              stage,
              toolCalls,
              toolOutputs,
              referencedFiles,
            })
          ),
        })
      ),
    })
  } else {
    await testInfo.attach(`${expected.journey}-live-business-evidence`, {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          runId: run.runId,
          mode: run.mode,
          hostRef: binding.hostRef,
          provider: binding.provider,
          model: binding.modelId,
          receiptId,
          taskId: turn.taskId,
          outputSha256: sha256(expected.output),
          toolSteps: turn.toolSteps,
        })
      ),
    })
  }
}
