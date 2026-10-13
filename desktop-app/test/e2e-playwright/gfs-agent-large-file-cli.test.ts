/**
 * E2E_GUARDIAN_IPC_FLOW — Electron delegates the chat/tool journey to its main
 * process, so there is no renderer HTTP request to alias.
 *
 * E2E contract (e2e-test-guardian):
 *  - Real user journey: login → Files → visible upload of an exact 3,836,961-byte
 *    CSV → exact managed agent chat → governed download → user-visible
 *    attended shell approval (one card per task; later shell_exec calls in the
 *    same task run without a new card) → completed tool stepper and bounded
 *    response.
 *  - Business signals: the download step reports a workspace file; execution
 *    completes after attended review; the final response reports the independent
 *    data-record count and complete header. The synthetic file also proves its
 *    unique last record beyond 3 MiB. Tool output previews are diagnostic only.
 *  - Setup shortcuts: managed agent/folder fixture seeding and the local CSV
 *    file are named preconditions. No provider-route mock, storage mutation,
 *    direct API trigger, or broad network mock is used.
 */
import { type ElectronApplication, type Locator, type Page, expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  UUID_RE,
  firstDataLine,
  getGfsChildResourceSummary,
  getGfsGrantSummary,
  kubectlOut,
  runControlPostgresSql,
  seedGfsGrant,
  sqlLiteral,
} from '../../../tests/e2e/gfsUiFixtures'
import { E2E_TEST_EMAIL } from '../../../tests/e2e/testUser'
import { exactNameFilter } from './helpers/agentLocators'
import { type ManagedGfsAgent, getManagedAgentDisplayName } from './helpers/gfsAgentDiscovery'
import { createGfsApprovalReview } from './helpers/gfsApprovalReview'
import { assertGfsInfraHealthy } from './helpers/gfsFixtures'
import {
  type AgentGfsLargeFileFixtures,
  seedAgentGfsLargeFileFixtures,
} from './helpers/gfsLargeFileAgentFixture'
import {
  GFS_LARGE_CSV_SIZE,
  GFS_OLD_VISUAL_LIMIT,
  type GfsLargeCsvFixture,
  countMissingCsvColumns,
  csvColumnCountClaims,
  hasCsvDataRecordCount,
  resolveGfsLargeCsvFixture,
} from './helpers/gfsLargeFileCsvFixture'
import { openAgentsPage, openResourcesNavItem } from './navigationHelpers'
import { launchAndLogin } from './workflowUi'

// The seeded Desktop user of the profile (admin@evenfire.local on the minimal
// seed) owns the upload.
const OWNER_EMAIL = E2E_TEST_EMAIL
// Named precondition for the two-users journey, created by SQL below.
const SECOND_USER_EMAIL = 'e2e-gfs-second-user@evenfire.local'
const HOST_WORKSPACE = '/workspace'
const HOST_RESTART_TIMEOUT_MS = 300_000
const RESPONSE_TIMEOUT_MS = 420_000
const PROGRESS_TIMEOUT_MS = 45_000
// A 16 KiB ceiling bounds header/count metadata well below the 3.8 MB input.
const CSV_SUMMARY_MAX_BYTES = 16_384

// This spec owns its Electron trace below instead of the runner's generic trace.
// Actual customer bytes must not enter a trace through file-chooser inputs,
// uploads or later reads. Synthetic fixture diagnostics remain available.
test.use({ trace: 'off' })

async function enterAgentChat(page: Page, agentName: string): Promise<void> {
  await openAgentsPage(page)
  const exactAgent = page.getByLabel(`Open agent ${agentName}`, { exact: true })
  await expect(exactAgent).toBeVisible({ timeout: 30_000 })
  await exactAgent.click()
  await page.getByTestId('nav-chat').click()
  await page.getByTestId('nav-new-chat').click()
  const chatInput = page.getByTestId('chat-input')
  await expect(chatInput).toBeVisible({ timeout: 45_000 })

  const selectedAgentInNewChat = page
    .getByRole('button', { name: 'Switch chat agent' })
    .filter(exactNameFilter(agentName))
  if (!(await selectedAgentInNewChat.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Switch chat agent' }).click()
    await page.getByRole('menuitem', { name: agentName, exact: true }).click()
  }
  await expect(selectedAgentInNewChat).toBeVisible({
    timeout: 15_000,
  })
}

async function sendTaskAndWaitForReviewedShell(
  page: Page,
  prompt: string,
  resourceId: string,
  sourceMode: 'path' | 'reference',
  reviewer?: Awaited<ReturnType<typeof createGfsApprovalReview>>
): Promise<{ response: Locator; expandButton: Locator; receiptId: string }> {
  const response = page.getByTestId('agent-response')
  const approval = page.getByTestId('approval-approve-btn')
  // This is a new chat. A completed stepper from a prior turn must never
  // satisfy the completion signal below.
  await expect(page.getByTestId('progress-stepper')).toHaveCount(0)

  await page.getByTestId('chat-input').fill(prompt)
  await page.getByTestId('send-button').click()

  await expect(approval).toHaveCount(1, { timeout: RESPONSE_TIMEOUT_MS })
  await expect(approval).toBeVisible({ timeout: 10_000 })
  // This is a new chat and the test asserted above that no prior stepper exists.
  // Keep the same stable turn locator after the approval button disappears.
  const stepper = page.getByTestId('progress-stepper')
  await expect(stepper).toBeVisible({ timeout: 10_000 })
  await expect(stepper).toContainText('Shell requires approval')
  const commandPreview = stepper.getByTestId('approval-input-preview')
  await expect(commandPreview).toBeVisible()
  await expect(commandPreview).toContainText('.gfs-downloads/')
  await expect(stepper.getByRole('note')).toHaveCount(0)
  const details = stepper.getByRole('button', { name: /More details/ })
  // Path requests must show discovery and transfer evidence. An attached
  // reference is prepared before the first model turn, so its approval card can
  // legitimately contain only the reviewed shell call.
  if (sourceMode === 'path') {
    await expect(details).toBeVisible()
    await details.click()
  }
  const downloaded = completedToolStepRow(page, /gfs_download|gfs_read/)
  let receiptPath: string | undefined
  if (sourceMode === 'path') {
    // The user supplied only a human path. An observed discovery result must
    // precede the transfer; the harness never injects a resourceId into chat.
    const discovery = completedToolStepRow(page, /gfs_accessible|gfs_list|gfs_search/)
    expect(await discovery.count()).toBeGreaterThan(0)
    const steps = await stepper.getByTestId(/^step-row-/).allInnerTexts()
    const firstDiscovery = steps.findIndex(value =>
      /gfs_accessible|gfs_list|gfs_search/.test(value)
    )
    const firstTransfer = steps.findIndex(value => /gfs_download|gfs_read/.test(value))
    expect(firstDiscovery).toBeGreaterThanOrEqual(0)
    expect(firstTransfer).toBeGreaterThan(firstDiscovery)
    await expect.poll(() => downloaded.count()).toBeGreaterThan(0)
    const commandText = await commandPreview.innerText()
    for (const row of await downloaded.all()) {
      const downloadOutput = await stepOutput(row)
      const outputText = await downloadOutput.innerText()
      if (!outputText.includes('workspace_file')) continue
      const sourceId = outputText.match(/"source"\s*:\s*\{[^}]*"resourceId"\s*:\s*"([^"]+)"/)?.[1]
      if (sourceId?.replace(/-/g, '') !== resourceId.replace(/-/g, '')) continue
      const receiptId = outputText.match(/"id"\s*:\s*"([A-Za-z0-9_-]+)"/)?.[1]
      if (!receiptId) continue
      // The store's receipt ID maps to this local path. The receipt's visible
      // source binds the transfer to the upload; an ID alone does not prove it.
      // The bounded preview does not certify fields such as source.version.
      const candidatePath = `.gfs-downloads/input-${receiptId}/source`
      if (commandText.includes(candidatePath)) receiptPath = candidatePath
    }
    expect(
      receiptPath,
      'The reviewed command must use a receipt for the uploaded source'
    ).toBeTruthy()
  } else {
    // An attached reference is prepared before the first model request. The
    // agent may also revalidate it through the normal GFS tools.
    const path = (await commandPreview.innerText()).match(
      /\.gfs-downloads\/input-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/source/
    )?.[0]
    expect(path).toBeTruthy()
    receiptPath = path!
  }
  await expect(commandPreview).toContainText(receiptPath!)
  const receiptId = receiptPath!.slice('.gfs-downloads/input-'.length, -'/source'.length)
  expect(receiptId, 'The reviewed receipt must have a UUID id').toMatch(UUID_RE)
  await expect(completedToolStepRow(page, 'shell_exec')).toHaveCount(0)
  // The agent creates its own program from the normal business request. A
  // reviewer inspects the complete command shown on the task's single shell
  // approval card and approves it in the UI; that approval covers later
  // shell_exec calls for the rest of the task, so later commands are not
  // reviewed card by card. Keyword matching cannot authorize arbitrary
  // generated code.
  await test.info().attach('attended-shell-review-required', {
    contentType: 'text/plain',
    body: "Review the complete command and referenced script shown on the task's shell approval card, verify read-only access to this receipt and bounded summary output, then approve it in the owned Desktop window. That approval covers later shell commands for the rest of this task only; the next user message asks again.",
  })
  // Local control becomes actionable only after this test verifies the initial
  // receipt and unexecuted shell. Every decision still clicks the visible UI.
  reviewer?.activate()
  // Wait on the stable turn while the attending reviewer decides the task's
  // shell approval card through the one-use local transport and visible
  // approval button; later shell_exec calls in this task need no new card.
  // Merely recognizing a program's keywords cannot grant execution consent.
  await expect(stepper).toHaveClass(/\bstatus-completed\b/, {
    timeout: RESPONSE_TIMEOUT_MS,
  })
  await expect(approval).toHaveCount(0, { timeout: RESPONSE_TIMEOUT_MS })
  await expect(response).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS })
  const expandButton = page.getByTestId('progress-expand-btn')
  await expect(expandButton).toHaveCount(1, { timeout: PROGRESS_TIMEOUT_MS })
  await expect(expandButton).toBeVisible({ timeout: PROGRESS_TIMEOUT_MS })
  return { response, expandButton, receiptId }
}

interface HostReceiptCopy {
  userKey: string
  sha256: string
}

/** The agent's one live, Ready Host pod; none or several fails the check. */
function readyHostPod(agent: ManagedGfsAgent): { name: string; uid: string } | undefined {
  const rows = kubectlOut([
    '-n',
    agent.namespace,
    'get',
    'pods',
    '-l',
    `app=${agent.name}`,
    '-o',
    'go-template={{range .items}}{{if not .metadata.deletionTimestamp}}{{.metadata.name}} {{.metadata.uid}}{{range .status.conditions}}{{if eq .type "Ready"}} {{.status}}{{end}}{{end}}{{"\\n"}}{{end}}{{end}}',
  ])
    .split('\n')
    .map(line => line.trim().split(' '))
    .filter(fields => fields[0])
  if (rows.length !== 1) return undefined
  const [name, uid, ready] = rows[0]!
  return ready === 'True' && name && uid ? { name, uid } : undefined
}

/**
 * Reads the Host's copy of a receipt from its own container. The receipt id is
 * a UUID checked above, so the glob only selects the user key directory.
 */
function hostReceiptCopy(agent: ManagedGfsAgent, receiptId: string): HostReceiptCopy {
  expect(receiptId).toMatch(UUID_RE)
  const pod = readyHostPod(agent)
  if (!pod) throw new Error(`no single Ready Host pod for ${agent.namespace}/${agent.name}`)
  const lines = kubectlOut(
    [
      '-n',
      agent.namespace,
      'exec',
      pod.name,
      '-c',
      'mcp-host',
      '--',
      'sh',
      '-c',
      `sha256sum ${HOST_WORKSPACE}/users/*/.gfs-downloads/input-${receiptId}/source`,
    ],
    60_000
  )
    .split('\n')
    .filter(Boolean)
  expect(lines, `exactly one Host copy for receipt ${receiptId}`).toHaveLength(1)
  const match = lines[0]!.match(
    new RegExp(
      `^([0-9a-f]{64})\\s+${HOST_WORKSPACE}/users/([0-9a-f]{16})/\\.gfs-downloads/input-${receiptId}/source$`
    )
  )
  expect(match, `unexpected sha256sum output for receipt ${receiptId}`).toBeTruthy()
  return { sha256: match![1]!, userKey: match![2]! }
}

/** The `adopted` count from the store-initialized line of the pod's Host log. */
function storeInitializedAdopted(agent: ManagedGfsAgent, pod: string): number | undefined {
  const line = kubectlOut(['-n', agent.namespace, 'logs', `pod/${pod}`, '-c', 'mcp-host'], 30_000)
    .split('\n')
    .find(value => value.includes('"msg":"GFS download store initialized"'))
  if (!line) return undefined
  const adopted = (JSON.parse(line) as { adopted?: unknown }).adopted
  if (typeof adopted !== 'number') throw new Error('store-initialized log has no adopted count')
  return adopted
}

/**
 * Named precondition: a second Desktop user in the owner's team with the same
 * agent and contexts as the owner, as the profile seed binds its users. The
 * password is seeded by `launchAndLogin`.
 */
function ensureSecondUser(ownerEmail: string, agentName: string): string {
  const userId = firstDataLine(
    runControlPostgresSql(`
      WITH owner AS (
        SELECT id FROM users WHERE email = ${sqlLiteral(ownerEmail.toLowerCase())}
      ), owner_team AS (
        SELECT tm.team_id FROM team_members tm JOIN owner ON owner.id = tm.user_id
         WHERE tm.status = 'active' ORDER BY tm.created_at ASC LIMIT 1
      ), second_user AS (
        INSERT INTO users(email, name) VALUES(${sqlLiteral(SECOND_USER_EMAIL)}, 'E2E GFS Second User')
        ON CONFLICT (email) DO UPDATE SET updated_at = now()
        RETURNING id
      ), second_profile AS (
        INSERT INTO profiles(user_id, display_name)
        SELECT id, 'E2E GFS Second User' FROM second_user
        ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
        RETURNING user_id
      ), membership AS (
        INSERT INTO team_members(team_id, user_id, role, status)
        SELECT owner_team.team_id, second_user.id, 'member', 'active'
          FROM owner_team CROSS JOIN second_user
        ON CONFLICT (team_id, user_id) DO UPDATE SET role = 'member', status = 'active', updated_at = now()
        RETURNING user_id
      ), agent_access AS (
        INSERT INTO user_agents(user_id, agent_name)
        SELECT id, ${sqlLiteral(agentName)} FROM second_user
        ON CONFLICT DO NOTHING
        RETURNING user_id
      ), contexts AS (
        INSERT INTO user_contexts(user_id, context_id)
        SELECT second_user.id, uc.context_id
          FROM second_user CROSS JOIN user_contexts uc JOIN owner ON owner.id = uc.user_id
        ON CONFLICT DO NOTHING
        RETURNING user_id
      )
      SELECT membership.user_id::text
        FROM membership JOIN second_profile ON second_profile.user_id = membership.user_id;
    `)
  )
  if (!UUID_RE.test(userId)) throw new Error(`second user precondition failed: ${userId}`)
  const bindings = firstDataLine(
    runControlPostgresSql(`
      SELECT (SELECT count(*) FROM user_agents WHERE user_id = ${sqlLiteral(userId)}::uuid
                 AND agent_name = ${sqlLiteral(agentName)})::text || ' ' ||
             (SELECT count(*) FROM user_contexts WHERE user_id = ${sqlLiteral(userId)}::uuid)::text;
    `)
  )
  const [agentCount, contextCount] = bindings.split(' ').map(Number)
  expect(agentCount, 'second user must have the agent').toBe(1)
  expect(contextCount, 'second user must have the owner contexts').toBeGreaterThan(0)
  return userId
}

function toolStepRow(page: Page, toolName: string | RegExp): Locator {
  return page.getByTestId(/^step-row-/).filter({ hasText: toolName })
}

function completedToolStepRow(page: Page, toolName: string | RegExp): Locator {
  return toolStepRow(page, toolName).filter({
    has: page.locator('.stepper-step-duration.state-completed'),
  })
}

async function stepOutput(row: Locator): Promise<Locator> {
  const toolCallId = (await row.getAttribute('data-testid'))?.slice('step-row-'.length)
  expect(toolCallId).toBeTruthy()
  const output = row
    .page()
    .getByTestId('step-output-panel')
    .and(row.page().locator(`[data-tool-call-id=${JSON.stringify(toolCallId)}]`))
    .locator('.stepper-step-output-code')
  if (!(await output.isVisible())) await row.click()
  await expect(output).toBeVisible({ timeout: 10_000 })
  return output
}

test.describe('GFS large-file business analysis with attended approval', () => {
  test.skip(
    process.env.E2E_GFS_ATTENDED_APPROVAL !== '1',
    'Real-provider acceptance requires a reviewer for the agent-generated shell command.'
  )
  test.describe.configure({ mode: 'serial' })
  // Both the provider's approval request and its resumed answer have a bounded
  // deadline; the default Desktop test timeout must not close Electron first.
  test.setTimeout(RESPONSE_TIMEOUT_MS * 2 + 120_000)

  let fixtures: AgentGfsLargeFileFixtures
  let agentLabel: string
  let csv: GfsLargeCsvFixture
  let csvUploadPath: string
  let syntheticDirectory: string | undefined

  test.beforeEach(() => {
    assertGfsInfraHealthy()
    fixtures = seedAgentGfsLargeFileFixtures(OWNER_EMAIL)
    agentLabel = getManagedAgentDisplayName(fixtures.agent)
    csv = resolveGfsLargeCsvFixture()
    expect(csv.buffer.byteLength).toBe(GFS_LARGE_CSV_SIZE)
    if (csv.source === 'synthetic')
      expect(csv.buffer.indexOf(csv.sentinel!, 'utf8')).toBeGreaterThan(GFS_OLD_VISUAL_LIMIT)
    if (csv.sourcePath) csvUploadPath = csv.sourcePath
    else {
      // Electron's file picker requires a real local path for getPathForFile.
      syntheticDirectory = mkdtempSync(join(tmpdir(), 'gfs-agent-large-csv-'))
      csvUploadPath = join(syntheticDirectory, csv.fileName)
      writeFileSync(csvUploadPath, csv.buffer, { mode: 0o600 })
    }
  })

  test.afterEach(() => {
    try {
      fixtures?.cleanup()
    } finally {
      if (syntheticDirectory) rmSync(syntheticDirectory, { recursive: true, force: true })
    }
  })

  function csvSha256(): string {
    return createHash('sha256').update(csv.buffer).digest('hex')
  }

  function analysisPrompt(sourceMode: 'path' | 'reference'): string {
    return (
      (sourceMode === 'path'
        ? `Analiza el CSV "${csv.fileName}" de la carpeta "${fixtures.granted.name}" en EvenDrive. `
        : 'Analiza el CSV que adjunté. ') +
      'Dime cuántos registros de datos contiene, sin contar la cabecera, y cuáles son sus columnas. ' +
      (csv.source === 'synthetic' ? 'Incluye también el identificador del último registro. ' : '') +
      'Mantén el archivo original sin cambios y responde con un resumen breve.'
    )
  }

  async function uploadCsvThroughFiles(
    page: Page
  ): Promise<NonNullable<ReturnType<typeof getGfsChildResourceSummary>>> {
    await openResourcesNavItem(page, 'nav-files')
    await expect(page.getByRole('heading', { name: 'Files', exact: true })).toBeVisible()
    const browser = page.getByRole('region', { name: 'EvenDrive browser' })
    await expect(browser).toBeVisible({ timeout: 30_000 })
    await browser
      .getByRole('button', { name: `Open ${fixtures.granted.name}`, exact: true })
      .click()
    await expect(
      browser.getByRole('button', { name: `Open ${fixtures.granted.childName}`, exact: true })
    ).toBeVisible({ timeout: 30_000 })
    const upload = browser.getByRole('button').filter({ hasText: /^Upload file$/ })
    await expect(upload).toBeVisible({ timeout: 30_000 })
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 30_000 }),
      upload.click(),
    ])
    await chooser.setFiles(csvUploadPath)
    await expect(page.getByText(`Uploaded ${csv.fileName}`)).toBeVisible({
      timeout: 30_000,
    })
    await expect(
      browser.getByRole('button', { name: `Open ${csv.fileName}`, exact: true })
    ).toBeVisible({ timeout: 30_000 })
    const uploaded = getGfsChildResourceSummary({
      parentResourceId: fixtures.granted.resourceId,
      name: csv.fileName,
    })
    expect(uploaded).toMatchObject({
      kind: 'file',
      bytes: GFS_LARGE_CSV_SIZE,
      deleted: false,
    })
    const hostGrant = getGfsGrantSummary({
      resourceId: fixtures.granted.resourceId,
      subjectType: 'host',
      subjectId: fixtures.agent.subjectId,
    })
    expect(hostGrant).toMatchObject({ permissions: ['read'], inherit: true })
    await test.info().attach('gfs-source-identity', {
      contentType: 'application/json',
      body: JSON.stringify({
        resourceId: uploaded!.resourceId,
        parentResourceId: fixtures.granted.resourceId,
        version: uploaded!.version,
        bytes: uploaded!.bytes,
        hostSubjectId: fixtures.agent.subjectId,
        hostGrant,
      }),
    })
    return uploaded!
  }

  /**
   * One path-mode analysis task in a new chat: governed download, attended
   * shell approval, and the independent record count in the response.
   */
  async function analyzeByPath(
    page: Page,
    resourceId: string,
    reviewer: Awaited<ReturnType<typeof createGfsApprovalReview>> | undefined
  ): Promise<string> {
    await enterAgentChat(page, agentLabel)
    const { response, receiptId } = await sendTaskAndWaitForReviewedShell(
      page,
      analysisPrompt('path'),
      resourceId,
      'path',
      reviewer
    )
    const summary = await response.innerText()
    expect(
      hasCsvDataRecordCount(summary, csv.dataRecordCount),
      'Response must report the independent count as CSV data records'
    ).toBe(true)
    return receiptId
  }

  /** Runs a journey in one owned Desktop session with the optional reviewer. */
  async function withDesktop<T>(
    email: string,
    label: string,
    journey: (
      page: Page,
      reviewer: Awaited<ReturnType<typeof createGfsApprovalReview>> | undefined
    ) => Promise<T>
  ): Promise<T> {
    const { app, page }: { app: ElectronApplication; page: Page } = await launchAndLogin(email)
    let reviewer: Awaited<ReturnType<typeof createGfsApprovalReview>> | undefined
    let verdict: 'passed' | 'failed' = 'failed'
    try {
      if (process.env.E2E_GFS_REVIEW_CONTROL === '1') {
        reviewer = await createGfsApprovalReview(
          app,
          page,
          pathToFileURL(resolve(__dirname, '../../ui-dist/index.html')).href
        )
        console.info(
          'GFS_APPROVAL_REVIEW_READY',
          JSON.stringify({
            socketPath: reviewer.socketPath,
            session: label,
            pid: app.process().pid,
          })
        )
      }
      const value = await journey(page, reviewer)
      verdict = 'passed'
      return value
    } catch (error) {
      if (!page.isClosed()) {
        try {
          await test.info().attach(`large-file-${label}-failure`, {
            contentType: 'image/png',
            body: await page.screenshot({ timeout: 5_000 }),
          })
        } catch {
          await test.info().attach(`large-file-${label}-screenshot-unavailable`, {
            contentType: 'text/plain',
            body: 'The owned Electron window did not produce a screenshot within five seconds.',
          })
        }
      }
      throw error
    } finally {
      try {
        if (reviewer) {
          try {
            await reviewer.observeResult(verdict)
          } finally {
            await reviewer.close()
          }
        }
      } finally {
        await app.close()
      }
    }
  }

  for (const sourceMode of ['path', 'reference'] as const) {
    test(`user asks for CSV record count and columns via ${sourceMode}`, async () => {
      const { app, page } = await launchAndLogin(OWNER_EMAIL)
      const desktopContext = app.context()
      let ownedTraceStarted = false
      let reviewer: Awaited<ReturnType<typeof createGfsApprovalReview>> | undefined
      let businessVerdict: 'passed' | 'failed' = 'failed'
      let visibleResponse: string | undefined
      let sourceBefore: NonNullable<ReturnType<typeof getGfsChildResourceSummary>>
      try {
        if (process.env.E2E_GFS_REVIEW_CONTROL === '1') {
          reviewer = await createGfsApprovalReview(
            app,
            page,
            pathToFileURL(resolve(__dirname, '../../ui-dist/index.html')).href
          )
          console.info(
            'GFS_APPROVAL_REVIEW_READY',
            JSON.stringify({
              socketPath: reviewer.socketPath,
              sourceMode,
              pid: app.process().pid,
            })
          )
        }
        if (csv.source === 'synthetic') {
          await desktopContext.tracing.start({ screenshots: true, snapshots: true, sources: false })
          ownedTraceStarted = true
        }
        await test.step('user uploads the exact CSV through Files', async () => {
          sourceBefore = await uploadCsvThroughFiles(page)
        })

        let expandButton: Locator
        let response: Locator
        let receiptId: string
        await test.step('exact agent downloads and processes the file after approval', async () => {
          await enterAgentChat(page, agentLabel)
          if (sourceMode === 'reference') {
            await page.getByRole('button', { name: 'Add context' }).click()
            await expect(
              page.getByRole('menuitem', { name: 'EvenDrive', exact: true })
            ).toBeVisible()
            await page.getByRole('menuitem', { name: 'EvenDrive', exact: true }).click()
            const picker = page.getByRole('dialog', { name: 'Choose files for this message' })
            await expect(picker).toBeVisible()
            const grantedFolder = picker.getByRole('button').filter({
              has: page.getByText(fixtures.granted.name, { exact: true }),
            })
            await expect(grantedFolder).toHaveCount(1, { timeout: 20_000 })
            await grantedFolder.click()
            await expect(
              picker
                .getByRole('navigation', { name: 'Global file path' })
                .getByRole('button', { name: fixtures.granted.name, exact: true })
            ).toBeVisible()
            const fileRow = picker
              .locator('.composer-global-files-row--file')
              .filter({ has: page.getByText(csv.fileName, { exact: true }) })
            await expect(fileRow).toHaveCount(1, { timeout: 20_000 })
            await fileRow.getByRole('checkbox').check()
            await picker.getByRole('button', { name: 'Attach 1', exact: true }).click()
            await expect(picker).toHaveCount(0)
            await expect(
              page.getByRole('button', { name: `Remove ${csv.fileName}`, exact: true })
            ).toBeVisible()
          }
          const result = await sendTaskAndWaitForReviewedShell(
            page,
            analysisPrompt(sourceMode),
            sourceBefore.resourceId,
            sourceMode,
            reviewer
          )
          expandButton = result.expandButton
          response = result.response
          receiptId = result.receiptId
        })

        await test.step('Host copy of the receipt has the uploaded bytes', async () => {
          expect(hostReceiptCopy(fixtures.agent, receiptId).sha256).toBe(csvSha256())
        })

        await test.step('tool stepper proves governed transfer and local execution', async () => {
          if ((await expandButton.getAttribute('aria-expanded')) === 'false')
            await expandButton.click()
          const downloadRow = completedToolStepRow(page, /gfs_download|gfs_read/)
          if (sourceMode === 'path') {
            expect(await downloadRow.count()).toBeGreaterThan(0)
            await expect(downloadRow.locator('.stepper-step-duration.state-error')).toHaveCount(0)
          }

          const shellRow = completedToolStepRow(page, 'shell_exec')
          expect(await shellRow.count()).toBeGreaterThan(0)
          await expect(shellRow.locator('.stepper-step-duration.state-error')).toHaveCount(0)
          for (const row of await shellRow.all()) {
            await expect(row).toBeVisible()
          }
          // The turn is complete. Tool previews cap each line and show only
          // the tail, so business metadata belongs to the final response.
          const responseSummary = await response.innerText()
          // Capture the visible result before navigation, including a failed
          // business oracle. The local reviewer never reads a private result API.
          if (Buffer.byteLength(responseSummary, 'utf8') <= CSV_SUMMARY_MAX_BYTES)
            visibleResponse = responseSummary
          expect(
            Buffer.byteLength(responseSummary, 'utf8'),
            'The response must remain a bounded CSV summary'
          ).toBeLessThanOrEqual(CSV_SUMMARY_MAX_BYTES)
          expect(
            hasCsvDataRecordCount(responseSummary, csv.dataRecordCount),
            'Response must report the independent count as CSV data records'
          ).toBe(true)
          // Original header values remain in fixture memory. Failure messages
          // report only the number of missing columns, never customer names.
          expect(
            countMissingCsvColumns(responseSummary, csv.columns),
            'Response must include every independently parsed CSV column'
          ).toBe(0)
          expect(
            csvColumnCountClaims(responseSummary).filter(claim => claim !== csv.columns.length),
            'Every stated column count must match the independently parsed header'
          ).toEqual([])
          if (csv.source === 'synthetic') {
            await expect(response).toContainText(csv.lastRecordId!)
          }
          expect(
            responseSummary.includes('zzzzzzzzzz'),
            'Response must not dump synthetic padding'
          ).toBe(false)
        })

        await test.step('source remains visible after read-only processing', async () => {
          await openResourcesNavItem(page, 'nav-files')
          const browser = page.getByRole('region', { name: 'EvenDrive browser' })
          await browser
            .getByRole('button', { name: `Open ${fixtures.granted.name}`, exact: true })
            .click()
          await expect(browser.getByRole('button', { name: `Open ${csv.fileName}` })).toBeVisible({
            timeout: 30_000,
          })
          expect(
            getGfsChildResourceSummary({
              parentResourceId: fixtures.granted.resourceId,
              name: csv.fileName,
            })
          ).toEqual(sourceBefore)
        })
        businessVerdict = 'passed'
      } catch (error) {
        // Capture the owned test window while it is still alive. Automatic
        // post-test screenshots cannot recover a window already closed here.
        if (!page.isClosed()) {
          try {
            await test.info().attach('large-file-desktop-failure', {
              contentType: 'image/png',
              body: await page.screenshot({ timeout: 5_000 }),
            })
          } catch {
            // A stalled renderer must not replace the original journey error.
            await test.info().attach('large-file-screenshot-unavailable', {
              contentType: 'text/plain',
              body: 'The owned Electron window did not produce a screenshot within five seconds.',
            })
          }
        }
        throw error
      } finally {
        try {
          if (reviewer) {
            try {
              await reviewer.observeResult(businessVerdict, visibleResponse)
            } finally {
              await reviewer.close()
            }
          }
          if (ownedTraceStarted) {
            try {
              await desktopContext.tracing.stop({
                path: test.info().outputPath('large-file-electron-context-trace.zip'),
              })
            } catch {
              await test.info().attach('large-file-context-trace-unavailable', {
                contentType: 'text/plain',
                body: 'The owned Electron context did not save its diagnostic trace.',
              })
            }
          }
        } finally {
          await app.close()
        }
      }
    })
  }

  test('downloads are fresh after a Host restart and separate per user', async () => {
    // Three attended tasks, one Host restart and two Desktop sessions.
    test.setTimeout(RESPONSE_TIMEOUT_MS * 6 + HOST_RESTART_TIMEOUT_MS + 300_000)
    const expectedSha256 = csvSha256()
    let resourceId = ''
    let r2 = ''
    let ownerKey = ''

    await withDesktop(OWNER_EMAIL, 'owner', async (page, reviewer) => {
      await test.step('owner uploads the exact CSV through Files', async () => {
        resourceId = (await uploadCsvThroughFiles(page)).resourceId
      })

      let r1 = ''
      await test.step('owner download R1 has the uploaded bytes on the Host', async () => {
        r1 = await analyzeByPath(page, resourceId, reviewer)
        const copy = hostReceiptCopy(fixtures.agent, r1)
        expect(copy.sha256).toBe(expectedSha256)
        ownerKey = copy.userKey
      })

      await test.step('Host pod is deleted and a new pod adopts the retained copy', async () => {
        const before = readyHostPod(fixtures.agent)
        expect(before, 'a single Ready Host pod before the restart').toBeTruthy()
        kubectlOut(['-n', fixtures.agent.namespace, 'delete', 'pod', before!.name, '--wait=false'])
        let after: { name: string; uid: string } | undefined
        await expect
          .poll(
            () => {
              after = readyHostPod(fixtures.agent)
              return after !== undefined && after.uid !== before!.uid
            },
            { timeout: HOST_RESTART_TIMEOUT_MS, intervals: [2_000, 5_000] }
          )
          .toBe(true)
        // A restarted store never reuses a copy it did not publish itself;
        // it adopts R1 for cleanup and quota only.
        await expect
          .poll(() => storeInitializedAdopted(fixtures.agent, after!.name), { timeout: 120_000 })
          .toBeGreaterThanOrEqual(1)
        await test.info().attach('host-restart', {
          contentType: 'application/json',
          body: JSON.stringify({ before, after }),
        })
      })

      await test.step('owner download after the restart is a new receipt R2', async () => {
        r2 = await analyzeByPath(page, resourceId, reviewer)
        expect(r2, 'an adopted copy must not be reused').not.toBe(r1)
        const copy = hostReceiptCopy(fixtures.agent, r2)
        expect(copy.sha256).toBe(expectedSha256)
        expect(copy.userKey, 'the same user downloads into the same user directory').toBe(ownerKey)
      })
    })

    await test.step('named precondition: a second user with read access to the folder', () => {
      const secondUserId = ensureSecondUser(OWNER_EMAIL, fixtures.agent.name)
      seedGfsGrant({
        resourceId: fixtures.granted.resourceId,
        subjectType: 'user',
        subjectId: secondUserId,
        permissions: ['read'],
        inherit: true,
        grantedBy: 'e2e:gfs-agent-large-file',
      })
    })

    await withDesktop(SECOND_USER_EMAIL, 'second-user', async (page, reviewer) => {
      await test.step('second user download R3 is separate from the owner copy', async () => {
        const r3 = await analyzeByPath(page, resourceId, reviewer)
        expect(r3, 'another user never reuses the owner receipt').not.toBe(r2)
        const copy = hostReceiptCopy(fixtures.agent, r3)
        expect(copy.sha256).toBe(expectedSha256)
        expect(copy.userKey, 'each user downloads into its own user directory').not.toBe(ownerKey)
        // The owner's copy is still in place: R3 did not replace it.
        expect(hostReceiptCopy(fixtures.agent, r2).userKey).toBe(ownerKey)
      })
    })
  })
})
