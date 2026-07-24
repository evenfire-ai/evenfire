/**
 * Issue #797 T2: real Desktop login -> exact Agent A -> native Copy/Rename ->
 * exact Agent B denial -> audited revoke -> same-runtime Agent A denial.
 * SQL/PVC and grant operations are named preconditions/assertions only; no
 * fixture helper performs the agent mutations under test.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'
import {
  type AgentGfsCopyFixtures,
  assertGfsInfraHealthy,
  countGfsLiveChildrenByName,
  getGfsChildResourceSummary,
  getGfsTreeAclShareCounts,
  getGfsTreeAclShareRows,
  getGfsTreeSnapshot,
  gfsGrantRevokeAuditCount,
  revokeGfsGrantViaControlApi,
  seedAgentGfsCopyFixtures,
} from './helpers/gfsFixtures'
import { exactNameFilter } from './helpers/agentLocators'
import { getManagedAgentPodIdentity } from './helpers/gfsAgentDiscovery'
import { openAgentsPage, openResourcesNavItem } from './navigationHelpers'
import { launchAndLogin } from './workflowUi'

const OWNER_EMAIL = 'test@clerum.io'
// Multi-tool turns (rename + recursive list + read-every-file) on the local
// glm profile routinely exceed the 180s single-turn calibration.
const RESPONSE_TIMEOUT_MS = 300_000
const SENSITIVE_OUTPUT =
  /\/data\/gfs|\/mnt\/|\.generations|blob_key|blobKey|\bSQL\b|internal (?:path|error)|stack trace/i

async function openExactAgent(
  page: Page,
  agentName: string,
  opts: { reuseThread?: boolean } = {}
): Promise<void> {
  await openAgentsPage(page)
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  const row = page.getByLabel(`Open details for ${agentName}`, { exact: true })
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
  if (!(await boundSwitcher.or(breadcrumb).first().isVisible().catch(() => false))) {
    await switcher.first().click()
    await page.getByRole('menuitem', { name: agentName, exact: true }).click()
  }
  // A stateless agent suspended at idle wakes through the rpc-proxy
  // wake-and-hold path (up to ~90s of scale-up) before its chat shell binds;
  // the binding element itself remains mandatory and is the LAST gate before
  // any turn is sent.
  await expect(boundSwitcher.or(breadcrumb).first()).toBeVisible({ timeout: 120_000 })
  if (opts.reuseThread) {
    // reuseThread continues the agent's MOST-RECENT session. Callers must drive
    // purely by visible NAMES here (never resource identifiers), because which
    // of the agent's threads is most-recent is not guaranteed: any earlier step
    // that opens a fresh thread for this agent becomes the newest one, so the
    // reused prompt must not presume a specific prior conversation history.
    await page.locator('.agent-dedicated-session-title-btn').first().click()
    await expect(page.getByTestId('agent-response').first()).toBeVisible({ timeout: 15_000 })
  } else {
    await expect(page.getByTestId('agent-response')).toHaveCount(0, { timeout: 10_000 })
  }
}

async function sendAgentTurn(page: Page, prompt: string): Promise<Locator> {
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
    if (remaining <= 0) throw new Error('timed out waiting for the issue #797 agent turn')
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
        `[gfs-agent-copy] "Retry last send" pressed (attempt ${sendRetries}/3) for turn: ${turnLabel}`
      )
      test
        .info()
        .annotations.push({
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
  const expand = page.getByTestId('progress-expand-btn').nth(progressIndex)
  await expect(expand).toBeVisible({ timeout: 30_000 })
  await expand.click()
  return expand.locator('..')
}

function toolRow(stepper: Locator, name: string): Locator {
  return stepper.locator('.stepper-step').filter({ hasText: name }).last()
}

async function expectToolSuccess(stepper: Locator, name: string): Promise<void> {
  const row = toolRow(stepper, name)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('.stepper-step-fn')).toContainText(name)
  await expect(row.locator('.stepper-step-duration.state-error')).toHaveCount(0)
}

async function expectToolForbidden(stepper: Locator, name: string): Promise<void> {
  const row = toolRow(stepper, name)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('.stepper-step-fn')).toContainText(name)
  await expect(row.locator('.stepper-step-duration.state-error')).toContainText(/gfsc 403.*forbidden/i)
  await expect(row).not.toContainText(/gfsc 503|not_mounted/i)
  await expect(stepper).not.toContainText(SENSITIVE_OUTPUT)
}

async function expectToolConflict(stepper: Locator, name: string): Promise<void> {
  // A copy onto an existing name is a non-destructive conflict: gfsc maps
  // already_exists to 409, which mcp-host redacts to `gfsc 409: conflict`.
  // It must never read as a 503/not_mounted infra failure and must never leak
  // server internals.
  const row = toolRow(stepper, name)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('.stepper-step-fn')).toContainText(name)
  await expect(row.locator('.stepper-step-duration.state-error')).toContainText(/gfsc 409.*conflict/i)
  await expect(row).not.toContainText(/gfsc 503|not_mounted/i)
  await expect(stepper).not.toContainText(SENSITIVE_OUTPUT)
}

async function expectCopyPublicOutput(stepper: Locator): Promise<void> {
  // The step-output panel renders the mcp-host preview, which truncates each
  // line at 200 chars (toolUseLoopPreviews MAX_LINE_LENGTH) — a single-line
  // copy JSON is cut after ok/requestId/resourceId/gfsUri. Those visible
  // fields are asserted here; name and object/file/folder counts are business
  // signals proven from the database right after each copy (child-by-name
  // lookup plus full tree-snapshot equality), where truncation cannot hide a
  // wrong result.
  const row = toolRow(stepper, 'gfs_copy')
  await row.click()
  const output = row
    .locator('xpath=following-sibling::*[@data-testid="step-output-panel"][1]')
    .locator('.stepper-step-output-code')
  await expect(output).toBeVisible({ timeout: 10_000 })
  await expect(output).toContainText('"ok":true')
  await expect(output).toContainText('"requestId":')
  await expect(output).toContainText('"resourceId":')
  await expect(output).toContainText('"gfsUri":"gfs://main/')
  await expect(output).not.toContainText(SENSITIVE_OUTPUT)
}

function comparableTree(root: ReturnType<typeof getGfsTreeSnapshot>) {
  return root.map(({ relativePath, kind, bytes, content }) => ({ relativePath, kind, bytes, content }))
}

async function openFilesBrowser(page: Page): Promise<Locator> {
  await openResourcesNavItem(page, 'nav-files')
  const browser = page.getByRole('region', { name: 'Global File System browser' })
  await expect(browser).toBeVisible({ timeout: 20_000 })
  return browser
}

async function browseSourceTree(page: Page, fixtures: AgentGfsCopyFixtures): Promise<void> {
  const browser = await openFilesBrowser(page)
  await browser.getByRole('button', { name: fixtures.tree.sourceName, exact: true }).click()
  await expect(
    browser.getByRole('button', { name: fixtures.tree.standaloneFileName, exact: true })
  ).toBeVisible()
  await browser.getByRole('button', { name: 'nested', exact: true }).click()
  await expect(browser.getByRole('button', { name: 'alpha.txt', exact: true })).toBeVisible()
  await browser.getByRole('button', { name: 'empty', exact: true }).click()
  await expect(browser.getByText('This folder is empty', { exact: true })).toBeVisible()
}

async function browseDestinationTree(page: Page, fixtures: AgentGfsCopyFixtures): Promise<void> {
  const browser = await openFilesBrowser(page)
  await browser.getByRole('button', { name: fixtures.tree.destinationName, exact: true }).click()
  await expect(browser.getByRole('button', { name: fixtures.fileCopyName, exact: true })).toBeVisible()
  await browser.getByRole('button', { name: fixtures.renamedFolderName, exact: true }).click()
  await expect(browser.getByRole('button', { name: 'nested', exact: true })).toBeVisible()
  await browser.getByRole('button', { name: 'nested', exact: true }).click()
  await expect(browser.getByRole('button', { name: 'alpha.txt', exact: true })).toBeVisible()
  await expect(browser.getByRole('button', { name: 'deeper', exact: true })).toBeVisible()
  await browser.getByRole('button', { name: 'empty', exact: true }).click()
  await expect(browser.getByText('This folder is empty', { exact: true })).toBeVisible()
}

test.describe('GFS per-agent native Copy and immediate grant enforcement (issue #797)', () => {
  test.describe.configure({ mode: 'serial' })
  let fixtures: AgentGfsCopyFixtures

  test.beforeAll(() => {
    assertGfsInfraHealthy()
    fixtures = seedAgentGfsCopyFixtures(OWNER_EMAIL)
  })

  test.afterAll(() => fixtures?.cleanup())

  test('copies complete trees and revokes destination access in one runtime', async ({}, testInfo) => {
    // Four real LLM turns (each allowed RESPONSE_TIMEOUT_MS) plus Electron
    // login and two Files-tree walks cannot fit the 240s config default.
    testInfo.setTimeout(1_200_000)
    const sourceBefore = getGfsTreeSnapshot(fixtures.tree.sourceResourceId)
    const sourceAclShareBefore = getGfsTreeAclShareRows(fixtures.tree.sourceResourceId)
    const sourceAclShareRecords = sourceAclShareBefore.map(
      row => JSON.parse(row) as { kind: 'grant' | 'share'; row: Record<string, unknown> }
    )
    expect(
      sourceAclShareRecords.filter(
        record =>
          record.kind === 'share' &&
          record.row.id === fixtures.sourceShareId &&
          record.row.subject_id === fixtures.sourceShareSubjectId
      )
    ).toHaveLength(1)
    expect(
      sourceAclShareRecords.filter(
        record =>
          record.kind === 'grant' && record.row.subject_id === fixtures.sourceShareSubjectId
      )
    ).toHaveLength(0)
    expect(getGfsTreeAclShareCounts(fixtures.tree.sourceResourceId).shares).toBeGreaterThanOrEqual(1)
    const { app, page } = await launchAndLogin(OWNER_EMAIL)
    try {
      await test.step('Agent A copies one file through the native tool', async () => {
        await browseSourceTree(page, fixtures)
        await openExactAgent(page, fixtures.agentA.name)
        const steps = await sendAgentTurn(
          page,
          `In drive main, open the folder named "${fixtures.tree.sourceName}" and read the file ` +
            `"${fixtures.tree.standaloneFileName}" inside it. Then copy that file into the folder ` +
            `named "${fixtures.tree.destinationName}", naming the copy "${fixtures.fileCopyName}". ` +
            `Use only your native Clerum GFS tools; never download and re-upload content yourself.`
        )
        await expectToolSuccess(steps, 'gfs_read')
        await expectToolSuccess(steps, 'gfs_copy')
        await expectCopyPublicOutput(steps)
        const copied = getGfsChildResourceSummary({
          parentResourceId: fixtures.tree.destinationResourceId,
          name: fixtures.fileCopyName,
        })
        expect(copied).not.toBeNull()
        expect(copied?.resourceId).not.toBe(fixtures.tree.standaloneFileResourceId)
        const copiedTree = getGfsTreeSnapshot(copied!.resourceId)
        const sourceFile = sourceBefore.find(node => node.resourceId === fixtures.tree.standaloneFileResourceId)
        expect(comparableTree(copiedTree)).toEqual([
          { relativePath: '.', kind: 'file', bytes: sourceFile!.bytes, content: sourceFile!.content },
        ])
        expect(getGfsTreeAclShareRows(fixtures.tree.sourceResourceId)).toEqual(sourceAclShareBefore)
        expect(getGfsTreeAclShareCounts(copied!.resourceId)).toEqual({ grants: 0, shares: 0 })
      })

      await test.step('Agent A recursively copies the complete folder', async () => {
        const steps = await sendAgentTurn(
          page,
          `Now copy the complete folder named "${fixtures.tree.sourceName}" from drive main into ` +
            `the folder named "${fixtures.tree.destinationName}", naming the copy ` +
            `"${fixtures.folderCopyName}". Make exactly one copy; do not move or delete anything.`
        )
        await expectToolSuccess(steps, 'gfs_copy')
        await expectCopyPublicOutput(steps)
      })

      await test.step('Agent A renames the copied root and reads it back', async () => {
        // A separate short turn keeps the user intent unambiguous: renaming
        // must never be "helpfully" followed by a fresh copy of the old name.
        const steps = await sendAgentTurn(
          page,
          `Rename the copy named "${fixtures.folderCopyName}" (inside ` +
            `"${fixtures.tree.destinationName}") to "${fixtures.renamedFolderName}". Then list ` +
            `that renamed folder recursively and read every file inside it. Do not copy, move, ` +
            `or delete anything.`
        )
        await expectToolSuccess(steps, 'gfs_rename')
        await expectToolSuccess(steps, 'gfs_list')
        await expectToolSuccess(steps, 'gfs_read')
      })

      await test.step('visible browse and persisted tree prove Copy did real work', async () => {
        const copied = getGfsChildResourceSummary({
          parentResourceId: fixtures.tree.destinationResourceId,
          name: fixtures.renamedFolderName,
        })
        expect(copied).not.toBeNull()
        expect(
          getGfsChildResourceSummary({
            parentResourceId: fixtures.tree.destinationResourceId,
            name: fixtures.folderCopyName,
          })
        ).toBeNull()
        const copiedTree = getGfsTreeSnapshot(copied!.resourceId)
        expect(comparableTree(copiedTree)).toEqual(comparableTree(sourceBefore))
        for (const source of sourceBefore) {
          expect(copiedTree.map(node => node.resourceId)).not.toContain(source.resourceId)
        }
        expect(getGfsTreeSnapshot(fixtures.tree.sourceResourceId)).toEqual(sourceBefore)
        expect(getGfsTreeAclShareRows(fixtures.tree.sourceResourceId)).toEqual(sourceAclShareBefore)
        expect(getGfsTreeAclShareCounts(copied!.resourceId)).toEqual({ grants: 0, shares: 0 })
        await browseDestinationTree(page, fixtures)
      })

      await test.step('copying onto an existing name is a non-destructive conflict (no duplicate)', async () => {
        // The file copy from the first step already put `fileCopyName` under the
        // destination. Copying the same source file there under the same name
        // must be refused (already_exists → gfsc 409), and — the load-bearing
        // business signal — must leave exactly one live child with that name.
        const beforeSummary = getGfsChildResourceSummary({
          parentResourceId: fixtures.tree.destinationResourceId,
          name: fixtures.fileCopyName,
        })
        expect(beforeSummary).not.toBeNull()
        expect(
          countGfsLiveChildrenByName({
            parentResourceId: fixtures.tree.destinationResourceId,
            name: fixtures.fileCopyName,
          })
        ).toBe(1)
        // Fresh thread on purpose: A has no memory of the earlier copy, so it
        // must actually re-attempt the copy by name and surface the tool's real
        // result rather than answering "already done" from context.
        await openExactAgent(page, fixtures.agentA.name)
        const steps = await sendAgentTurn(
          page,
          `In drive main, copy the file "${fixtures.tree.standaloneFileName}" from the folder ` +
            `"${fixtures.tree.sourceName}" into the folder "${fixtures.tree.destinationName}", ` +
            `naming the copy "${fixtures.fileCopyName}". Use your native Clerum GFS copy tool and ` +
            `report exactly what it returns. Attempt the copy even if a listing suggests the name ` +
            `already exists — do not decline based on a prior listing — and do not rename, delete, ` +
            `or overwrite anything.`
        )
        await expectToolConflict(steps, 'gfs_copy')
        // The existing copy is untouched and NO duplicate row was created.
        const afterSummary = getGfsChildResourceSummary({
          parentResourceId: fixtures.tree.destinationResourceId,
          name: fixtures.fileCopyName,
        })
        expect(afterSummary?.resourceId).toBe(beforeSummary?.resourceId)
        expect(
          countGfsLiveChildrenByName({
            parentResourceId: fixtures.tree.destinationResourceId,
            name: fixtures.fileCopyName,
          })
        ).toBe(1)
      })

      await test.step('Agent B passes root/destination grants but unreadable child denies the tree', async () => {
        await openExactAgent(page, fixtures.agentB.name)
        const steps = await sendAgentTurn(
          page,
          `Copy the folder named "${fixtures.tree.sourceName}" from drive main into the folder ` +
            `named "${fixtures.tree.destinationName}", naming the copy "${fixtures.deniedCopyName}". ` +
            `Attempt the copy with your native Clerum GFS copy tool and report exactly what it ` +
            `returns — do not decline based on a prior listing, even if it looks like you lack access.`
        )
        await expectToolForbidden(steps, 'gfs_copy')
        expect(
          getGfsChildResourceSummary({
            parentResourceId: fixtures.tree.destinationResourceId,
            name: fixtures.deniedCopyName,
          })
        ).toBeNull()
      })

      await test.step('audited revoke denies Agent A immediately in the same runtime', async () => {
        await openExactAgent(page, fixtures.agentA.name, { reuseThread: true })
        const runtimeBefore = getManagedAgentPodIdentity(fixtures.agentA)
        const auditBefore = gfsGrantRevokeAuditCount(fixtures.agentA)
        await revokeGfsGrantViaControlApi(fixtures.destinationGrantId)
        expect(gfsGrantRevokeAuditCount(fixtures.agentA)).toBe(auditBefore + 1)
        const steps = await sendAgentTurn(
          page,
          `Copy the folder "${fixtures.tree.sourceName}" into the folder ` +
            `"${fixtures.tree.destinationName}", naming the copy ` +
            `"${fixtures.revokedCopyName}". Attempt the copy with your native Clerum GFS copy ` +
            `tool and report exactly what it returns — do not decline based on a prior listing, ` +
            `even if it looks like you lack access.`
        )
        // Under name driving, revoking the destination removes even its
        // resolvability (no-disclosure): the visible denial surfaces on the
        // agent's own discovery tool (gfsc 403/404) BEFORE any gfs_copy can be
        // issued. Require a gfsc-denied tool row, forbid any successful
        // gfs_copy, and keep the infra-shape negatives.
        const deniedGfsRow = steps
          .locator('.stepper-step-duration.state-error')
          .filter({ hasText: /gfsc 40[34]/ })
        await expect(deniedGfsRow.first()).toBeVisible({ timeout: 15_000 })
        const successfulCopy = steps
          .locator('.stepper-step')
          .filter({ has: page.locator('.stepper-step-fn', { hasText: 'gfs_copy' }) })
          .filter({ hasNot: page.locator('.stepper-step-duration.state-error') })
        await expect(successfulCopy).toHaveCount(0)
        await expect(steps).not.toContainText(/gfsc 503|not_mounted/i)
        await expect(steps).not.toContainText(SENSITIVE_OUTPUT)
        // Same-runtime proof: the denial must come from live cache
        // invalidation, not from a pod restart re-reading grants.
        expect(getManagedAgentPodIdentity(fixtures.agentA)).toBe(runtimeBefore)
        expect(
          getGfsChildResourceSummary({
            parentResourceId: fixtures.tree.destinationResourceId,
            name: fixtures.revokedCopyName,
          })
        ).toBeNull()
      })

      expect(getGfsTreeSnapshot(fixtures.tree.sourceResourceId)).toEqual(sourceBefore)
    } finally {
      await app.close()
    }
  })
})
