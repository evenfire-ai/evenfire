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
import { kubectlOut } from '../../../tests/e2e/gfsUiFixtures'
import { exactNameFilter } from './helpers/agentLocators'
import { type ManagedGfsAgent, getManagedAgentDisplayName } from './helpers/gfsAgentDiscovery'
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
  // `agentName` is the rendered label (Host `spec.host`), not the CRD name.
  // The fleet row opens the agent workspace — opening it does not rebind the
  // composer (only the "Switch chat agent" dropdown does), and the chat lives
  // under the primary nav-chat item. With the single seeded agent the chat
  // home renders "New chat with <agent>" and the ComposerPanel textarea
  // directly; a cold Electron renderer can take a while, so the wait mirrors
  // the 45s entry budget of workflowUi's login poll.
  await openAgentsPage(page)
  const exactAgent = page.getByLabel(`Open agent ${agentName}`, { exact: true })
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

// The Host writes one JSON line per admitted message with file references
// (mcp-host/src/agent/incomingAdmission.ts, `file_reference_resolved`),
// serialized by mcp-host/src/logger.ts with JSON.stringify.
const FILE_REFERENCE_RESOLVED_MARKER = '"event":"file_reference_resolved"'
const KUBELET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

interface HostLogWindow {
  pod: string
  restartCount: string
  since: string
  baseline: number
}

/** The agent's one live Host pod; none or several fails the test. */
function liveHostPod(agent: ManagedGfsAgent): string {
  const pods = kubectlOut([
    '-n',
    agent.namespace,
    'get',
    'pods',
    '-l',
    `app=${agent.name}`,
    '-o',
    'go-template={{range .items}}{{if not .metadata.deletionTimestamp}}{{.metadata.name}}{{"\\n"}}{{end}}{{end}}',
  ])
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const [pod] = pods
  if (pods.length !== 1 || !pod) {
    throw new Error(
      `expected exactly one live Host pod for ${agent.namespace}/${agent.name}, found ${pods.length}: ${pods.join(', ')}`
    )
  }
  return pod
}

function hostContainerRestarts(agent: ManagedGfsAgent, pod: string): string {
  const restarts = kubectlOut([
    '-n',
    agent.namespace,
    'get',
    'pod',
    pod,
    '-o',
    'jsonpath={.status.containerStatuses[?(@.name=="mcp-host")].restartCount}',
  ]).trim()
  if (!/^\d+$/.test(restarts)) {
    throw new Error(`Host pod ${agent.namespace}/${pod} has no mcp-host container status`)
  }
  return restarts
}

function hostLogLinesSince(agent: ManagedGfsAgent, pod: string, since: string): string[] {
  return kubectlOut(
    ['-n', agent.namespace, 'logs', `pod/${pod}`, '-c', 'mcp-host', `--since-time=${since}`],
    30_000
  ).split('\n')
}

function fileReferenceResolvedLines(lines: string[]): string[] {
  return lines.filter(line => line.includes(FILE_REFERENCE_RESOLVED_MARKER))
}

/**
 * Anchors a log window at the Host's newest line (kubelet clock, so host/VM
 * clock skew cannot hide the event) and counts the events already in it. Only
 * the window is read, never the whole container log.
 */
function openHostLogWindow(agent: ManagedGfsAgent): HostLogWindow {
  const pod = liveHostPod(agent)
  const restartCount = hostContainerRestarts(agent, pod)
  const newest = kubectlOut([
    '-n',
    agent.namespace,
    'logs',
    `pod/${pod}`,
    '-c',
    'mcp-host',
    '--tail=1',
    '--timestamps',
  ]).trim()
  const since = newest.split(' ', 1)[0] ?? ''
  if (!KUBELET_TIMESTAMP.test(since)) {
    throw new Error(`Host pod ${agent.namespace}/${pod} has no timestamped log line to anchor on`)
  }
  const baseline = fileReferenceResolvedLines(hostLogLinesSince(agent, pod, since)).length
  return { pod, restartCount, since, baseline }
}

test.describe('GFS agent file read (issue #775)', () => {
  test.describe.configure({ mode: 'serial' })

  let fixtures: AgentGfsFixtures
  let agentLabel: string

  test.beforeAll(() => {
    // Infra guard FIRST: a broken permission-store credential is a blocker to
    // fix, never a reason to skip or mock (fail-loud rule).
    assertGfsInfraHealthy()
    fixtures = seedAgentGfsFixtures(OWNER_EMAIL)
    agentLabel = getManagedAgentDisplayName(fixtures.agent)
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
        await enterAgentChat(page, agentLabel)
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

  // Issue #666: the Global Files picker sends the selection as a structured
  // FileReference; the Host resolves it and lists it in the turn context. The
  // message names no file, so the read can only come from the reference.
  // Requires a renderer built with VITE_SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM=true
  // (scripts/e2e/playwright-dev.sh exports it before the Desktop build).
  test('agent reads a file selected in the Global Files picker (#666)', async () => {
    const { app, page } = await launchAndLogin(OWNER_EMAIL)
    try {
      await test.step('precondition: renderer built with the Global Files composer item', async () => {
        await enterAgentChat(page, agentLabel)
        await startFreshThread(page)
        await page.getByRole('button', { name: 'Add context' }).click()
        await expect(
          page.getByRole('menuitem', { name: 'Global File System' }),
          'The "Add context" menu has no "Global File System" item: the Desktop renderer was ' +
            'built without VITE_SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM=true. Rebuild the renderer ' +
            'with that flag (scripts/e2e/playwright-dev.sh exports it) and rerun.'
        ).toBeVisible({ timeout: 5_000 })
      })

      await test.step('user attaches the file from the Global Files picker', async () => {
        await page.getByRole('menuitem', { name: 'Global File System' }).click()
        const picker = page.getByRole('dialog', { name: 'Choose files for this message' })
        await expect(picker).toBeVisible({ timeout: 10_000 })
        const fileRow = picker
          .locator('.composer-global-files-row--file')
          .filter({ hasText: fixtures.granted.fileName })
        await expect(fileRow).toBeVisible({ timeout: 20_000 })
        await fileRow.getByRole('checkbox').check()
        await picker.getByRole('button', { name: 'Attach 1' }).click()
        await expect(picker).toHaveCount(0)
        await expect(
          page.getByRole('button', { name: `Remove ${fixtures.granted.fileName}` })
        ).toBeVisible()
      })

      let expandBtn: import('@playwright/test').Locator
      let hostLog: HostLogWindow
      await test.step('agent reads the attached file', async () => {
        hostLog = openHostLogWindow(fixtures.agent)
        const result = await sendGfsTask(
          page,
          'Quote the contents of the attached file verbatim. Do not answer from memory.'
        )
        expandBtn = result.expandBtn
        expect(result.response.toLowerCase()).not.toContain('not_mounted')
        expect(result.response.toLowerCase()).not.toContain('gfsc 503')
        expect(result.response.toLowerCase()).not.toContain('fetch failed')
      })

      await test.step('tool details prove the read of the referenced file', async () => {
        await expandBtn.click()
        const readRow = toolStepRow(page, 'gfs_read')
        await expect(readRow).toBeVisible({ timeout: 10_000 })
        await expect(readRow.locator('.stepper-step-duration.state-error')).toHaveCount(0)
        await readRow.click()
        const readOutput = readRow
          .locator('xpath=following-sibling::*[@data-testid="step-output-panel"][1]')
          .locator('.stepper-step-output-code')
        await expect(readOutput).toBeVisible({ timeout: 10_000 })
        await expect(readOutput).toContainText(`E2E GFS file fixture: ${fixtures.granted.name}`)
      })

      await test.step('Host log proves it resolved the reference', async () => {
        // The same container must have served the turn, or the window
        // anchored before the send would belong to a different log.
        expect(liveHostPod(fixtures.agent), 'Host pod replaced during the turn').toBe(hostLog.pod)
        expect(
          hostContainerRestarts(fixtures.agent, hostLog.pod),
          'mcp-host container restarted during the turn'
        ).toBe(hostLog.restartCount)
        const events = fileReferenceResolvedLines(
          hostLogLinesSince(fixtures.agent, hostLog.pod, hostLog.since)
        )
        expect(events.length).toBeGreaterThan(hostLog.baseline)
        const newest = JSON.parse(events[events.length - 1] as string) as {
          referenceCount?: unknown
          availabilities?: unknown
        }
        expect(newest.referenceCount).toBe(1)
        expect(newest.availabilities).toEqual(['available'])
      })
    } finally {
      await app.close()
    }
  })

  test('agent is denied on a file the host has no grant for (403, never 503)', async () => {
    const { app, page } = await launchAndLogin(OWNER_EMAIL)
    try {
      await test.step('agent attempts to read the ungranted gfs:// URI', async () => {
        await enterAgentChat(page, agentLabel)
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
