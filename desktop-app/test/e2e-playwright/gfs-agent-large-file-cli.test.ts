/**
 * E2E_GUARDIAN_IPC_FLOW — Electron delegates the chat/tool journey to its main
 * process, so there is no renderer HTTP request to alias.
 *
 * E2E contract (e2e-test-guardian):
 *  - Real user journey: login → Files → visible upload of an exact 3,836,961-byte
 *    CSV → exact managed agent chat → governed download → user-visible
 *    `shell_exec` approval → completed tool stepper and bounded response.
 *  - Business signals: the download step reports a workspace file; the approved
 *    Node command reports the independently generated CSV record count and a
 *    sentinel located beyond the former 3 MiB boundary.
 *  - Setup shortcuts: managed agent/folder fixture seeding and the local CSV
 *    file are named preconditions. No provider-route mock, storage mutation,
 *    direct API trigger, or broad network mock is used.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGfsChildResourceSummary, getGfsGrantSummary } from '../../../tests/e2e/gfsUiFixtures'
import { exactNameFilter } from './helpers/agentLocators'
import { type ManagedGfsAgent, getManagedAgentDisplayName } from './helpers/gfsAgentDiscovery'
import { assertGfsInfraHealthy } from './helpers/gfsFixtures'
import {
  type AgentGfsLargeFileFixtures,
  seedAgentGfsLargeFileFixtures,
} from './helpers/gfsLargeFileAgentFixture'
import { largeCsvProofCommand, largeCsvProofProgram } from './helpers/gfsLargeFileCliCommand'
import {
  GFS_LARGE_CSV_SIZE,
  GFS_OLD_VISUAL_LIMIT,
  type GfsLargeCsvFixture,
  resolveGfsLargeCsvFixture,
} from './helpers/gfsLargeFileCsvFixture'
import { openAgentsPage, openResourcesNavItem } from './navigationHelpers'
import { launchAndLogin } from './workflowUi'

const OWNER_EMAIL = 'test@clerum.io'
const RESPONSE_TIMEOUT_MS = 420_000
const PROGRESS_TIMEOUT_MS = 45_000
const runToken = `GFS-LARGE-CLI-${randomUUID()}`

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

async function sendTaskAndApproveShell(
  page: Page,
  prompt: string,
  resourceId: string,
  sourceMode: 'path' | 'reference'
): Promise<{ response: Locator; expandButton: Locator }> {
  const response = page.getByTestId('agent-response').filter({ hasText: runToken })
  const approval = page.getByTestId('approval-approve-btn')

  await page.getByTestId('chat-input').fill(prompt)
  await page.getByTestId('send-button').click()

  await expect(approval).toHaveCount(1, { timeout: RESPONSE_TIMEOUT_MS })
  await expect(approval).toBeVisible({ timeout: 10_000 })
  const stepper = page.getByTestId('progress-stepper').filter({ has: approval })
  await expect(stepper).toBeVisible({ timeout: 10_000 })
  await expect(stepper).toContainText('shell_exec')
  const commandPreview = stepper.getByTestId('approval-input-preview')
  await expect(commandPreview).toBeVisible()
  await expect(commandPreview).toContainText('node')
  await expect(commandPreview).toContainText('createHash')
  await expect(commandPreview).toContainText('.gfs-downloads/')
  await expect(stepper.getByRole('note')).toHaveCount(0)
  const details = stepper.getByRole('button', { name: /More details/ })
  await expect(details).toBeVisible()
  await details.click()
  const downloaded = completedToolStepRow(page, 'gfs_download')
  let receiptPath: string
  if (sourceMode === 'path') {
    await expect(downloaded).toHaveCount(1)
    const downloadOutput = await stepOutput(downloaded)
    await expect(downloadOutput).toContainText('workspace_file')
    await expect(downloadOutput).toContainText(resourceId.replace(/-/g, ''))
    // The bounded UI preview exposes the receipt ID before source fields. Use
    // that ID to check the complete command and its exact file before approval.
    const receiptId = (await downloadOutput.innerText()).match(/"id":"([A-Za-z0-9_-]+)"/)?.[1]
    expect(receiptId).toBeTruthy()
    receiptPath = `.gfs-downloads/input-${receiptId}/source`
  } else {
    // The attached reference is prepared before the first model request. The
    // model must use that local receipt without another GFS content tool call.
    await expect(toolStepRow(page, 'gfs_download')).toHaveCount(0)
    await expect(toolStepRow(page, 'gfs_read')).toHaveCount(0)
    const path = (await commandPreview.innerText()).match(
      /\.gfs-downloads\/input-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/source/
    )?.[0]
    expect(path).toBeTruthy()
    receiptPath = path!
  }
  await expect(commandPreview).toHaveText(largeCsvProofCommand(runToken, receiptPath))
  await expect(completedToolStepRow(page, 'shell_exec')).toHaveCount(0)
  await approval.click()
  await expect(approval).toHaveCount(0, { timeout: PROGRESS_TIMEOUT_MS })

  await expect(response).toContainText(/ROWS=/, { timeout: RESPONSE_TIMEOUT_MS })
  await expect(response).toContainText(/PROOF=[0-9a-f]{16}/, {
    timeout: RESPONSE_TIMEOUT_MS,
  })
  const expandButton = page.getByTestId('progress-expand-btn')
  await expect(expandButton).toHaveCount(1, { timeout: PROGRESS_TIMEOUT_MS })
  await expect(expandButton).toBeVisible({ timeout: PROGRESS_TIMEOUT_MS })
  return { response, expandButton }
}

function toolStepRow(page: Page, toolName: string): Locator {
  return page.getByTestId(/^step-row-/).filter({ hasText: toolName })
}

function completedToolStepRow(page: Page, toolName: string): Locator {
  return toolStepRow(page, toolName).filter({
    has: page.locator('.stepper-step-duration.state-completed'),
  })
}

async function stepOutput(row: Locator): Promise<Locator> {
  const toolCallId = (await row.getAttribute('data-testid'))?.slice('step-row-'.length)
  expect(toolCallId).toBeTruthy()
  await row.click()
  const output = row
    .page()
    .getByTestId('step-output-panel')
    .and(row.page().locator(`[data-tool-call-id=${JSON.stringify(toolCallId)}]`))
    .locator('.stepper-step-output-code')
  await expect(output).toBeVisible({ timeout: 10_000 })
  return output
}

test.describe('GFS agent large-file CLI journey', () => {
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
    test(`user uploads a 3.8 MiB CSV and approves local processing via ${sourceMode}`, async () => {
      const { app, page } = await launchAndLogin(OWNER_EMAIL)
      let sourceBefore: NonNullable<ReturnType<typeof getGfsChildResourceSummary>>
      try {
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
            await expect(page.getByRole('menuitem', { name: 'Global File System' })).toBeVisible()
            await page.getByRole('menuitem', { name: 'Global File System' }).click()
            const picker = page.getByRole('dialog', { name: 'Choose files for this message' })
            await expect(picker).toBeVisible()
            const fileRow = picker
              .locator('.composer-global-files-row--file')
              .filter({ hasText: csv.fileName })
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
              ? `Download "/${fixtures.granted.name}/${csv.fileName}" from GFS drive main with clerum__gfs_download. `
              : 'Process the attached file using the ready workspace receipt prepared by the Host. ') +
            'Do not print or file_read the whole file. Use exactly one approved shell_exec ' +
            'Node.js command with the receipt path as an argument. Count complete CSV records including the header, ' +
            'never raw newlines. Use exactly this read-only program, preserving its single-quoted shell argument and all bytes: ' +
            `node -e '${largeCsvProofProgram(runToken)}' '<receipt path>'. ` +
            'Replace only <receipt path> with the relative path from the successful download receipt. ' +
            `Return the command stdout unchanged: RUN=${runToken} ROWS=<record count> PROOF=<16 hex characters>.`
          const result = await sendTaskAndApproveShell(
            page,
            prompt,
            sourceBefore.resourceId,
            sourceMode
          )
          expandButton = result.expandButton
          response = result.response
        })

        await test.step('tool stepper proves governed transfer and local execution', async () => {
          if ((await expandButton.getAttribute('aria-expanded')) === 'false')
            await expandButton.click()
          const downloadRow = completedToolStepRow(page, 'gfs_download')
          await expect(downloadRow).toHaveCount(sourceMode === 'path' ? 1 : 0, { timeout: 15_000 })
          if (sourceMode === 'path') {
            await expect(downloadRow).toBeVisible({ timeout: 15_000 })
            await expect(downloadRow.locator('.stepper-step-duration.state-error')).toHaveCount(0)
            await expect(downloadRow).toContainText('gfs_download')
          } else {
            await expect(toolStepRow(page, 'gfs_download')).toHaveCount(0)
            await expect(toolStepRow(page, 'gfs_read')).toHaveCount(0)
          }

          const shellRow = completedToolStepRow(page, 'shell_exec')
          await expect(shellRow).toHaveCount(1, { timeout: 15_000 })
          await expect(shellRow).toBeVisible({ timeout: 15_000 })
          await expect(shellRow.locator('.stepper-step-duration.state-error')).toHaveCount(0)
          const shellOutput = await stepOutput(shellRow)
          const expectedRows = new RegExp(`\\bROWS=${csv.recordCount}(?=\\s|$)`)
          const expectedProof = new RegExp(`\\bPROOF=${csv.tailProof}(?=\\s|$)`)
          await expect(shellOutput).toContainText(expectedRows)
          await expect(shellOutput).toContainText(expectedProof)

          await expect(response).toContainText(expectedRows)
          await expect(response).toContainText(expectedProof)
          await expect(response).not.toContainText('zzzzzzzzzz')
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
      } catch (error) {
        // Capture the owned test window while it is still alive. Automatic
        // post-test screenshots cannot recover a window already closed here.
        if (!page.isClosed()) {
          await test.info().attach('large-file-desktop-failure', {
            contentType: 'image/png',
            body: await page.screenshot(),
          })
        }
        throw error
      } finally {
        await app.close()
      }
    })
  }
})
