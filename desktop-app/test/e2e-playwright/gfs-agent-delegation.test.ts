/**
 * E2E — Desktop per-agent GFS delegation (plan "compressed-drifting-matsumoto",
 * ADDENDUM 1): full pre/post permission sequence with TWO agents.
 *
 * One serial suite, two serial tests sharing beforeAll fixtures:
 *
 * Test 1 — "agents have no access until granted; grant gives A read AND write":
 *   1. Pre-grant negative (chat): A, then B, asked to read the file by its
 *      visible path → no-disclosure denial for BOTH (zero successful gfs_read,
 *      no sentinel leak, no gfsc 503/not_mounted).
 *   2. Grant via UI: Files → Options for <folder> → Manage → Agents section →
 *      select A only → read+write, inherit ON → Grant. Toast + gfs_grants row
 *      (host subject = A, permissions read/write, inherit true) via SQL helper.
 *   3. Chat A read: sentinel content surfaces from the real PVC.
 *   4. Chat A write: A replaces the file content (its own tools discover
 *      If-Match); new content + bumped version asserted in DB and on the PVC.
 *   5. Isolation: B (stateless — exercises the wake path) still denied.
 *
 * Test 2 — "stateless agent grant + revoke keeps agents isolated":
 *   1. Grant B via UI: second Manage round → select B → read → Grant; row
 *      asserted in DB.
 *   2. Chat B read: B reads the MODIFIED sentinel (stateless runtime + fresh
 *      grant proven together).
 *   3. Revoke A via UI: Manage → grants list → Revoke on A's row. Toast + row
 *      deleted + gfsGrantRevokeAuditCount +1.
 *   4. Same-runtime denial for A: retry in A's existing thread is denied with
 *      NO content disclosure (no successful gfs_read, no sentinel, no infra-
 *      shape leak — per the name/path indistinguishability contract; a bare
 *      403/404 code is intentionally NOT asserted) and pod UID/startTime
 *      invariance (no restart).
 *   5. B unaffected: B reads again — revocation is isolated in both directions.
 *
 * E2E contract (e2e-test-guardian / human-driving):
 *  - Prompts and UI driving reference ONLY visible names and paths; business
 *    truth is always asserted from the database and the PVC via the shared
 *    SQL/kubectl helpers. No fixture helper performs the grant/revoke under
 *    test — those happen exclusively through the Manage modal UI.
 *  - Infra guard: gfsc unhealthy ⇒ the suite THROWS (never skips, never mocks).
 */
import { type Locator, type Page, expect, test } from '@playwright/test'
import { exactNameFilter } from './helpers/agentLocators'
import { getManagedAgentPodIdentity } from './helpers/gfsAgentDiscovery'
import {
  type ManagedGfsAgent,
  assertGfsInfraHealthy,
  discoverManagedGfsAgents,
  getGfsTreeSnapshot,
  gfsGrantRevokeAuditCount,
} from './helpers/gfsFixtures'
import {
  type GfsFileFixture,
  cleanupGfsFixture,
  getE2EUserId,
  seedGfsFileFixture,
  seedGfsGrant,
  uniqueGfsFixtureName,
} from '../../../tests/e2e/gfsUiFixtures'
import { getGfsHostGrantsUnderTree } from '../../../tests/e2e/gfsCopyFixtures'
import { openAgentsPage, openResourcesNavItem } from './navigationHelpers'
import { launchAndLogin } from './workflowUi'

const OWNER_EMAIL = 'test@clerum.io'
// glm-5.1 calibration (repo baseline): single agent turns can take minutes;
// multi-tool turns (discover + read/write) share the 300s budget proven by the
// issue #797 copy suite.
const RESPONSE_TIMEOUT_MS = 300_000
const SENSITIVE_OUTPUT =
  /\/data\/gfs|\/mnt\/|\.generations|blob_key|blobKey|\bSQL\b|internal (?:path|error)|stack trace/i

interface AgentGfsDelegationFixtures {
  /** Stateful journey agent (grantee of read+write, later revoked). */
  agentA: ManagedGfsAgent
  /** Stateless journey agent (wake path; read-only grantee, never revoked). */
  agentB: ManagedGfsAgent
  /** Seeded folder + file; the file carries the run-unique original sentinel. */
  folder: GfsFileFixture
  /** Exact content sentinel seeded into the file (PVC truth). */
  originalSentinel: string
  /** Exact replacement sentinel Agent A is asked to write in Test 1. */
  modifiedSentinel: string
  cleanup(): void
}

/**
 * Named setup preconditions ONLY (performed outside the journeys under test):
 * a folder+file the OWNER can see and manage. The owner grant carries
 * read+write (escalation guard: you can only grant bits you hold) and
 * manage_acl (Manage-modal delegation affordance + grants GET). NO host grant
 * is seeded — creating and revoking those is exactly what the UI journeys
 * must do themselves.
 */
function seedAgentGfsDelegationFixtures(ownerEmail: string): AgentGfsDelegationFixtures {
  const [agentA, agentB] = discoverManagedGfsAgents()
  const folder = seedGfsFileFixture(uniqueGfsFixtureName('e2e-gfs-agent-delegation'))
  try {
    seedGfsGrant({
      resourceId: folder.resourceId,
      subjectType: 'user',
      subjectId: getE2EUserId(ownerEmail),
      permissions: ['read', 'write', 'manage_acl'],
      inherit: true,
      grantedBy: 'e2e:gfs-agent-delegation-owner',
    })
    for (const agent of [agentA, agentB]) {
      if (getGfsHostGrantsUnderTree(folder.resourceId, agent.subjectId).length !== 0) {
        throw new Error(
          `delegation fixture must start with ZERO host grants for ${agent.subjectId} — ` +
            'the pre-grant denial phase would be meaningless'
        )
      }
    }
    return {
      agentA,
      agentB,
      folder,
      originalSentinel: `E2E GFS file fixture: ${folder.name}`,
      modifiedSentinel: `Delegated write sentinel ${folder.name} rewritten by the granted agent`,
      cleanup: () => cleanupGfsFixture(folder.name),
    }
  } catch (error) {
    try {
      cleanupGfsFixture(folder.name)
    } catch (cleanupError) {
      throw new Error(
        `GFS delegation setup failed (${String(error)}) and cleanup failed (${String(cleanupError)})`
      )
    }
    throw error
  }
}

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
    // The revocation retry deliberately continues the agent's most recent
    // session: the user only repeats visible paths, and any resource
    // identifiers live in the agent's own conversational memory from its
    // previous discovery.
    await page.locator('.agent-dedicated-session-title-btn').first().click()
    await expect(page.getByTestId('agent-response').first()).toBeVisible({ timeout: 15_000 })
  } else {
    await expect(page.getByTestId('agent-response')).toHaveCount(0, { timeout: 10_000 })
  }
}

async function sendAgentTurn(
  page: Page,
  prompt: string
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
    if (remaining <= 0) throw new Error('timed out waiting for the delegation-suite agent turn')
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
        `[gfs-agent-delegation] "Retry last send" pressed (attempt ${sendRetries}/3) for turn: ${turnLabel}`
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

function toolRow(stepper: Locator, name: string): Locator {
  return stepper.locator('.stepper-step').filter({ hasText: name }).last()
}

async function expectToolSuccess(stepper: Locator, name: string): Promise<void> {
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
async function expectReadWithSentinel(stepper: Locator, sentinel: string): Promise<void> {
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

function assertNoInfraFailureShape(responseText: string): void {
  // Credential repair must be distinguishable from resource authorization: a
  // not_mounted/503 here means the permission store broke (issue #775 shape),
  // which must NEVER read as a denial pass.
  expect(responseText.toLowerCase()).not.toContain('not_mounted')
  expect(responseText.toLowerCase()).not.toContain('gfsc 503')
  expect(responseText.toLowerCase()).not.toContain('fetch failed')
}

/**
 * No-disclosure denial contract for NAME/PATH driving (pattern from
 * gfs-agent-file-read.test.ts): an ungranted agent cannot even resolve the
 * resource, so a denied file is deliberately indistinguishable from an absent
 * one. The contract is: the agent really attempted its gfs tools, NO gfs_read
 * ever succeeded, nothing leaked the sentinel content, and no infra
 * 503/not_mounted shape appeared.
 */
async function expectNoDisclosureDenial(
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

async function openFilesBrowser(page: Page): Promise<Locator> {
  await openResourcesNavItem(page, 'nav-files')
  const browser = page.getByRole('region', { name: 'Global File System browser' })
  await expect(browser).toBeVisible({ timeout: 20_000 })
  return browser
}

/**
 * Enters the fixture folder (visible-path proof: the user sees the file they
 * will later name to the agents) and opens the Manage dialog through the
 * folder's own "Options for <folder>" menu.
 */
async function openManageForFixtureFolder(
  page: Page,
  fixtures: AgentGfsDelegationFixtures
): Promise<Locator> {
  const browser = await openFilesBrowser(page)
  await browser.getByRole('button', { name: fixtures.folder.name, exact: true }).click()
  await expect(
    browser.getByRole('button', { name: fixtures.folder.fileName, exact: true })
  ).toBeVisible({ timeout: 20_000 })
  await browser.getByRole('button', { name: `Options for ${fixtures.folder.name}`, exact: true }).click()
  await browser.getByRole('menuitem', { name: 'Manage', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `Manage folder ${fixtures.folder.name}` })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  return dialog
}

async function closeManageDialog(page: Page, dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Close manage dialog', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /^Manage folder / })).toHaveCount(0)
}

/**
 * Drives the Agents section of the Manage dialog exactly as a user would:
 * select ONE agent by its visible name (asserting the other stays unselected),
 * optionally add Write in the permission dropdown, keep the directory-default
 * "Include contents of this folder" toggle ON, and press Grant. Success is a
 * product toast plus the agent's row appearing in the "Who has access" list
 * (list-after-write is mandatory: the grant PUT returns no ids).
 */
async function grantAgentAccessViaManageModal(
  page: Page,
  dialog: Locator,
  opts: { agentName: string; unselectedAgentName: string; includeWrite: boolean }
): Promise<void> {
  const agentSection = dialog.locator('.da-gfs-agent-access')
  await expect(agentSection).toBeVisible({ timeout: 20_000 })
  const agentGroup = agentSection.getByRole('group', { name: 'My agents' })
  await expect(agentGroup).toBeVisible({ timeout: 20_000 })
  const target = agentGroup.getByRole('button', { name: opts.agentName, exact: true })
  const untouched = agentGroup.getByRole('button', { name: opts.unselectedAgentName, exact: true })
  await expect(untouched).toBeVisible({ timeout: 20_000 })
  await target.click()
  await expect(target).toHaveAttribute('aria-pressed', 'true')
  await expect(untouched).toHaveAttribute('aria-pressed', 'false')
  if (opts.includeWrite) {
    // The agent dropdown starts at the read-only default; add Write through
    // the real menu (menuitemcheckbox), then close it by clicking the section
    // heading so the Grant press cannot be swallowed by the click-outside
    // handler.
    await agentSection.getByRole('button', { name: 'Read', exact: true }).click()
    const menu = agentSection.getByRole('menu', { name: 'Permissions' })
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Read' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await menu.getByRole('menuitemcheckbox', { name: 'Write' }).click()
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Write' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await agentSection.getByRole('heading', { name: 'Agents' }).click()
    await expect(
      agentSection.getByRole('button', { name: '2 permissions', exact: true })
    ).toBeVisible()
  } else {
    await expect(agentSection.getByRole('button', { name: 'Read', exact: true })).toBeVisible()
  }
  const inherit = agentSection.getByRole('checkbox', { name: 'Include contents of this folder' })
  // Directory default is ON — asserted, never toggled: a folder grant with
  // inherit=false would silently break the agent-reads-file journey.
  await expect(inherit).toBeChecked()
  await agentSection.getByRole('button', { name: 'Grant agent access', exact: true }).click()
  await expect(page.getByText('Access granted to 1 agent', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  })
  await expect(
    dialog.getByRole('button', { name: `Revoke access for ${opts.agentName}`, exact: true })
  ).toBeVisible({ timeout: 20_000 })
}

test.describe('GFS per-agent delegation: UI grant/revoke with full pre/post enforcement (Addendum 1)', () => {
  test.describe.configure({ mode: 'serial' })
  let fixtures: AgentGfsDelegationFixtures

  test.beforeAll(() => {
    // Infra guard FIRST: a broken permission-store credential is a blocker to
    // fix, never a reason to skip or mock (fail-loud rule).
    assertGfsInfraHealthy()
    fixtures = seedAgentGfsDelegationFixtures(OWNER_EMAIL)
  })

  test.afterAll(() => fixtures?.cleanup())

  test('agents have no access until granted; UI grant gives Agent A read AND write', async ({}, testInfo) => {
    // Four real LLM turns (each allowed RESPONSE_TIMEOUT_MS) plus Electron
    // login, one stateless wake (≤120s binding), and the Manage-modal grant
    // round cannot fit the 240s config default.
    testInfo.setTimeout(1_500_000)
    const filePath = `/${fixtures.folder.name}/${fixtures.folder.fileName}`
    const fileBefore = getGfsTreeSnapshot(fixtures.folder.fileResourceId)
    expect(fileBefore).toHaveLength(1)
    expect(fileBefore[0]!.kind).toBe('file')
    expect(fileBefore[0]!.content).toContain(fixtures.originalSentinel)
    const { app, page } = await launchAndLogin(OWNER_EMAIL)
    try {
      await test.step('user sees the delegated folder and file in the Files page', async () => {
        const browser = await openFilesBrowser(page)
        await browser.getByRole('button', { name: fixtures.folder.name, exact: true }).click()
        await expect(
          browser.getByRole('button', { name: fixtures.folder.fileName, exact: true })
        ).toBeVisible({ timeout: 20_000 })
      })

      await test.step('pre-grant: Agent A is denied without disclosure', async () => {
        await openExactAgent(page, fixtures.agentA.name)
        const turn = await sendAgentTurn(
          page,
          `Read the file at path "${filePath}" in GFS drive main and quote its contents ` +
            'verbatim. Do not answer from memory — attempt the read with your Clerum GFS tools ' +
            'even if the file is not in your listing.'
        )
        await expectNoDisclosureDenial(turn, [fixtures.originalSentinel])
      })

      await test.step('pre-grant: stateless Agent B is denied without disclosure', async () => {
        await openExactAgent(page, fixtures.agentB.name)
        const turn = await sendAgentTurn(
          page,
          `Read the file at path "${filePath}" in GFS drive main and quote its contents ` +
            'verbatim. Do not answer from memory — attempt the read with your Clerum GFS tools ' +
            'even if the file is not in your listing.'
        )
        await expectNoDisclosureDenial(turn, [fixtures.originalSentinel])
      })

      await test.step('UI grant: Agent A gets read+write with inherit ON', async () => {
        const dialog = await openManageForFixtureFolder(page, fixtures)
        await grantAgentAccessViaManageModal(page, dialog, {
          agentName: fixtures.agentA.name,
          unselectedAgentName: fixtures.agentB.name,
          includeWrite: true,
        })
        await closeManageDialog(page, dialog)
        // Business truth: exactly one host grant row for A on the folder,
        // read+write, inherit true — and still none for B.
        const grantsA = getGfsHostGrantsUnderTree(fixtures.folder.resourceId, fixtures.agentA.subjectId)
        expect(grantsA).toHaveLength(1)
        expect(grantsA[0]!.resourceId).toBe(fixtures.folder.resourceId)
        expect([...grantsA[0]!.permissions].sort()).toEqual(['read', 'write'])
        expect(grantsA[0]!.inherit).toBe(true)
        expect(
          getGfsHostGrantsUnderTree(fixtures.folder.resourceId, fixtures.agentB.subjectId)
        ).toHaveLength(0)
      })

      await test.step('Agent A reads the sentinel through the real PVC', async () => {
        await openExactAgent(page, fixtures.agentA.name)
        const turn = await sendAgentTurn(
          page,
          `Read the file at path "${filePath}" in GFS drive main and quote its contents ` +
            'verbatim. Use your Clerum GFS tools; do not answer from memory.'
        )
        assertNoInfraFailureShape(turn.responseText)
        await expectReadWithSentinel(turn.stepper, fixtures.originalSentinel)
      })

      await test.step('Agent A replaces the content; DB version bumps and the PVC serves it', async () => {
        // Same thread as the read: the write is the natural follow-up turn.
        const turn = await sendAgentTurn(
          page,
          `Now replace the ENTIRE contents of that same file ("${filePath}" in GFS drive main) ` +
            `with exactly this single line of text: "${fixtures.modifiedSentinel}". Use only ` +
            "your native Clerum GFS tools; if your write tool needs the file's current version, " +
            'discover it with your own GFS tools first. Do not create, copy, or delete anything.'
        )
        assertNoInfraFailureShape(turn.responseText)
        await expectToolSuccess(turn.stepper, 'gfs_write')
        const fileAfter = getGfsTreeSnapshot(fixtures.folder.fileResourceId)
        expect(fileAfter).toHaveLength(1)
        // DB truth: the version bumped and bytes match the stored blob.
        expect(fileAfter[0]!.version).toBeGreaterThan(fileBefore[0]!.version)
        expect(fileAfter[0]!.bytes).toBe(Buffer.byteLength(fileAfter[0]!.content ?? '', 'utf8'))
        // PVC truth: the snapshot content is read via kubectl exec cat on the
        // gfsc writer pod — the new sentinel must be served, the old one gone
        // (a "helpful" append instead of a replace must fail here).
        expect(fileAfter[0]!.content).toContain(fixtures.modifiedSentinel)
        expect(fileAfter[0]!.content).not.toContain(fixtures.originalSentinel)
      })

      await test.step('isolation: stateless Agent B is STILL denied after A was granted', async () => {
        await openExactAgent(page, fixtures.agentB.name)
        const turn = await sendAgentTurn(
          page,
          `Read the file at path "${filePath}" in GFS drive main and quote its contents ` +
            'verbatim. Do not answer from memory — attempt the read with your Clerum GFS tools ' +
            'even if the file is not in your listing.'
        )
        await expectNoDisclosureDenial(turn, [fixtures.originalSentinel, fixtures.modifiedSentinel])
        expect(
          getGfsHostGrantsUnderTree(fixtures.folder.resourceId, fixtures.agentB.subjectId)
        ).toHaveLength(0)
      })
    } finally {
      await app.close()
    }
  })

  test('stateless agent grant + UI revoke keeps agents isolated in the same runtime', async ({}, testInfo) => {
    // Three real LLM turns plus two Manage-modal rounds, Electron login, and a
    // possible stateless wake.
    testInfo.setTimeout(1_200_000)
    const filePath = `/${fixtures.folder.name}/${fixtures.folder.fileName}`
    const { app, page } = await launchAndLogin(OWNER_EMAIL)
    try {
      await test.step('UI grant: Agent B gets read-only with inherit ON', async () => {
        const dialog = await openManageForFixtureFolder(page, fixtures)
        // Continuity from Test 1: A's grant row is still listed before B's
        // grant is created.
        await expect(
          dialog.getByRole('button', {
            name: `Revoke access for ${fixtures.agentA.name}`,
            exact: true,
          })
        ).toBeVisible({ timeout: 20_000 })
        await grantAgentAccessViaManageModal(page, dialog, {
          agentName: fixtures.agentB.name,
          unselectedAgentName: fixtures.agentA.name,
          includeWrite: false,
        })
        await closeManageDialog(page, dialog)
        const grantsB = getGfsHostGrantsUnderTree(fixtures.folder.resourceId, fixtures.agentB.subjectId)
        expect(grantsB).toHaveLength(1)
        expect(grantsB[0]!.resourceId).toBe(fixtures.folder.resourceId)
        expect(grantsB[0]!.permissions).toEqual(['read'])
        expect(grantsB[0]!.inherit).toBe(true)
        // A's Test-1 grant is untouched by B's grant.
        const grantsA = getGfsHostGrantsUnderTree(fixtures.folder.resourceId, fixtures.agentA.subjectId)
        expect(grantsA).toHaveLength(1)
        expect([...grantsA[0]!.permissions].sort()).toEqual(['read', 'write'])
      })

      await test.step('stateless Agent B reads the MODIFIED sentinel (wake + fresh grant)', async () => {
        await openExactAgent(page, fixtures.agentB.name)
        const turn = await sendAgentTurn(
          page,
          `Read the file at path "${filePath}" in GFS drive main and quote its contents ` +
            'verbatim. Use your Clerum GFS tools; do not answer from memory.'
        )
        assertNoInfraFailureShape(turn.responseText)
        await expectReadWithSentinel(turn.stepper, fixtures.modifiedSentinel)
      })

      let runtimeBefore = ''
      await test.step('UI revoke: Agent A is removed from the grants list, audited', async () => {
        // Capture A's live pod identity BEFORE the revoke: the later denial
        // must come from live cache invalidation, not a restart.
        runtimeBefore = getManagedAgentPodIdentity(fixtures.agentA)
        const auditBefore = gfsGrantRevokeAuditCount(fixtures.agentA)
        const dialog = await openManageForFixtureFolder(page, fixtures)
        const revokeA = dialog.getByRole('button', {
          name: `Revoke access for ${fixtures.agentA.name}`,
          exact: true,
        })
        await expect(revokeA).toBeVisible({ timeout: 20_000 })
        await revokeA.click()
        await expect(
          page.getByText(`Access revoked for ${fixtures.agentA.name}`, { exact: true }).first()
        ).toBeVisible({ timeout: 20_000 })
        await expect(
          dialog.getByRole('button', {
            name: `Revoke access for ${fixtures.agentA.name}`,
            exact: true,
          })
        ).toHaveCount(0, { timeout: 20_000 })
        // B's row survives A's revocation.
        await expect(
          dialog.getByRole('button', {
            name: `Revoke access for ${fixtures.agentB.name}`,
            exact: true,
          })
        ).toBeVisible({ timeout: 20_000 })
        await closeManageDialog(page, dialog)
        expect(
          getGfsHostGrantsUnderTree(fixtures.folder.resourceId, fixtures.agentA.subjectId)
        ).toHaveLength(0)
        expect(gfsGrantRevokeAuditCount(fixtures.agentA)).toBe(auditBefore + 1)
      })

      await test.step('Agent A is denied in the SAME runtime (no pod restart)', async () => {
        // A FRESH thread is deliberate: reusing A's earlier thread would let it
        // quote the file straight from conversational memory (it legitimately
        // read+wrote the content while granted), which proves nothing about the
        // revocation. Driving by name in a clean thread forces a real re-access
        // through gfsc, which now denies it. Revocation blocks FUTURE access; it
        // does not erase context the agent already holds.
        await openExactAgent(page, fixtures.agentA.name)
        const turn = await sendAgentTurn(
          page,
          `Read the file at path "${filePath}" in GFS drive main and quote its contents ` +
            'verbatim. Do not answer from memory — attempt the read with your Clerum GFS ' +
            'tools even if the file is not in your listing.'
        )
        await expectNoDisclosureDenial(turn, [
          fixtures.originalSentinel,
          fixtures.modifiedSentinel,
        ])
        // Same-runtime proof: pod UID + startTime are unchanged across the
        // revoke and the denied retry — live cache invalidation, not a restart.
        expect(getManagedAgentPodIdentity(fixtures.agentA)).toBe(runtimeBefore)
      })

      await test.step('Agent B still reads fine — revocation is isolated per agent', async () => {
        await openExactAgent(page, fixtures.agentB.name)
        const turn = await sendAgentTurn(
          page,
          `Read the file at path "${filePath}" in GFS drive main one more time and quote its ` +
            'contents verbatim. Use your Clerum GFS tools; do not answer from memory.'
        )
        assertNoInfraFailureShape(turn.responseText)
        await expectReadWithSentinel(turn.stepper, fixtures.modifiedSentinel)
        const grantsB = getGfsHostGrantsUnderTree(fixtures.folder.resourceId, fixtures.agentB.subjectId)
        expect(grantsB).toHaveLength(1)
        expect(grantsB[0]!.permissions).toEqual(['read'])
      })
    } finally {
      await app.close()
    }
  })
})
