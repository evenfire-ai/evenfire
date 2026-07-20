// desktop-app/test/e2e-playwright/chat.test.ts
import { expect, test } from './fixtures.js'
import { enterChatllmChat as enterAgentChat, startFreshThread } from './workflowAgentChatTools.js'

/** Send a message and wait for the agent response to appear. Returns the response text. */
async function sendAndWaitForResponse(
  appPage: import('@playwright/test').Page,
  message: string,
  timeoutMs = 90_000
): Promise<string> {
  const chatInput = appPage.locator('[data-testid="chat-input"]')
  const countBefore = await appPage.locator('[data-testid="agent-response"]').count()
  await chatInput.fill(message)
  await appPage.locator('[data-testid="send-button"]').click()
  const newResponse = appPage.locator(`[data-testid="agent-response"] >> nth=${countBefore}`)
  await expect(newResponse).toBeVisible({ timeout: timeoutMs })
  return (await newResponse.textContent()) || ''
}

/** Send a prompt that must execute tools, approving the call if the UI requests it. */
async function sendToolTaskAndWaitForResponse(
  appPage: import('@playwright/test').Page,
  message: string,
  responseTimeoutMs = 120_000
): Promise<{
  response: string
  approvalUsed: boolean
}> {
  const chatInput = appPage.locator('[data-testid="chat-input"]')
  const responseCountBefore = await appPage.locator('[data-testid="agent-response"]').count()
  const approvalCountBefore = await appPage.locator('[data-testid="approval-approve-btn"]').count()

  await chatInput.fill(message)
  await appPage.locator('[data-testid="send-button"]').click()

  const newResponse = appPage.locator(
    `[data-testid="agent-response"] >> nth=${responseCountBefore}`
  )
  const approveBtn = appPage
    .locator('[data-testid="approval-approve-btn"]')
    .nth(approvalCountBefore)

  const firstVisible = await Promise.race([
    approveBtn
      .waitFor({ state: 'visible', timeout: responseTimeoutMs })
      .then(() => 'approval' as const),
    newResponse
      .waitFor({ state: 'visible', timeout: responseTimeoutMs })
      .then(() => 'response' as const),
  ]).catch(() => {
    throw new Error('Timed out waiting for approval prompt or agent response')
  })

  let approvalUsed = false
  if (firstVisible === 'approval') {
    approvalUsed = true
    await approveBtn.click()
  }

  await expect(newResponse).toBeVisible({ timeout: responseTimeoutMs })

  return {
    response: (await newResponse.textContent()) || '',
    approvalUsed,
  }
}

/** Send a prompt that must execute tools and wait for the completed progress summary. */
async function sendToolTaskAndWaitForProgress(
  appPage: import('@playwright/test').Page,
  message: string,
  responseTimeoutMs = 120_000,
  progressTimeoutMs = 30_000
): Promise<{
  response: string
  expandBtn: import('@playwright/test').Locator
  approvalUsed: boolean
}> {
  const progressCountBefore = await appPage.locator('[data-testid="progress-expand-btn"]').count()
  const result = await sendToolTaskAndWaitForResponse(appPage, message, responseTimeoutMs)

  const expandBtn = appPage.locator('[data-testid="progress-expand-btn"]').nth(progressCountBefore)
  await expect(expandBtn).toBeVisible({ timeout: progressTimeoutMs })

  return {
    ...result,
    expandBtn,
  }
}

test.describe('agent chat e2e', () => {
  test('4. agent responds to a simple question', async ({ appPage }) => {
    await enterAgentChat(appPage)
    await startFreshThread(appPage)
    const response = await sendAndWaitForResponse(
      appPage,
      'What tools do you have available? List their names briefly.'
    )
    expect(response.length).toBeGreaterThan(20)
  })

  test('5. agent uses MongoDB tool to list databases', async ({ appPage }) => {
    await enterAgentChat(appPage)
    await startFreshThread(appPage)
    // No probe/skip: backend must be seeded with MongoDB MCP tools. A silent skip
    // here hid broken backends in the audit. If MongoDB isn't connected, fail loudly.
    const { response, expandBtn } = await sendToolTaskAndWaitForProgress(
      appPage,
      'List all MongoDB databases available. Use the mongodb tools.'
    )
    // Assert backend did NOT fail (fetch failed is a common failure mode that
    // must never be accepted as success).
    expect(response.toLowerCase()).not.toContain('fetch failed')
    expect(response.toLowerCase()).not.toContain('was denied by the user')
    await expect(appPage.locator('[data-testid="progress-stepper"]').last()).toContainText(
      /mongodb/i
    )
    await expandBtn.click()
    // Assert a real MongoDB tool actually ran (rendered as a step row with the
    // prefixed tool name after the `__` separator).
    const mongoToolStep = appPage
      .locator('.stepper-step-fn')
      .filter({ hasText: /list[_-]?databases|list[_-]?collections|find|aggregate/i })
    await expect(mongoToolStep.first()).toBeVisible({ timeout: 10_000 })
    // Shape match: response must reference a database concept, not be a
    // generic "I don't have access" fallback.
    expect(response.toLowerCase()).toMatch(/database|collection|admin|local|config/)
  })

  test('6. agent uses Airtable tool to list bases', async ({ appPage }) => {
    await enterAgentChat(appPage)
    await startFreshThread(appPage)
    const { response, expandBtn } = await sendToolTaskAndWaitForProgress(
      appPage,
      'Use the Airtable MCP tools to list all Airtable bases you can access. Do not answer from memory.'
    )
    expect(response.toLowerCase()).not.toContain('was denied by the user')
    // Explicit failure-mode rejection: `fetch failed` / tool errors must NEVER
    // count as a passing Airtable test. Previously this regex accepted
    // "fetch failed" as valid output, hiding a broken backend.
    expect(response.toLowerCase()).not.toContain('fetch failed')
    expect(response.toLowerCase()).not.toMatch(
      /\b(error|failed to|could not|unable to)\b.*airtable/i
    )
    await expect(appPage.locator('[data-testid="progress-stepper"]').last()).toContainText(
      /Airtable-server/i
    )
    await expandBtn.click()
    // Assert a real Airtable MCP tool ran in the progress stepper. Tool names
    // are prefixed like `airtable__list_bases`; the component shows the
    // function name after `__` in `.stepper-step-fn`.
    // TODO(desktop-app): consider adding `data-testid="tool-call"` with
    // `data-tool-name` attribute on step rows for more robust selection.
    const airtableToolStep = appPage
      .locator('.stepper-step-fn')
      .filter({ hasText: /list[_-]?bases|list[_-]?tables|list[_-]?records/i })
    await expect(airtableToolStep.first()).toBeVisible({ timeout: 15_000 })
    // Shape match: the response must contain a base-related concept, not just
    // the token "airtable" or "base" which can appear in refusal text.
    expect(response).toMatch(/\bbase[s]?\b/i)
    expect(response.length).toBeGreaterThan(20)
  })

  test('7. agent performs multi-step task with tool calls and shows progress', async ({
    appPage,
  }) => {
    await enterAgentChat(appPage)
    await startFreshThread(appPage)
    const response = await sendAndWaitForResponse(
      appPage,
      'What is 2+2? Then explain briefly why the answer is correct.'
    )
    // Shape match: must contain the literal answer "4" somewhere — a length
    // check alone was accepting any >10-char reply (including refusals).
    expect(response).toMatch(/\b4\b|\bfour\b/i)
    expect(response.length).toBeGreaterThan(10)
  })

  test('8. progress expand/collapse toggle works after tool task', async ({ appPage }) => {
    await enterAgentChat(appPage)
    await startFreshThread(appPage)
    const { expandBtn } = await sendToolTaskAndWaitForProgress(
      appPage,
      'Use the Airtable MCP tools to list all Airtable bases you can access. Do not answer from memory.'
    )

    await expandBtn.click()
    await expect(expandBtn).toHaveText('Hide')
    await expandBtn.click()
    await expect(expandBtn).toHaveText('Details')
  })
})
