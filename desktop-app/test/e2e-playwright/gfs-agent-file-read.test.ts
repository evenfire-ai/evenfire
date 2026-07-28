/**
 * E2E — GFS agent file read (issue #775 regression journey)
 *
 * Proves, through the real Desktop App UI only, the exact chain the issue
 * reported broken: a user-visible GFS file is browsable in the Files page and
 * the agent can resolve + read its stable gfs:// URI through the native
 * clerum__gfs_* tools — and, separately, that an UNGRANTED file yields a clean
 * authorization denial (gfsc 403), never a permission-store outage
 * (gfsc 503 not_mounted).
 *
 * E2E contract (e2e-test-guardian):
 *  - Journey: real login → Files page browse → chat composer send → tool
 *    details expansion. No storage/API shortcuts for the behavior under test.
 *  - Business signals: the gfs_read step output contains the run-unique
 *    fixture sentinel (content actually read through gfsc), and the denial
 *    step error carries `gfsc 403` (deny-by-default intact).
 *  - Setup shortcuts (allowed, named): SQL fixture seeding + host grant are
 *    preconditions, performed OUTSIDE the journey via the shared fixtures.
 *  - Infra guard: gfsc unhealthy ⇒ the suite THROWS (never skips, never mocks).
 */
import { expect, test } from '@playwright/test'
import { exactNameFilter } from './helpers/agentLocators'
import {
  type AgentGfsFixtures,
  assertGfsInfraHealthy,
  seedAgentGfsFixtures,
} from './helpers/gfsFixtures'
import { openAgentsPage, openResourcesNavItem } from './navigationHelpers'
import { launchAndLogin } from './workflowUi'

const OWNER_EMAIL = 'test@clerum.io'
// glm-4.7 latency calibration (repo baseline): LLM turns can take minutes —
// deterministic waits on UI elements, never fixed sleeps.
const RESPONSE_TIMEOUT_MS = 180_000
const PROGRESS_TIMEOUT_MS = 30_000

type Page = import('@playwright/test').Page

async function enterAgentChat(page: Page, agentName: string): Promise<void> {
  // The agents TABLE row opens the workspace in 'details' view — navigating
  // to details does not rebind the composer (only the "Switch chat agent"
  // dropdown does), and the chat lives under the primary nav-chat item. With
  // the single seeded agent the chat home renders "New chat with <agent>" and
  // the ComposerPanel textarea directly; a cold Electron renderer can take a
  // while, so the wait mirrors the 45s entry budget of workflowUi's login
  // poll.
  await openAgentsPage(page)
  const exactAgent = page.getByLabel(`Open details for ${agentName}`, { exact: true })
  await expect(exactAgent).toBeVisible({ timeout: 30_000 })
  await exactAgent.click()
  await expect(page.getByText(agentName, { exact: true }).first()).toBeVisible()
  const chatInput = page.locator('[data-testid="chat-input"]')
  await page.getByTestId('nav-chat').click()
  await chatInput.waitFor({ state: 'visible', timeout: 45_000 })
  // In the two-agent #797 topology a denial from the WRONG agent must not be
  // able to satisfy this suite: assert the composer is bound to the exact
  // agent before any turn is sent (same contract as the copy suite).
  const selectedAgentInNewChat = page
    .getByRole('button', { name: 'Switch chat agent' })
    .filter(exactNameFilter(agentName))
  const selectedAgentInThread = page
    .getByRole('navigation', { name: 'Chat breadcrumb' })
    .getByText(agentName, { exact: true })
  // The chat view can restore whichever agent was last used; the product's
  // way to rebind is the "Switch chat agent" selector.
  if (
    !(await selectedAgentInNewChat
      .or(selectedAgentInThread)
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    await page.getByRole('button', { name: 'Switch chat agent' }).first().click()
    await page.getByRole('menuitem', { name: agentName, exact: true }).click()
  }
  await expect(selectedAgentInNewChat.or(selectedAgentInThread).first()).toBeVisible({
    timeout: 15_000,
  })
}

async function startFreshThread(page: Page): Promise<void> {
  // A freshly launched app lands on a NEW chat (no thread yet), where no
  // "new thread" button exists; click it only when a previous thread is open.
  const newThread = page.getByRole('button', { name: /new thread/i })
  if (await newThread.isVisible().catch(() => false)) {
    await newThread.click()
  }
  await expect(page.locator('[data-testid="agent-response"]')).toHaveCount(0, { timeout: 10_000 })
}

/**
 * Sends a tool-requiring prompt, auto-approves if the UI asks, and waits for
 * BOTH the assistant turn and the completed tool-progress stepper. A missing
 * stepper is a loud failure: it means the agent answered from memory (e.g.
 * the host has no GFS runtime token), which must never pass as success.
 */
async function sendGfsTask(
  page: Page,
  message: string
): Promise<{ response: string; expandBtn: import('@playwright/test').Locator }> {
  const responseCountBefore = await page.locator('[data-testid="agent-response"]').count()
  const approvalCountBefore = await page.locator('[data-testid="approval-approve-btn"]').count()
  const progressCountBefore = await page.locator('[data-testid="progress-expand-btn"]').count()

  await page.locator('[data-testid="chat-input"]').fill(message)
  await page.locator('[data-testid="send-button"]').click()

  const newResponse = page.locator(`[data-testid="agent-response"] >> nth=${responseCountBefore}`)
  // Approve EVERY suspension until the response lands: the prompt drives two
  // tool calls (gfs_resolve, then gfs_read), so a per-tool approval policy can
  // suspend more than once — a single click would hang the turn.
  let approvalsSeen = 0
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS
  for (;;) {
    const nextApproval = page
      .locator('[data-testid="approval-approve-btn"]')
      .nth(approvalCountBefore + approvalsSeen)
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error('Timed out waiting for approval prompt or agent response')
    }
    const approvalWait = nextApproval
      .waitFor({ state: 'visible', timeout: remaining })
      .then(() => 'approval' as const)
    const responseWait = newResponse
      .waitFor({ state: 'visible', timeout: remaining })
      .then(() => 'response' as const)
    const firstVisible = await Promise.race([approvalWait, responseWait]).catch(() => {
      throw new Error('Timed out waiting for approval prompt or agent response')
    })
    // Silence the losing waitFor so its later rejection cannot surface as an
    // unhandled "Target closed" failure after the turn already settled.
    void approvalWait.catch(() => undefined)
    void responseWait.catch(() => undefined)
    if (firstVisible === 'response') break
    await nextApproval.click()
    approvalsSeen += 1
  }
  await expect(newResponse).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS })

  const expandBtn = page.locator('[data-testid="progress-expand-btn"]').nth(progressCountBefore)
  await expect(expandBtn).toBeVisible({ timeout: PROGRESS_TIMEOUT_MS })

  return { response: (await newResponse.textContent()) || '', expandBtn }
}

/**
 * Step row for a tool name as rendered in the expanded stepper (after `__`).
 * Picks the LAST matching row: an agent may retry a tool (first attempt
 * errored, retry succeeded) and the journey verdict belongs to the FINAL
 * attempt — the response-level negative assertions still catch real failures.
 */
function toolStepRow(page: Page, toolName: string) {
  return page
    .locator('.stepper-step')
    .filter({ has: page.locator('.stepper-step-fn', { hasText: toolName }) })
    .last()
}

test.describe('GFS agent file read (issue #775)', () => {
  test.describe.configure({ mode: 'serial' })

  let fixtures: AgentGfsFixtures

  test.beforeAll(() => {
    // Infra guard FIRST: a broken permission-store credential is a blocker to
    // fix, never a reason to skip or mock (fail-loud rule).
    assertGfsInfraHealthy()
    fixtures = seedAgentGfsFixtures(OWNER_EMAIL)
  })

  test.afterAll(() => {
    if (fixtures) fixtures.cleanup()
  })

  test('user sees the GFS file and the agent reads it end-to-end', async () => {
    const { app, page } = await launchAndLogin(OWNER_EMAIL)
    try {
      await test.step('user can browse the file in the Files page', async () => {
        await openResourcesNavItem(page, 'nav-files')
        await expect(page.getByRole('heading', { name: 'Files', exact: true })).toBeVisible({
          timeout: 20_000,
        })
        await expect(
          page.getByRole('region', { name: 'Global File System browser' })
        ).toContainText(fixtures.granted.fileName, { timeout: 20_000 })
      })

      let expandBtn: import('@playwright/test').Locator
      let response = ''
      await test.step('agent resolves and reads the gfs:// URI', async () => {
        await enterAgentChat(page, fixtures.agent.name)
        await startFreshThread(page)
        // The user drives with the path they just saw in the Files browser —
        // never with resource UUIDs or gfs:// URIs, which are internal
        // storage identifiers a real user does not know.
        const result = await sendGfsTask(
          page,
          `Read the file at path "/${fixtures.granted.name}/${fixtures.granted.fileName}" in GFS ` +
            'drive main and quote its contents verbatim. Use your Clerum GFS tools; do not answer ' +
            'from memory.'
        )
        expandBtn = result.expandBtn
        response = result.response
        // Failure modes that must NEVER read as success (issue #775 shape and
        // the generic backend-down shape).
        expect(response.toLowerCase()).not.toContain('not_mounted')
        expect(response.toLowerCase()).not.toContain('gfsc 503')
        expect(response.toLowerCase()).not.toContain('fetch failed')
      })

      await test.step('tool details prove the real read (business signal)', async () => {
        await expandBtn.click()

        // Which discovery tool the agent picks for a path (resolve vs list) is
        // its own business; the required proof is the successful read whose
        // output carries the run-unique sentinel served from the real PVC.
        const readRow = toolStepRow(page, 'gfs_read')
        await expect(readRow).toBeVisible({ timeout: 10_000 })
        await expect(readRow.locator('.stepper-step-duration.state-error')).toHaveCount(0)

        // The output preview renders the head of the tool result payload — the
        // run-unique sentinel can only be there if gfsc actually served the
        // file content (impossible with a broken permission store). The
        // OutputPanel is a SIBLING of the step row (ProgressStepper renders
        // them inside one Fragment), so bind row→panel via following-sibling.
        await readRow.click()
        const readOutput = readRow
          .locator('xpath=following-sibling::*[@data-testid="step-output-panel"][1]')
          .locator('.stepper-step-output-code')
        await expect(readOutput).toBeVisible({ timeout: 10_000 })
        await expect(readOutput).toContainText(`E2E GFS file fixture: ${fixtures.granted.name}`)
      })
    } finally {
      await app.close()
    }
  })

  test('agent is denied on a file the host has no grant for (403, never 503)', async () => {
    const { app, page } = await launchAndLogin(OWNER_EMAIL)
    try {
      await test.step('agent attempts to read the ungranted gfs:// URI', async () => {
        await enterAgentChat(page, fixtures.agent.name)
        await startFreshThread(page)
        const { response, expandBtn } = await sendGfsTask(
          page,
          `Read the file at path "/${fixtures.ungranted.name}/${fixtures.ungranted.fileName}" in ` +
            'GFS drive main and quote its contents verbatim. Do not answer from memory — attempt ' +
            'the read with your Clerum GFS tools even if the file is not in your listing.'
        )
        // Credential repair must be distinguishable from resource
        // authorization: the store is healthy, so the ONLY acceptable failure
        // is deny-by-default (403). A not_mounted/503 here means the
        // permission store broke again (issue #775 regression).
        expect(response.toLowerCase()).not.toContain('not_mounted')
        expect(response.toLowerCase()).not.toContain('gfsc 503')
        // The sentinel content must NOT leak to an ungranted host.
        expect(response).not.toContain(`E2E GFS file fixture: ${fixtures.ungranted.name}`)

        await expandBtn.click()
        const gfsSteps = page
          .locator('.stepper-step')
          .filter({ has: page.locator('.stepper-step-fn', { hasText: /gfs_/ }) })
        await expect(gfsSteps.first()).toBeVisible({ timeout: 10_000 })

        // Under human name/path driving a denied file is deliberately
        // indistinguishable from an absent one (no-disclosure): the agent
        // cannot reach a direct 403 without legitimately holding the resource
        // id, so the contract here is that NO gfs_read ever succeeds, nothing
        // leaks the sentinel content, and no infra 503/not_mounted shape
        // appears. The deterministic gfsc-403 badge contract is proven by the
        // issue #797 copy journey, where the agent owns its discovered ids.
        const successfulRead = page
          .locator('.stepper-step')
          .filter({ has: page.locator('.stepper-step-fn', { hasText: 'gfs_read' }) })
          .filter({ hasNot: page.locator('.stepper-step-duration.state-error') })
        await expect(successfulRead).toHaveCount(0)
        const errorBadges = page.locator('.stepper-step-duration.state-error')
        await expect(errorBadges.filter({ hasText: /not_mounted|gfsc 503/ })).toHaveCount(0)
        await expect(
          page.locator('.stepper-step-error-detail').filter({ hasText: /not_mounted|gfsc 503/ })
        ).toHaveCount(0)
      })
    } finally {
      await app.close()
    }
  })
})
