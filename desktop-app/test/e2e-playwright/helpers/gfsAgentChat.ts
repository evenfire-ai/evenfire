/**
 * Agent chat driving and GFS tool-evidence assertions shared by the Desktop
 * GFS journeys (extracted unchanged from gfs-agent-delegation.test.ts so the
 * per-user home journeys reuse the same proven contract instead of a copy).
 *
 * Business truth for an agent operation is the tool stepper evidence plus the
 * run-unique sentinel; a denial is an observed authorization refusal (no
 * successful gfs_read, no sentinel leak, no infra 503/not_mounted shape),
 * never a timeout.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'
import { openAgentsPage } from '../navigationHelpers'
import { exactNameFilter } from './agentLocators'

// glm-5.1 calibration (repo baseline): single agent turns can take minutes;
// multi-tool turns (discover + read/write) share the 300s budget proven by the
// issue #797 copy suite.
export const RESPONSE_TIMEOUT_MS = 300_000
export const SENSITIVE_OUTPUT =
  /\/data\/gfs|\/mnt\/|\.generations|blob_key|blobKey|\bSQL\b|internal (?:path|error)|stack trace/i

export async function openExactAgent(
  page: Page,
  // The rendered label (Host `spec.host`), not the CRD name.
  agentName: string,
  opts: { reuseThread?: boolean } = {}
): Promise<void> {
  await openAgentsPage(page)
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  const row = page.getByLabel(`Open agent ${agentName}`, { exact: true })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.getByText(agentName, { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('nav-chat').click()
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 })
  // Starting a new chat can reset the composer to the DEFAULT agent, so it
  // must happen BEFORE the agent switch — never after, or the turn silently
  // goes to the wrong agent.
  if (!opts.reuseThread) {
    const fresh = page.getByRole('button', { name: /new (?:chat|thread)/i }).first()
    if (await fresh.isVisible().catch(() => false)) await fresh.click()
  }
  // The product binds the composer to an agent ONLY through the chat view's
  // "Switch chat agent" selector — opening another agent's details page
  // deliberately does not switch the chat. Drive exactly that user flow.
  const switcher = page.getByRole('button', { name: 'Switch chat agent' })
  const boundSwitcher = switcher.filter(exactNameFilter(agentName))
  const breadcrumb = page
    .getByRole('navigation', { name: 'Chat breadcrumb' })
    .getByText(agentName, { exact: true })
  if (
    !(await boundSwitcher
      .or(breadcrumb)
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    await switcher.first().click()
    await page.getByRole('menuitem', { name: agentName, exact: true }).click()
  }
  // A stateless agent suspended at idle wakes through the rpc-proxy
  // wake-and-hold path (up to ~90s of scale-up) before its chat shell binds;
  // the binding element itself remains mandatory and is the LAST gate before
  // any turn is sent.
  await expect(boundSwitcher.or(breadcrumb).first()).toBeVisible({ timeout: 120_000 })
  if (opts.reuseThread) {
    // A revocation retry deliberately continues the agent's most recent
    // session: the user only repeats visible paths, and any resource
    // identifiers live in the agent's own conversational memory from its
    // previous discovery.
    await page.locator('.agent-dedicated-session-title-btn').first().click()
    await expect(page.getByTestId('agent-response').first()).toBeVisible({ timeout: 15_000 })
  } else {
    await expect(page.getByTestId('agent-response')).toHaveCount(0, { timeout: 10_000 })
  }
}

export async function sendAgentTurn(
  page: Page,
  prompt: string,
  logLabel = 'gfs-agent-delegation'
): Promise<{ stepper: Locator; responseText: string }> {
  const responseIndex = await page.getByTestId('agent-response').count()
  const approvalIndex = await page.getByTestId('approval-approve-btn').count()
  const progressIndex = await page.getByTestId('progress-expand-btn').count()
  await expect(page.getByTestId('chat-input')).toBeEnabled()
  await page.getByTestId('chat-input').fill(prompt)
  await page.getByTestId('send-button').click()

  const response = page.getByTestId('agent-response').nth(responseIndex)
  const retrySend = page.getByRole('button', { name: 'Retry last send' })
  let approvals = 0
  let sendRetries = 0
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`timed out waiting for the ${logLabel} agent turn`)
    // A just-restarted runtime can drop the send with a visible "Temporary
    // connection issue" banner; a real user presses the product's own
    // "Retry last send". Bounded — a persistent failure still fails the turn.
    if (await retrySend.isVisible().catch(() => false)) {
      if (sendRetries >= 3) throw new Error('agent send kept failing after 3 product retries')
      sendRetries += 1
      // An absorbed retry must be LOUD in a green run: warn on the console
      // and annotate the test report, without changing pass/fail semantics.
      const turnLabel = prompt.slice(0, 80)
      console.warn(
        `[${logLabel}] "Retry last send" pressed (attempt ${sendRetries}/3) for turn: ${turnLabel}`
      )
      test.info().annotations.push({
        type: 'retry-last-send',
        description: `attempt ${sendRetries}/3 for turn: ${turnLabel}`,
      })
      await retrySend.click()
      continue
    }
    const approval = page.getByTestId('approval-approve-btn').nth(approvalIndex + approvals)
    const approvalWait = approval
      .waitFor({ state: 'visible', timeout: Math.min(remaining, 10_000) })
      .then(() => 'approval' as const)
    const responseWait = response
      .waitFor({ state: 'visible', timeout: Math.min(remaining, 10_000) })
      .then(() => 'response' as const)
    // The losing waitFor keeps its timer; silence its eventual rejection so a
    // settled turn cannot surface a late "Target closed" unhandled rejection.
    // .catch() returns a NEW promise, so the originals still race unchanged.
    void approvalWait.catch(() => undefined)
    void responseWait.catch(() => undefined)
    let visible: 'approval' | 'response'
    try {
      visible = await Promise.race([approvalWait, responseWait])
    } catch {
      // Neither appeared within this slice; loop to re-check the retry banner
      // and the overall deadline.
      continue
    }
    if (visible === 'response') break
    await approval.click()
    approvals += 1
  }
  await expect(response).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS })
  const responseText = (await response.textContent()) ?? ''
  const expand = page.getByTestId('progress-expand-btn').nth(progressIndex)
  await expect(expand).toBeVisible({ timeout: 30_000 })
  await expand.click()
  return { stepper: expand.locator('..'), responseText }
}

export function toolRow(stepper: Locator, name: string): Locator {
  return stepper.locator('.stepper-step').filter({ hasText: name }).last()
}

export async function expectToolSuccess(stepper: Locator, name: string): Promise<void> {
  const row = toolRow(stepper, name)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('.stepper-step-fn')).toContainText(name)
  await expect(row.locator('.stepper-step-duration.state-error')).toHaveCount(0)
}

/**
 * The step-output panel renders the head of the tool result payload — the
 * run-unique sentinel can only be there if gfsc actually served the file
 * content from the real PVC. The OutputPanel is a SIBLING of the step row, so
 * row→panel binds via following-sibling.
 */
export async function expectReadWithSentinel(stepper: Locator, sentinel: string): Promise<void> {
  await expectToolSuccess(stepper, 'gfs_read')
  const row = toolRow(stepper, 'gfs_read')
  await row.click()
  const output = row
    .locator('xpath=following-sibling::*[@data-testid="step-output-panel"][1]')
    .locator('.stepper-step-output-code')
  await expect(output).toBeVisible({ timeout: 10_000 })
  await expect(output).toContainText(sentinel)
  await expect(output).not.toContainText(SENSITIVE_OUTPUT)
}

export function assertNoInfraFailureShape(responseText: string): void {
  // Credential repair must be distinguishable from resource authorization: a
  // not_mounted/503 here means the permission store broke (issue #775 shape),
  // which must NEVER read as a denial pass.
  expect(responseText.toLowerCase()).not.toContain('not_mounted')
  expect(responseText.toLowerCase()).not.toContain('gfsc 503')
  expect(responseText.toLowerCase()).not.toContain('fetch failed')
}

/**
 * Write-denial contract for an agent that can read the file but holds no
 * write bit: the agent really attempted `gfs_write`, every attempt ended in
 * an error state (zero successful writes), no infra 503/not_mounted shape
 * appeared, and the denied text never reached the transcript. The caller then
 * proves the content is unchanged with an authorized read.
 */
export async function expectWriteRefused(
  turn: { stepper: Locator; responseText: string },
  deniedText: string
): Promise<void> {
  const page = turn.stepper.page()
  assertNoInfraFailureShape(turn.responseText)
  expect(turn.responseText).not.toContain(deniedText)
  const writeSteps = turn.stepper
    .locator('.stepper-step')
    .filter({ has: page.locator('.stepper-step-fn', { hasText: 'gfs_write' }) })
  await expect(writeSteps.first()).toBeVisible({ timeout: 15_000 })
  const successfulWrite = writeSteps.filter({
    hasNot: page.locator('.stepper-step-duration.state-error'),
  })
  await expect(successfulWrite).toHaveCount(0)
  await expect(turn.stepper).not.toContainText(/gfsc 503|not_mounted/i)
}

/**
 * No-disclosure denial contract for NAME/PATH driving (pattern from
 * gfs-agent-file-read.test.ts): an ungranted agent cannot even resolve the
 * resource, so a denied file is deliberately indistinguishable from an absent
 * one. The contract is: the agent really attempted its gfs tools, NO gfs_read
 * ever succeeded, nothing leaked the sentinel content, and no infra
 * 503/not_mounted shape appeared.
 */
export async function expectNoDisclosureDenial(
  turn: { stepper: Locator; responseText: string },
  forbiddenSentinels: string[]
): Promise<void> {
  const page = turn.stepper.page()
  assertNoInfraFailureShape(turn.responseText)
  for (const sentinel of forbiddenSentinels) {
    expect(turn.responseText).not.toContain(sentinel)
  }
  const gfsSteps = turn.stepper
    .locator('.stepper-step')
    .filter({ has: page.locator('.stepper-step-fn', { hasText: /gfs_/ }) })
  await expect(gfsSteps.first()).toBeVisible({ timeout: 15_000 })
  const successfulRead = turn.stepper
    .locator('.stepper-step')
    .filter({ has: page.locator('.stepper-step-fn', { hasText: 'gfs_read' }) })
    .filter({ hasNot: page.locator('.stepper-step-duration.state-error') })
  await expect(successfulRead).toHaveCount(0)
  await expect(turn.stepper).not.toContainText(/gfsc 503|not_mounted/i)
  await expect(turn.stepper).not.toContainText(SENSITIVE_OUTPUT)
  for (const sentinel of forbiddenSentinels) {
    await expect(turn.stepper).not.toContainText(sentinel)
  }
}
