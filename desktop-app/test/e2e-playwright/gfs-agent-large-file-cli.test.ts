/**
 * E2E_GUARDIAN_IPC_FLOW — Electron delegates the chat/tool journey to its main
 * process, so there is no renderer HTTP request to alias.
 *
 * E2E contract (e2e-test-guardian):
 *  - Real user journey: login → Files → visible upload of an exact 3,836,961-byte
 *    CSV → exact managed agent chat → governed download → user-visible
 *    attended shell approvals → completed tool stepper and bounded response.
 *  - Business signals: the download step reports a workspace file; execution
 *    completes after attended review; the final response reports the independent
 *    data-record count and complete header. The synthetic file also proves its
 *    unique last record beyond 3 MiB. Tool output previews are diagnostic only.
 *  - Setup shortcuts: managed agent/folder fixture seeding and the local CSV
 *    file are named preconditions. No provider-route mock, storage mutation,
 *    direct API trigger, or broad network mock is used.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getGfsChildResourceSummary, getGfsGrantSummary } from '../../../tests/e2e/gfsUiFixtures'
import { exactNameFilter } from './helpers/agentLocators'
import { getManagedAgentDisplayName } from './helpers/gfsAgentDiscovery'
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
  hasCsvDataRecordCount,
  resolveGfsLargeCsvFixture,
} from './helpers/gfsLargeFileCsvFixture'
import { openAgentsPage, openResourcesNavItem } from './navigationHelpers'
import { launchAndLogin } from './workflowUi'

const OWNER_EMAIL = 'test@clerum.io'
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
): Promise<{ response: Locator; expandButton: Locator }> {
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
  await expect(completedToolStepRow(page, 'shell_exec')).toHaveCount(0)
  // The agent creates its own program from the normal business request. A
  // reviewer inspects each complete visible command and approves individually
  // in the UI; keyword matching cannot authorize arbitrary generated code.
  await test.info().attach('attended-shell-review-required', {
    contentType: 'text/plain',
    body: 'Review each complete command and referenced script, verify read-only access to this receipt and bounded summary output, then approve each request individually in the owned Desktop window.',
  })
  // Local control becomes actionable only after this test verifies the initial
  // receipt and unexecuted shell. Every decision still clicks the visible UI.
  reviewer?.activate()
  const responseDeadline = Date.now() + RESPONSE_TIMEOUT_MS
  let stepperClass = ''
  let lastReviewState = 'not started'
  while (Date.now() < responseDeadline) {
    if (reviewer) {
      const clicked = await reviewer.reviewAndApproveVisible(receiptPath!)
      lastReviewState = clicked ? 'clicked visible approval' : 'no actionable approval'
    }
    stepperClass = (await stepper.getAttribute('class')) ?? ''
    if (/\bstatus-completed\b/.test(stepperClass)) break
    await page.waitForFunction(
      () => {
        const currentStepper = document.querySelector('[data-testid="progress-stepper"]')
        const approve = document.querySelector<HTMLButtonElement>(
          '[data-testid="approval-approve-btn"]'
        )
        return (
          currentStepper?.classList.contains('status-completed') === true ||
          approve?.disabled === false
        )
      },
      undefined,
      { timeout: Math.max(1, responseDeadline - Date.now()), polling: 'raf' }
    )
  }
  expect(
    stepperClass,
    `Governed turn did not complete; last review state: ${lastReviewState}`
  ).toMatch(/\bstatus-completed\b/)
  await expect(approval).toHaveCount(0, { timeout: RESPONSE_TIMEOUT_MS })
  await expect(response).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS })
  const expandButton = page.getByTestId('progress-expand-btn')
  await expect(expandButton).toHaveCount(1, { timeout: PROGRESS_TIMEOUT_MS })
  await expect(expandButton).toBeVisible({ timeout: PROGRESS_TIMEOUT_MS })
  return { response, expandButton }
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
          sourceBefore = uploaded!
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
        })

        let expandButton: Locator
        let response: Locator
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
          const prompt =
            (sourceMode === 'path'
              ? `Analiza el CSV "${csv.fileName}" de la carpeta "${fixtures.granted.name}" en EvenDrive. `
              : 'Analiza el CSV que adjunté. ') +
            'Dime cuántos registros de datos contiene, sin contar la cabecera, y cuáles son sus columnas. ' +
            (csv.source === 'synthetic'
              ? 'Incluye también el identificador del último registro. '
              : '') +
            'Mantén el archivo original sin cambios y responde con un resumen breve.'
          const result = await sendTaskAndWaitForReviewedShell(
            page,
            prompt,
            sourceBefore.resourceId,
            sourceMode,
            reviewer
          )
          expandButton = result.expandButton
          response = result.response
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
})
